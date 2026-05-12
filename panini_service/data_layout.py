"""Application data directory (multi-user albums + auth registry)."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def data_dir() -> Path:
    """``PANINI_DATA_DIR`` when set (e.g. ``/data`` on Fly); else ``<repo>/data``."""
    env = os.environ.get("PANINI_DATA_DIR", "").strip()
    if env:
        return Path(env)
    return ROOT / "data"


def albums_dir() -> Path:
    d = data_dir() / "albums"
    d.mkdir(parents=True, exist_ok=True)
    return d


def registry_db_path() -> Path:
    return data_dir() / "registry.sqlite"


def use_legacy_single_db() -> bool:
    """When true, API uses ``PANINI_DB_PATH`` only (no per-browser guest / no registry)."""
    return os.environ.get("PANINI_USE_LEGACY_DB", "").strip() in ("1", "true", "yes")


def legacy_db_path() -> Path:
    env = os.environ.get("PANINI_DB_PATH", "").strip()
    if env:
        return Path(env)
    return ROOT / "data" / "panini_wm26.sqlite"


def ensure_data_directories() -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    albums_dir()
