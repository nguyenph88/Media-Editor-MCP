"""Audio decoding + beat detection. All heavy imports are lazy."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path


def log(msg: str) -> None:
    """stdout is the MCP transport — log to stderr only."""
    print(f"[analysis] {msg}", file=sys.stderr, flush=True)


def _ffmpeg_exe() -> str:
    import imageio_ffmpeg  # lazy

    return imageio_ffmpeg.get_ffmpeg_exe()


def decode_to_wav(src: str, sample_rate: int = 22050) -> str:
    """Decode any audio/video file to a temp mono WAV. Returns the temp path."""
    src_path = Path(src)
    if not src_path.exists():
        raise FileNotFoundError(f"File not found: {src}")
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    out.close()
    cmd = [
        _ffmpeg_exe(),
        "-y",
        "-i",
        str(src_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        out.name,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        Path(out.name).unlink(missing_ok=True)
        tail = (proc.stderr or "")[-500:]
        raise RuntimeError(f"ffmpeg failed to decode {src_path.name}: {tail}")
    return out.name


@lru_cache(maxsize=1)
def _beat_this_model():
    """beat_this File2Beats, loaded once per process (downloads checkpoint on first ever run)."""
    log("loading beat_this model (first call may download the checkpoint)...")
    from beat_this.inference import File2Beats  # lazy: pulls torch

    model = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
    log("beat_this model ready")
    return model


def detect_beats_beat_this(wav_path: str) -> tuple[list[float], list[float]]:
    """Returns (beats, downbeats) in seconds."""
    f2b = _beat_this_model()
    beats, downbeats = f2b(wav_path)
    return [float(b) for b in beats], [float(d) for d in downbeats]


def detect_beats_librosa(wav_path: str) -> tuple[float, list[float]]:
    """Fallback: returns (bpm, beats). No downbeat info."""
    import librosa  # lazy

    y, sr = librosa.load(wav_path, sr=None, mono=True)
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
    times = librosa.frames_to_time(frames, sr=sr)
    bpm = float(tempo if not hasattr(tempo, "__len__") else tempo[0])
    return bpm, [float(t) for t in times]


def bpm_from_beats(beats: list[float]) -> float:
    """Median inter-beat interval → BPM. Robust against a few missed beats."""
    if len(beats) < 2:
        return 0.0
    intervals = sorted(b - a for a, b in zip(beats, beats[1:]) if b > a)
    if not intervals:
        return 0.0
    median = intervals[len(intervals) // 2]
    return round(60.0 / median, 2) if median > 0 else 0.0
