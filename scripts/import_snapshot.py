#!/usr/bin/env python3
"""Import album snapshot JSON (inventory + optional session) into SQLite."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from panini_service.db import DEFAULT_DB_PATH, connect  # noqa: E402
from panini_service.migrate import ensure_schema  # noqa: E402
from panini_service.snapshot import import_album_snapshot  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description="Import album snapshot JSON.")
    p.add_argument("file", type=Path, help="Snapshot JSON file")
    p.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    p.add_argument(
        "--no-session",
        action="store_true",
        help="Do not restore packs_opened / trade counters (inventory still restored)",
    )
    args = p.parse_args()

    with args.file.open(encoding="utf-8") as f:
        data = json.load(f)

    conn = connect(args.db)
    try:
        ensure_schema(conn)
        result = import_album_snapshot(conn, data, apply_session=not args.no_session)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print(result)


if __name__ == "__main__":
    main()
