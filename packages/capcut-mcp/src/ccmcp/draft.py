"""Draft IO: locate, open, create, and safely save CapCut drafts on disk.

Wraps pycapcut's DraftFolder/ScriptFile. The only value this layer adds over pycapcut
is *safety*: a backup of draft_content.json before every overwrite, and a warning when
CapCut appears to be running (it overwrites on-disk changes when it saves).

CapCut must be CLOSED while we write a draft it has open, or our changes are lost.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import List, Optional

from pycapcut import DraftFolder, ScriptFile

from . import paths

BACKUP_SUFFIX = ".ccmcp.bak"  # distinct from CapCut's own ".bak" so we never clobber it


def ensure_audio_only(path: str) -> str:
    """Return a path to an audio-only file for `path`.

    pyCapCut's ``AudioMaterial`` rejects any file that carries a video track (e.g. mp4 music
    files raise "音频素材不应包含视频轨道") and has no extract/detach API. So if `path` has a
    video track, extract its audio to a sidecar ``<stem>.ccmcp-audio.m4a`` next to the source
    (reused if already extracted and at least as new as the source) and return that. Audio-only
    inputs are returned unchanged.
    """
    import pymediainfo  # transitive dep via pyCapCut

    src = Path(path)
    if not src.exists():
        return path  # let AudioMaterial raise its clear FileNotFoundError
    info = pymediainfo.MediaInfo.parse(str(src))
    if not info.video_tracks:
        return path  # already audio-only — nothing to do
    sidecar = src.with_name(f"{src.stem}.ccmcp-audio.m4a")
    if sidecar.exists() and sidecar.stat().st_mtime >= src.stat().st_mtime:
        return str(sidecar)  # reuse a fresh prior extraction
    import imageio_ffmpeg  # bundled ffmpeg binary

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.run(
        [ff, "-y", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "192k", str(sidecar)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not sidecar.exists():
        tail = (proc.stderr or "")[-400:]
        raise RuntimeError(f"Failed to extract audio from {src.name}: {tail}")
    return str(sidecar)


def get_folder() -> DraftFolder:
    """A DraftFolder bound to the user's CapCut drafts directory.

    Raises FileNotFoundError (with a clear message) if the directory is missing.
    """
    d = paths.draft_dir()
    if not d.exists():
        raise FileNotFoundError(
            f"CapCut drafts folder not found at {d}. "
            f"Set CAPCUT_DRAFT_DIR if your install uses a non-default location."
        )
    return DraftFolder(str(d))


def list_drafts() -> List[str]:
    return get_folder().list_drafts()


def is_capcut_running() -> bool:
    """Best-effort check whether CapCut.exe is running (Windows only)."""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq CapCut.exe", "/NH"],
            capture_output=True, text=True, timeout=5,
        )
        return "CapCut.exe" in out.stdout
    except Exception:
        return False


_FONT_DIRS = [
    Path("C:/Windows/Fonts"),
    Path.home() / "AppData/Local/Microsoft/Windows/Fonts",  # per-user installed fonts
]


def resolve_local_font(name: str) -> Optional[str]:
    """Find a real .ttf/.otf on this machine for a font name or path. CapCut renders fonts from
    an absolute file path, so this is the reliable way to set a non-system font (the built-in
    FontType catalog doesn't render — its resources aren't downloaded and carry no URL).

    Accepts a direct file path, or a fuzzy name ('UVN May Chu P' -> UVNMayChuP.TTF): compares
    alphanumerics only, matching when either the query or the file stem is a prefix of the other.
    Prefers an exact match, then the shortest (base, non -Italic/-Bold) variant."""
    if not name:
        return None
    if os.path.isfile(name):
        return name
    q = re.sub(r"[^a-z0-9]", "", name.lower())
    if not q:
        return None
    best = None  # (sort_key, path)
    for d in _FONT_DIRS:
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.suffix.lower() not in (".ttf", ".otf"):
                continue
            stem = re.sub(r"[^a-z0-9]", "", f.stem.lower())
            if stem and (q == stem or q.startswith(stem) or stem.startswith(q)):
                key = (q != stem, len(stem))  # exact first, then shortest stem
                if best is None or key < best[0]:
                    best = (key, str(f))
    return best[1] if best else None


def _capcut_launcher() -> Optional[Path]:
    """A path to launch CapCut: the Start-menu/Desktop .lnk if present, else the bootstrap
    Apps\\CapCut.exe (the stub that opens the current version). None if nothing is found."""
    home = Path.home()
    candidates = [
        home / "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/CapCut/CapCut.lnk",
        home / "Desktop/CapCut.lnk",
        paths.draft_dir().parents[2] / "Apps" / "CapCut.exe",  # .../Local/CapCut/Apps/CapCut.exe
    ]
    return next((p for p in candidates if p.exists()), None)


def stop_capcut() -> bool:
    """Force-close all CapCut.exe processes. Returns True if any were running. Force kill (/F)
    so CapCut can't write its in-memory state back over a draft we just authored on disk."""
    if not is_capcut_running():
        return False
    try:
        subprocess.run(["taskkill", "/F", "/IM", "CapCut.exe", "/T"],
                       capture_output=True, text=True, timeout=15)
    except Exception:
        pass
    return True


def launch_capcut() -> bool:
    """Open CapCut via its launcher (non-blocking). Returns True if a launcher was found."""
    import os
    launcher = _capcut_launcher()
    if launcher is None:
        return False
    try:
        os.startfile(str(launcher))  # type: ignore[attr-defined]  # Windows shell launch, detached
        return True
    except Exception:
        return False


def restart_capcut() -> dict:
    """Force-close CapCut (if running) and relaunch it, so its home screen re-scans the drafts
    folder and shows newly written / changed drafts. CapCut only reads the draft catalog at
    startup, so this restart is the only way to surface offline edits without manual close/open.
    Opens to Home (no per-draft deep link)."""
    was_running = stop_capcut()
    if was_running:
        time.sleep(1.5)  # let file handles release before the new instance starts
    launched = launch_capcut()
    return {"was_running": was_running, "relaunched": launched,
            "launcher_found": _capcut_launcher() is not None}


def backup_content(name: str) -> Optional[Path]:
    """Copy a draft's draft_content.json to a timestamped .ccmcp.bak. Returns the backup path."""
    content = paths.draft_content_path(name)
    if not content.exists():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = content.with_name(f"draft_content.json.{stamp}{BACKUP_SUFFIX}")
    shutil.copy2(content, dest)
    return dest


def create(name: str, width: int = 1080, height: int = 1920, fps: int = 30,
           *, allow_replace: bool = False) -> ScriptFile:
    """Create a new draft (vertical 1080x1920 @30 by default). Call save_draft() to persist."""
    return get_folder().create_draft(name, width, height, fps, allow_replace=allow_replace)


def load_for_edit(name: str) -> ScriptFile:
    """Open an existing draft as an editable template."""
    return get_folder().load_template(name)


def save_draft(script: ScriptFile, name: str) -> dict:
    """Persist a ScriptFile, backing up any existing draft_content.json first.

    Returns a small report including whether CapCut was detected running (a risk that
    the save will be overwritten when the user next saves in CapCut).
    """
    backup = backup_content(name)
    script.save()
    return {
        "saved": str(paths.draft_content_path(name)),
        "backup": str(backup) if backup else None,
        "capcut_running": is_capcut_running(),
    }
