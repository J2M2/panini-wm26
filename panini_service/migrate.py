"""Ensure session_stats and future additive schema exists."""

from __future__ import annotations

import sqlite3

SESSION_STATS_SQL = """
CREATE TABLE IF NOT EXISTS session_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    packs_opened INTEGER NOT NULL DEFAULT 0,
    traded_out_count INTEGER NOT NULL DEFAULT 0,
    traded_in_count INTEGER NOT NULL DEFAULT 0
);
"""


def ensure_session_stats(conn: sqlite3.Connection) -> None:
    conn.executescript(SESSION_STATS_SQL)
    conn.execute(
        """
        INSERT OR IGNORE INTO session_stats (id, packs_opened, traded_out_count, traded_in_count)
        VALUES (1, 0, 0, 0)
        """
    )


def ensure_schema(conn: sqlite3.Connection) -> None:
    ensure_session_stats(conn)
