"""Mutations: add/remove qty, open pack, trade."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import sqlite3

from panini_service.album_pages import album_index_group, printed_album_page
from panini_service.constants import STICKERS_PER_PACK
from panini_service.db import sticker_id_for
from panini_service.migrate import ensure_schema
from panini_service.queries import get_sticker
from panini_service.refs import FWC_CODE, TEAM_CODES, format_sticker_ref, parse_sticker_ref
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


def packs_opened_delta(n: int, per_pack: int) -> int:
    """Rounded pack count for session (at least one pack when n >= 1)."""
    if n < 1:
        raise ValueError("pack must list at least one sticker")
    if per_pack < 1:
        raise ValueError("per_pack must be >= 1")
    return max(1, round(n / per_pack))


def _fractional_pack_warnings(n: int, per_pack: int) -> list[str]:
    if n % per_pack == 0:
        return []
    d = packs_opened_delta(n, per_pack)
    return [
        f"{n} stickers is not a multiple of the nominal {per_pack} per pack. "
        f"packs_opened will increase by {d} (rounded). "
        "OK if the envelope had an extra sticker, a missing slot, or damage."
    ]


def _in_pack_duplicate_entries(pairs: list[tuple[str, str, str]]) -> list[dict[str, Any]]:
    c = Counter(ref for ref, _, _ in pairs)
    return [{"ref": r, "occurrences": n} for r, n in sorted(c.items()) if n > 1]


def _album_order_key(category_code: str, slot_code: str) -> tuple[int, int, int]:
    cat = category_code.upper()
    page = printed_album_page(cat, slot_code)
    s = int(str(slot_code).strip())
    if cat == FWC_CODE:
        return (page, 0, s)
    try:
        ti = TEAM_CODES.index(cat)
    except ValueError:
        return (page, 9999, s)
    return (page, ti, s)


def _normalize_pack_ref_pairs(sticker_refs: list[str]) -> list[tuple[str, str, str]]:
    pairs: list[tuple[str, str, str]] = []
    for raw in sticker_refs:
        cat, slot = parse_sticker_ref(raw)
        pairs.append((format_sticker_ref(cat, slot), cat, slot))
    return pairs


def check_pack(
    conn: sqlite3.Connection,
    sticker_refs: list[str],
    *,
    per_pack: int = STICKERS_PER_PACK,
) -> dict[str, Any]:
    """Dry-run: classify additions and album order without mutating inventory or session."""
    ensure_schema(conn)
    if not sticker_refs:
        raise ValueError("need at least one sticker in the pack list")
    pairs = _normalize_pack_ref_pairs(sticker_refs)
    n = len(pairs)
    sim: dict[tuple[str, str], int] = {}
    new_rows: list[dict[str, Any]] = []
    dup_rows: list[dict[str, Any]] = []
    for ref_canon, cat, slot in pairs:
        k = (cat, slot)
        if k not in sim:
            sim[k] = _get_qty(conn, cat, slot)
        before = sim[k]
        page = printed_album_page(cat, slot)
        grp = album_index_group(cat)
        row = {
            "ref": ref_canon,
            "category_code": cat,
            "slot_code": slot,
            "qty_before": before,
            "album_printed_page": page,
            "album_index_group": grp,
        }
        if before == 0:
            new_rows.append(row)
        else:
            dup_rows.append(row)
        sim[k] = before + 1

    in_dup = _in_pack_duplicate_entries(pairs)
    warnings = list(_fractional_pack_warnings(n, per_pack))

    new_rows.sort(key=lambda r: _album_order_key(r["category_code"], r["slot_code"]))
    dup_rows.sort(key=lambda r: _album_order_key(r["category_code"], r["slot_code"]))

    return {
        "per_pack": per_pack,
        "sticker_count": n,
        "packs_opened_delta": packs_opened_delta(n, per_pack),
        "warnings": warnings,
        "in_pack_duplicates": in_dup,
        "new_to_album": new_rows,
        "would_duplicate": dup_rows,
    }


@dataclass
class PackOpenResult:
    per_pack: int
    sticker_count: int = 0
    packs_opened_delta: int = 0
    added_as_new: list[dict[str, Any]] = field(default_factory=list)
    added_as_duplicate: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    in_pack_duplicates: list[dict[str, Any]] = field(default_factory=list)


def open_pack(
    conn: sqlite3.Connection,
    sticker_refs: list[str],
    *,
    per_pack: int = STICKERS_PER_PACK,
) -> PackOpenResult:
    ensure_schema(conn)
    if not sticker_refs:
        raise ValueError("need at least one sticker in the pack list")
    pairs = _normalize_pack_ref_pairs(sticker_refs)
    n = len(pairs)
    delta = packs_opened_delta(n, per_pack)
    in_dup = _in_pack_duplicate_entries(pairs)
    warnings = list(_fractional_pack_warnings(n, per_pack))

    result = PackOpenResult(
        per_pack=per_pack,
        sticker_count=n,
        packs_opened_delta=delta,
        warnings=warnings,
        in_pack_duplicates=in_dup,
    )
    conn.execute("SAVEPOINT sp_pack_open")
    try:
        sim: dict[tuple[str, str], int] = {}
        for ref_canon, cat, slot in pairs:
            k = (cat, slot)
            if k not in sim:
                sim[k] = _get_qty(conn, cat, slot)
            before = sim[k]
            _set_qty_delta(conn, cat, slot, 1)
            sim[k] = before + 1
            detail = get_sticker(conn, cat, slot)
            entry = detail or {"ref": format_sticker_ref(cat, slot)}
            entry["qty_before"] = before
            entry["qty_after"] = before + 1
            if before == 0:
                result.added_as_new.append(entry)
            else:
                result.added_as_duplicate.append(entry)
        update_session_stats(conn, packs_delta=delta)
        conn.execute("RELEASE SAVEPOINT sp_pack_open")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT sp_pack_open")
        raise
    return result


@dataclass
class PackUndoResult:
    warnings: list[str] = field(default_factory=list)
    reverted: list[dict[str, Any]] = field(default_factory=list)


def reverse_pack_open(
    conn: sqlite3.Connection,
    sticker_refs: list[str],
    *,
    packs_opened_delta: int,
) -> PackUndoResult:
    """Undo a prior open_pack: remove one qty per listed ref and roll back packs_opened."""
    ensure_schema(conn)
    if not sticker_refs:
        raise ValueError("undo requires the same sticker list as the registered pack")
    if packs_opened_delta < 1:
        raise ValueError("packs_opened_delta must be >= 1")

    result = PackUndoResult()
    conn.execute("SAVEPOINT sp_pack_undo")
    try:
        for raw in sticker_refs:
            cat, slot = parse_sticker_ref(raw)
            ref = format_sticker_ref(cat, slot)
            before = _get_qty(conn, cat, slot)
            if before < 1:
                raise ValueError(f"cannot undo pack: {ref} qty is 0 (already changed or list mismatch)")
            _set_qty_delta(conn, cat, slot, -1)
            after = before - 1
            result.reverted.append({"ref": ref, "qty_before": before, "qty_after": after})
        update_session_stats(conn, packs_delta=-packs_opened_delta)
        conn.execute("RELEASE SAVEPOINT sp_pack_undo")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT sp_pack_undo")
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


def reverse_trade(
    conn: sqlite3.Connection,
    forward_give: list[str],
    forward_take: list[str],
) -> TradeResult:
    """
    Undo a prior ``execute_trade(forward_give, forward_take, ...)``:
    restore each forward_give slot (+1) and remove each forward_take slot (-1),
    and roll back session trade counters for that forward trade.
    """
    ensure_schema(conn)
    result = TradeResult()
    if not forward_give or not forward_take:
        raise ValueError("undo requires non-empty give and take lists from the forward trade")

    take_pairs: list[tuple[str, str, str]] = []
    for ref in forward_take:
        cat, slot = parse_sticker_ref(ref)
        q = _get_qty(conn, cat, slot)
        if q < 1:
            raise TradeImpossibleError(
                f"cannot undo: {ref} qty is 0 (already removed or trade did not add it)",
            )
        take_pairs.append((ref, cat, slot))

    give_pairs: list[tuple[str, str, str]] = []
    for ref in forward_give:
        cat, slot = parse_sticker_ref(ref)
        give_pairs.append((ref, cat, slot))

    conn.execute("SAVEPOINT sp_trade_undo")
    try:
        for ref, cat, slot in take_pairs:
            before = _get_qty(conn, cat, slot)
            _set_qty_delta(conn, cat, slot, -1)
            result.gave.append({"ref": ref, "qty_before": before, "qty_after": before - 1})
        for ref, cat, slot in give_pairs:
            before = _get_qty(conn, cat, slot)
            _set_qty_delta(conn, cat, slot, +1)
            result.received.append({"ref": ref, "qty_before": before, "qty_after": before + 1})
        update_session_stats(
            conn,
            traded_out_delta=-len(forward_give),
            traded_in_delta=-len(forward_take),
        )
        conn.execute("RELEASE SAVEPOINT sp_trade_undo")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT sp_trade_undo")
        raise
    return result
