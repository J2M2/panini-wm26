"""Pack open and trade operations."""

from __future__ import annotations

import pytest

from panini_service.constants import STICKERS_PER_PACK
from panini_service.inventory_ops import (
    StrictTradeError,
    TradeImpossibleError,
    add_stickers,
    execute_trade,
    open_pack,
    remove_stickers,
)
from panini_service.session_store import get_session_stats


def test_open_pack_all_duplicates(db_conn):
    refs = ["FWC:1"] * STICKERS_PER_PACK
    r = open_pack(db_conn, refs, per_pack=STICKERS_PER_PACK)
    assert len(r.added_as_new) == 0
    assert len(r.added_as_duplicate) == 7
    db_conn.commit()
    s = get_session_stats(db_conn)
    assert s.packs_opened == 1


def test_open_pack_includes_new(db_conn):
    remove_stickers(db_conn, "FWC:3", 1)
    db_conn.commit()
    refs = ["FWC:3"] + ["FWC:1"] * (STICKERS_PER_PACK - 1)
    r = open_pack(db_conn, refs, per_pack=STICKERS_PER_PACK)
    assert len(r.added_as_new) == 1
    assert r.added_as_new[0]["slot_code"] == "3"
    assert len(r.added_as_duplicate) == 6


def test_trade_strict_fails_when_only_one_copy(db_conn):
    with pytest.raises(StrictTradeError):
        execute_trade(
            db_conn,
            ["MEX:1"],
            ["MEX:2"],
            strict_duplicates_only=True,
        )


def test_trade_cannot_give_zero(db_conn):
    remove_stickers(db_conn, "MEX:7", 1)
    db_conn.commit()
    with pytest.raises(TradeImpossibleError):
        execute_trade(db_conn, ["MEX:7"], ["MEX:8"])


def test_trade_success_updates_inventory(db_conn):
    add_stickers(db_conn, "MEX:1", 1)
    db_conn.commit()
    r = execute_trade(db_conn, ["MEX:1"], ["MEX:2"], strict_duplicates_only=False)
    assert len(r.warnings) == 0
    db_conn.commit()


def test_trade_non_strict_warns_last_copy(db_conn):
    remove_stickers(db_conn, "MEX:9", 1)
    add_stickers(db_conn, "MEX:9", 1)
    db_conn.commit()
    r = execute_trade(db_conn, ["MEX:9"], ["MEX:10"], strict_duplicates_only=False)
    assert any("non-duplicate" in w or "last copy" in w for w in r.warnings)
    db_conn.commit()


def test_trade_uneven_requires_flag(db_conn):
    add_stickers(db_conn, "MEX:1", 1)
    db_conn.commit()
    with pytest.raises(TradeImpossibleError):
        execute_trade(db_conn, ["MEX:1", "MEX:2"], ["MEX:3"], allow_uneven=False)


def test_trade_uneven_allowed(db_conn):
    add_stickers(db_conn, "MEX:1", 1)
    add_stickers(db_conn, "MEX:2", 1)
    db_conn.commit()
    r = execute_trade(
        db_conn,
        ["MEX:1", "MEX:2"],
        ["MEX:3"],
        strict_duplicates_only=False,
        allow_uneven=True,
    )
    assert len(r.gave) == 2
    assert len(r.received) == 1
