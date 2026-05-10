#!/usr/bin/env python3
"""Add session_stats row/table to an existing panini_wm26.sqlite."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from panini_service.db import DEFAULT_DB_PATH, connect  # noqa: E402
from panini_service.migrate import ensure_schema  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    args = p.parse_args()
    conn = connect(args.db)
    try:
        ensure_schema(conn)
        conn.commit()
    finally:
        conn.close()
    print(f"Schema OK: {args.db}")


if __name__ == "__main__":
    main()
