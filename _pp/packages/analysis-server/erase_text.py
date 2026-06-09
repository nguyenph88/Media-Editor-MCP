#!/usr/bin/env python
"""Standalone burned-in caption remover (no Premiere, no MCP).

Key idea: a burned-in caption is a STATIC overlay that persists across a whole
shot while the background moves. So instead of thresholding each frame on its
own (brittle: misses faint/fading frames, flickers, smudges), we:

  1. split the video into shots (PySceneDetect),
  2. per shot, mark pixels that are white-ish AND persist across most of the
     shot's frames  -> one stable mask that captures the full caption,
  3. inpaint every frame of the shot with that single mask.

This catches the caption even on frames where it's faint, rejects moving bright
background (waves, sky, building faces) because those aren't persistent at a
fixed pixel, and removes flicker because the mask is constant within a shot.
Audio is copied from the source untouched.

ALWAYS `--preview SEC` first to eyeball the mask for that shot, then run full.

Examples
--------
  python erase_text.py "clip.mp4" --preview 16
  python erase_text.py "clip.mp4"
  python erase_text.py "clip.mp4" --persist 0.4 --band 0.55 0.88   # looser
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


def log(msg: str) -> None:
    print(f"[erase-text] {msg}", file=sys.stderr, flush=True)


def ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def detect_shots(path: str, total: int, fps: float):
    """Return a list of (start_frame, end_frame) shot ranges covering the video."""
    try:
        from scenedetect import open_video, SceneManager
        from scenedetect.detectors import ContentDetector

        video = open_video(path)
        sm = SceneManager()
        sm.add_detector(ContentDetector(min_scene_len=int(fps)))
        sm.detect_scenes(video, show_progress=False)
        scenes = sm.get_scene_list()
        if scenes:
            ranges = [(s.get_frames(), e.get_frames()) for s, e in scenes]
            # guard: make sure we cover the whole clip
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], total))
            return ranges
    except Exception as e:  # noqa: BLE001
        log(f"scene detection failed ({e}); treating whole clip as one shot")
    return [(0, total)]


def bright_in_band(frame, band, v_min, s_max):
    """uint8 0/1 — white-ish pixels inside the vertical band (rest zero)."""
    h, w = frame.shape[:2]
    y0, y1 = int(band[0] * h), int(band[1] * h)
    out = np.zeros((h, w), np.uint8)
    hsv = cv2.cvtColor(frame[y0:y1], cv2.COLOR_BGR2HSV)
    out[y0:y1] = ((hsv[:, :, 2] >= v_min) & (hsv[:, :, 1] <= s_max)).astype(np.uint8)
    return out


def finalize_mask(count, n_frames, persist_frac, max_h_frac, max_area_frac, dilate, h, w):
    """Persistence count -> text-shaped, dilated binary mask (uint8 0/255)."""
    need = max(1, int(round(persist_frac * n_frames)))
    binary = (count >= need).astype(np.uint8)
    if not binary.any():
        return binary * 255

    # Keep only glyph-shaped components (drops any persistent bright blob that's
    # too tall/large to be text, e.g. a static bright building or sky patch).
    max_h = max_h_frac * h
    max_area = max_area_frac * h * w
    num, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    keep = np.zeros_like(binary)
    for i in range(1, num):
        ch, area = stats[i, cv2.CC_STAT_HEIGHT], stats[i, cv2.CC_STAT_AREA]
        if area >= 6 and ch <= max_h and area <= max_area:
            keep[labels == i] = 255
    if dilate > 0 and keep.any():
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate, dilate))
        keep = cv2.dilate(keep, k, iterations=1)
    return keep


def shot_of(frame_idx, ranges, ptr):
    """Advance ptr so ranges[ptr] contains frame_idx (frames read in order)."""
    while ptr < len(ranges) - 1 and frame_idx >= ranges[ptr][1]:
        ptr += 1
    return ptr


def compute_masks(path, ranges, band, v_min, s_max, persist_frac, max_h_frac, max_area_frac, dilate, h, w):
    """Pass 1: accumulate per-shot persistence counts -> one mask per shot."""
    counts = [np.zeros((h, w), np.uint16) for _ in ranges]
    lengths = [0] * len(ranges)
    cap = cv2.VideoCapture(path)
    n, ptr = 0, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        ptr = shot_of(n, ranges, ptr)
        counts[ptr] += bright_in_band(frame, band, v_min, s_max)
        lengths[ptr] += 1
        n += 1
    cap.release()
    masks = []
    for k, c in enumerate(counts):
        m = finalize_mask(c, max(1, lengths[k]), persist_frac, max_h_frac, max_area_frac, dilate, h, w)
        masks.append(m)
        cov = float((m > 0).mean()) * 100
        log(f"  shot {k+1}/{len(ranges)} frames {ranges[k][0]}-{ranges[k][1]}: mask {cov:.2f}%"
            + ("  (no caption found)" if not m.any() else ""))
    return masks


def erase(path, out_path, band, v_min, s_max, persist_frac, dilate, radius, method, max_h_frac, max_area_frac):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    cap.release()

    ranges = detect_shots(path, total, fps)
    log(f"{len(ranges)} shot(s); computing persistence masks (persist>={persist_frac})...")
    masks = compute_masks(path, ranges, band, v_min, s_max, persist_frac, max_h_frac, max_area_frac, dilate, h, w)

    flag = cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS
    ff = ffmpeg_exe()
    cmd = [
        ff, "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
        "-i", path,
        "-map", "0:v:0", "-map", "1:a:0?",
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-movflags", "+faststart", "-shortest", str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    cap = cv2.VideoCapture(path)
    n, ptr = 0, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        ptr = shot_of(n, ranges, ptr)
        m = masks[ptr]
        out = cv2.inpaint(frame, m, radius, flag) if m.any() else frame
        proc.stdin.write(out.astype(np.uint8).tobytes())
        n += 1
        if total and n % 60 == 0:
            log(f"  inpaint {n}/{total}")
    cap.release()
    proc.stdin.close()
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"ffmpeg encode failed (rc={rc})")
    log(f"DONE: {n} frames -> {out_path}")


def preview(path, at_sec, band, v_min, s_max, persist_frac, dilate, radius, method, max_h_frac, max_area_frac):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    cap.release()
    at_frame = int(at_sec * fps)

    ranges = detect_shots(path, total, fps)
    ptr = shot_of(at_frame, ranges, 0)
    s, e = ranges[ptr]

    # accumulate persistence over just this shot
    count = np.zeros((h, w), np.uint16)
    length = 0
    cap = cv2.VideoCapture(path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, s)
    target = None
    for n in range(s, e):
        ok, frame = cap.read()
        if not ok:
            break
        count += bright_in_band(frame, band, v_min, s_max)
        length += 1
        if n == at_frame:
            target = frame
    cap.release()
    if target is None:
        raise RuntimeError(f"could not read frame at {at_sec}s")

    mask = finalize_mask(count, length, persist_frac, max_h_frac, max_area_frac, dilate, h, w)
    flag = cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS
    result = cv2.inpaint(target, mask, radius, flag) if mask.any() else target

    overlay = target.copy()
    overlay[mask > 0] = (0, 0, 255)
    blend = cv2.addWeighted(target, 0.5, overlay, 0.5, 0)
    H = 720
    fit = lambda img: cv2.resize(img, (int(img.shape[1] * H / img.shape[0]), H))
    strip = cv2.hconcat([fit(target), fit(blend), fit(result)])
    out = Path(f"_preview_{Path(path).stem}_{int(at_sec)}s.png")
    cv2.imwrite(str(out), strip)
    cov = float((mask > 0).mean()) * 100
    log(f"preview shot {ptr+1} (frames {s}-{e}, {length} frames) @ {at_sec}s -> {out}"
        f"  | mask {cov:.2f}%  | left=orig, mid=mask, right=result")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Erase burned-in captions via shot-persistence inpainting.")
    ap.add_argument("input")
    ap.add_argument("--out", help="output file (default: <input>_clean.mp4)")
    ap.add_argument("--preview", type=float, metavar="SEC",
                    help="write a before/mask/after PNG for the shot at SEC and exit")
    ap.add_argument("--band", type=float, nargs=2, default=[0.55, 0.88], metavar=("TOP", "BOT"),
                    help="vertical search region as height fractions (default 0.55 0.88)")
    ap.add_argument("--persist", type=float, default=0.5, dest="persist_frac",
                    help="fraction of a shot's frames a pixel must be white to count as caption (default 0.5)")
    ap.add_argument("--v-min", type=int, default=190, help="min brightness 0-255 (default 190)")
    ap.add_argument("--s-max", type=int, default=60, help="max saturation 0-255 (default 60)")
    ap.add_argument("--dilate", type=int, default=5, help="mask dilation px to cover edges/shadow (default 5)")
    ap.add_argument("--radius", type=int, default=5, help="inpaint radius px (default 5)")
    ap.add_argument("--method", choices=["telea", "ns"], default="telea", help="inpaint algorithm (default telea)")
    ap.add_argument("--max-h", type=float, default=0.06, dest="max_h_frac",
                    help="drop persistent blobs taller than this fraction of frame height (default 0.06)")
    ap.add_argument("--max-area", type=float, default=0.006, dest="max_area_frac",
                    help="drop persistent blobs larger than this fraction of frame area (default 0.006)")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        log(f"input not found: {src}")
        return 2
    band = (args.band[0], args.band[1])

    if args.preview is not None:
        preview(str(src), args.preview, band, args.v_min, args.s_max, args.persist_frac,
                args.dilate, args.radius, args.method, args.max_h_frac, args.max_area_frac)
        return 0

    out_path = Path(args.out) if args.out else src.with_name(src.stem + "_clean.mp4")
    erase(str(src), out_path, band, args.v_min, args.s_max, args.persist_frac,
          args.dilate, args.radius, args.method, args.max_h_frac, args.max_area_frac)
    print(str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
