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


def probe_content_fraction(file_path: str) -> float:
    """Fraction of the padded 320x320 face frame occupied by actual video.

    Vertical 9:16 content fills only ~56% of the square — without this
    correction, face-area scores are silently diluted for the exact footage
    reels are made of.
    """
    proc = subprocess.run([_ffmpeg(), "-i", file_path], capture_output=True, text=True)
    m = re.search(r"Stream .*Video.*?(\d{3,5})x(\d{3,5})", proc.stderr)
    if not m:
        return 1.0
    w, h = int(m.group(1)), int(m.group(2))
    s = _FACE_SIZE / max(w, h)
    return (w * s) * (h * s) / (_FACE_SIZE * _FACE_SIZE)


def decode_gray_frames(file_path: str, sample_fps: float) -> np.ndarray:
    """Decode the whole file to a (n, 96, 96) uint8 array at sample_fps."""
    return _decode(
        file_path,
        f"fps={sample_fps},scale={_ANALYSIS_SIZE}:{_ANALYSIS_SIZE}",
        _ANALYSIS_SIZE,
    )


_FACE_SIZE = 320  # px — faces need real resolution; aspect preserved via padding
_FACE_FPS = 2.0  # face presence changes slowly; half the metric rate is plenty


def decode_face_frames(file_path: str) -> np.ndarray:
    """Decode (n, 320, 320) gray frames at 2fps, aspect-preserved + padded.

    The 96px squished frames are useless for face detection (a face becomes
    ~20 distorted pixels); this second decode keeps geometry intact.
    """
    vf = (
        f"fps={_FACE_FPS},"
        f"scale={_FACE_SIZE}:{_FACE_SIZE}:force_original_aspect_ratio=decrease,"
        f"pad={_FACE_SIZE}:{_FACE_SIZE}:(ow-iw)/2:(oh-ih)/2"
    )
    return _decode(file_path, vf, _FACE_SIZE)


def _decode(file_path: str, vf: str, size: int) -> np.ndarray:
    cmd = [
        _ffmpeg(),
        "-i", file_path,
        "-vf", vf,
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
    frame_bytes = size * size
    n = len(proc.stdout) // frame_bytes
    return np.frombuffer(proc.stdout[: n * frame_bytes], dtype=np.uint8).reshape(n, size, size)


_YUNET_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)


def _yunet_model_path() -> "Path":
    """Lazy-download the YuNet face model (~230KB), like the beat/whisper models."""
    from pathlib import Path
    from urllib.request import urlretrieve

    cache = Path.home() / ".cache" / "ppmcp-analysis"
    cache.mkdir(parents=True, exist_ok=True)
    model = cache / "face_detection_yunet_2023mar.onnx"
    if not model.exists():
        log(f"downloading YuNet face model to {model}")
        urlretrieve(_YUNET_URL, model)
    return model


def face_scores(file_path: str, n_metric_frames: int, sample_fps: float) -> np.ndarray:
    """Per-metric-frame face score in 0..1: detected face area / frame area, scaled.

    YuNet (OpenCV DNN) on 2fps padded frames, mapped onto the sample_fps
    metric timeline. Haar was tried first and rejected: it false-positived on
    landscape texture and missed angled faces. ABSOLUTE (not normalized within
    the clip) on purpose: windows with faces should outrank faceless windows,
    and a clip with no faces gets zeros everywhere — which leaves its internal
    ranking untouched.
    """
    import cv2

    detector = cv2.FaceDetectorYN_create(
        str(_yunet_model_path()), "", (_FACE_SIZE, _FACE_SIZE), score_threshold=0.6
    )
    frames = decode_face_frames(file_path)
    content_area = probe_content_fraction(file_path) * _FACE_SIZE * _FACE_SIZE
    per_face_frame = np.zeros(len(frames), dtype=np.float32)
    for i, frame in enumerate(frames):
        bgr = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
        _, detections = detector.detect(bgr)
        if detections is not None and len(detections):
            area = float(sum(d[2] * d[3] for d in detections))
            # A face filling ~12.5% of the CONTENT (not the padding) -> 1.0
            per_face_frame[i] = min(1.0, 8.0 * area / content_area)

    if not len(per_face_frame):
        return np.zeros(n_metric_frames, dtype=np.float32)
    # Map 2fps detections onto the metric timeline by nearest time.
    metric_t = np.arange(n_metric_frames) / sample_fps
    face_idx = np.clip((metric_t * _FACE_FPS).round().astype(int), 0, len(per_face_frame) - 1)
    return per_face_frame[face_idx]


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
    include_faces: bool = True,
) -> dict:
    duration = probe_duration(file_path)
    frames = decode_gray_frames(file_path, sample_fps)
    if len(frames) < 2:
        return {
            "durationSeconds": round(duration, 2),
            "activityMotion": 0.0,
            "activitySharpness": 0.0,
            "windows": [{"start": 0.0, "end": round(duration, 2), "score": 0.0,
                         "motion": 0.0, "sharpness": 0.0, "exposure": 0.0, "faces": 0.0}],
            "note": "clip too short to score; whole clip returned",
        }

    s = score_frames(frames)
    motion_n = _normalize(s.motion)
    sharp_n = _normalize(s.sharpness)

    faces = np.zeros(len(frames), dtype=np.float32)
    if include_faces:
        try:
            faces = face_scores(file_path, len(frames), sample_fps)
        except Exception as e:  # noqa: BLE001 — cv2 missing/codec oddity: degrade, don't die
            log(f"face scoring failed ({e!r}); continuing without faces")

    per_frame = 0.35 * motion_n + 0.25 * sharp_n + 0.25 * faces + 0.15 * s.exposure_ok
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
            "faces": round(float(faces[sl].mean()), 4),
        }

    log(
        f"find_best_windows: {file_path} dur={duration:.1f}s "
        f"frames={len(frames)}@{sample_fps}fps -> {len(picked)} window(s)"
    )
    return {
        "durationSeconds": round(duration, 2),
        # ABSOLUTE (un-normalized) whole-clip means — comparable ACROSS clips,
        # so callers can rank "how dynamic/sharp is this footage" (e.g. to decide
        # beat-spans). The per-window motion/sharpness above are clip-relative.
        "activityMotion": round(float(s.motion.mean()), 3),
        "activitySharpness": round(float(s.sharpness.mean()), 2),
        "windows": [window_entry(i) for i in picked],
    }
