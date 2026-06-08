"""Harvest a personal effect library from the user's own CapCut drafts + resource cache.

The live catalog (effects.catalog()) already provides ~4400 built-in entries from pycapcut
and flags which resources are cached. This script adds the *personal* layer: which effects
the user has actually applied across their drafts (real, proven-on-disk IDs — including any
custom/VIP ones not in pycapcut's enums), how often, and whether each is cached.

Writes src/ccmcp/effect_library.json. Single local batch pass (no per-file MCP calls).

    PYTHONUTF8=1 .venv/Scripts/python.exe -m ccmcp.harvest
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict

from . import effects, paths

# Which materials arrays hold effect-like entries, and the kind we label them.
_MATERIAL_KEYS = {
    "effects": "filter/adjust",      # CapCut stores filters + adjustments here
    "filters": "filter",
    "video_effects": "video_effect",
    "transitions": "transition",
    "material_animations": "animation",
}


def harvest_used() -> Dict[str, dict]:
    """Scan every draft's draft_content.json for applied effects. Keyed by effect_id."""
    used: Dict[str, dict] = {}
    counts: Dict[str, int] = defaultdict(int)
    root = paths.draft_dir()
    if not root.exists():
        return used

    for draft_folder in root.iterdir():
        content = draft_folder / "draft_content.json"
        if not content.is_file():
            continue
        try:
            data = json.loads(content.read_text(encoding="utf-8"))
        except Exception:
            continue
        mats = data.get("materials", {})
        for key, kind in _MATERIAL_KEYS.items():
            for item in mats.get(key, []) or []:
                eid = str(item.get("effect_id") or "")
                rid = str(item.get("resource_id") or "")
                name = item.get("name") or ""
                if not (eid or name):
                    continue
                ukey = eid or f"name:{name}"
                counts[ukey] += 1
                if ukey not in used:
                    used[ukey] = {
                        "name": name,
                        "effect_id": eid,
                        "resource_id": rid,
                        "kind": kind,
                        "type": item.get("type"),
                        "cached": paths.resource_is_cached(rid),
                    }
    for k, rec in used.items():
        rec["use_count"] = counts[k]
    return used


def build_library() -> dict:
    catalog_by_id = {r["effect_id"]: r for r in effects.catalog() if r["effect_id"]}
    used = harvest_used()
    for rec in used.values():
        rec["in_pycapcut_catalog"] = rec["effect_id"] in catalog_by_id
    return {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "catalog_counts": effects.counts(),
        "cached_resource_count": effects.counts().get("_cached_total", 0),
        "user_used_count": len(used),
        "user_used": sorted(used.values(), key=lambda r: -r["use_count"]),
    }


def main() -> None:
    lib = build_library()
    out = Path(__file__).with_name("effect_library.json")
    out.write_text(json.dumps(lib, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out}")
    print(f"  built-in catalog: {sum(v for k, v in lib['catalog_counts'].items() if not k.startswith('_'))}")
    print(f"  cached locally:   {lib['cached_resource_count']}")
    print(f"  used in your drafts: {lib['user_used_count']}")
    top = lib["user_used"][:8]
    for r in top:
        print(f"   - {r['kind']:>12} | uses={r['use_count']:>2} | cached={r['cached']} | {r['name'] or r['effect_id']}")


if __name__ == "__main__":
    main()
