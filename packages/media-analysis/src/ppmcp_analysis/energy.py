"""Music energy envelope for mapping clip intensity to the timeline (issue #2).

Reels feel right when calm footage sits over calm music and the most kinetic
footage lands on the drop. detect_energy measures a loudness+onset envelope and
reports a 0..1 energy level per beat slot, so /pp-create-reel can rank clips by
motion and assign them to matching slots instead of placing them blindly.
"""

from __future__ import annotations

import numpy as np

from .audio import decode_to_wav, log


def _envelope(y: np.ndarray, sr: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Combined loudness+onset envelope (0..1) and its frame times."""
    import librosa

    # RMS loudness in dB — what "how loud" actually maps to perceptually.
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    rms_db = librosa.power_to_db(rms**2 + 1e-10, ref=np.max)
    rms_n = np.clip((rms_db + 60.0) / 60.0, 0.0, 1.0)  # -60dB..0dB -> 0..1

    # Onset strength — the percussive "busy-ness" that makes a drop feel like one.
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    onset_n = onset / (onset.max() + 1e-10)

    n = min(len(rms_n), len(onset_n))
    env = 0.6 * rms_n[:n] + 0.4 * onset_n[:n]
    times = librosa.frames_to_time(np.arange(n), sr=sr, hop_length=hop)
    return env, times


def detect_energy(file_path: str, slot_boundaries: list[float]) -> dict:
    """Energy level (0..1) for each slot defined by consecutive boundaries.

    slot_boundaries: timeline seconds, e.g. [0, 1.82, 3.54, ..., 59]. Returns
    one level per gap (len-1 values), normalized across the track so the
    quietest slot ~0 and the drop ~1, plus a coarse label per slot.
    """
    import librosa

    wav = decode_to_wav(file_path)
    try:
        y, sr = librosa.load(wav, sr=22050, mono=True)
    finally:
        from pathlib import Path

        Path(wav).unlink(missing_ok=True)

    hop = 512
    env, times = _envelope(y, sr, hop)

    if len(slot_boundaries) < 2:
        return {"slots": [], "note": "need at least 2 boundaries"}

    raw = []
    for a, b in zip(slot_boundaries, slot_boundaries[1:]):
        mask = (times >= a) & (times < b)
        raw.append(float(env[mask].mean()) if mask.any() else 0.0)
    raw = np.array(raw)

    # Normalize across slots (robust 10th..90th pct) so labels are relative to
    # THIS track, not absolute dB — a mellow song still gets a "drop".
    lo, hi = np.percentile(raw, 10.0), np.percentile(raw, 90.0)
    levels = np.clip((raw - lo) / (hi - lo), 0.0, 1.0) if hi - lo > 1e-6 else np.zeros_like(raw)

    def label(x: float) -> str:
        return "calm" if x < 0.34 else "build" if x < 0.67 else "drop"

    slots = [
        {
            "index": i,
            "start": round(float(a), 3),
            "end": round(float(b), 3),
            "energy": round(float(levels[i]), 4),
            "label": label(float(levels[i])),
        }
        for i, (a, b) in enumerate(zip(slot_boundaries, slot_boundaries[1:]))
    ]
    log(
        f"detect_energy: {file_path} {len(slots)} slots, "
        f"calm/build/drop = "
        f"{sum(s['label']=='calm' for s in slots)}/"
        f"{sum(s['label']=='build' for s in slots)}/"
        f"{sum(s['label']=='drop' for s in slots)}"
    )
    return {"slots": slots}
