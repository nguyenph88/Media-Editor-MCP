"""Draft IO: locate, open, create, and safely save CapCut drafts on disk.

Wraps pycapcut's DraftFolder/ScriptFile. The only value this layer adds over pycapcut
is *safety*: a backup of draft_content.json before every overwrite, and a warning when
CapCut appears to be running (it overwrites on-disk changes when it saves).

CapCut must be CLOSED while we write a draft it has open, or our changes are lost.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path
from typing import List, Optional

from pycapcut import DraftFolder, ScriptFile

from . import paths

BACKUP_SUFFIX = ".ccmcp.bak"  # distinct from CapCut's own ".bak" so we never clobber it


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
