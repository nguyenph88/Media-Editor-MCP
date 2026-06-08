"""End-to-end smoke test — builds a tiny draft and validates the JSON. No CapCut needed.

Writes into a TEMP draft dir (never the real CapCut folder) via CAPCUT_DRAFT_DIR, using a
small bundled image as a clip and a stdlib-generated WAV as audio. Run:

    PYTHONUTF8=1 .venv/Scripts/python.exe tests/smoke.py
"""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import tempfile
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ASSETS = REPO / "tests" / "assets"


def _make_wav(path: Path, seconds: float = 3.0, freq: float = 440.0, rate: int = 44100) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        for i in range(int(seconds * rate)):
            val = int(32767 * 0.2 * math.sin(2 * math.pi * freq * i / rate))
            w.writeframes(struct.pack("<h", val))


def _find_test_image() -> Path:
    """Use a bundled image if present, else borrow a small CapCut draft cover."""
    bundled = ASSETS / "test.jpg"
    if bundled.exists():
        return bundled
    local = os.environ.get("LOCALAPPDATA", "")
    root = Path(local) / "CapCut" / "User Data" / "Projects" / "com.lveditor.draft"
    if root.exists():
        for cover in root.glob("*/draft_cover.jpg"):
            if cover.stat().st_size < 20 * 1024 * 1024:
                ASSETS.mkdir(parents=True, exist_ok=True)
                shutil.copy2(cover, bundled)
                return bundled
    raise FileNotFoundError("No test image available; place a small jpg at tests/assets/test.jpg")


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="ccmcp_smoke_"))
    os.environ["CAPCUT_DRAFT_DIR"] = str(tmp)

    # Import AFTER setting the env override so paths.draft_dir() picks it up.
    from ccmcp import effects, session

    img = _find_test_image()
    wav = ASSETS / "test.wav"
    _make_wav(wav, seconds=3.0)

    # Pick a guaranteed-resolvable filter/effect/transition by enum key.
    import pycapcut as cc
    filt = list(cc.FilterType)[0].name
    fx = list(cc.VideoSceneEffectType)[0].name
    trans = list(cc.TransitionType)[0].name
    intro = list(cc.IntroType)[0].name

    s = session.new("ccmcp_smoke", 1080, 1920, 30)
    s.clips.append(session.ClipSpec(path=str(img), start_us=0, duration_us=3 * session.SEC))
    s.clips[0].filters.append(session.FilterSpec(name=filt, intensity=80))
    s.clips[0].effects.append(session.FxSpec(kind="video_effect", name=fx))
    s.clips[0].animations.append(session.AnimSpec(kind="intro", name=intro))
    s.clips[0].transition = session.TransitionSpec(name=trans)
    s.audios.append(session.AudioSpec(path=str(wav), start_us=0, duration_us=3 * session.SEC))
    s.texts.append(session.TextSpec(text="Hello CapCut", start_us=0, duration_us=2 * session.SEC))

    report = session.save(s)
    content_path = Path(report["saved"])
    assert content_path.exists(), "draft_content.json was not written"

    d = json.loads(content_path.read_text(encoding="utf-8"))
    mats = d["materials"]
    checks = {
        "videos": len(mats.get("videos", [])),
        "audios": len(mats.get("audios", [])),
        "texts": len(mats.get("texts", [])),
        "filters(effects)": len(mats.get("effects", [])),
        "video_effects": len(mats.get("video_effects", [])),
        "transitions": len(mats.get("transitions", [])),
        "material_animations": len(mats.get("material_animations", [])),
        "tracks": len(d.get("tracks", [])),
        "app_source": d.get("platform", {}).get("app_source"),
    }
    print("draft written to:", content_path)
    print("validation:", json.dumps(checks, ensure_ascii=False))
    assert checks["videos"] >= 1 and checks["audios"] >= 1, "missing media"
    assert checks["transitions"] >= 1 and checks["video_effects"] >= 1, "effects not registered"
    assert checks["app_source"] == "cc", "wrong app_source"
    print("catalog cached locally:", effects.counts()["_cached_total"])
    print("SMOKE OK")

    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
