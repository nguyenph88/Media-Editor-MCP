"""Resolve CapCut's on-disk locations (Windows).

CapCut International stores drafts and the downloaded effect-resource cache under
%LOCALAPPDATA%\\CapCut\\User Data\\. Locations can be overridden with env vars for
non-default installs or testing:

  CAPCUT_DRAFT_DIR   -> the "com.lveditor.draft" folder that holds one subfolder per draft
  CAPCUT_CACHE_DIR   -> the "Cache" folder that holds downloaded effect resources
"""

from __future__ import annotations

import os
from pathlib import Path

# Relative to %LOCALAPPDATA% for a default CapCut International install.
_DRAFT_REL = Path("CapCut") / "User Data" / "Projects" / "com.lveditor.draft"
_CACHE_REL = Path("CapCut") / "User Data" / "Cache"


def _local_appdata() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base)
    # Fallback for non-standard environments.
    return Path.home() / "AppData" / "Local"


def draft_dir() -> Path:
    """The folder containing one subfolder per CapCut draft."""
    override = os.environ.get("CAPCUT_DRAFT_DIR")
    if override:
        return Path(override)
    return _local_appdata() / _DRAFT_REL


def cache_dir() -> Path:
    """CapCut's resource cache folder (downloaded effects live under Cache/effect/<id>/)."""
    override = os.environ.get("CAPCUT_CACHE_DIR")
    if override:
        return Path(override)
    return _local_appdata() / _CACHE_REL


def effect_cache_dir() -> Path:
    """Folder of downloaded effect resources, keyed by resource_id."""
    return cache_dir() / "effect"


def draft_path(name: str) -> Path:
    """Path to a single draft's folder."""
    return draft_dir() / name


def draft_content_path(name: str) -> Path:
    """Path to a single draft's draft_content.json."""
    return draft_path(name) / "draft_content.json"


def resource_is_cached(resource_id: str) -> bool:
    """True if an effect/filter resource has been downloaded locally (guaranteed to render)."""
    if not resource_id:
        return False
    d = effect_cache_dir() / str(resource_id)
    return d.is_dir() and any(d.iterdir())
