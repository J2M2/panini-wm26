"""Create catalog schema and seed stickers + empty (or full) inventory — shared by CLI and multi-user album files."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from panini_catalog import (  # noqa: E402
    FWC_CODE,
    TEAM_CODES,
    expected_sticker_count,
    fwc_role_for_slot,
    fwc_slot_codes,
    team_role_for_slot,
    team_slot_codes,
)

SCHEMA = """
CREATE TABLE categories (
    code TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('fwc', 'team')),
    name TEXT
);

CREATE TABLE stickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_code TEXT NOT NULL REFERENCES categories(code) ON DELETE CASCADE,
    slot_code TEXT NOT NULL,
    role TEXT CHECK (role IN ('shield', 'team_photo', 'fwc_special', 'fwc')),
    UNIQUE (category_code, slot_code)
);

CREATE INDEX idx_stickers_category ON stickers(category_code);

CREATE TABLE inventory (
    sticker_id INTEGER PRIMARY KEY REFERENCES stickers(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0)
);

CREATE TABLE session_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    packs_opened INTEGER NOT NULL DEFAULT 0,
    traded_out_count INTEGER NOT NULL DEFAULT 0,
    traded_in_count INTEGER NOT NULL DEFAULT 0
);
"""


def seed(conn: sqlite3.Connection, *, album_owned: bool = False) -> None:
    """Insert categories, stickers, inventory rows, session_stats.

    ``album_owned=False``: empty album (qty=0). ``album_owned=True``: qty=1 everywhere (tests).
    """
    conn.executescript(SCHEMA)

    conn.execute(
        "INSERT INTO categories (code, kind, name) VALUES (?, 'fwc', ?)",
        (FWC_CODE, "FIFA World Cup™ / Special"),
    )
    for code in TEAM_CODES:
        conn.execute(
            "INSERT INTO categories (code, kind, name) VALUES (?, 'team', NULL)",
            (code,),
        )

    for slot in fwc_slot_codes():
        role = fwc_role_for_slot(slot)
        conn.execute(
            "INSERT INTO stickers (category_code, slot_code, role) VALUES (?, ?, ?)",
            (FWC_CODE, slot, role),
        )

    for team in TEAM_CODES:
        for slot in team_slot_codes():
            role = team_role_for_slot(slot)
            conn.execute(
                "INSERT INTO stickers (category_code, slot_code, role) VALUES (?, ?, ?)",
                (team, slot, role),
            )

    count = conn.execute("SELECT COUNT(*) AS c FROM stickers").fetchone()[0]
    expected = expected_sticker_count()
    if count != expected:
        raise RuntimeError(f"Sticker count {count} != expected {expected}")

    qty = 1 if album_owned else 0
    conn.execute(
        """
        INSERT INTO inventory (sticker_id, qty)
        SELECT id, ? FROM stickers
        """,
        (qty,),
    )

    conn.execute(
        """
        INSERT OR IGNORE INTO session_stats (id, packs_opened, traded_out_count, traded_in_count)
        VALUES (1, 0, 0, 0)
        """
    )


def create_fresh_album_file(path: Path | str) -> None:
    """Create a new SQLite file at ``path`` with catalog + empty album."""
    import sqlite3 as _sqlite3

    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        p.unlink()
    conn = _sqlite3.connect(p, timeout=30.0)
    conn.row_factory = _sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        seed(conn, album_owned=False)
        conn.commit()
    finally:
        conn.close()


def copy_album_database_file(src: Path | str, dst: Path | str) -> None:
    """Copy an album SQLite file using the backup API (WAL-safe). Overwrites ``dst``."""
    import sqlite3 as _sqlite3

    s_path = Path(src)
    d_path = Path(dst)
    if not s_path.is_file():
        raise FileNotFoundError(str(s_path))
    d_path.parent.mkdir(parents=True, exist_ok=True)
    if d_path.exists():
        d_path.unlink()
    for suffix in ("-wal", "-shm"):
        side = Path(str(d_path) + suffix)
        if side.exists():
            side.unlink()
    src_conn = _sqlite3.connect(str(s_path), timeout=30.0)
    dst_conn = _sqlite3.connect(str(d_path), timeout=30.0)
    try:
        src_conn.backup(dst_conn)
        dst_conn.commit()
    finally:
        src_conn.close()
        dst_conn.close()
