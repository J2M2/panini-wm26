#!/usr/bin/env python3
"""
Import raw Panini export CSVs into inventory.

Baseline rules (reproducible):
  1. Expect database initialized by init_db.py: every sticker has qty=1.
  2. Missing CSV: each non-empty cell is a slot number you do NOT have → set qty=0
     for that sticker.
  3. Duplicates CSV: each non-empty cell is one EXTRA copy you own → increment qty
     by 1 for that sticker (repeat appearances stack).

Order of operations: apply missing first (all cells), then duplicates (all cells).

Column headers must match category codes: FWC plus the same 48 team codes as in
panini_catalog.TEAM_CODES. Body rows are sparse; delimiter is semicolon.

FWC column values use album print numbers (including **00** for the standalone
sticker). Those map to internal slots **1–20**: album **00** (or 0) → internal
**20**; album **1–19** → internal **1–19**. Internal **20** is also accepted as
the 20th slot / physical **00**.
"""

from __future__ import annotations

import argparse
import csv
import re
import sqlite3
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from panini_catalog import FWC_CODE, TEAM_CODES, fwc_slot_codes, team_slot_codes  # noqa: E402
from panini_db import DEFAULT_DB_PATH, connect, sticker_id_for  # noqa: E402

ALLOWED_FWC = set(fwc_slot_codes())
ALLOWED_TEAM = set(team_slot_codes())
_ZEROISH = re.compile(r"^0+$")


def normalize_cell(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    return s


def parse_slot_code(category: str, raw: str) -> str:
    s = raw.strip()
    if category == FWC_CODE:
        return fwc_album_cell_to_internal(s)
    n = int(s)
    return str(n)


def fwc_album_cell_to_internal(s: str) -> str:
    """Album FWC **00** → internal slot **20**; **1–19** unchanged; **20** → slot **20**."""
    if _ZEROISH.match(s) or s in ("00", "0"):
        return "20"
    n = int(s)
    if n == 0:
        return "20"
    if n == 20:
        return "20"
    if 1 <= n <= 19:
        return str(n)
    raise ValueError(f"FWC album number must be 00/0 or 1–20, got {s!r}")


def validate_slot(category: str, slot_code: str) -> None:
    if category == FWC_CODE:
        if slot_code not in ALLOWED_FWC:
            raise ValueError(f"Invalid FWC slot {slot_code!r}; allowed: {sorted(ALLOWED_FWC)}")
    else:
        if slot_code not in ALLOWED_TEAM:
            raise ValueError(f"Invalid team slot {slot_code!r}; allowed 1–20")


def read_raw_grid(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f, delimiter=";")
        rows = list(reader)
    if not rows:
        raise ValueError(f"Empty file: {path}")
    header = [normalize_cell(c) or "" for c in rows[0]]
    data_rows = []
    for r in rows[1:]:
        data_rows.append([normalize_cell(c) for c in r])
    return header, data_rows


def validate_header(header: list[str]) -> list[str]:
    expected = [FWC_CODE] + TEAM_CODES
    if header[: len(expected)] != expected:
        # tolerate shorter rows if trailing empty omitted
        if len(header) < len(expected):
            raise ValueError(
                f"Header mismatch: got {len(header)} cols, need {len(expected)}. First cols: {header[:5]}..."
            )
        for i, exp in enumerate(expected):
            if header[i] != exp:
                raise ValueError(f"Header col {i}: expected {exp!r}, got {header[i]!r}")
    return expected


def collect_cells(header: list[str], data_rows: list[list[str | None]], categories: list[str]):
    """Yield (category_code, slot_code) for each non-empty body cell."""
    n = len(categories)
    for row in data_rows:
        for j in range(min(n, len(row))):
            cell = row[j]
            if not cell:
                continue
            cat = categories[j]
            try:
                slot = parse_slot_code(cat, cell)
            except ValueError as e:
                raise ValueError(f"Bad cell {cell!r} under column {cat}: {e}") from e
            validate_slot(cat, slot)
            yield cat, slot


def apply_missing(conn: sqlite3.Connection, path: Path) -> int:
    header, data_rows = read_raw_grid(path)
    categories = validate_header(header)
    n = 0
    for cat, slot in collect_cells(header, data_rows, categories):
        sid = sticker_id_for(conn, cat, slot)
        if sid is None:
            raise RuntimeError(f"No sticker for {cat} slot {slot}")
        conn.execute("UPDATE inventory SET qty = 0 WHERE sticker_id = ?", (sid,))
        n += 1
    return n


def apply_duplicates(conn: sqlite3.Connection, path: Path) -> int:
    header, data_rows = read_raw_grid(path)
    categories = validate_header(header)
    n = 0
    for cat, slot in collect_cells(header, data_rows, categories):
        sid = sticker_id_for(conn, cat, slot)
        if sid is None:
            raise RuntimeError(f"No sticker for {cat} slot {slot}")
        conn.execute(
            "UPDATE inventory SET qty = qty + 1 WHERE sticker_id = ?",
            (sid,),
        )
        n += 1
    return n


def main() -> None:
    parser = argparse.ArgumentParser(description="Import missing / duplicate CSV exports.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--missing", type=Path, help="Semicolon CSV of missing sticker numbers")
    parser.add_argument("--duplicates", type=Path, help="Semicolon CSV of duplicate sticker numbers")
    args = parser.parse_args()

    if not args.missing and not args.duplicates:
        parser.error("Provide --missing and/or --duplicates")

    conn = connect(args.db)
    try:
        missing_ops = 0
        dup_ops = 0
        if args.missing:
            missing_ops = apply_missing(conn, args.missing)
        if args.duplicates:
            dup_ops = apply_duplicates(conn, args.duplicates)
        conn.commit()
    finally:
        conn.close()

    print(f"Applied missing cells: {missing_ops}; duplicate increments: {dup_ops}")


if __name__ == "__main__":
    main()
