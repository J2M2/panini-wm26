"""Toy Monte Carlo: random packs + idealized duplicate trades for remaining album slots.

Each pack draws ``per_pack`` i.i.d. uniform slots over the album. Duplicates — from your
starting inventory or from a pack — are independently traded with probability
``trade_repeat_p`` for a random still-missing slot (idealized: you always find a match).

Real packs and trades are not uniform — treat outputs as rough guidance only.
"""

from __future__ import annotations

import random
import sqlite3
import statistics
from typing import Any

from panini_service.queries import inventory_metrics


def load_album_state(conn: sqlite3.Connection) -> tuple[set[int], int]:
    """Sticker ids are 1..N in catalog row order; map to 0..N-1 index for simulation."""
    rows = conn.execute(
        """
        SELECT s.id, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        ORDER BY s.id
        """
    ).fetchall()
    missing: set[int] = set()
    spares = 0
    for r in rows:
        idx = int(r["id"]) - 1
        qty = int(r["qty"])
        if qty < 1:
            missing.add(idx)
        elif qty > 1:
            spares += qty - 1
    return missing, spares


def apply_trades_on_duplicates(
    n_dupes: int,
    need: set[int],
    trade_repeat_p: float,
    rng: random.Random,
) -> set[int]:
    """Each duplicate independently trades with probability ``trade_repeat_p``."""
    if n_dupes <= 0 or not need or trade_repeat_p <= 0.0:
        return need
    still = set(need)
    for _ in range(n_dupes):
        if not still:
            break
        if rng.random() < trade_repeat_p:
            still.remove(rng.choice(tuple(still)))
    return still


def simulate_packs_one_trial(
    missing: set[int],
    *,
    initial_spares: int,
    n_slots: int,
    per_pack: int,
    trade_repeat_p: float,
    rng: random.Random,
    max_packs: int,
) -> int:
    need = apply_trades_on_duplicates(initial_spares, set(missing), trade_repeat_p, rng)
    if not need:
        return 0
    packs = 0
    while need:
        packs += 1
        if packs > max_packs:
            return -1
        pack_dupes = 0
        for _ in range(per_pack):
            j = rng.randrange(n_slots)
            if j in need:
                need.remove(j)
            else:
                pack_dupes += 1
        need = apply_trades_on_duplicates(pack_dupes, need, trade_repeat_p, rng)
    return packs


def percentile_sorted(sorted_x: list[int], p: float) -> float:
    if not sorted_x:
        return 0.0
    k = (len(sorted_x) - 1) * p
    f = int(k)
    c = k - f
    if f + 1 < len(sorted_x):
        return sorted_x[f] * (1 - c) + sorted_x[f + 1] * c
    return float(sorted_x[f])


def run_monte_carlo(
    missing: set[int],
    *,
    initial_spares: int,
    n_slots: int,
    per_pack: int,
    trade_repeat_p: float,
    trials: int,
    seed: int | None,
    max_packs: int,
) -> tuple[list[int], str | None]:
    rng = random.Random(seed)
    results: list[int] = []
    truncated = False
    for _ in range(trials):
        r = simulate_packs_one_trial(
            missing,
            initial_spares=initial_spares,
            n_slots=n_slots,
            per_pack=per_pack,
            trade_repeat_p=trade_repeat_p,
            rng=rng,
            max_packs=max_packs,
        )
        if r < 0:
            truncated = True
            continue
        results.append(r)
    msg = None
    if truncated:
        msg = (
            f"Some trials exceeded max_packs ({max_packs}); increase the cap or lower trials — "
            "results may be biased low."
        )
    return results, msg


def pack_outlook_projection(
    conn: sqlite3.Connection,
    *,
    trade_repeat_p: float,
    per_pack: int = 7,
    trials: int = 1200,
    seed: int | None = None,
    max_packs: int = 500_000,
) -> dict[str, Any]:
    """
    ``trade_repeat_p``: share of duplicate stickers successfully traded (0–1). Each duplicate
    — from starting inventory or from a pack — is an independent idealized trade try.
    """
    p = max(0.0, min(1.0, float(trade_repeat_p)))
    trials = max(50, min(10_000, int(trials)))
    per_pack = max(1, min(50, int(per_pack)))

    m = inventory_metrics(conn)
    n_slots = int(m["album_unique_slots"])
    missing_n = int(m["unique_slots_missing"])
    spare_copies = int(m["spare_copies"])
    if missing_n <= 0:
        return {
            "album_unique_slots": n_slots,
            "unique_slots_missing": 0,
            "pct_complete_unique": float(m["pct_complete_unique"]),
            "spare_copies": spare_copies,
            "session_packs_opened": int(m["session"]["packs_opened"]),
            "per_pack": per_pack,
            "trade_repeat_p": p,
            "trials_requested": trials,
            "trials_used": 0,
            "p50_packs": 0.0,
            "p90_packs": 0.0,
            "mean_packs": 0.0,
            "p50_stickers": 0,
            "p90_stickers": 0,
            "mean_stickers": 0.0,
            "truncated_note": None,
            "disclaimer": (
                "Toy uniform-pack model only; real Panini distribution and your trading network differ."
            ),
        }

    need, initial_spares = load_album_state(conn)
    results, warn = run_monte_carlo(
        need,
        initial_spares=initial_spares,
        n_slots=n_slots,
        per_pack=per_pack,
        trade_repeat_p=p,
        trials=trials,
        seed=seed,
        max_packs=max_packs,
    )
    results.sort()
    used = len(results)
    p50 = percentile_sorted(results, 0.50) if used else 0.0
    p90 = percentile_sorted(results, 0.90) if used else 0.0
    mean_p = float(statistics.mean(results)) if used else 0.0

    return {
        "album_unique_slots": n_slots,
        "unique_slots_missing": missing_n,
        "pct_complete_unique": float(m["pct_complete_unique"]),
        "spare_copies": spare_copies,
        "session_packs_opened": int(m["session"]["packs_opened"]),
        "per_pack": per_pack,
        "trade_repeat_p": p,
        "trials_requested": trials,
        "trials_used": used,
        "p50_packs": round(p50, 1),
        "p90_packs": round(p90, 1),
        "mean_packs": round(mean_p, 1),
        "p50_stickers": int(round(p50 * per_pack)),
        "p90_stickers": int(round(p90 * per_pack)),
        "mean_stickers": round(mean_p * per_pack, 1),
        "truncated_note": warn,
        "disclaimer": (
            "Toy model: random stickers per pack; the slider is the share of duplicates "
            "successfully traded for missing slots. Not financial or completion advice — "
            "use for ballpark sense only."
        ),
    }
