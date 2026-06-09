"""In-memory draft sessions.

A tool call alone can't hold a live pyCapCut ScriptFile across the many calls that build
a reel, and pyCapCut collects a segment's effects/filters into materials *at add time* —
so effects must be attached before a segment is added. We therefore keep a **declarative
plan** per draft and materialize it into a fresh ScriptFile at save time. Re-saving
rebuilds from the plan, which makes saves naturally idempotent.

The plan is plain dataclasses (JSON-friendly) so it can be inspected and, later, persisted.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pycapcut as cc

from . import draft, effects, paths

SEC = 1_000_000  # microseconds per second (CapCut's time unit)

# Animation kind -> resolver kind in effects._KINDS
_ANIM_KINDS = {"intro", "outro", "group_anim"}


@dataclass
class FxSpec:
    kind: str                     # effects._KINDS key: video_effect / character_effect
    name: str
    params: Optional[List[Optional[float]]] = None


@dataclass
class FilterSpec:
    name: str
    intensity: float = 100.0


@dataclass
class AnimSpec:
    kind: str                     # intro / outro / group_anim
    name: str
    duration_us: Optional[int] = None


@dataclass
class TransitionSpec:
    name: str
    duration_us: Optional[int] = None


@dataclass
class EffectLayer:
    """A standalone scene-effect on its own effect track, applied to everything beneath it
    for [start, start+duration). The layer-based alternative to per-clip FxSpec."""
    name: str
    start_us: int
    duration_us: int
    kind: str = "video_effect"    # video_effect / character_effect
    params: Optional[List[Optional[float]]] = None


@dataclass
class FilterLayer:
    """A standalone color filter on its own filter track (an adjustment layer)."""
    name: str
    start_us: int
    duration_us: int
    intensity: float = 100.0


@dataclass
class ClipSpec:
    path: str
    start_us: int
    duration_us: int
    source_start_us: int = 0
    track: Optional[str] = None
    volume: float = 1.0
    effects: List[FxSpec] = field(default_factory=list)
    filters: List[FilterSpec] = field(default_factory=list)
    animations: List[AnimSpec] = field(default_factory=list)
    transition: Optional[TransitionSpec] = None


@dataclass
class AudioSpec:
    path: str
    start_us: int
    duration_us: int
    source_start_us: int = 0
    volume: float = 1.0
    track: Optional[str] = None
    beats_us: List[int] = field(default_factory=list)  # timeline beat marks (microseconds)


@dataclass
class TextSpec:
    text: str
    start_us: int
    duration_us: int
    track: Optional[str] = None
    animations: List[AnimSpec] = field(default_factory=list)
    # Typography
    size: float = 8.0                                 # CapCut font size units
    font: Optional[str] = None                        # cc.FontType key (catalog; often won't render)
    font_file: Optional[str] = None                   # absolute .ttf/.otf path (reliable; injected post-save)
    bold: bool = False
    italic: bool = False
    color: Tuple[float, float, float] = (1.0, 1.0, 1.0)  # RGB 0-1, default white
    alpha: float = 1.0
    align: int = 0                                    # 0 left, 1 center, 2 right
    # Position over the canvas (normalized, top-left origin: 0,0=top-left, 1,1=bottom-right).
    # None keeps CapCut's default (dead center). scale multiplies the whole text box.
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    scale: float = 1.0
    # Optional outline
    border: bool = False
    border_color: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    border_width: float = 40.0
    # Wrapping (for subtitle-style line captions): wrap long text within max_line_width of the canvas.
    auto_wrap: bool = False
    max_line_width: float = 0.82


@dataclass
class DraftSession:
    name: str
    width: int = 1080
    height: int = 1920
    fps: int = 30
    created: bool = False         # True once we've written this folder (we own it)
    clips: List[ClipSpec] = field(default_factory=list)
    audios: List[AudioSpec] = field(default_factory=list)
    texts: List[TextSpec] = field(default_factory=list)
    effect_layers: List[EffectLayer] = field(default_factory=list)
    filter_layers: List[FilterLayer] = field(default_factory=list)

    def timeline_us(self) -> int:
        """End of the last clip on the main track (microseconds)."""
        return max((c.start_us + c.duration_us for c in self.clips), default=0)

    def summary(self) -> dict:
        return {
            "name": self.name,
            "resolution": f"{self.width}x{self.height}",
            "fps": self.fps,
            "clips": len(self.clips),
            "audios": len(self.audios),
            "texts": len(self.texts),
            "effect_layers": len(self.effect_layers),
            "filter_layers": len(self.filter_layers),
            "saved": self.created,
        }


# ---- registry -------------------------------------------------------------------------

_sessions: Dict[str, DraftSession] = {}
_active: Optional[str] = None


def new(name: str, width: int = 1080, height: int = 1920, fps: int = 30) -> DraftSession:
    global _active
    s = DraftSession(name=name, width=width, height=height, fps=fps)
    _sessions[name] = s
    _active = name
    return s


def active() -> DraftSession:
    if _active is None or _active not in _sessions:
        raise RuntimeError("No active draft. Call create_draft first.")
    return _sessions[_active]


def set_active(name: str) -> DraftSession:
    global _active
    if name not in _sessions:
        raise RuntimeError(f"No session named '{name}'. Call create_draft first.")
    _active = name
    return _sessions[name]


# ---- materialization ------------------------------------------------------------------

def _timerange(start_us: int, duration_us: int) -> cc.Timerange:
    return cc.Timerange(int(start_us), int(duration_us))


def _apply_anim(seg, anim: AnimSpec) -> None:
    member = effects.resolve(anim.kind, anim.name)
    if anim.duration_us is not None:
        seg.add_animation(member, anim.duration_us)
    else:
        seg.add_animation(member)


def _build_video_segment(script: cc.ScriptFile, clip: ClipSpec):
    mat = cc.VideoMaterial(clip.path)
    script.add_material(mat)
    seg = cc.VideoSegment(
        mat,
        _timerange(clip.start_us, clip.duration_us),
        source_timerange=_timerange(clip.source_start_us, clip.duration_us),
        volume=clip.volume,
    )
    # Filters / effects / animations / transition must be attached BEFORE add_segment.
    for f in clip.filters:
        seg.add_filter(effects.resolve("filter", f.name), f.intensity)
    for e in clip.effects:
        seg.add_effect(effects.resolve(e.kind, e.name), e.params)
    for a in clip.animations:
        _apply_anim(seg, a)
    if clip.transition is not None:
        member = effects.resolve("transition", clip.transition.name)
        if clip.transition.duration_us is not None:
            seg.add_transition(member, duration=clip.transition.duration_us)
        else:
            seg.add_transition(member)
    return seg


def _resolve_font(name: Optional[str]):
    """cc.FontType member for a key (exact, then case-insensitive). None -> system font."""
    if not name:
        return None
    try:
        return cc.FontType[name]
    except KeyError:
        low = name.lower()
        for m in cc.FontType:
            if m.name.lower() == low:
                return m
        raise KeyError(f"Unknown font '{name}'. Pick a cc.FontType key (e.g. Anton, BebasNeue).")


def _build_text_segment(tx: TextSpec):
    style = cc.TextStyle(
        size=tx.size, bold=tx.bold, italic=tx.italic,
        color=tuple(tx.color), alpha=tx.alpha, align=tx.align,
        auto_wrapping=tx.auto_wrap, max_line_width=tx.max_line_width,
    )
    clip_settings = None
    if tx.pos_x is not None or tx.pos_y is not None or tx.scale != 1.0:
        px = tx.pos_x if tx.pos_x is not None else 0.5
        py = tx.pos_y if tx.pos_y is not None else 0.5
        # Normalized top-left coords -> CapCut transform (origin centre, +x right, +y up,
        # unit = half canvas). So x: 0->-1, 1->+1; y flips because screen-y grows downward.
        clip_settings = cc.ClipSettings(
            transform_x=(px - 0.5) * 2.0, transform_y=(0.5 - py) * 2.0,
            scale_x=tx.scale, scale_y=tx.scale,
        )
    border = cc.TextBorder(color=tuple(tx.border_color), width=tx.border_width) if tx.border else None
    seg = cc.TextSegment(
        tx.text, _timerange(tx.start_us, tx.duration_us),
        font=_resolve_font(tx.font),
        style=style, clip_settings=clip_settings, border=border,
    )
    for a in tx.animations:  # attached BEFORE add_segment (same rule as video)
        _apply_anim(seg, a)
    return seg


def materialize(session: DraftSession) -> cc.ScriptFile:
    """Build a fresh ScriptFile from the plan. Overwrites the draft folder (we own it)."""
    folder = draft.get_folder()
    # Protect the user's own drafts: refuse to clobber a folder we didn't create.
    if not session.created and folder.has_draft(session.name):
        raise FileExistsError(
            f"A CapCut draft named '{session.name}' already exists. "
            f"Choose another name (we won't overwrite drafts we didn't create)."
        )
    script = folder.create_draft(
        session.name, session.width, session.height, session.fps, allow_replace=True
    )

    # Tracks: one video + one audio + one text track per distinct text-track name. CapCut only
    # allows the FIRST track of a type to be unnamed, so name every text track after the first.
    # Stacked/overlapping text (e.g. a lyric block) needs each line on its own track.
    script.add_track(cc.TrackType.video)
    if session.audios:
        script.add_track(cc.TrackType.audio)
    text_track_names: List[Optional[str]] = []
    for tx in session.texts:
        if tx.track not in text_track_names:
            text_track_names.append(tx.track)
    text_track_names.sort(key=lambda n: (n is not None, n))  # None first (the unnamed track)
    for i, tname in enumerate(text_track_names):
        if tname is None:
            script.add_track(cc.TrackType.text)       # only allowed first, hence None sorted ahead
        else:
            script.add_track(cc.TrackType.text, tname)

    for clip in session.clips:
        script.add_segment(_build_video_segment(script, clip), clip.track)

    for au in session.audios:
        amat = cc.AudioMaterial(au.path)
        script.add_material(amat)
        aseg = cc.AudioSegment(
            amat,
            _timerange(au.start_us, au.duration_us),
            source_timerange=_timerange(au.source_start_us, au.duration_us),
            volume=au.volume,
        )
        script.add_segment(aseg, au.track)

    for tx in session.texts:
        script.add_segment(_build_text_segment(tx), tx.track)

    # Standalone adjustment layers: one track per layer so stacked/overlapping effects don't
    # collide (CapCut shows each as its own row above the video). add_effect/add_filter (not
    # add_segment) are the APIs that register the resource into materials. Filters, then effects.
    for i, fl in enumerate(session.filter_layers):
        tname = f"filter_{i}"
        script.add_track(cc.TrackType.filter, tname)
        script.add_filter(
            effects.resolve("filter", fl.name),
            _timerange(fl.start_us, fl.duration_us),
            tname, intensity=fl.intensity,
        )

    for i, el in enumerate(session.effect_layers):
        tname = f"effect_{i}"
        script.add_track(cc.TrackType.effect, tname)
        script.add_effect(
            effects.resolve(el.kind, el.name),
            _timerange(el.start_us, el.duration_us),
            tname, params=el.params,
        )

    return script


# ---- beat markers --------------------------------------------------------------------
# pyCapCut leaves materials.beats empty and exposes no API for it, so we inject the beats
# material directly into the saved JSON. Schema reverse-engineered + confirmed in CapCut 8.x:
# one beats material per audio segment, its id appended to that segment's extra_material_refs;
# user_beats are timeline positions in MICROSECONDS.

def _beats_material(bid: str, beats_us: List[int]) -> dict:
    return {
        "type": "beats", "id": bid,
        "mode": 404, "gear": 404, "gear_count": 0,
        "enable_ai_beats": False,
        "ai_beats": {
            "beat_speed_infos": [], "beats_path": "", "beats_url": "",
            "melody_path": "", "melody_percents": [], "melody_url": "",
        },
        "user_beats": [int(x) for x in beats_us],
        "user_delete_ai_beats": [],
    }


def _inject_beats(content_path: str, audios: List[AudioSpec]) -> int:
    """Post-process the saved draft: attach a beats material to each audio segment that has
    beat marks. Audio-track segments are in the same order as session.audios. Returns count."""
    p = Path(content_path)
    d = json.loads(p.read_text(encoding="utf-8"))
    audio_segs = [seg for tr in d.get("tracks", []) if tr.get("type") == "audio"
                  for seg in tr.get("segments", [])]
    beats_arr = d.setdefault("materials", {}).setdefault("beats", [])
    marked = 0
    for spec, seg in zip(audios, audio_segs):
        if not spec.beats_us:
            continue
        bid = str(uuid.uuid4()).upper()
        beats_arr.append(_beats_material(bid, spec.beats_us))
        seg.setdefault("extra_material_refs", []).append(bid)
        marked += 1
    if marked:
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return marked


# ---- relink cached scene effects -----------------------------------------------------
# pyCapCut writes real local cache paths for filters and transitions, but leaves a
# placeholder path on scene video-effects (materials.video_effects) — so even when the
# resource is already downloaded, CapCut shows a re-download prompt and the effect never
# renders. Point those at the local resource folder, same as filters/transitions get.

_PLACEHOLDER_PREFIX = "##_material_placeholder"


def _cached_resource_path(resource_id: str) -> Optional[str]:
    """The local folder CapCut should load for a downloaded resource (the hash subfolder
    that holds config.json), or None if it isn't cached on disk."""
    if not resource_id:
        return None
    base = paths.effect_cache_dir() / str(resource_id)
    if not base.is_dir():
        return None
    for sub in base.iterdir():
        # Ignore the "<hash>_tmp" download-scratch dirs; the real root has config.json.
        if sub.is_dir() and not sub.name.endswith("_tmp") and (sub / "config.json").is_file():
            return str(sub).replace("\\", "/")
    return None


def _link_cached_effects(content_path: str) -> int:
    """Point cached effect materials at their local resource folder. pyCapCut leaves scene
    video-effects with no usable path (``None``, empty, or a ``##_material_placeholder_…##``
    token), so CapCut shows a re-download prompt and the effect never renders. Any material
    whose resource is downloaded but whose path isn't already a real folder gets relinked.
    Filters/transitions already carry valid paths, so they're skipped. Returns count relinked."""
    p = Path(content_path)
    d = json.loads(p.read_text(encoding="utf-8"))
    fixed = 0
    for arr in d.get("materials", {}).values():
        if not isinstance(arr, list):
            continue
        for m in arr:
            if not isinstance(m, dict):
                continue
            path = m.get("path")
            if isinstance(path, str) and path and not path.startswith(_PLACEHOLDER_PREFIX) \
                    and os.path.isdir(path):
                continue  # already linked to a real local folder
            local = _cached_resource_path(str(m.get("resource_id") or ""))
            if local:
                m["path"] = local
                fixed += 1
    if fixed:
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return fixed


def _relabel_effects_en(content_path: str) -> int:
    """Rename effect/filter materials to their English label (CapCut shows this on the timeline
    row), keeping the CN name in parentheses for cross-reference. Returns count relabeled."""
    p = Path(content_path)
    d = json.loads(p.read_text(encoding="utf-8"))
    done = 0
    for key in ("video_effects", "effects"):
        for m in d.get("materials", {}).get(key, []):
            if not isinstance(m, dict):
                continue
            cn = m.get("name") or ""
            en = effects.english_for(cn)
            if en and " (" not in cn:           # don't double-label on re-save
                m["name"] = f"{en} ({cn})"
                done += 1
    if done:
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return done


def _apply_local_fonts(content_path: str, session: DraftSession) -> int:
    """Point text materials at a real local font file. pyCapCut's FontType writes a catalog id
    + a fake 'C:/<name>.ttf' path that CapCut can't resolve (the font isn't downloaded and there's
    no URL), so it silently falls back to System. CapCut DOES load a font from a valid absolute
    path, so for any text whose spec set font_file we rewrite content.styles[].font.path and the
    material-level font_path to that file. Text materials are in session.texts order. Returns count."""
    specs = session.texts
    if not any(getattr(s, "font_file", None) for s in specs):
        return 0
    p = Path(content_path)
    d = json.loads(p.read_text(encoding="utf-8"))
    mats = d.get("materials", {}).get("texts", [])
    fixed = 0
    for spec, mat in zip(specs, mats):
        if not spec.font_file:
            continue
        path = str(spec.font_file).replace("\\", "/")
        name = Path(path).stem
        try:
            content = json.loads(mat["content"])
        except (KeyError, ValueError):
            continue
        for st in content.get("styles", []):
            st["font"] = {"id": "", "path": path}
        mat["content"] = json.dumps(content, ensure_ascii=False)
        mat["font_path"] = path
        mat["font_name"] = name
        mat["font_title"] = name
        fixed += 1
    if fixed:
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return fixed


def save(session: DraftSession) -> dict:
    script = materialize(session)
    report = draft.save_draft(script, session.name)
    relinked = _link_cached_effects(report["saved"])
    if relinked:
        report["effects_relinked"] = relinked
    fonts = _apply_local_fonts(report["saved"], session)
    if fonts:
        report["local_fonts_applied"] = fonts
    relabeled = _relabel_effects_en(report["saved"])
    if relabeled:
        report["effects_relabeled"] = relabeled
    if any(a.beats_us for a in session.audios):
        report["beats_marked"] = _inject_beats(report["saved"], session.audios)
    session.created = True
    report["summary"] = session.summary()
    return report
