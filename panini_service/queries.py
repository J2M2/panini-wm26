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

from panini_service.album_pages import (  # noqa: E402
    album_index_group,
    album_list_hover_hint,
    printed_album_page,
)
from panini_service.refs import format_sticker_ref  # noqa: E402
from panini_service.session_store import get_session_stats  # noqa: E402


def _album_field(category_code: str, slot_code: str) -> dict[str, str]:
    if category_code == FWC_CODE:
        return {"album_code": fwc_album_code_for_internal_slot(slot_code)}
    return {}


def _album_paste_and_location(category_code: str, slot_code: str) -> dict[str, Any]:
    """Human + paste-friendly album hints (WM26: manual printed page index)."""
    cat = category_code.upper()
    sc = str(slot_code).strip()
    page = printed_album_page(cat, sc)

    if cat == FWC_CODE:
        ac = fwc_album_code_for_internal_slot(sc)
        paste = f"FWC {ac} | p.{page}"
        loc = f"Page: {page}"
        return {
            "album_paste_line": paste,
            "album_location": loc,
            "album_team_ordinal": None,
            "album_printed_page": page,
            "album_index_group": None,
        }
    try:
        idx = TEAM_CODES.index(cat)
    except ValueError:
        idx = -1
    n = idx + 1 if idx >= 0 else None
    paste = f"{cat} {sc} | p.{page}"
    g = album_index_group(cat)
    if n is not None and g is not None:
        loc = f"Group: {g}\nPage: {page}"
    else:
        loc = f"Page: {page}"
    return {
        "album_paste_line": paste,
        "album_location": loc,
        "album_team_ordinal": n,
        "album_printed_page": page,
        "album_index_group": g,
    }


def _team_shield_photo_completion(conn: sqlite3.Connection) -> dict[str, Any]:
    """Across all team pages: slot 1 (shield) and slot 13 (team photo), 48 each."""
    out: dict[str, dict[str, Any]] = {}
    for role, key in (("shield", "shield"), ("team_photo", "team_photo")):
        row = conn.execute(
            """
            SELECT
              SUM(CASE WHEN i.qty >= 1 THEN 1 ELSE 0 END) AS have,
              COUNT(*) AS total
            FROM stickers s
            JOIN inventory i ON i.sticker_id = s.id
            JOIN categories c ON c.code = s.category_code
            WHERE c.kind = 'team' AND s.role = ?
            """,
            (role,),
        ).fetchone()
        total = int(row["total"] or 0)
        have = int(row["have"] or 0)
        miss = max(0, total - have)
        pct = round(100.0 * have / total, 2) if total else 0.0
        out[key] = {
            "with_copy": have,
            "missing": miss,
            "total": total,
            "pct_complete": pct,
        }
    return out


def team_analytics_pages(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Per team page (20 slots): completion %, shield (slot 1) and team photo (slot 13) present flags."""
    rows = conn.execute(
        """
        SELECT
          s.category_code AS code,
          SUM(CASE WHEN i.qty >= 1 THEN 1 ELSE 0 END) AS slots_with_copy,
          COUNT(*) AS slots_total,
          SUM(i.qty) AS total_stickers,
          MAX(CASE WHEN s.role = 'shield' AND i.qty >= 1 THEN 1 ELSE 0 END) AS shield_ok,
          MAX(CASE WHEN s.role = 'team_photo' AND i.qty >= 1 THEN 1 ELSE 0 END) AS photo_ok
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        JOIN categories c ON c.code = s.category_code
        WHERE c.kind = 'team'
        GROUP BY s.category_code
        """
    ).fetchall()
    by_code = {str(r["code"]): r for r in rows}
    out: list[dict[str, Any]] = []
    for code in TEAM_CODES:
        r = by_code.get(code)
        if r is None:
            continue
        have = int(r["slots_with_copy"] or 0)
        total = int(r["slots_total"] or 0)
        miss = max(0, total - have)
        pct = round(100.0 * have / total, 2) if total else 0.0
        out.append(
            {
                "code": code,
                "slots_with_copy": have,
                "slots_missing": miss,
                "slots_total": total,
                "total_stickers": int(r["total_stickers"] or 0),
                "pct_complete": pct,
                "shield_ok": bool(int(r["shield_ok"] or 0)),
                "team_photo_ok": bool(int(r["photo_ok"] or 0)),
            }
        )
    return out


def _teams_fully_complete_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    """How many national team pages (20/20 slots) have at least one copy everywhere."""
    row = conn.execute(
        """
        SELECT COUNT(*) AS n_complete FROM (
            SELECT s.category_code
            FROM stickers s
            JOIN inventory i ON i.sticker_id = s.id
            JOIN categories c ON c.code = s.category_code
            WHERE c.kind = 'team'
            GROUP BY s.category_code
            HAVING SUM(CASE WHEN i.qty >= 1 THEN 1 ELSE 0 END) = COUNT(*)
        )
        """
    ).fetchone()
    n = int(row["n_complete"] or 0)
    total = len(TEAM_CODES)
    pct = round(100.0 * n / total, 2) if total else 0.0
    return {
        "teams_fully_complete": n,
        "teams_total": total,
        "pct_teams_fully_complete": pct,
    }


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


def _attach_list_album_hints(item: dict[str, Any], category_code: str, slot_code: str, role: Any) -> None:
    """Printed page + group + tooltip text for missing/duplicate list rows."""
    try:
        cat = str(category_code).upper()
        sc = str(slot_code).strip()
        item["album_printed_page"] = printed_album_page(cat, sc)
        g = album_index_group(cat)
        if g is not None:
            item["album_index_group"] = g
        r = role if isinstance(role, str) or role is None else str(role)
        item["album_hover_hint"] = album_list_hover_hint(cat, sc, r)
    except (ValueError, TypeError):
        pass


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
        _attach_list_album_hints(item, r["category_code"], r["slot_code"], r["role"])
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
        _attach_list_album_hints(item, r["category_code"], r["slot_code"], r["role"])
        out.append(item)
    return out


def list_sticker_canonical_refs(conn: sqlite3.Connection) -> list[str]:
    """All sticker refs in stable order (for client autocomplete)."""
    rows = conn.execute(
        """
        SELECT category_code, slot_code FROM stickers
        ORDER BY category_code, CAST(slot_code AS INTEGER)
        """
    ).fetchall()
    return [format_sticker_ref(r["category_code"], r["slot_code"]) for r in rows]


def list_album_table(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """All stickers with inventory + album hints (same shape as ``get_sticker`` rows)."""
    rows = conn.execute(
        """
        SELECT s.id, s.category_code, s.slot_code, s.role, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        ORDER BY s.category_code, CAST(s.slot_code AS INTEGER)
        """
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        qty = int(r["qty"])
        spare = max(0, qty - 1)
        cat = r["category_code"]
        sc = r["slot_code"]
        item: dict[str, Any] = {
            "id": int(r["id"]),
            "category_code": cat,
            "slot_code": sc,
            "role": r["role"],
            "qty": qty,
            "spare_copies": spare,
            "ref": format_sticker_ref(cat, sc),
            "status": "missing" if qty == 0 else ("duplicate" if qty > 1 else "single"),
        }
        item.update(_album_field(cat, sc))
        item.update(_album_paste_and_location(cat, sc))
        _attach_list_album_hints(item, cat, sc, r["role"])
        out.append(item)

    def _album_table_sort_key(item: dict[str, Any]) -> tuple[int, int, int]:
        cat = str(item["category_code"])
        slot = int(str(item["slot_code"]))
        if cat == FWC_CODE:
            return (0, 0, slot)
        try:
            ti = TEAM_CODES.index(cat)
        except ValueError:
            return (1, 9999, slot)
        return (1, ti, slot)

    out.sort(key=_album_table_sort_key)
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
    item.update(_album_paste_and_location(row["category_code"], row["slot_code"]))
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
    """Optional keys: team progress, hunt zone, duplicate pile per national page (with tie notes)."""
    if include is None:
        include = {
            "most_repeated",
            "most_completed_team",
            "most_missing_team",
            "most_duplicated_team",
        }
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

    if (
        "most_completed_team" in include
        or "most_missing_team" in include
        or "most_duplicated_team" in include
    ):
        pair_list: list[tuple[str, int, int, int, int]] = []
        for team in TEAM_CODES:
            r = conn.execute(
                """
                SELECT
                  SUM(CASE WHEN i.qty >= 1 THEN 1 ELSE 0 END) AS h,
                  SUM(CASE WHEN i.qty = 0 THEN 1 ELSE 0 END) AS m,
                  SUM(CASE WHEN i.qty > 1 THEN i.qty - 1 ELSE 0 END) AS spare,
                  SUM(CASE WHEN i.qty > 1 THEN 1 ELSE 0 END) AS dup_slots
                FROM stickers s
                JOIN inventory i ON i.sticker_id = s.id
                WHERE s.category_code = ?
                """,
                (team,),
            ).fetchone()
            h = int(r["h"] or 0)
            m = int(r["m"] or 0)
            spare = int(r["spare"] or 0)
            dup_slots = int(r["dup_slots"] or 0)
            pair_list.append((team, h, m, spare, dup_slots))

        if "most_completed_team" in include:
            incomplete = [(t, h, m) for t, h, m, _, _ in pair_list if h < 20]
            if not incomplete:
                out["most_completed_team"] = {
                    "all_teams_complete": True,
                    "code": None,
                    "codes": [],
                    "slots_with_copy": 20,
                    "slots_missing": 0,
                    "pct_complete": 100.0,
                    "tied": False,
                    "tie_note": None,
                }
            else:
                max_h = max(h for _, h, _ in incomplete)
                leaders = [(t, h, m) for t, h, m in incomplete if h == max_h]
                leaders.sort(key=lambda x: x[0])
                codes = [t for t, _, _ in leaders]
                t0, h0, m0 = leaders[0]
                tied = len(leaders) > 1
                tie_note = f"Tied for closest: {', '.join(codes)}" if tied else None
                out["most_completed_team"] = {
                    "all_teams_complete": False,
                    "code": t0,
                    "codes": codes,
                    "slots_with_copy": h0,
                    "slots_missing": m0,
                    "pct_complete": round(100.0 * h0 / 20.0, 2),
                    "tied": tied,
                    "tie_note": tie_note,
                }

        if "most_missing_team" in include:
            max_m = max(m for _, _, m, _, _ in pair_list)
            if max_m <= 0:
                out["most_missing_team"] = None
            else:
                worst = [(t, h, m) for t, h, m, _, _ in pair_list if m == max_m]
                worst.sort(key=lambda x: x[0])
                codes = [t for t, _, _ in worst]
                t0, h0, m0 = worst[0]
                tied = len(worst) > 1
                tie_note = f"Tied for most missing: {', '.join(codes)}" if tied else None
                out["most_missing_team"] = {
                    "code": t0,
                    "codes": codes,
                    "slots_missing": m0,
                    "pct_complete": round(100.0 * (20 - m0) / 20.0, 2),
                    "tied": tied,
                    "tie_note": tie_note,
                }

        if "most_duplicated_team" in include:
            max_spare = max(s for _, _, _, s, _ in pair_list)
            if max_spare <= 0:
                out["most_duplicated_team"] = None
            else:
                hoard = [(t, h, m, s, d) for t, h, m, s, d in pair_list if s == max_spare]
                hoard.sort(key=lambda x: x[0])
                codes = [t for t, _, _, _, _ in hoard]
                t0, _h0, _m0, s0, d0 = hoard[0]
                tied = len(hoard) > 1
                tie_note = f"Tied for most duplicate copies: {', '.join(codes)}" if tied else None
                out["most_duplicated_team"] = {
                    "code": t0,
                    "codes": codes,
                    "spare_copies": s0,
                    "slots_with_duplicates": d0,
                    "pct_slots_with_dup": round(100.0 * d0 / 20.0, 2),
                    "tied": tied,
                    "tie_note": tie_note,
                }

    if "fwc_summary" in include:
        out["fwc_summary"] = get_category(conn, FWC_CODE)

    if "team_shield_photo" in include:
        out["team_shield_photo"] = _team_shield_photo_completion(conn)
        out["teams_fully_complete"] = _teams_fully_complete_summary(conn)

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
