"""Pack outlook Monte Carlo (toy model)."""

from __future__ import annotations

import random

from panini_service.inventory_ops import remove_stickers  # noqa: E402
from panini_service.pack_projection import pack_outlook_projection, simulate_packs_one_trial


def test_simulate_zero_missing_returns_zero():
    rng = random.Random(0)
    n = simulate_packs_one_trial(set(), n_slots=10, per_pack=5, trade_repeat_p=0.3, rng=rng, max_packs=100)
    assert n == 0


def test_pack_outlook_deterministic_seed(db_conn):
    remove_stickers(db_conn, "MEX:5", 1)
    db_conn.commit()
    r1 = pack_outlook_projection(db_conn, trade_repeat_p=0.2, per_pack=7, trials=400, seed=42)
    r2 = pack_outlook_projection(db_conn, trade_repeat_p=0.2, per_pack=7, trials=400, seed=42)
    assert r1["unique_slots_missing"] >= 1
    assert r1["p50_packs"] == r2["p50_packs"]
    assert r1["mean_packs"] == r2["mean_packs"]
    assert r1["trials_used"] == 400
