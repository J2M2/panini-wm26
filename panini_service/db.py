"""SQLite connection for panini_service (same DB file as scripts/panini_db)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT / "data" / "panini_wm26.sqlite"


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def sticker_id_for(conn: sqlite3.Connection, category_code: str, slot_code: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM stickers WHERE category_code = ? AND slot_code = ?",
        (category_code, slot_code),
    ).fetchone()
    return int(row["id"]) if row else None
