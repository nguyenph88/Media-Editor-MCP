"""CapCut MCP server (stdio).

Builds and edits CapCut drafts on disk by writing draft_content.json (offline, via
pycapcut). CapCut must be CLOSED while writing a draft it has open. Workflow:
  create_draft -> place_clip/add_audio/add_text -> add_filter/add_clip_effect/... -> save_draft
then open the project in CapCut.

Times in tool arguments are in SECONDS (floats); they're converted to CapCut's
microsecond unit internally.
"""

from __future__ import annotations

import sys
from typing import Any, List, Optional

from mcp.server.fastmcp import FastMCP

from . import __version__, draft, effects, session
from .session import SEC

mcp = FastMCP("capcut")


def _us(seconds: float) -> int:
    return int(round(float(seconds) * SEC))


def log(msg: str) -> None:
    print(f"[capcut-mcp] {msg}", file=sys.stderr, flush=True)


# ---- diagnostics ----------------------------------------------------------------------

@mcp.tool()
def cc_health() -> dict[str, Any]:
    """Check the CapCut MCP: version, where it looks for drafts, and the effect catalog size.

    Reports whether the CapCut drafts folder is found and how many effects/filters are
    in the catalog (and how many resources are already cached locally = guaranteed to render).
    """
    from . import paths
    dd = paths.draft_dir()
    return {
        "version": __version__,
        "python": sys.version.split()[0],
        "draftDir": str(dd),
        "draftDirExists": dd.exists(),
        "effectCounts": effects.counts(),
        "capcutRunning": draft.is_capcut_running(),
    }


@mcp.tool()
def list_drafts() -> dict[str, Any]:
    """List existing CapCut drafts (folder names) in the CapCut drafts directory."""
    return {"drafts": draft.list_drafts()}


# ---- effect / filter discovery --------------------------------------------------------

@mcp.tool()
def list_effects(query: str = "", kind: str = "", cached_only: bool = False,
                 limit: int = 40) -> dict[str, Any]:
    """Search CapCut's built-in effect/filter catalog (~4400 entries with IDs).

    kind narrows the category: filter, video_effect, character_effect, transition,
    intro, outro, group_anim, audio_effect, text_intro, text_outro, text_loop.
    Leave kind empty to search all. cached_only=True returns only resources already
    downloaded on this machine (guaranteed to render without CapCut fetching on open).
    Results put cached + non-VIP entries first. Use a returned "name" with add_* tools.
    """
    rows = effects.search(query, kind or None, cached_only=cached_only, limit=limit)
    return {"count": len(rows), "results": rows}


@mcp.tool()
def list_filters(query: str = "", cached_only: bool = False, limit: int = 40) -> dict[str, Any]:
    """Search just the color filters (shortcut for list_effects with kind='filter')."""
    rows = effects.search(query, "filter", cached_only=cached_only, limit=limit)
    return {"count": len(rows), "results": rows}


# ---- draft building -------------------------------------------------------------------

@mcp.tool()
def create_draft(name: str, width: int = 1080, height: int = 1920, fps: int = 30) -> dict[str, Any]:
    """Start a new in-memory draft (default vertical 1080x1920 @30fps) and make it active.

    Nothing is written to disk until save_draft. The draft is materialized under the
    CapCut drafts folder as <name>. Build it with place_clip/add_audio/add_text, decorate
    with add_filter/add_clip_effect/add_animation/apply_transition, then call save_draft.
    """
    s = session.new(name, width, height, fps)
    return {"created": True, "session": s.summary()}


@mcp.tool()
def place_clip(path: str, start: float, duration: float, source_start: float = 0.0,
               volume: float = 1.0) -> dict[str, Any]:
    """Place a video/image clip on the main video track of the active draft.

    start/duration/source_start are in SECONDS. start is the clip's position on the
    timeline; source_start trims into the source media. Main-track clips should tile from
    0s with no gaps. Returns the clip's index, used to attach effects/filters later.
    """
    s = session.active()
    s.clips.append(session.ClipSpec(
        path=path, start_us=_us(start), duration_us=_us(duration),
        source_start_us=_us(source_start), volume=volume,
    ))
    return {"clipIndex": len(s.clips) - 1, "clips": len(s.clips)}


@mcp.tool()
def add_audio(path: str, start: float, duration: float, source_start: float = 0.0,
              volume: float = 1.0) -> dict[str, Any]:
    """Add an audio clip (e.g. the music track) to the audio track of the active draft.

    Times in SECONDS. source_start trims into the source (e.g. skip an intro). Returns
    the audio index.
    """
    s = session.active()
    s.audios.append(session.AudioSpec(
        path=path, start_us=_us(start), duration_us=_us(duration),
        source_start_us=_us(source_start), volume=volume,
    ))
    return {"audioIndex": len(s.audios) - 1, "audios": len(s.audios)}


@mcp.tool()
def add_text(text: str, start: float, duration: float) -> dict[str, Any]:
    """Add a text overlay to the active draft for a time span (SECONDS). Returns its index."""
    s = session.active()
    s.texts.append(session.TextSpec(text=text, start_us=_us(start), duration_us=_us(duration)))
    return {"textIndex": len(s.texts) - 1, "texts": len(s.texts)}


# ---- effects / filters / animations (the headline feature) ----------------------------

@mcp.tool()
def add_filter(clip_index: int, name: str, intensity: float = 100.0) -> dict[str, Any]:
    """Apply a color filter to a clip (the CapCut analogue of a Lumetri look/LUT).

    name is a filter name/key from list_filters. intensity is 0-100. Idempotent per
    filter name on a clip (re-applying updates rather than stacking duplicates).
    """
    s = session.active()
    _check_clip(s, clip_index)
    effects.resolve("filter", name)  # validate now for a clear error
    clip = s.clips[clip_index]
    clip.filters = [f for f in clip.filters if f.name != name]
    clip.filters.append(session.FilterSpec(name=name, intensity=intensity))
    return {"clipIndex": clip_index, "filters": [f.name for f in clip.filters]}


@mcp.tool()
def add_clip_effect(clip_index: int, name: str, kind: str = "video_effect",
                    params: Optional[List[float]] = None) -> dict[str, Any]:
    """Apply a visual effect (glitch, blur, light leak, shake, VHS, ...) to a clip.

    kind is video_effect (scene effects, default) or character_effect. name comes from
    list_effects. params is an optional list of 0-100 effect parameters (effect-specific).
    Idempotent per effect name on a clip.
    """
    s = session.active()
    _check_clip(s, clip_index)
    effects.resolve(kind, name)
    clip = s.clips[clip_index]
    clip.effects = [e for e in clip.effects if not (e.kind == kind and e.name == name)]
    clip.effects.append(session.FxSpec(kind=kind, name=name, params=params))
    return {"clipIndex": clip_index, "effects": [f"{e.kind}:{e.name}" for e in clip.effects]}


@mcp.tool()
def add_animation(clip_index: int, name: str, kind: str = "intro",
                  duration: Optional[float] = None) -> dict[str, Any]:
    """Add an in/out/loop animation to a clip.

    kind is intro, outro, or group_anim. name comes from list_effects (with that kind).
    duration in SECONDS (optional; uses the animation's default if omitted). A clip keeps
    at most one animation per kind.
    """
    s = session.active()
    _check_clip(s, clip_index)
    effects.resolve(kind, name)
    clip = s.clips[clip_index]
    clip.animations = [a for a in clip.animations if a.kind != kind]
    clip.animations.append(session.AnimSpec(
        kind=kind, name=name, duration_us=_us(duration) if duration is not None else None,
    ))
    return {"clipIndex": clip_index, "animations": [f"{a.kind}:{a.name}" for a in clip.animations]}


@mcp.tool()
def apply_transition(clip_index: int, name: str, duration: Optional[float] = None) -> dict[str, Any]:
    """Set the transition that follows a clip (into the next one).

    name comes from list_effects with kind='transition'. duration in SECONDS (optional).
    """
    s = session.active()
    _check_clip(s, clip_index)
    effects.resolve("transition", name)
    s.clips[clip_index].transition = session.TransitionSpec(
        name=name, duration_us=_us(duration) if duration is not None else None,
    )
    return {"clipIndex": clip_index, "transition": name}


# ---- persistence ----------------------------------------------------------------------

@mcp.tool()
def save_draft() -> dict[str, Any]:
    """Write the active draft to disk (backs up any existing draft_content.json first).

    After this, open the project in CapCut. Warns if CapCut is currently running, since
    it can overwrite on-disk changes when it next saves. Re-running rebuilds from the
    plan (idempotent).
    """
    s = session.active()
    report = session.save(s)
    if report.get("capcut_running"):
        report["warning"] = (
            "CapCut appears to be running. Close it before/while editing this draft, "
            "or it may overwrite these changes when it saves."
        )
    return report


@mcp.tool()
def draft_status() -> dict[str, Any]:
    """Show the active draft's current plan (clips, audio, texts, and their effects)."""
    s = session.active()
    return {
        "session": s.summary(),
        "clips": [
            {
                "index": i, "path": c.path,
                "start": c.start_us / SEC, "duration": c.duration_us / SEC,
                "filters": [f.name for f in c.filters],
                "effects": [f"{e.kind}:{e.name}" for e in c.effects],
                "animations": [f"{a.kind}:{a.name}" for a in c.animations],
                "transition": c.transition.name if c.transition else None,
            }
            for i, c in enumerate(s.clips)
        ],
    }


def _check_clip(s: session.DraftSession, idx: int) -> None:
    if idx < 0 or idx >= len(s.clips):
        raise IndexError(f"clip_index {idx} out of range (0..{len(s.clips) - 1}). "
                         f"Place clips with place_clip first.")


def main() -> None:
    # Windows consoles default to cp1252; effect names contain non-ASCII. Force UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass
    log(f"capcut server v{__version__} starting (stdio)")
    mcp.run()


if __name__ == "__main__":
    main()
