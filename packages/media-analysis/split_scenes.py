#!/usr/bin/env python
"""Standalone scene splitter — no Premiere, no MCP server required.

Detects scene/shot boundaries in a video (hard cuts and, with a lower
threshold, dissolves) and exports each scene as its own file in an output
folder. Detection uses PySceneDetect (OpenCV backend); splitting calls the
ffmpeg binary bundled with imageio-ffmpeg, so no system ffmpeg is needed.

Examples
--------
  # Preview boundaries only (no files written) — tune the threshold first:
  python split_scenes.py "long.mp4" --list

  # Split into <long>_scenes/ , frame-accurate re-encode (default):
  python split_scenes.py "long.mp4"

  # Fast, lossless, keyframe-snapped cuts (cuts may be a few frames off):
  python split_scenes.py "long.mp4" --copy --out "D:/clips"

  # More sensitive (catch soft dissolves), ignore sub-2s fragments:
  python split_scenes.py "long.mp4" --threshold 18 --min-len 2
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def log(msg: str) -> None:
    print(f"[split-scenes] {msg}", file=sys.stderr, flush=True)


def ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def detect_scenes(path: str, threshold: float, min_len_s: float, detector: str):
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector, AdaptiveDetector

    video = open_video(path)
    fps = float(video.frame_rate)
    min_frames = max(1, int(round(min_len_s * fps)))

    sm = SceneManager()
    if detector == "adaptive":
        # Better on fast camera motion / handheld — fewer false splits.
        sm.add_detector(AdaptiveDetector(adaptive_threshold=threshold, min_scene_len=min_frames))
    else:
        sm.add_detector(ContentDetector(threshold=threshold, min_scene_len=min_frames))

    log(f"detecting scenes (detector={detector}, threshold={threshold}, min_len={min_len_s}s, fps={fps:.3f})...")
    sm.detect_scenes(video, show_progress=True)
    scenes = sm.get_scene_list()

    duration = video.duration.get_seconds() if video.duration else None
    if not scenes:
        # No cut found → whole video is a single scene.
        end = duration if duration else 0.0
        return fps, duration, [(0.0, end)]
    return fps, duration, [(s.get_seconds(), e.get_seconds()) for s, e in scenes]


def split_one(ff: str, src: str, start: float, end: float, out: Path, copy: bool, fps: float) -> None:
    # PySceneDetect's scene `end` is the FIRST frame of the next scene, so cutting
    # the full [start, end) span lets timestamp rounding include that boundary
    # frame as the clip's last frame (a 1-frame "bleed" from the next shot).
    # Trim half a frame off the end: drops the bleed without losing a real frame,
    # and the next clip still starts at `end`, so nothing is lost overall.
    dur = (end - start) - (0.5 / fps if fps > 0 else 0.0)
    if copy:
        # Fast seek before -i, stream copy. Snaps to nearest keyframe at/before start.
        cmd = [ff, "-y", "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
               "-c", "copy", "-avoid_negative_ts", "make_zero", str(out)]
    else:
        # Accurate seek + re-encode. -ss before -i is fast and frame-accurate in modern ffmpeg.
        cmd = [ff, "-y", "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
               "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
               "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-600:]
        raise RuntimeError(f"ffmpeg failed on scene {out.name}: {tail}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Split a video into one file per detected scene.")
    ap.add_argument("input", help="path to the source video")
    ap.add_argument("--out", help="output folder (default: <input>_scenes next to the input)")
    ap.add_argument("--threshold", type=float, default=27.0,
                    help="detector sensitivity; LOWER = more cuts (default 27.0; try ~18 for soft dissolves)")
    ap.add_argument("--min-len", type=float, default=1.0,
                    help="minimum scene length in seconds; avoids tiny fragments (default 1.0)")
    ap.add_argument("--detector", choices=["content", "adaptive"], default="content",
                    help="'content' (default) for clean cuts; 'adaptive' for fast-motion footage")
    ap.add_argument("--copy", action="store_true",
                    help="stream-copy (fast, lossless, keyframe-snapped) instead of frame-accurate re-encode")
    ap.add_argument("--list", action="store_true", dest="list_only",
                    help="detect and print boundaries only; write no files")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        log(f"input not found: {src}")
        return 2

    fps, duration, scenes = detect_scenes(str(src), args.threshold, args.min_len, args.detector)
    log(f"found {len(scenes)} scene(s)" + (f"; duration {duration:.2f}s" if duration else ""))

    out_dir = Path(args.out) if args.out else src.with_name(src.stem + "_scenes")
    ext = src.suffix if args.copy else ".mp4"

    manifest = []
    for i, (start, end) in enumerate(scenes, 1):
        name = f"{src.stem}_scene_{i:03d}{ext}"
        manifest.append({"index": i, "start": round(start, 3), "end": round(end, 3),
                         "duration": round(end - start, 3), "file": name})

    # Always print the plan as JSON to stdout (scriptable / wrappable later).
    summary = {"source": str(src), "fps": round(fps, 3), "duration": round(duration, 3) if duration else None,
               "sceneCount": len(scenes), "outDir": str(out_dir), "mode": "copy" if args.copy else "reencode",
               "scenes": manifest}

    if args.list_only:
        for m in manifest:
            log(f"  scene {m['index']:>3}: {m['start']:>8.2f}s -> {m['end']:>8.2f}s  ({m['duration']:.2f}s)")
        print(json.dumps(summary, indent=2))
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_exe()
    for m in manifest:
        log(f"exporting scene {m['index']}/{len(scenes)} -> {m['file']} ({m['duration']:.2f}s)")
        split_one(ff, str(src), m["start"], m["end"], out_dir / m["file"], args.copy, fps)

    (out_dir / "scenes.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log(f"DONE: {len(scenes)} files in {out_dir}")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
