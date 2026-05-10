#!/usr/bin/env python3
"""Export catalog + inventory snapshot as JSON for a TypeScript / web client."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_ROOT = _SCRIPTS_DIR.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from panini_db import DEFAULT_DB_PATH, connect  # noqa: E402
from panini_service.snapshot import build_full_snapshot  # noqa: E402


def export_snapshot(conn: sqlite3.Connection) -> dict:
    """Thin wrapper: full snapshot including session (schema v3)."""
    return build_full_snapshot(conn)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export JSON snapshot for web UI.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "panini_snapshot.json",
    )
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        data = export_snapshot(conn)
    finally:
        conn.close()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
