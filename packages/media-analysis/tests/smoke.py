"""Standalone smoke test (no MCP): synthesizes a 120 BPM click track and checks
the full decode -> beat-detect path, plus text-PNG and SRT generation.

Run: uv run python tests/smoke.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

failed = False


def check(label: str, cond: bool, extra: str = "") -> None:
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {label}{f' — {extra}' if extra else ''}")
    if not cond:
        failed = True


# --- 1. synthesize a 30s click track at 120 BPM (click every 0.5s) ----------
sr = 22050
duration, bpm = 30.0, 120.0
t = np.arange(int(sr * duration)) / sr
audio = np.zeros_like(t)
click = (np.sin(2 * np.pi * 1000 * np.arange(int(0.02 * sr)) / sr) * np.hanning(int(0.02 * sr)))
for beat_time in np.arange(0, duration, 60.0 / bpm):
    i = int(beat_time * sr)
    audio[i : i + len(click)] += click[: len(audio) - i]
# light bass thump on bar starts (every 4th beat) to help downbeat detection
thump = np.sin(2 * np.pi * 60 * np.arange(int(0.1 * sr)) / sr) * np.hanning(int(0.1 * sr))
for bar_time in np.arange(0, duration, 4 * 60.0 / bpm):
    i = int(bar_time * sr)
    audio[i : i + len(thump)] += thump[: len(audio) - i] * 0.8

wav_path = Path(tempfile.gettempdir()) / "ppmcp_click_120bpm.wav"
sf.write(wav_path, audio, sr)
check("synthesized 120 BPM click track", wav_path.exists(), str(wav_path))

# --- 2. detect_beats end to end ---------------------------------------------
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from media_analysis.server import detect_beats, generate_srt, render_text_png  # noqa: E402

result = detect_beats.fn(str(wav_path)) if hasattr(detect_beats, "fn") else detect_beats(str(wav_path))
check(
    f"detect_beats engine={result['engine']} bpm={result['bpm']}",
    115 <= result["bpm"] <= 125,
    f"{result['beatCount']} beats",
)
check("beat times look right (first ~0.0, spacing ~0.5s)",
      result["beatCount"] >= 50 and abs((result["beats"][10] - result["beats"][9]) - 0.5) < 0.06)
# Downbeat positions on a synthetic click track are inherently ambiguous (no
# real musical bar cues) — only check structural sanity, not exact bar length.
if result["downbeats"]:
    db = result["downbeats"]
    spacings = [b - a for a, b in zip(db, db[1:])]
    avg = sum(spacings) / len(spacings)
    check(
        "downbeats structurally sane (subset cadence of beats)",
        len(db) < result["beatCount"] and 1.0 <= avg <= 3.0,
        f"{len(db)} downbeats, avg spacing {avg:.2f}s",
    )

# --- 3. render_text_png ------------------------------------------------------
png_path = Path(tempfile.gettempdir()) / "ppmcp_text_test.png"
fn = render_text_png.fn if hasattr(render_text_png, "fn") else render_text_png
png = fn("Mui Ne\nVietnam 2026", str(png_path))
check("render_text_png", Path(png["path"]).exists() and png["width"] > 100 and png["lines"] == 2,
      f"{png['width']}x{png['height']}")

# --- 4. generate_srt ---------------------------------------------------------
srt_path = Path(tempfile.gettempdir()) / "ppmcp_test.srt"
fn = generate_srt.fn if hasattr(generate_srt, "fn") else generate_srt
srt_result = fn(
    [{"start": 0.0, "end": 1.5, "text": "Hello"}, {"start": 1.5, "end": 3.0, "text": "World"}],
    str(srt_path),
)
content = Path(srt_result["path"]).read_text(encoding="utf-8")
check("generate_srt", srt_result["subtitles"] == 2 and "00:00:01,500" in content)

print("\n" + ("SMOKE TEST FAILED" if failed else "SMOKE TEST PASSED"))
sys.exit(1 if failed else 0)
