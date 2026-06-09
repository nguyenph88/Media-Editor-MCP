"""Transcription via faster-whisper. Models cached per size, loaded lazily."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from .audio import log


@lru_cache(maxsize=2)
def _whisper_model(size: str):
    log(f"loading faster-whisper '{size}' (first ever call downloads the model)...")
    from faster_whisper import WhisperModel  # lazy

    model = WhisperModel(size, device="cpu", compute_type="int8")
    log(f"whisper '{size}' ready")
    return model


def transcribe_file(path: str, model_size: str, word_timestamps: bool) -> dict[str, Any]:
    model = _whisper_model(model_size)
    segments_iter, info = model.transcribe(path, word_timestamps=word_timestamps)

    segments: list[dict[str, Any]] = []
    for seg in segments_iter:
        item: dict[str, Any] = {
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
        }
        if word_timestamps and seg.words:
            item["words"] = [
                {"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)}
                for w in seg.words
            ]
        segments.append(item)

    return {
        "language": info.language,
        "languageProbability": round(info.language_probability, 3),
        "durationSeconds": round(info.duration, 3),
        "segments": segments,
    }
