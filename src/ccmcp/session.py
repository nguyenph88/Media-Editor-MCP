"""In-memory draft sessions.

A tool call alone can't hold a live pyCapCut ScriptFile across the many calls that build
a reel, and pyCapCut collects a segment's effects/filters into materials *at add time* —
so effects must be attached before a segment is added. We therefore keep a **declarative
plan** per draft and materialize it into a fresh ScriptFile at save time. Re-saving
rebuilds from the plan, which makes saves naturally idempotent.

The plan is plain dataclasses (JSON-friendly) so it can be inspected and, later, persisted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import pycapcut as cc

from . import draft, effects

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


@dataclass
class TextSpec:
    text: str
    start_us: int
    duration_us: int
    track: Optional[str] = None
    animations: List[AnimSpec] = field(default_factory=list)


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

    def summary(self) -> dict:
        return {
            "name": self.name,
            "resolution": f"{self.width}x{self.height}",
            "fps": self.fps,
            "clips": len(self.clips),
            "audios": len(self.audios),
            "texts": len(self.texts),
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

    # Tracks: one video + one audio + (if needed) one text. First of each type is unnamed.
    script.add_track(cc.TrackType.video)
    if session.audios:
        script.add_track(cc.TrackType.audio)
    if session.texts:
        script.add_track(cc.TrackType.text)

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
        tseg = cc.TextSegment(tx.text, _timerange(tx.start_us, tx.duration_us))
        for a in tx.animations:
            _apply_anim(tseg, a)
        script.add_segment(tseg, tx.track)

    return script


def save(session: DraftSession) -> dict:
    script = materialize(session)
    report = draft.save_draft(script, session.name)
    session.created = True
    report["summary"] = session.summary()
    return report
