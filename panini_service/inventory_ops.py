"""Mutations: add/remove qty, open pack, trade."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import sqlite3

from panini_service.constants import STICKERS_PER_PACK
from panini_service.db import sticker_id_for
from panini_service.migrate import ensure_schema
from panini_service.queries import get_sticker
from panini_service.refs import format_sticker_ref, parse_sticker_ref
from panini_service.session_store import update_session_stats


class StrictTradeError(Exception):
    """Giving away a sticker that is not a duplicate (qty < 2) in strict mode."""


class TradeImpossibleError(Exception):
    """Not enough qty to give, or invalid uneven lists."""


def _get_qty(conn: sqlite3.Connection, category_code: str, slot_code: str) -> int:
    sid = sticker_id_for(conn, category_code, slot_code)
    if sid is None:
        raise ValueError("Unknown sticker")
    row = conn.execute("SELECT qty FROM inventory WHERE sticker_id = ?", (sid,)).fetchone()
    return int(row["qty"]) if row else 0


def _set_qty_delta(conn: sqlite3.Connection, category_code: str, slot_code: str, delta: int) -> int:
    sid = sticker_id_for(conn, category_code, slot_code)
    if sid is None:
        raise ValueError("Unknown sticker")
    row = conn.execute("SELECT qty FROM inventory WHERE sticker_id = ?", (sid,)).fetchone()
    cur = int(row["qty"])
    new = cur + delta
    if new < 0:
        raise ValueError("insufficient qty")
    conn.execute("UPDATE inventory SET qty = ? WHERE sticker_id = ?", (new, sid))
    return new


def add_stickers(
    conn: sqlite3.Connection,
    ref: str,
    count: int,
) -> dict[str, Any]:
    if count < 1:
        raise ValueError("count must be >= 1")
    ensure_schema(conn)
    cat, slot = parse_sticker_ref(ref)
    before = _get_qty(conn, cat, slot)
    _set_qty_delta(conn, cat, slot, count)
    after = _get_qty(conn, cat, slot)
    return {"ref": ref, "before": before, "after": after, "added": count}


def remove_stickers(conn: sqlite3.Connection, ref: str, count: int) -> dict[str, Any]:
    if count < 1:
        raise ValueError("count must be >= 1")
    ensure_schema(conn)
    cat, slot = parse_sticker_ref(ref)
    before = _get_qty(conn, cat, slot)
    if before < count:
        raise ValueError(f"cannot remove {count}; only have {before}")
    _set_qty_delta(conn, cat, slot, -count)
    after = _get_qty(conn, cat, slot)
    return {"ref": ref, "before": before, "after": after, "removed": count}


@dataclass
class PackOpenResult:
    per_pack: int
    added_as_new: list[dict[str, Any]] = field(default_factory=list)
    added_as_duplicate: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def open_pack(
    conn: sqlite3.Connection,
    sticker_refs: list[str],
    *,
    per_pack: int = STICKERS_PER_PACK,
) -> PackOpenResult:
    ensure_schema(conn)
    if len(sticker_refs) != per_pack:
        raise ValueError(f"expected exactly {per_pack} sticker refs for one pack")
    result = PackOpenResult(per_pack=per_pack)
    conn.execute("SAVEPOINT sp_pack_open")
    try:
        for ref in sticker_refs:
            cat, slot = parse_sticker_ref(ref)
            before = _get_qty(conn, cat, slot)
            _set_qty_delta(conn, cat, slot, 1)
            detail = get_sticker(conn, cat, slot)
            entry = detail or {"ref": format_sticker_ref(cat, slot)}
            entry["qty_before"] = before
            entry["qty_after"] = before + 1
            if before == 0:
                result.added_as_new.append(entry)
            else:
                result.added_as_duplicate.append(entry)
        update_session_stats(conn, packs_delta=1)
        conn.execute("RELEASE SAVEPOINT sp_pack_open")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT sp_pack_open")
        raise
    return result


@dataclass
class TradeResult:
    warnings: list[str] = field(default_factory=list)
    gave: list[dict[str, Any]] = field(default_factory=list)
    received: list[dict[str, Any]] = field(default_factory=list)


def execute_trade(
    conn: sqlite3.Connection,
    give_refs: list[str],
    take_refs: list[str],
    *,
    strict_duplicates_only: bool = False,
    allow_uneven: bool = False,
) -> TradeResult:
    ensure_schema(conn)
    result = TradeResult()
    if len(give_refs) != len(take_refs) and not allow_uneven:
        raise TradeImpossibleError("give and take lists must have same length unless allow_uneven=true")

    # Validate give side + strict / warnings
    give_pairs: list[tuple[str, str, str]] = []
    for ref in give_refs:
        cat, slot = parse_sticker_ref(ref)
        q = _get_qty(conn, cat, slot)
        if q < 1:
            raise TradeImpossibleError(f"cannot give {ref}: qty is 0")
        if strict_duplicates_only and q < 2:
            raise StrictTradeError(f"strict mode: {ref} is not a duplicate (qty={q})")
        if not strict_duplicates_only and q < 2:
            result.warnings.append(f"giving non-duplicate / last copy for {ref} (qty={q})")
        give_pairs.append((ref, cat, slot))

    take_pairs: list[tuple[str, str, str]] = []
    for ref in take_refs:
        cat, slot = parse_sticker_ref(ref)
        take_pairs.append((ref, cat, slot))

    conn.execute("SAVEPOINT sp_trade")
    try:
        for ref, cat, slot in give_pairs:
            before = _get_qty(conn, cat, slot)
            _set_qty_delta(conn, cat, slot, -1)
            result.gave.append({"ref": ref, "qty_before": before, "qty_after": before - 1})
        for ref, cat, slot in take_pairs:
            before = _get_qty(conn, cat, slot)
            _set_qty_delta(conn, cat, slot, 1)
            result.received.append({"ref": ref, "qty_before": before, "qty_after": before + 1})
        update_session_stats(
            conn,
            traded_out_delta=len(give_refs),
            traded_in_delta=len(take_refs),
        )
        conn.execute("RELEASE SAVEPOINT sp_trade")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT sp_trade")
        raise
    return result
