"""Standalone smoke test for fetch_stock_videos (hits the real Pexels/Pixabay
APIs — needs PEXELS_API_KEY and/or PIXABAY_API_KEY in the env).

Fetches a few queries, then checks each downloaded clip: exists, is long enough,
and has NO audio stream (the whole point — stock audio must never reach A1).

Run: PEXELS_API_KEY=... PIXABAY_API_KEY=... uv run python tests/stock_smoke.py
     (PowerShell: $env:PEXELS_API_KEY="..."; uv run python tests/stock_smoke.py)
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from media_analysis.audio import _ffmpeg_exe  # noqa: E402
from media_analysis.stock import fetch_stock_videos  # noqa: E402

failed = False


def check(label: str, cond: bool, extra: str = "") -> None:
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {label}{f' — {extra}' if extra else ''}")
    if not cond:
        failed = True


def has_audio_stream(path: str) -> bool:
    """ffmpeg writes stream info to stderr; look for an Audio stream line."""
    proc = subprocess.run([_ffmpeg_exe(), "-i", path], capture_output=True, text=True)
    return "Audio:" in (proc.stderr or "")


if not (os.environ.get("PEXELS_API_KEY") or os.environ.get("PIXABAY_API_KEY")):
    print("SKIP — set PEXELS_API_KEY and/or PIXABAY_API_KEY to run this smoke test")
    sys.exit(0)

MIN_DURATION = 3.0
queries = [
    {"key": "L0", "query": "autumn leaves falling"},
    {"key": "L1", "query": "city street rain night"},
    {"key": "L1dupe", "query": "city street rain night"},  # dedup: should reuse L1's file
]
out_dir = str(Path(tempfile.gettempdir()) / "ppmcp_stock_smoke")

res = fetch_stock_videos(queries, out_dir, orientation="portrait", min_duration=MIN_DURATION)
results = res["results"]
check("got a result per query", len(results) == len(queries), f"{len(results)} results")

by_key = {r["key"]: r for r in results}
for key in ("L0", "L1"):
    r = by_key.get(key, {})
    ok = "path" in r and Path(r.get("path", "")).exists()
    check(f"{key}: downloaded ({r.get('provider', '?')})", ok, r.get("error") or r.get("path", ""))
    if ok:
        check(f"{key}: duration >= {MIN_DURATION}s", r["durationSeconds"] >= MIN_DURATION,
              f"{r['durationSeconds']}s {r['width']}x{r['height']}")
        check(f"{key}: audio stripped (no audio stream)", not has_audio_stream(r["path"]))
        check(f"{key}: portrait orientation", r["height"] >= r["width"],
              f"{r['width']}x{r['height']}")

# dedup: the repeated query should resolve to the SAME file as L1
dup = by_key.get("L1dupe", {})
check("dedup: repeated query reuses the same file",
      dup.get("path") and dup.get("path") == by_key.get("L1", {}).get("path"))

print("\n" + ("STOCK SMOKE TEST FAILED" if failed else "STOCK SMOKE TEST PASSED"))
sys.exit(1 if failed else 0)
