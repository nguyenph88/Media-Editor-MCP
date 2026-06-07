"""Media-analysis MCP server (stdio).

Heavy models (beat_this, faster-whisper) load lazily on first use and stay
resident for the life of the process — keep this server long-lived.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from . import __version__
from .audio import (
    bpm_from_beats,
    decode_to_wav,
    detect_beats_beat_this,
    detect_beats_librosa,
    log,
)

mcp = FastMCP("media-analysis")


@mcp.tool()
def analysis_health() -> dict[str, Any]:
    """Check the analysis server: version, python, which models are loaded."""
    import sys

    from .audio import _beat_this_model
    from .speech import _whisper_model

    return {
        "version": __version__,
        "python": sys.version.split()[0],
        "beatModelLoaded": _beat_this_model.cache_info().currsize > 0,
        "whisperModelsLoaded": _whisper_model.cache_info().currsize,
    }


@mcp.tool()
def detect_beats(file_path: str, include_downbeats: bool = True) -> dict[str, Any]:
    """Detect musical beats in an audio (or video) file.

    Returns beat times and downbeat times (bar starts) in seconds, plus BPM.
    Works on mp3/wav/m4a/mp4 etc. First-ever call downloads the beat model.
    Use downbeats for cutting on bars (typical for reels), beats for faster cuts.
    """
    wav = decode_to_wav(file_path)
    try:
        engine = "beat_this"
        try:
            beats, downbeats = detect_beats_beat_this(wav)
        except Exception as e:  # noqa: BLE001 — model/install issues fall back
            log(f"beat_this failed ({e!r}); falling back to librosa")
            engine = "librosa"
            _, beats = detect_beats_librosa(wav)
            downbeats = beats[::4]  # assume 4/4 from the first detected beat
        return {
            "engine": engine,
            "bpm": bpm_from_beats(beats),
            "beatCount": len(beats),
            "beats": [round(b, 3) for b in beats],
            "downbeats": [round(d, 3) for d in downbeats] if include_downbeats else [],
        }
    finally:
        Path(wav).unlink(missing_ok=True)


@mcp.tool()
def find_best_moments(
    file_path: str,
    window_seconds: float = 2.0,
    count: int = 3,
    sample_fps: float = 4.0,
    include_faces: bool = True,
) -> dict[str, Any]:
    """Find the most visually interesting moments in a video clip.

    Scores downsampled frames on motion (35%), sharpness (25%), face presence
    (25%, Haar on aspect-preserved frames — faces are what viewers look at)
    and exposure (15%), then returns up to `count` non-overlapping windows of
    `window_seconds`, best first. Face scores are ABSOLUTE, so windows with
    people outrank empty ones. Use the top window's start/end as the
    place_clip slice for that clip — and put the single best moment across
    all clips FIRST in a reel (the hook). ~2s per clip.
    """
    from .video import find_best_windows

    return find_best_windows(file_path, window_seconds, count, sample_fps, include_faces)


@mcp.tool()
def classify_song(file_path: str) -> dict[str, Any]:
    """Classify a song's 'drive' (energetic ↔ cinematic) to set the cutting pace.

    Uses tempo (BPM), onset density and percussive fraction — no genre ML.
    Returns bpm, onsetDensity, percussiveFraction, a 0..1 `drive`, a `mood`
    (energetic | balanced | cinematic) and `recommendedSpanCenter` = the average
    beats-per-clip the edit should aim for (energetic ~1.3 = fast cuts,
    cinematic ~2.5 = clips linger). Per-clip find_best_moments activity then
    distributes individual spans around that center.
    """
    from .song import classify_song as _classify

    return _classify(file_path)


@mcp.tool()
def detect_energy(file_path: str, slot_boundaries: list[float]) -> dict[str, Any]:
    """Measure the music's energy level (0..1) for each timeline slot.

    slot_boundaries: timeline seconds marking slot edges (e.g. the downbeats
    used for a beat-edit, plus the final cut: [0, 1.82, 3.54, ..., 59]).
    Returns one entry per slot with energy 0..1 (normalized across the track)
    and a label calm/build/drop. Use it to place the MOST kinetic footage
    (highest find_best_moments motion) on 'drop' slots and calm clips on
    'calm' slots — the edit then breathes with the music. RMS loudness 60% +
    onset strength 40%.
    """
    from .energy import detect_energy as _detect_energy

    return _detect_energy(file_path, slot_boundaries)


@mcp.tool()
def transcribe(
    file_path: str, model_size: str = "small", word_timestamps: bool = True
) -> dict[str, Any]:
    """Transcribe speech in an audio/video file using faster-whisper (local).

    model_size: tiny | base | small | medium | large-v3 (small = good default).
    Returns segments with start/end times and per-word timestamps for subtitle
    placement. First call with a given size downloads that model.
    """
    wav = decode_to_wav(file_path, sample_rate=16000)
    try:
        from .speech import transcribe_file

        return transcribe_file(wav, model_size, word_timestamps)
    finally:
        Path(wav).unlink(missing_ok=True)


@mcp.tool()
def generate_srt(segments: list[dict[str, Any]], out_path: str) -> dict[str, Any]:
    """Write an .srt subtitle file from transcript segments.

    segments: [{"start": sec, "end": sec, "text": "..."}] (e.g. from transcribe).
    The resulting .srt can be dragged into Premiere Pro to create a native
    caption track (Premiere's plugin API cannot create captions directly).
    """
    import datetime as dt

    import srt as srtlib

    subs = [
        srtlib.Subtitle(
            index=i + 1,
            start=dt.timedelta(seconds=float(s["start"])),
            end=dt.timedelta(seconds=float(s["end"])),
            content=str(s["text"]).strip(),
        )
        for i, s in enumerate(segments)
    ]
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(srtlib.compose(subs), encoding="utf-8")
    return {"path": str(out.resolve()), "subtitles": len(subs)}


@mcp.tool()
def render_text_png(
    text: str,
    out_path: str,
    font_size: int = 72,
    color: str = "#FFFFFF",
    stroke_color: str = "#000000",
    stroke_width: int = 4,
    font_path: str | None = None,
    max_width_px: int = 1600,
) -> dict[str, Any]:
    """Render text to a transparent PNG for use as a Premiere overlay.

    This is the text-overlay workaround: Premiere's plugin API cannot create
    titles, so we render the text as an image, import it, and place it on an
    upper video track. Centered, word-wrapped, with outline stroke.
    """
    from .textpng import render_text_png as render

    return render(
        text=text,
        out_path=out_path,
        font_size=font_size,
        color=color,
        stroke_color=stroke_color,
        stroke_width=stroke_width,
        font_path=font_path,
        max_width_px=max_width_px,
    )


def main() -> None:
    log(f"media-analysis server v{__version__} starting (stdio)")
    mcp.run()


if __name__ == "__main__":
    main()
