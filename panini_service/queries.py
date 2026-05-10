"""Aggregate metrics and sticker/category queries."""

from __future__ import annotations

import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sqlite3

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from panini_catalog import (  # noqa: E402
    FWC_CODE,
    TEAM_CODES,
    expected_sticker_count,
    fwc_album_code_for_internal_slot,
)

from panini_service.refs import format_sticker_ref  # noqa: E402
from panini_service.session_store import get_session_stats  # noqa: E402


def _album_field(category_code: str, slot_code: str) -> dict[str, str]:
    if category_code == FWC_CODE:
        return {"album_code": fwc_album_code_for_internal_slot(slot_code)}
    return {}


def inventory_metrics(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
          SUM(i.qty) AS total_physical,
          SUM(CASE WHEN i.qty >= 1 THEN 1 ELSE 0 END) AS unique_slots_filled,
          SUM(CASE WHEN i.qty = 0 THEN 1 ELSE 0 END) AS unique_slots_missing,
          SUM(CASE WHEN i.qty > 1 THEN i.qty - 1 ELSE 0 END) AS spare_copies,
          SUM(CASE WHEN i.qty > 1 THEN 1 ELSE 0 END) AS slots_with_duplicates
        FROM inventory i
        """
    ).fetchone()
    album_slots = expected_sticker_count()
    filled = int(row["unique_slots_filled"] or 0)
    pct = 100.0 * filled / album_slots if album_slots else 0.0
    session = get_session_stats(conn)
    return {
        "album_unique_slots": album_slots,
        "total_physical_stickers": int(row["total_physical"] or 0),
        "unique_slots_filled": filled,
        "unique_slots_missing": int(row["unique_slots_missing"] or 0),
        "pct_complete_unique": round(pct, 2),
        "spare_copies": int(row["spare_copies"] or 0),
        "slots_with_duplicates": int(row["slots_with_duplicates"] or 0),
        "session": {
            "packs_opened": session.packs_opened,
            "traded_out_count": session.traded_out_count,
            "traded_in_count": session.traded_in_count,
        },
    }


def list_missing(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT s.category_code, s.slot_code, s.role, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        WHERE i.qty = 0
        ORDER BY s.category_code, CAST(s.slot_code AS INTEGER)
        """
    ).fetchall()
    out = []
    for r in rows:
        item = {
            "category_code": r["category_code"],
            "slot_code": r["slot_code"],
            "role": r["role"],
            "qty": int(r["qty"]),
            "ref": format_sticker_ref(r["category_code"], r["slot_code"]),
        }
        item.update(_album_field(r["category_code"], r["slot_code"]))
        out.append(item)
    return out


def list_duplicates(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Slots with qty > 1; includes spare count (qty - 1)."""
    rows = conn.execute(
        """
        SELECT s.category_code, s.slot_code, s.role, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        WHERE i.qty > 1
        ORDER BY i.qty DESC, s.category_code, CAST(s.slot_code AS INTEGER)
        """
    ).fetchall()
    out = []
    for r in rows:
        q = int(r["qty"])
        item = {
            "category_code": r["category_code"],
            "slot_code": r["slot_code"],
            "role": r["role"],
            "qty": q,
            "spare_copies": q - 1,
            "ref": format_sticker_ref(r["category_code"], r["slot_code"]),
        }
        item.update(_album_field(r["category_code"], r["slot_code"]))
        out.append(item)
    return out


def get_sticker(conn: sqlite3.Connection, category_code: str, slot_code: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT s.id, s.category_code, s.slot_code, s.role, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        WHERE s.category_code = ? AND s.slot_code = ?
        """,
        (category_code, slot_code),
    ).fetchone()
    if row is None:
        return None
    qty = int(row["qty"])
    spare = max(0, qty - 1)
    item = {
        "id": int(row["id"]),
        "category_code": row["category_code"],
        "slot_code": row["slot_code"],
        "role": row["role"],
        "qty": qty,
        "spare_copies": spare,
        "ref": format_sticker_ref(row["category_code"], row["slot_code"]),
        "status": "missing"
        if qty == 0
        else ("duplicate" if qty > 1 else "single"),
    }
    item.update(_album_field(row["category_code"], row["slot_code"]))
    return item


def get_category(conn: sqlite3.Connection, category_code: str) -> dict[str, Any] | None:
    cat = conn.execute(
        "SELECT code, kind, name FROM categories WHERE code = ?", (category_code.upper(),)
    ).fetchone()
    if cat is None:
        return None
    rows = conn.execute(
        """
        SELECT s.slot_code, s.role, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        WHERE s.category_code = ?
        ORDER BY CAST(s.slot_code AS INTEGER)
        """,
        (category_code.upper(),),
    ).fetchall()
    slots = []
    have = 0
    for r in rows:
        q = int(r["qty"])
        if q >= 1:
            have += 1
        slot = {
            "slot_code": r["slot_code"],
            "role": r["role"],
            "qty": q,
            "ref": format_sticker_ref(cat["code"], r["slot_code"]),
        }
        slot.update(_album_field(cat["code"], r["slot_code"]))
        slots.append(slot)
    missing_ct = sum(1 for r in rows if int(r["qty"]) == 0)
    return {
        "code": cat["code"],
        "kind": cat["kind"],
        "name": cat["name"],
        "slots_total": len(slots),
        "slots_with_copy": have,
        "slots_missing": missing_ct,
        "pct_complete": round(100.0 * have / len(slots), 2) if slots else 0.0,
        "slots": slots,
    }


def analytics(conn: sqlite3.Connection, include: set[str] | None = None) -> dict[str, Any]:
    """Optional keys per plan; team-level proxies when rarity unknown."""
    if include is None:
        include = {"most_repeated", "most_completed_team", "most_missing_team"}
    out: dict[str, Any] = {}

    if "most_repeated" in include:
        row = conn.execute(
            """
            SELECT s.category_code, s.slot_code, i.qty, s.id
            FROM stickers s
            JOIN inventory i ON i.sticker_id = s.id
            ORDER BY i.qty DESC, s.id ASC
            LIMIT 1
            """
        ).fetchone()
        if row:
            item = {
                "category_code": row["category_code"],
                "slot_code": row["slot_code"],
                "qty": int(row["qty"]),
                "ref": format_sticker_ref(row["category_code"], row["slot_code"]),
            }
            item.update(_album_field(row["category_code"], row["slot_code"]))
            out["most_repeated"] = item
        else:
            out["most_repeated"] = None

    if "most_completed_team" in include or "most_missing_team" in include:
        best_team = None
        worst_team = None
        best_have = -1
        worst_missing_ct = -1
        for team in TEAM_CODES:
            r = conn.execute(
                """
                SELECT
                  SUM(CASE WHEN i.qty >= 1 THEN 1 ELSE 0 END) AS h,
                  SUM(CASE WHEN i.qty = 0 THEN 1 ELSE 0 END) AS m
                FROM stickers s
                JOIN inventory i ON i.sticker_id = s.id
                WHERE s.category_code = ?
                """,
                (team,),
            ).fetchone()
            h = int(r["h"] or 0)
            m = int(r["m"] or 0)
            pct_have = 100.0 * h / 20.0
            if h > best_have:
                best_have = h
                best_team = {"code": team, "slots_with_copy": h, "pct_complete": round(pct_have, 2)}
            if m > worst_missing_ct:
                worst_missing_ct = m
                worst_team = {
                    "code": team,
                    "slots_missing": m,
                    "pct_complete": round(100.0 * (20 - m) / 20.0, 2),
                }
        if "most_completed_team" in include:
            out["most_completed_team"] = best_team
        if "most_missing_team" in include:
            out["most_missing_team"] = worst_team

    if "fwc_summary" in include:
        out["fwc_summary"] = get_category(conn, FWC_CODE)

    if "most_difficult_sticker" in include:
        out["most_difficult_sticker"] = {
            "note": "Panini rarity weights not in DB; use team-level most_missing_team or missing list instead.",
            "proxy": None,
        }

    return out


def display_slot_label(category_code: str, slot_code: str) -> str:
    """Album-facing sticker number (FWC slot 20 -> '00')."""
    if category_code == FWC_CODE:
        return fwc_album_code_for_internal_slot(slot_code)
    return str(slot_code)


def _category_sort_order() -> list[str]:
    return [FWC_CODE] + list(TEAM_CODES)


def format_compact_missing(conn: sqlite3.Connection) -> str:
    """One line per category: TEAM: 1, 2, 3 — easy to scan and print."""
    rows = list_missing(conn)
    by_cat: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in rows:
        cat = r["category_code"]
        sc = r["slot_code"]
        by_cat[cat].append((int(sc), display_slot_label(cat, sc)))
    lines: list[str] = ["Missing", ""]
    any_line = False
    for cat in _category_sort_order():
        if cat not in by_cat:
            continue
        pairs = sorted(by_cat[cat], key=lambda x: x[0])
        labels = [p[1] for p in pairs]
        lines.append(f"{cat}: {', '.join(labels)}")
        any_line = True
    if not any_line:
        lines.append("(none)")
    return "\n".join(lines)


def format_compact_duplicates(conn: sqlite3.Connection) -> str:
    """One line per category, same style as missing (sticker numbers only, no qty)."""
    rows = list_duplicates(conn)
    by_cat: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in rows:
        cat = r["category_code"]
        sc = r["slot_code"]
        by_cat[cat].append((int(sc), display_slot_label(cat, sc)))
    lines: list[str] = ["Duplicates", ""]
    any_line = False
    for cat in _category_sort_order():
        if cat not in by_cat:
            continue
        pairs = sorted(by_cat[cat], key=lambda x: x[0])
        labels = [p[1] for p in pairs]
        lines.append(f"{cat}: {', '.join(labels)}")
        any_line = True
    if not any_line:
        lines.append("(none)")
    return "\n".join(lines)


def format_printable_lists(conn: sqlite3.Connection) -> str:
    """Single plain-text page: summary header + missing block + duplicates block."""
    m = inventory_metrics(conn)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    header = [
        "Panini WM26 — trading lists",
        f"Generated: {now}",
        (
            f"Progress: {m['unique_slots_filled']}/{m['album_unique_slots']} unique slots "
            f"({m['pct_complete_unique']}%)  |  spare copies (tradable): {m['spare_copies']}"
        ),
        "",
        "=" * 56,
        "",
    ]
    body = [
        format_compact_missing(conn),
        "",
        "=" * 56,
        "",
        format_compact_duplicates(conn),
        "",
    ]
    return "\n".join(header + body)


def format_table_missing(rows: list[dict[str, Any]]) -> str:
    lines = ["category\tslot\tref\talbum_code?"]
    for r in rows:
        alb = r.get("album_code", "")
        lines.append(f"{r['category_code']}\t{r['slot_code']}\t{r['ref']}\t{alb}")
    return "\n".join(lines)


def format_table_duplicates(rows: list[dict[str, Any]]) -> str:
    lines = ["category\tslot\tref\tqty\tspare_copies\talbum_code?"]
    for r in rows:
        alb = r.get("album_code", "")
        lines.append(
            f"{r['category_code']}\t{r['slot_code']}\t{r['ref']}\t{r['qty']}\t{r['spare_copies']}\t{alb}"
        )
    return "\n".join(lines)
