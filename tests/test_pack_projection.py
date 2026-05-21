"""Pack outlook Monte Carlo (toy model)."""

from __future__ import annotations

import random

from panini_service.inventory_ops import add_stickers, remove_stickers  # noqa: E402
from panini_service.pack_projection import (
    apply_trades_on_duplicates,
    effective_trade_p,
    network_reach,
    pack_outlook_projection,
    simulate_packs_one_trial,
)


def test_simulate_zero_missing_returns_zero():
    rng = random.Random(0)
    n = simulate_packs_one_trial(
        set(),
        initial_dupe_copies=[],
        n_slots=10,
        per_pack=5,
        trade_repeat_p=0.3,
        trading_partners=5,
        rng=rng,
        max_packs=100,
    )
    assert n == 0


def test_apply_trades_respects_probability():
    rng = random.Random(0)
    need = {0, 1, 2, 3, 4}
    dupes = [0] * 100
    after = apply_trades_on_duplicates(dupes, need, 0.0, rng)
    assert after == need
    after_all = apply_trades_on_duplicates(dupes, need, 1.0, rng)
    assert after_all == set()


def test_network_reach_scales_with_partners():
    assert network_reach(0) == 0.0
    assert network_reach(1) < network_reach(10)
    assert network_reach(20) <= 1.0


def test_higher_trade_rate_needs_fewer_packs():
    rng_lo = random.Random(99)
    rng_hi = random.Random(99)
    missing = set(range(50))
    dupes = [0] * 20
    lo = simulate_packs_one_trial(
        missing,
        initial_dupe_copies=dupes,
        n_slots=100,
        per_pack=7,
        trade_repeat_p=0.0,
        trading_partners=10,
        rng=rng_lo,
        max_packs=10_000,
    )
    hi = simulate_packs_one_trial(
        missing,
        initial_dupe_copies=dupes,
        n_slots=100,
        per_pack=7,
        trade_repeat_p=0.8,
        trading_partners=10,
        rng=rng_hi,
        max_packs=10_000,
    )
    assert lo > 0
    assert hi > 0
    assert hi < lo


def test_more_partners_needs_fewer_packs():
    rng_lo = random.Random(7)
    rng_hi = random.Random(7)
    missing = set(range(40))
    dupes = [0] * 15
    lo = simulate_packs_one_trial(
        missing,
        initial_dupe_copies=dupes,
        n_slots=100,
        per_pack=7,
        trade_repeat_p=0.5,
        trading_partners=1,
        rng=rng_lo,
        max_packs=10_000,
    )
    hi = simulate_packs_one_trial(
        missing,
        initial_dupe_copies=dupes,
        n_slots=100,
        per_pack=7,
        trade_repeat_p=0.5,
        trading_partners=15,
        rng=rng_hi,
        max_packs=10_000,
    )
    assert hi < lo


def test_effective_trade_p_combines_knobs():
    assert effective_trade_p(0.5, 0) == 0.0
    assert effective_trade_p(0.0, 10) == 0.0
    assert effective_trade_p(1.0, 10) == network_reach(10)


def test_pack_outlook_deterministic_seed(db_conn):
    remove_stickers(db_conn, "MEX:5", 1)
    db_conn.commit()
    r1 = pack_outlook_projection(
        db_conn, trade_repeat_p=0.2, trading_partners=5, per_pack=7, trials=400, seed=42
    )
    r2 = pack_outlook_projection(
        db_conn, trade_repeat_p=0.2, trading_partners=5, per_pack=7, trials=400, seed=42
    )
    assert r1["unique_slots_missing"] >= 1
    assert r1["p50_packs"] == r2["p50_packs"]
    assert r1["mean_packs"] == r2["mean_packs"]
    assert r1["trials_used"] == 400


def test_initial_spares_reduce_packs(db_conn):
    remove_stickers(db_conn, "MEX:5", 1)
    add_stickers(db_conn, "MEX:1", 5)
    db_conn.commit()
    none = pack_outlook_projection(
        db_conn, trade_repeat_p=0.0, trading_partners=5, per_pack=7, trials=200, seed=7
    )
    traded = pack_outlook_projection(
        db_conn, trade_repeat_p=1.0, trading_partners=5, per_pack=7, trials=200, seed=7
    )
    assert traded["p50_packs"] <= none["p50_packs"]
