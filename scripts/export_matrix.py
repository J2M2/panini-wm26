#!/usr/bin/env python3
"""Export one qty matrix CSV (FWC + all teams, rows 1–20); optional stats."""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from panini_catalog import FWC_CODE, TEAM_CODES, team_slot_codes  # noqa: E402
from panini_db import DEFAULT_DB_PATH, connect  # noqa: E402


def load_qty_map(conn: sqlite3.Connection) -> dict[tuple[str, str], int]:
    rows = conn.execute(
        """
        SELECT s.category_code, s.slot_code, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        """
    ).fetchall()
    return {(r["category_code"], r["slot_code"]): int(r["qty"]) for r in rows}


def print_stats(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        """
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN i.qty = 0 THEN 1 ELSE 0 END) AS missing_slots,
          SUM(CASE WHEN i.qty > 1 THEN 1 ELSE 0 END) AS slots_with_extras,
          SUM(CASE WHEN i.qty > 1 THEN i.qty - 1 ELSE 0 END) AS extra_copies
        FROM inventory i
        """
    ).fetchone()
    total = row["total"]
    missing = row["missing_slots"]
    have = total - missing
    pct = 100.0 * have / total if total else 0.0
    print(f"Stickers with at least one copy: {have} / {total} ({pct:.1f}%)")
    print(f"Slots still missing (qty=0): {missing}")
    print(f"Slots with duplicates (qty>1): {row['slots_with_extras']}; spare copies: {row['extra_copies']}")


def export_matrix_csv(path: Path, qty_map: dict[tuple[str, str], int]) -> None:
    """Same column layout as raw sheets: slot + FWC + 48 teams; rows 1–20; cells = qty."""
    categories = [FWC_CODE] + TEAM_CODES
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["slot"] + categories)
        for slot in team_slot_codes():
            row = [slot]
            for cat in categories:
                row.append(qty_map.get((cat, slot), 0))
            w.writerow(row)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export unified qty matrix CSV and optional stats.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--stats", action="store_true", help="Print summary to stdout")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Directory for matrix.csv (default: <repo>/data)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output file path (overrides --out-dir / matrix.csv)",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    out_dir = args.out_dir or (root / "data")
    out_path = args.output if args.output is not None else (out_dir / "matrix.csv")

    conn = connect(args.db)
    try:
        qty_map = load_qty_map(conn)
        if args.stats:
            print_stats(conn)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        export_matrix_csv(out_path, qty_map)
        print(f"Wrote {out_path}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
