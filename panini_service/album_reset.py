"""Reset album inventory + session counters (keep catalog)."""

from __future__ import annotations

import sqlite3


def reset_album_collection(conn: sqlite3.Connection) -> None:
    conn.execute("UPDATE inventory SET qty = 0")
    conn.execute(
        """
        UPDATE session_stats SET
          packs_opened = 0,
          traded_out_count = 0,
          traded_in_count = 0
        WHERE id = 1
        """
    )
