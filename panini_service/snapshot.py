"""Full album snapshot export/import (inventory + optional session metadata)."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sqlite3

_ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = _ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from panini_catalog import (  # noqa: E402
    FWC_CODE,
    expected_sticker_count,
    fwc_album_code_for_internal_slot,
)

from panini_service.db import sticker_id_for  # noqa: E402
from panini_service.migrate import ensure_schema  # noqa: E402
from panini_service.session_store import get_session_stats, set_session_stats  # noqa: E402

# v2: categories + stickers (no session). v3: adds session block.
SNAPSHOT_SCHEMA_VERSION = 3


def build_full_snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    """Export categories, all sticker rows with qty, album_code for FWC, and session_stats."""
    categories = [
        dict(r)
        for r in conn.execute("SELECT code, kind, name FROM categories ORDER BY kind, code").fetchall()
    ]
    stickers: list[dict[str, Any]] = []
    for r in conn.execute(
        """
        SELECT s.id, s.category_code, s.slot_code, s.role, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        ORDER BY s.id
        """
    ).fetchall():
        row = {
            "id": int(r["id"]),
            "category_code": r["category_code"],
            "slot_code": r["slot_code"],
            "role": r["role"],
            "qty": int(r["qty"]),
        }
        if r["category_code"] == FWC_CODE:
            row["album_code"] = fwc_album_code_for_internal_slot(r["slot_code"])
        stickers.append(row)

    n = len(stickers)
    expected = expected_sticker_count()
    if n != expected:
        raise RuntimeError(f"Sticker row count {n} != expected {expected}")

    sess = get_session_stats(conn)
    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "categories": categories,
        "stickers": stickers,
        "session": {
            "packs_opened": sess.packs_opened,
            "traded_out_count": sess.traded_out_count,
            "traded_in_count": sess.traded_in_count,
        },
    }


def import_album_snapshot(
    conn: sqlite3.Connection,
    data: dict[str, Any],
    *,
    apply_session: bool = True,
) -> dict[str, Any]:
    """
    Restore inventory from snapshot. Session counters are updated only when
    ``apply_session`` is True and the snapshot includes a ``session`` object.
    """
    ensure_schema(conn)
    ver = int(data.get("schema_version", 0))
    if ver < 2:
        raise ValueError(f"Unsupported schema_version {ver}; need >= 2")

    stickers_in = data.get("stickers")
    if not isinstance(stickers_in, list) or not stickers_in:
        raise ValueError("Snapshot must contain a non-empty 'stickers' array")

    incoming: dict[tuple[str, str], int] = {}
    for s in stickers_in:
        try:
            cat = s["category_code"]
            slot = str(s["slot_code"])
            incoming[(cat, slot)] = int(s["qty"])
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"Invalid sticker entry: {s!r}") from e

    catalog_rows = conn.execute("SELECT category_code, slot_code FROM stickers").fetchall()
    expected_keys = {(r["category_code"], r["slot_code"]) for r in catalog_rows}
    if set(incoming.keys()) != expected_keys:
        missing = expected_keys - set(incoming.keys())
        extra = set(incoming.keys()) - expected_keys
        raise ValueError(
            f"Sticker keys must match catalog exactly: missing {len(missing)} entries, "
            f"extra {len(extra)} entries"
        )

    warnings: list[str] = []
    session_updated = False

    conn.execute("SAVEPOINT snapshot_import")
    try:
        for r in catalog_rows:
            cat, slot = r["category_code"], r["slot_code"]
            qty = incoming[(cat, slot)]
            if qty < 0:
                raise ValueError(f"Negative qty for {cat}:{slot}")
            sid = sticker_id_for(conn, cat, slot)
            if sid is None:
                raise RuntimeError(f"No sticker id for {cat}:{slot}")
            conn.execute("UPDATE inventory SET qty = ? WHERE sticker_id = ?", (qty, sid))

        if apply_session:
            sess = data.get("session")
            if isinstance(sess, dict) and sess:
                set_session_stats(
                    conn,
                    packs_opened=int(sess.get("packs_opened", 0)),
                    traded_out_count=int(sess.get("traded_out_count", 0)),
                    traded_in_count=int(sess.get("traded_in_count", 0)),
                )
                session_updated = True
            else:
                warnings.append(
                    "Snapshot has no session block; packs/trade counters unchanged"
                )
        conn.execute("RELEASE SAVEPOINT snapshot_import")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT snapshot_import")
        raise

    return {
        "imported_stickers": len(incoming),
        "session_updated": session_updated,
        "warnings": warnings,
    }
