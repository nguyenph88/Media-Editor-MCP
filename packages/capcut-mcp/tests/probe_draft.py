"""Read-only schema probe for a real CapCut draft. Never writes.

Usage:
    PYTHONUTF8=1 .venv/Scripts/python.exe tests/probe_draft.py <draft_name>

Dumps top-level keys, material counts, track types, and a sample effect/filter so you can
see how your installed CapCut version represents things.
"""

from __future__ import annotations

import json
import sys

from ccmcp import paths


def main() -> None:
    if len(sys.argv) < 2:
        names = [p.name for p in paths.draft_dir().iterdir() if p.is_dir()]
        print("Pass a draft name. Available:", ", ".join(sorted(names)[:30]))
        return
    name = sys.argv[1]
    content = paths.draft_content_path(name)
    if not content.exists():
        print("No draft_content.json at", content)
        return

    d = json.loads(content.read_text(encoding="utf-8"))
    print("draft:", name)
    print("app:", d.get("platform", {}).get("app_source"), d.get("platform", {}).get("app_version"))
    print("top-level keys:", len(d.keys()))
    mats = d.get("materials", {})
    nonempty = {k: len(v) for k, v in mats.items() if isinstance(v, list) and v}
    print("materials (non-empty):", json.dumps(nonempty, ensure_ascii=False))
    print("tracks:", [(t.get("type"), len(t.get("segments", []))) for t in d.get("tracks", [])])

    for key in ("effects", "filters", "video_effects", "transitions"):
        arr = mats.get(key) or []
        if arr:
            sample = {k: arr[0].get(k) for k in ("name", "effect_id", "resource_id", "type", "category_name") if k in arr[0]}
            print(f"sample {key}[0]:", json.dumps(sample, ensure_ascii=False)[:300])


if __name__ == "__main__":
    main()
