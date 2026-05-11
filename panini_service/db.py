"""SQLite connection for panini_service (same DB file as scripts/panini_db)."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _default_db_path() -> Path:
    """Use ``PANINI_DB_PATH`` when set (e.g. Docker volume); else ``data/panini_wm26.sqlite``."""
    env = os.environ.get("PANINI_DB_PATH", "").strip()
    if env:
        return Path(env)
    return ROOT / "data" / "panini_wm26.sqlite"


DEFAULT_DB_PATH = _default_db_path()


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI runs sync deps in a thread pool; enter/exit may differ.
    # timeout: retry when another request holds the DB (web UI parallel fetches).
    conn = sqlite3.connect(path, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def sticker_id_for(conn: sqlite3.Connection, category_code: str, slot_code: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM stickers WHERE category_code = ? AND slot_code = ?",
        (category_code, slot_code),
    ).fetchone()
    return int(row["id"]) if row else None
