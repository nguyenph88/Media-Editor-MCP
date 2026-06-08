"""Effect / filter / animation / transition library.

Two merged sources (see plan):
  1. pycapcut's built-in enums — the full catalog (~4400 entries) with effect_id /
     resource_id / display name already mapped. Free and comprehensive.
  2. The user's local resource cache — flags which entries are already downloaded
     (``cached=True`` => guaranteed to render without CapCut fetching anything on open).

The catalog is the lookup table for the list_* / add_* MCP tools. ``resolve()`` turns a
user-supplied name back into the pycapcut enum member needed to apply it.
"""

from __future__ import annotations

import functools
from typing import Dict, List, Optional

import pycapcut as cc

from . import paths

# kind -> pycapcut enum class. These are the categories we expose.
_KINDS: Dict[str, type] = {
    "filter": cc.FilterType,
    "video_effect": cc.VideoSceneEffectType,
    "character_effect": cc.VideoCharacterEffectType,
    "transition": cc.TransitionType,
    "intro": cc.IntroType,
    "outro": cc.OutroType,
    "group_anim": cc.GroupAnimationType,
    "audio_effect": cc.AudioSceneEffectType,
    "text_intro": cc.TextIntro,
    "text_outro": cc.TextOutro,
    "text_loop": cc.TextLoopAnim,
}


def _meta_of(member) -> Optional[object]:
    """The EffectMeta carried by an enum member's value, if any."""
    val = getattr(member, "value", None)
    # EffectMeta has effect_id / resource_id / name; some enums (e.g. MaskType) differ.
    if val is not None and hasattr(val, "effect_id"):
        return val
    return None


@functools.lru_cache(maxsize=1)
def catalog() -> List[dict]:
    """The full merged catalog. Cached for the process lifetime (built once)."""
    records: List[dict] = []
    for kind, enum_cls in _KINDS.items():
        for member in enum_cls:
            meta = _meta_of(member)
            resource_id = str(getattr(meta, "resource_id", "") or "") if meta else ""
            records.append({
                "kind": kind,
                "key": member.name,                       # python identifier used by resolve()
                "name": getattr(meta, "name", member.name) if meta else member.name,
                "effect_id": str(getattr(meta, "effect_id", "") or "") if meta else "",
                "resource_id": resource_id,
                "is_vip": bool(getattr(meta, "is_vip", False)) if meta else False,
                "cached": paths.resource_is_cached(resource_id),
            })
    return records


def search(query: str = "", kind: Optional[str] = None, *, cached_only: bool = False,
           limit: int = 50) -> List[dict]:
    """Search the catalog by case-insensitive substring on name or key.

    cached_only restricts to resources already downloaded locally (guaranteed to render).
    """
    q = (query or "").strip().lower()
    out: List[dict] = []
    for rec in catalog():
        if kind and rec["kind"] != kind:
            continue
        if cached_only and not rec["cached"]:
            continue
        if q and q not in rec["name"].lower() and q not in rec["key"].lower():
            continue
        out.append(rec)
        if len(out) >= limit:
            break
    # Surface guaranteed (cached) and free (non-VIP) results first.
    out.sort(key=lambda r: (not r["cached"], r["is_vip"]))
    return out[:limit]


def resolve(kind: str, name: str):
    """Return the pycapcut enum member for a given kind + name/key.

    Matches the enum key (python identifier) first, then the display name
    (case-insensitive). Raises KeyError with guidance if not found.
    """
    enum_cls = _KINDS.get(kind)
    if enum_cls is None:
        raise KeyError(f"Unknown effect kind '{kind}'. Valid kinds: {sorted(_KINDS)}")
    # Exact key match.
    for member in enum_cls:
        if member.name == name:
            return member
    # Display-name match (case-insensitive).
    low = name.lower()
    for member in enum_cls:
        meta = _meta_of(member)
        if meta and getattr(meta, "name", "").lower() == low:
            return member
    raise KeyError(
        f"No {kind} named '{name}'. Use list_effects/list_filters to find a valid name."
    )


def counts() -> Dict[str, int]:
    """Per-kind catalog sizes (handy for health/diagnostics)."""
    out: Dict[str, int] = {k: 0 for k in _KINDS}
    cached = 0
    for rec in catalog():
        out[rec["kind"]] += 1
        if rec["cached"]:
            cached += 1
    out["_cached_total"] = cached
    return out
