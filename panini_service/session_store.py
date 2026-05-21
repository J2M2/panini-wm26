"""Session counters (packs opened, trade totals)."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass


@dataclass
class SessionStats:
    packs_opened: int
    traded_out_count: int
    traded_in_count: int


def get_session_stats(conn: sqlite3.Connection) -> SessionStats:
    row = conn.execute(
        "SELECT packs_opened, traded_out_count, traded_in_count FROM session_stats WHERE id = 1"
    ).fetchone()
    if row is None:
        raise RuntimeError("session_stats row missing; run migration")
    return SessionStats(
        packs_opened=int(row["packs_opened"]),
        traded_out_count=int(row["traded_out_count"]),
        traded_in_count=int(row["traded_in_count"]),
    )


def update_session_stats(
    conn: sqlite3.Connection,
    *,
    packs_delta: int = 0,
    traded_out_delta: int = 0,
    traded_in_delta: int = 0,
) -> SessionStats:
    conn.execute(
        """
        UPDATE session_stats SET
          packs_opened = packs_opened + ?,
          traded_out_count = traded_out_count + ?,
          traded_in_count = traded_in_count + ?
        WHERE id = 1
        """,
        (packs_delta, traded_out_delta, traded_in_delta),
    )
    return get_session_stats(conn)


def set_session_stats(
    conn: sqlite3.Connection,
    *,
    packs_opened: int | None = None,
    traded_out_count: int | None = None,
    traded_in_count: int | None = None,
) -> SessionStats:
    cur = conn.execute("SELECT * FROM session_stats WHERE id = 1").fetchone()
    if cur is None:
        raise RuntimeError("session_stats missing")
    p = packs_opened if packs_opened is not None else int(cur["packs_opened"])
    o = traded_out_count if traded_out_count is not None else int(cur["traded_out_count"])
    i = traded_in_count if traded_in_count is not None else int(cur["traded_in_count"])
    conn.execute(
        """
        UPDATE session_stats SET packs_opened = ?, traded_out_count = ?, traded_in_count = ?
        WHERE id = 1
        """,
        (p, o, i),
    )
    return get_session_stats(conn)


def session_duplicate_trade_rate(traded_out: int, spare_copies: int) -> float | None:
    """
    Observed share of duplicate copies traded away vs still held as spares.

    ``traded_out / (traded_out + spare_copies)``; None when there are no duplicates
    in that pool (no spares and nothing traded out).
    """
    pool = int(traded_out) + int(spare_copies)
    if pool <= 0:
        return None
    return round(int(traded_out) / pool, 4)
