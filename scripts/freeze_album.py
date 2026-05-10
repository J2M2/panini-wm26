#!/usr/bin/env python3
"""
Write a timestamped JSON snapshot of the current DB under data/frozen/, plus
data/frozen/album_latest.json (always overwritten) for quick restore or tests.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_ROOT = _SCRIPTS_DIR.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from panini_db import DEFAULT_DB_PATH, connect  # noqa: E402
from panini_service.snapshot import build_full_snapshot  # noqa: E402

FROZEN_DIR = _ROOT / "data" / "frozen"


def main() -> None:
    p = argparse.ArgumentParser(description="Freeze current album to data/frozen/*.json")
    p.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    p.add_argument(
        "--label",
        type=str,
        default="",
        help="Optional short tag for the filename, e.g. v1 or after_packs_100",
    )
    args = p.parse_args()

    FROZEN_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect(args.db)
    try:
        data = build_full_snapshot(conn)
    finally:
        conn.close()

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    label = f"_{args.label}" if args.label.strip() else ""
    versioned = FROZEN_DIR / f"album_frozen{label}_{ts}.json"
    latest = FROZEN_DIR / "album_latest.json"

    for path in (versioned, latest):
        with path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")

    print(f"Frozen:  {versioned}")
    print(f"Latest:  {latest}  (overwrite each time you freeze)")


if __name__ == "__main__":
    main()
