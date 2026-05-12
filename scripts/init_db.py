#!/usr/bin/env python3
"""Create schema, seed catalog (980 stickers), empty album (qty=0 per slot).

New installs (e.g. Fly.io) should start with no stickers owned. For Panini
semicolon CSV import (missing + duplicates), ``import_raw_csv`` lifts an
all-zero album to qty=1 before applying cells — same as the old baseline.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow running as script from repo root or scripts/
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
if str(_SCRIPTS_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR.parent))

from panini_catalog import expected_sticker_count  # noqa: E402
from panini_service.bootstrap_db import seed  # noqa: E402
from panini_db import DEFAULT_DB_PATH, connect  # noqa: E402


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
    parser.add_argument(
        "--baseline-one",
        action="store_true",
        help="Seed qty=1 per slot (dev / tests) instead of empty album.",
    )
    args = parser.parse_args()

    if args.db.exists():
        if not args.force:
            print(f"Refusing to overwrite {args.db}. Use --force to recreate.", file=sys.stderr)
            sys.exit(1)
        args.db.unlink()

    conn = connect(args.db)
    try:
        seed(conn, album_owned=args.baseline_one)
        conn.commit()
    finally:
        conn.close()

    mode = "qty=1 per slot" if args.baseline_one else "empty album, qty=0 per slot"
    print(f"Initialized {args.db} with {expected_sticker_count()} stickers ({mode}).")


if __name__ == "__main__":
    main()
