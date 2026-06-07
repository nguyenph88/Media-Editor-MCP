"""Classify a song's 'drive' (energetic ↔ cinematic) to pick a cutting pace.

No genre-label ML — three cheap, defensible audio features separate a punchy
dance track from a mellow ballad well enough to set the edit's cutting pace:
  - tempo (BPM): faster = more energetic
  - onset density (rhythmic events / second): busier = more energetic
  - percussive fraction (HPSS): beat-driven vs. ambient/harmonic

The result recommends an average beat-span per clip: energetic songs cut fast
(clips ~1 beat), cinematic songs let clips linger (~2-3 beats). Per-clip
activity (find_best_moments) then distributes spans around that center.
"""

from __future__ import annotations

from pathlib import Path

from .audio import decode_to_wav, log


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def classify_song(file_path: str) -> dict:
    import librosa
    import numpy as np

    wav = decode_to_wav(file_path)
    try:
        y, sr = librosa.load(wav, sr=22050, mono=True)
    finally:
        Path(wav).unlink(missing_ok=True)

    duration = len(y) / sr

    # Tempo
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(tempo if not hasattr(tempo, "__len__") else tempo[0])

    # Onset density: strong rhythmic events per second
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time", backtrack=False)
    onset_density = len(onsets) / duration if duration > 0 else 0.0

    # Percussive fraction via harmonic/percussive source separation
    y_h, y_p = librosa.effects.hpss(y)
    h_e = float(np.sum(y_h.astype(np.float64) ** 2))
    p_e = float(np.sum(y_p.astype(np.float64) ** 2))
    perc_fraction = p_e / (h_e + p_e + 1e-12)

    # Normalize each to a rough musical range, then blend into a 0..1 "drive".
    bpm_n = _clamp01((bpm - 70.0) / (140.0 - 70.0))      # 70bpm→0, 140bpm→1
    onset_n = _clamp01(onset_density / 4.0)               # ~4 onsets/s = busy
    perc_n = _clamp01((perc_fraction - 0.2) / 0.4)        # 0.2→0, 0.6→1
    drive = 0.4 * bpm_n + 0.35 * onset_n + 0.25 * perc_n

    if drive >= 0.60:
        mood, span_center = "energetic", 1.3
    elif drive <= 0.38:
        mood, span_center = "cinematic", 2.5
    else:
        mood, span_center = "balanced", 1.8

    log(
        f"classify_song: {Path(file_path).name} bpm={bpm:.0f} "
        f"onset/s={onset_density:.2f} perc={perc_fraction:.2f} -> drive={drive:.2f} ({mood})"
    )
    return {
        "bpm": round(bpm, 1),
        "onsetDensity": round(onset_density, 2),
        "percussiveFraction": round(perc_fraction, 3),
        "drive": round(drive, 3),
        "mood": mood,
        # Average beats-per-clip the edit should aim for; per-clip activity
        # shifts individual clips ±1 around this, clamped to [1,3].
        "recommendedSpanCenter": span_center,
    }
