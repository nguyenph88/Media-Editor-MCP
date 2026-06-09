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


# Default fade animations (CapCut catalog names). Cached: no — CapCut fetches on first open.
_FADE_IN = "渐显"    # text_intro
_FADE_OUT = "渐隐"   # text_outro


def _rgb(color: Any) -> tuple[float, float, float]:
    """Accept '#RRGGBB' / 'RRGGBB' / a name shortcut / an (r,g,b) 0-1 triple -> RGB 0-1 tuple."""
    if isinstance(color, (list, tuple)) and len(color) == 3:
        return (float(color[0]), float(color[1]), float(color[2]))
    s = str(color).strip().lstrip("#")
    named = {"white": "ffffff", "black": "000000", "red": "ff0000",
             "yellow": "ffff00", "gold": "ffd700"}
    s = named.get(s.lower(), s)
    if len(s) == 6:
        return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]
    raise ValueError(f"Bad color {color!r}; use '#RRGGBB' or an (r,g,b) 0-1 triple.")


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
              volume: float = 1.0, beats: list[float] | None = None) -> dict[str, Any]:
    """Add an audio clip (e.g. the music track) to the audio track of the active draft.

    Times in SECONDS. source_start trims into the source (e.g. skip an intro).
    beats (optional): timeline positions in SECONDS to mark as beat markers on the clip
    (the dots CapCut's "Beats" feature draws) — pass detect_beats output so the draft opens
    with beats already marked. Returns the audio index.
    """
    s = session.active()
    s.audios.append(session.AudioSpec(
        path=path, start_us=_us(start), duration_us=_us(duration),
        source_start_us=_us(source_start), volume=volume,
        beats_us=[_us(b) for b in (beats or [])],
    ))
    return {"audioIndex": len(s.audios) - 1, "audios": len(s.audios)}


@mcp.tool()
def add_text(text: str, start: float, duration: float,
             size: float = 8.0, font: str = "", bold: bool = False, italic: bool = False,
             color: str = "#FFFFFF", align: int = 0, alpha: float = 1.0,
             pos_x: Optional[float] = None, pos_y: Optional[float] = None, scale: float = 1.0,
             fade_in: float = 0.0, fade_out: float = 0.0,
             intro: str = "", outro: str = "",
             border: bool = False, border_color: str = "#000000", border_width: float = 40.0,
             wrap: bool = False, max_line_width: float = 0.82,
             track: Optional[str] = None) -> dict[str, Any]:
    """Add a (optionally styled & animated) text overlay to the active draft. Times in SECONDS.

    Typography: size (CapCut font units, ~8 default), font (a font NAME or a .ttf/.otf path; a name
    is resolved to a locally-installed font file, e.g. 'UVN May Chu P' -> UVNMayChuP.TTF, which is
    the only reliable way to render a non-system font; '' = system font), bold, italic,
    color ('#RRGGBB' or a name),
    align (0 left / 1 center / 2 right), alpha (0-1). border draws an outline (border_color/width).
    wrap=True word-wraps long text within max_line_width (0-1 of canvas) — use for line/subtitle captions.
    Position: pos_x/pos_y are normalized 0-1 over the canvas, TOP-LEFT origin (0,0=top-left,
    0.5,0.5=center, 1,1=bottom-right); omit to keep CapCut's centered default. scale resizes the box.
    Entry/exit: fade_in/fade_out are seconds of a fade (渐显/渐隐). For a different look pass intro/
    outro (a text_intro/text_outro name from list_effects, e.g. '放大' zoom) — these override fades;
    their duration uses fade_in/fade_out if given, else the animation default.
    track: optional text-track name; overlays that overlap in time must be on different tracks.
    Returns the text index. NOTE: animations aren't cached locally, so CapCut downloads them on
    first open of the draft.
    """
    s = session.active()
    # Prefer a real local font file (renders reliably); fall back to the catalog name otherwise.
    font_file = draft.resolve_local_font(font) if font else None
    font_catalog = None if (font_file or not font) else font
    anims: list[session.AnimSpec] = []
    intro_name = intro or (_FADE_IN if fade_in > 0 else "")
    if intro_name:
        effects.resolve("text_intro", intro_name)
        anims.append(session.AnimSpec(kind="text_intro", name=intro_name,
                                      duration_us=_us(fade_in) if fade_in > 0 else None))
    outro_name = outro or (_FADE_OUT if fade_out > 0 else "")
    if outro_name:
        effects.resolve("text_outro", outro_name)
        anims.append(session.AnimSpec(kind="text_outro", name=outro_name,
                                      duration_us=_us(fade_out) if fade_out > 0 else None))
    s.texts.append(session.TextSpec(
        text=text, start_us=_us(start), duration_us=_us(duration),
        size=size, font=font_catalog, font_file=font_file, bold=bold, italic=italic,
        color=_rgb(color), align=align, alpha=alpha,
        pos_x=pos_x, pos_y=pos_y, scale=scale, animations=anims, track=track,
        border=border, border_color=_rgb(border_color), border_width=border_width,
        auto_wrap=wrap, max_line_width=max_line_width,
    ))
    return {"textIndex": len(s.texts) - 1, "texts": len(s.texts)}


@mcp.tool()
def add_text_block(lines: List[str], start: float, duration: float,
                   sizes: Optional[List[float]] = None, bold: Optional[List[bool]] = None,
                   stagger: float = 0.45, anchor_x: float = 0.07, anchor_y: float = 0.60,
                   line_gap: float = 0.052, align: int = 0, color: str = "#FFFFFF",
                   intro: str = "放大", intro_dur: float = 0.4,
                   base_size: float = 11.0, emphasis_size: float = 21.0,
                   marker: str = "") -> dict[str, Any]:
    """Build a stacked, staggered, popping-in TEXT BLOCK — the animated lyric/caption look where
    lines appear one after another, stacked, in alternating sizes (like a song-lyric reel).

    Each line becomes its own text overlay on its OWN text track (so they coexist), entering with
    `intro` (a text_intro animation, default '放大' = zoom/pop). Lines appear `stagger` seconds
    apart and all stay until start+duration, then clear together.

    lines: the phrases, top to bottom. sizes/bold: optional per-line overrides (same length as
    lines); by default lines ALTERNATE big-bold (emphasis_size) and small-thin (base_size).
    Layout is normalized 0-1, top-left origin: anchor_x is the left margin, anchor_y the block top;
    line_gap is the vertical step for a base-size line (bigger lines advance proportionally more).
    marker: optional small static label drawn just above the block (e.g. '•••').
    Times in SECONDS. NOTE: the intro animation isn't cached, so CapCut downloads it on first open.
    Returns the text indices created.
    """
    s = session.active()
    if not lines:
        raise ValueError("add_text_block needs at least one line.")
    if intro:
        effects.resolve("text_intro", intro)  # validate once, clear error
    n = len(lines)
    sizes = sizes or [emphasis_size if i % 2 == 0 else base_size for i in range(n)]
    bold = bold or [sz >= emphasis_size for sz in sizes]
    if len(sizes) != n or len(bold) != n:
        raise ValueError("sizes/bold, when given, must match len(lines).")

    block_end = start + duration
    start_idx = len(s.texts)
    indices: list[int] = []

    if marker:
        s.texts.append(session.TextSpec(
            text=marker, start_us=_us(start), duration_us=_us(duration),
            size=base_size * 0.7, bold=True, color=_rgb(color), align=align,
            pos_x=anchor_x, pos_y=max(anchor_y - line_gap * 0.9, 0.0),
            track=f"blk{start_idx}_marker",
        ))
        indices.append(len(s.texts) - 1)

    y = anchor_y
    for i, text in enumerate(lines):
        line_start = start + i * stagger
        anims = [session.AnimSpec(kind="text_intro", name=intro,
                                  duration_us=_us(intro_dur))] if intro else []
        s.texts.append(session.TextSpec(
            text=text, start_us=_us(line_start), duration_us=_us(max(block_end - line_start, 0.1)),
            size=sizes[i], bold=bold[i], color=_rgb(color), align=align,
            pos_x=anchor_x, pos_y=y, animations=anims, track=f"blk{start_idx}_{i}",
        ))
        indices.append(len(s.texts) - 1)
        y += line_gap * (sizes[i] / base_size)  # advance proportional to this line's size

    return {"textIndices": indices, "lines": n, "texts": len(s.texts)}


@mcp.tool()
def add_captions(captions: List[dict], style: str = "lines",
                 font: str = "", size: float = 9.0, color: str = "#FFFFFF",
                 anchor_y: Optional[float] = None, bold: Optional[bool] = None,
                 fade: float = 0.25, intro: str = "放大", intro_dur: float = 0.22,
                 gap_cap: float = 0.6, border: bool = True, border_color: str = "#000000",
                 border_width: float = 50.0, track: str = "captions") -> dict[str, Any]:
    """Lay a transcript onto the timeline as captions — the speech/lyric subtitle workflow.

    captions: a list (in time order) of {"start": sec, "end": sec, "text": str} dicts, optionally
    with "words": [{"start","end","word"}] for karaoke. Feed it the output of a transcription
    (e.g. media-analysis transcribe), whose times are relative to the audio you placed at the
    matching timeline position. CAVEAT: transcription is only accurate on clean speech — sung
    music comes back with right timing but wrong words (fix the text after).

    style:
      'lines'    — one readable line at a time, centered, word-wrapped, lower-third (anchor_y
                   default 0.82), soft fade in/out. The clean subtitle look. Uses the caption text.
      'karaoke'  — one word at a time, centered (anchor_y default 0.52), popping in (intro), from
                   each word's timestamp. Needs per-word timings (falls back to the line if absent).
    Both keep a single caption track (segments don't overlap) and CAP each item so it clears within
    gap_cap seconds of its end — nothing lingers through instrumental/silent gaps.

    font: a font NAME or .ttf/.otf path resolved to a local file (e.g. 'UVN May Chu P _R'); '' =
    system. size/color/border style the text. bold defaults to False for lines, True for karaoke.
    Times in SECONDS. Returns the number of caption segments created."""
    s = session.active()
    caps = [c for c in (captions or []) if str(c.get("text", "")).strip()]
    if not caps:
        raise ValueError("add_captions needs a non-empty captions list with 'text'.")
    if style not in ("lines", "karaoke"):
        raise ValueError("style must be 'lines' or 'karaoke'.")
    ay = anchor_y if anchor_y is not None else (0.82 if style == "lines" else 0.52)
    is_bold = bold if bold is not None else (style == "karaoke")
    before = len(s.texts)

    def _emit(text, start, end, **kw):
        add_text(text, start=start, duration=max(end - start, 0.15), size=size, font=font,
                 bold=is_bold, color=color, align=1, pos_x=0.5, pos_y=ay,
                 border=border, border_color=border_color, border_width=border_width,
                 track=track, **kw)

    if style == "lines":
        n = len(caps)
        for i, c in enumerate(caps):
            start = float(c["start"])
            nxt = float(caps[i + 1]["start"]) if i + 1 < n else start + 3.0
            end = min(nxt - 0.05, float(c.get("end", start + 3.0)) + gap_cap)
            _emit(c["text"], start, end, wrap=True, max_line_width=0.86,
                  fade_in=fade, fade_out=fade * 0.8)
    else:  # karaoke — flatten to words
        words = []
        for c in caps:
            ws = c.get("words") or [{"start": c["start"], "end": c.get("end", c["start"] + 1.0),
                                     "word": c["text"]}]
            words.extend(w for w in ws if str(w.get("word", "")).strip())
        words.sort(key=lambda w: float(w["start"]))
        if intro:
            effects.resolve("text_intro", intro)  # validate once
        m = len(words)
        for i, w in enumerate(words):
            start = float(w["start"])
            nxt = float(words[i + 1]["start"]) if i + 1 < m else start + 1.0
            end = min(nxt - 0.02, float(w.get("end", start + 0.5)) + gap_cap)
            _emit(w["word"].strip(), start, end, intro=intro, fade_in=intro_dur)

    return {"captionsAdded": len(s.texts) - before, "style": style, "texts": len(s.texts)}


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


# ---- adjustment layers (effect/filter on their own track) -----------------------------

@mcp.tool()
def add_filter_layer(name: str, start: float = 0.0, duration: Optional[float] = None,
                     intensity: float = 100.0) -> dict[str, Any]:
    """Add a color filter as its own adjustment layer (a filter track), not attached to one
    clip. It grades every clip beneath it for its time span — the easy-to-track way to apply
    a consistent look. start/duration in SECONDS; duration defaults to the whole timeline.
    name comes from list_filters; intensity is 0-100.
    """
    s = session.active()
    effects.resolve("filter", name)
    start_us = _us(start)
    dur_us = _us(duration) if duration is not None else max(s.timeline_us() - start_us, 0)
    s.filter_layers.append(session.FilterLayer(
        name=name, start_us=start_us, duration_us=dur_us, intensity=intensity,
    ))
    return {"filter_layers": [f.name for f in s.filter_layers]}


@mcp.tool()
def add_effect_layer(name: str, start: float = 0.0, duration: Optional[float] = None,
                     kind: str = "video_effect",
                     params: Optional[List[float]] = None) -> dict[str, Any]:
    """Add a visual effect as its own layer (an effect track), not attached to one clip. It
    applies to everything beneath it for its time span — each layer is a separate row, so
    stack as many as you like. start/duration in SECONDS; duration defaults to the whole
    timeline. name comes from list_effects; kind is video_effect/character_effect; params is
    an optional list of 0-100 effect parameters.
    """
    s = session.active()
    effects.resolve(kind, name)
    start_us = _us(start)
    dur_us = _us(duration) if duration is not None else max(s.timeline_us() - start_us, 0)
    s.effect_layers.append(session.EffectLayer(
        name=name, start_us=start_us, duration_us=dur_us, kind=kind, params=params,
    ))
    return {"effect_layers": [f"{e.kind}:{e.name}" for e in s.effect_layers]}


# ---- persistence ----------------------------------------------------------------------

@mcp.tool()
def save_draft(restart: bool = False) -> dict[str, Any]:
    """Write the active draft to disk (backs up any existing draft_content.json first).

    After this, open the project in CapCut. Warns if CapCut is currently running, since
    it can overwrite on-disk changes when it next saves. Re-running rebuilds from the
    plan (idempotent).

    restart=True: after writing, force-close and relaunch CapCut so its home screen picks
    up this draft (CapCut only re-scans drafts at startup). This force-closes CapCut —
    UNSAVED work in any open project is lost — and reopens to Home, not this draft.
    """
    s = session.active()
    report = session.save(s)
    if restart:
        report["restart"] = draft.restart_capcut()
    elif report.get("capcut_running"):
        report["warning"] = (
            "CapCut appears to be running. Close it before/while editing this draft, "
            "or it may overwrite these changes when it saves. (Pass restart=True, or call "
            "reopen_capcut, to refresh CapCut's home automatically.)"
        )
    return report


@mcp.tool()
def reopen_capcut() -> dict[str, Any]:
    """Force-close and relaunch CapCut so its home screen re-scans the drafts folder and shows
    newly written or changed drafts. This is the only way to surface offline edits without
    manually closing/opening — CapCut reads its draft catalog only at startup and offers no
    live-refresh API. WARNING: this force-closes CapCut (unsaved work in any open project is
    lost) and reopens to Home (it can't deep-link to a specific draft)."""
    return draft.restart_capcut()


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
        "filter_layers": [
            {"name": f.name, "start": f.start_us / SEC, "duration": f.duration_us / SEC,
             "intensity": f.intensity}
            for f in s.filter_layers
        ],
        "effect_layers": [
            {"name": e.name, "kind": e.kind, "start": e.start_us / SEC,
             "duration": e.duration_us / SEC}
            for e in s.effect_layers
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
