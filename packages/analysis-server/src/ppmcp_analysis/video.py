"""Frame-level video scoring for best-moment selection (issue #1).

No OpenCV: frames are decoded by the bundled ffmpeg into a raw grayscale
stream and scored with numpy. Everything is downsampled hard (default 4fps,
96x96, gray) — we are measuring *where the action is*, not making pictures,
and a 30s clip costs ~1MB of buffer this way.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass

import imageio_ffmpeg
import numpy as np

from .audio import log

_ANALYSIS_SIZE = 96  # px, both axes — aspect squish is fine for these metrics


def _ffmpeg() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_duration(file_path: str) -> float:
    """Media duration in seconds via ffmpeg banner (same trick as tests/probe_media.py)."""
    proc = subprocess.run([_ffmpeg(), "-i", file_path], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", proc.stderr)
    if not m:
        raise ValueError(f"Could not read duration of {file_path}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def decode_gray_frames(file_path: str, sample_fps: float) -> np.ndarray:
    """Decode the whole file to a (n, 96, 96) uint8 array at sample_fps."""
    cmd = [
        _ffmpeg(),
        "-i", file_path,
        "-vf", f"fps={sample_fps},scale={_ANALYSIS_SIZE}:{_ANALYSIS_SIZE}",
        "-f", "rawvideo",
        "-pix_fmt", "gray",
        "-v", "error",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        raise ValueError(
            f"ffmpeg decode failed for {file_path}: {proc.stderr.decode(errors='replace')[-400:]}"
        )
    frame_bytes = _ANALYSIS_SIZE * _ANALYSIS_SIZE
    n = len(proc.stdout) // frame_bytes
    return np.frombuffer(proc.stdout[: n * frame_bytes], dtype=np.uint8).reshape(
        n, _ANALYSIS_SIZE, _ANALYSIS_SIZE
    )


@dataclass
class FrameScores:
    """Per-frame raw metrics, aligned to frame i at time i / sample_fps."""

    motion: np.ndarray  # mean |frame diff| vs previous frame (frame 0 copies frame 1's)
    sharpness: np.ndarray  # Laplacian variance
    exposure_ok: np.ndarray  # 0..1, penalizes too dark / blown out / flat


def score_frames(frames: np.ndarray) -> FrameScores:
    f = frames.astype(np.float32)

    diffs = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    motion = np.concatenate([[diffs[0] if len(diffs) else 0.0], diffs])

    # 4-neighbour Laplacian, variance per frame = focus/detail measure
    lap = (
        4.0 * f[:, 1:-1, 1:-1]
        - f[:, :-2, 1:-1]
        - f[:, 2:, 1:-1]
        - f[:, 1:-1, :-2]
        - f[:, 1:-1, 2:]
    )
    sharpness = lap.var(axis=(1, 2))

    mean = f.mean(axis=(1, 2))
    std = f.std(axis=(1, 2))
    # Smooth ramps: full marks for mean in [60, 190], fading to 0 at 20/235;
    # flat frames (std < 10) are near-information-free regardless of mean.
    dark = np.clip((mean - 20.0) / 40.0, 0.0, 1.0)
    bright = np.clip((235.0 - mean) / 45.0, 0.0, 1.0)
    contrast = np.clip(std / 10.0, 0.0, 1.0)
    exposure_ok = dark * bright * contrast

    return FrameScores(motion=motion, sharpness=sharpness, exposure_ok=exposure_ok)


def _normalize(x: np.ndarray) -> np.ndarray:
    """Robust 0-1 normalization within the clip (5th..95th percentile)."""
    lo, hi = np.percentile(x, 5.0), np.percentile(x, 95.0)
    if hi - lo < 1e-6:
        return np.zeros_like(x)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def find_best_windows(
    file_path: str,
    window_seconds: float,
    count: int,
    sample_fps: float,
) -> dict:
    duration = probe_duration(file_path)
    frames = decode_gray_frames(file_path, sample_fps)
    if len(frames) < 2:
        return {
            "durationSeconds": round(duration, 2),
            "windows": [{"start": 0.0, "end": round(duration, 2), "score": 0.0,
                         "motion": 0.0, "sharpness": 0.0, "exposure": 0.0}],
            "note": "clip too short to score; whole clip returned",
        }

    s = score_frames(frames)
    motion_n = _normalize(s.motion)
    sharp_n = _normalize(s.sharpness)
    per_frame = 0.5 * motion_n + 0.3 * sharp_n + 0.2 * s.exposure_ok
    # Hard-gate badly exposed frames: a high-motion black frame is still junk.
    per_frame = per_frame * (0.25 + 0.75 * s.exposure_ok)

    win_frames = max(1, round(window_seconds * sample_fps))
    if win_frames >= len(frames):
        win_scores = np.array([per_frame.mean()])
    else:
        kernel = np.ones(win_frames) / win_frames
        win_scores = np.convolve(per_frame, kernel, mode="valid")

    # Greedy non-overlapping pick, best first.
    order = np.argsort(win_scores)[::-1]
    picked: list[int] = []
    for idx in order:
        if len(picked) >= count:
            break
        if all(abs(idx - p) >= win_frames for p in picked):
            picked.append(int(idx))

    def window_entry(i: int) -> dict:
        start = i / sample_fps
        end = min(start + window_seconds, duration)
        sl = slice(i, i + win_frames)
        return {
            "start": round(start, 2),
            "end": round(end, 2),
            "score": round(float(win_scores[i]), 4),
            "motion": round(float(motion_n[sl].mean()), 4),
            "sharpness": round(float(sharp_n[sl].mean()), 4),
            "exposure": round(float(s.exposure_ok[sl].mean()), 4),
        }

    log(
        f"find_best_windows: {file_path} dur={duration:.1f}s "
        f"frames={len(frames)}@{sample_fps}fps -> {len(picked)} window(s)"
    )
    return {
        "durationSeconds": round(duration, 2),
        "windows": [window_entry(i) for i in picked],
    }
