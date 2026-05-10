#!/usr/bin/env python3
"""Create schema, seed catalog (980 stickers), set baseline inventory qty=1."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

# Allow running as script from repo root or scripts/
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from panini_catalog import (  # noqa: E402
    FWC_CODE,
    TEAM_CODES,
    expected_sticker_count,
    fwc_role_for_slot,
    fwc_slot_codes,
    team_role_for_slot,
    team_slot_codes,
)
from panini_db import DEFAULT_DB_PATH, connect  # noqa: E402

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


def seed(conn: sqlite3.Connection) -> None:
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

    conn.execute(
        """
        INSERT INTO inventory (sticker_id, qty)
        SELECT id, 1 FROM stickers
        """
    )

    conn.execute(
        """
        INSERT OR IGNORE INTO session_stats (id, packs_opened, traded_out_count, traded_in_count)
        VALUES (1, 0, 0, 0)
        """
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize Panini WM26 SQLite database.")
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"Database path (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Remove existing database file and recreate.",
    )
    args = parser.parse_args()

    if args.db.exists():
        if not args.force:
            print(f"Refusing to overwrite {args.db}. Use --force to recreate.", file=sys.stderr)
            sys.exit(1)
        args.db.unlink()

    conn = connect(args.db)
    try:
        seed(conn)
        conn.commit()
    finally:
        conn.close()

    print(f"Initialized {args.db} with {expected_sticker_count()} stickers (baseline qty=1).")


if __name__ == "__main__":
    main()
