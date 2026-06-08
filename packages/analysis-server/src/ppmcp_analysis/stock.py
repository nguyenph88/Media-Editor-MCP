"""Stock-video fetch: search Pexels (then Pixabay as fallback), download the best
match per query, and strip audio so it can never stomp the music track on A1.

One batched call handles a whole song's worth of lyric lines — never fire this
per-line as parallel MCP calls (permission-prompt spam). Identical queries are
deduped within a call so a repeated chorus line downloads once and is reused.

Env: PEXELS_API_KEY (required for Pexels), PIXABAY_API_KEY (required for the
Pixabay fallback). Either may be set alone; queries fall through to whichever
provider is configured.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .audio import _ffmpeg_exe, log

PEXELS_SEARCH = "https://api.pexels.com/videos/search"
PIXABAY_SEARCH = "https://pixabay.com/api/videos/"
# Target a vertical reel frame; we score renditions by closeness to this.
_TARGET_W, _TARGET_H = 1080, 1920


def _slug(text: str) -> str:
    """Safe, short filename stem from a query."""
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s or "clip")[:40]


def _orientation_of(w: int, h: int) -> str:
    if h > w:
        return "portrait"
    if w > h:
        return "landscape"
    return "square"


def _pick_pexels(videos: list[dict], orientation: str, min_duration: float) -> dict | None:
    """Choose the best Pexels video + the file rendition closest to the target frame."""
    best: tuple[float, dict, dict] | None = None  # (score, video, file)
    for v in videos:
        if float(v.get("duration", 0)) < min_duration:
            continue
        files = [f for f in v.get("video_files", []) if f.get("link")]
        if not files:
            continue
        # Prefer renditions matching the requested orientation; rank by frame closeness.
        for f in files:
            fw, fh = int(f.get("width") or 0), int(f.get("height") or 0)
            if fw and fh and _orientation_of(fw, fh) != orientation:
                continue
            # Distance from target frame (smaller = better); penalise tiny renders.
            area_gap = abs(fw * fh - _TARGET_W * _TARGET_H)
            small_pen = 1e12 if (fw < 480 or fh < 480) else 0
            score = area_gap + small_pen
            if best is None or score < best[0]:
                best = (score, v, f)
    if best is None:
        return None
    _, video, file = best
    return {
        "provider": "pexels",
        "url": file["link"],
        "duration": float(video.get("duration", 0)),
        "width": int(file.get("width") or 0),
        "height": int(file.get("height") or 0),
        "source": video.get("url", ""),
    }


def _pick_pixabay(hits: list[dict], min_duration: float) -> dict | None:
    """Choose the best Pixabay hit. Pixabay returns fixed renditions per hit; take
    'large' (≈1920) when it carries real dimensions, else 'medium'."""
    for h in hits:
        if float(h.get("duration", 0)) < min_duration:
            continue
        streams = h.get("videos", {})
        for key in ("large", "medium", "small"):
            f = streams.get(key) or {}
            if f.get("url") and int(f.get("width") or 0) and int(f.get("height") or 0):
                return {
                    "provider": "pixabay",
                    "url": f["url"],
                    "duration": float(h.get("duration", 0)),
                    "width": int(f["width"]),
                    "height": int(f["height"]),
                    "source": h.get("pageURL", ""),
                }
    return None


def _search_pexels(query: str, orientation: str, min_duration: float) -> dict | None:
    import requests  # lazy

    key = os.environ.get("PEXELS_API_KEY")
    if not key:
        return None
    resp = requests.get(
        PEXELS_SEARCH,
        params={"query": query, "orientation": orientation, "per_page": 15, "size": "medium"},
        headers={"Authorization": key},
        timeout=30,
    )
    resp.raise_for_status()
    return _pick_pexels(resp.json().get("videos", []), orientation, min_duration)


def _search_pixabay(query: str, orientation: str, min_duration: float) -> dict | None:
    import requests  # lazy

    key = os.environ.get("PIXABAY_API_KEY")
    if not key:
        return None
    resp = requests.get(
        PIXABAY_SEARCH,
        params={"key": key, "q": query, "per_page": 20, "video_type": "film"},
        timeout=30,
    )
    resp.raise_for_status()
    hits = resp.json().get("hits", [])
    # Pixabay has no orientation filter; prefer hits whose 'large' matches our orientation.
    if orientation in ("portrait", "landscape"):
        def ok(h: dict) -> bool:
            f = (h.get("videos", {}) or {}).get("large", {}) or {}
            w, hh = int(f.get("width") or 0), int(f.get("height") or 0)
            return bool(w and hh) and _orientation_of(w, hh) == orientation

        oriented = [h for h in hits if ok(h)]
        if oriented:
            hits = oriented
    return _pick_pixabay(hits, min_duration)


def _download(url: str, dest: Path) -> None:
    import requests  # lazy

    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with dest.open("wb") as fh:
            for chunk in r.iter_content(chunk_size=1 << 16):
                if chunk:
                    fh.write(chunk)


def _strip_audio(src: Path, dest: Path) -> None:
    """Re-mux without audio. Tries stream-copy (fast, lossless); falls back to a
    re-encode if the container/codec won't copy cleanly."""
    ff = _ffmpeg_exe()
    copy_cmd = [ff, "-y", "-i", str(src), "-an", "-c", "copy", str(dest)]
    proc = subprocess.run(copy_cmd, capture_output=True, text=True)
    if proc.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
        return
    log(f"audio-strip copy failed for {src.name}; re-encoding")
    enc_cmd = [ff, "-y", "-i", str(src), "-an", "-c:v", "libx264", "-preset", "veryfast", str(dest)]
    proc = subprocess.run(enc_cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-400:]
        raise RuntimeError(f"ffmpeg audio-strip failed for {src.name}: {tail}")


def fetch_stock_videos(
    queries: list[dict[str, str]],
    out_dir: str,
    orientation: str = "portrait",
    min_duration: float = 3.0,
    strip_audio: bool = True,
) -> dict[str, Any]:
    """Search stock providers and download one matching clip per query.

    queries: [{"key": "L03", "query": "autumn leaves falling porch"}, ...] — `key`
    ties each result back to its lyric line. Searches Pexels first, falls back to
    Pixabay when Pexels has no usable match. Filters to `orientation`
    (portrait = vertical reel) and `duration >= min_duration` (pass longest slot
    + headroom). Audio is stripped by default so stock audio can't land on the
    music track. Identical queries download once and are reused.

    Returns {"outDir", "results": [{"key","query","provider","path",
    "durationSeconds","width","height","source"} | {"key","query","error"}]}.
    """
    if not (os.environ.get("PEXELS_API_KEY") or os.environ.get("PIXABAY_API_KEY")):
        raise RuntimeError(
            "No stock API key set. Export PEXELS_API_KEY and/or PIXABAY_API_KEY "
            "(register them when adding the media-analysis MCP server)."
        )

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="stockdl-"))

    results: list[dict[str, Any]] = []
    by_query: dict[str, dict[str, Any]] = {}  # dedup cache: query -> success result

    for item in queries:
        key = str(item.get("key") or _slug(str(item.get("query", ""))))
        query = str(item.get("query", "")).strip()
        if not query:
            results.append({"key": key, "query": query, "error": "empty query"})
            continue

        # Reuse an already-downloaded identical query (same file, new key).
        if query in by_query:
            prev = by_query[query]
            results.append({**prev, "key": key})
            continue

        try:
            pick = _search_pexels(query, orientation, min_duration) or _search_pixabay(
                query, orientation, min_duration
            )
            if pick is None:
                results.append({"key": key, "query": query, "error": "no match found"})
                continue

            raw = tmp / f"{key}_{_slug(query)}.mp4"
            _download(pick["url"], raw)
            final = out / f"{key}_{_slug(query)}.mp4"
            if strip_audio:
                _strip_audio(raw, final)
                raw.unlink(missing_ok=True)
            else:
                raw.replace(final)

            res = {
                "key": key,
                "query": query,
                "provider": pick["provider"],
                "path": str(final.resolve()),
                "durationSeconds": round(pick["duration"], 3),
                "width": pick["width"],
                "height": pick["height"],
                "source": pick["source"],
            }
            results.append(res)
            by_query[query] = res
        except Exception as e:  # noqa: BLE001 — one bad query shouldn't sink the batch
            log(f"fetch failed for {key!r} ({query!r}): {e!r}")
            results.append({"key": key, "query": query, "error": str(e)})

    return {"outDir": str(out.resolve()), "results": results}
