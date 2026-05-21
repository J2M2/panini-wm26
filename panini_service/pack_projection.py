"""Toy Monte Carlo: random packs + idealized duplicate trades for remaining album slots.

Each pack draws ``per_pack`` i.i.d. uniform slots over the album. Duplicate copies — from
starting inventory or from a pack — each get one trade try. A try succeeds with probability
``trade_repeat_p × network_reach(trading_partners)`` and fills one random missing slot
(idealized: you always find a fair swap).

Real packs and trades are not uniform — treat outputs as rough guidance only.
"""

from __future__ import annotations

import math
import random
import sqlite3
import statistics
from typing import Any

from panini_service.queries import inventory_metrics

# Partners at which network reach ≈ 63%; ~95% at 15 people.
_NETWORK_SCALE = 5.0


def network_reach(trading_partners: int) -> float:
    """How much of the missing-sticker market your contacts cover (0–1)."""
    n = max(0, int(trading_partners))
    if n <= 0:
        return 0.0
    return 1.0 - math.exp(-n / _NETWORK_SCALE)


def effective_trade_p(trade_repeat_p: float, trading_partners: int) -> float:
    """Share of duplicate copies that convert to missing slots after both knobs."""
    p = max(0.0, min(1.0, float(trade_repeat_p)))
    return p * network_reach(trading_partners)


def load_album_state(conn: sqlite3.Connection) -> tuple[set[int], list[int]]:
    """Return missing slot indices (0..N-1) and one entry per spare copy in inventory."""
    rows = conn.execute(
        """
        SELECT s.id, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        ORDER BY s.id
        """
    ).fetchall()
    missing: set[int] = set()
    dupe_copies: list[int] = []
    for r in rows:
        idx = int(r["id"]) - 1
        qty = int(r["qty"])
        if qty < 1:
            missing.add(idx)
        elif qty > 1:
            dupe_copies.extend([idx] * (qty - 1))
    return missing, dupe_copies


def apply_trades_on_duplicates(
    dupe_copies: list[int],
    need: set[int],
    effective_p: float,
    rng: random.Random,
) -> set[int]:
    """Each duplicate copy independently trades with probability ``effective_p``."""
    if not dupe_copies or not need or effective_p <= 0.0:
        return need
    still = set(need)
    for _ in dupe_copies:
        if not still:
            break
        if rng.random() < effective_p:
            still.remove(rng.choice(tuple(still)))
    return still


def simulate_packs_one_trial(
    missing: set[int],
    *,
    initial_dupe_copies: list[int],
    n_slots: int,
    per_pack: int,
    trade_repeat_p: float,
    trading_partners: int,
    rng: random.Random,
    max_packs: int,
) -> int:
    eff = effective_trade_p(trade_repeat_p, trading_partners)
    need = apply_trades_on_duplicates(initial_dupe_copies, set(missing), eff, rng)
    if not need:
        return 0
    packs = 0
    while need:
        packs += 1
        if packs > max_packs:
            return -1
        pack_dupes: list[int] = []
        for _ in range(per_pack):
            j = rng.randrange(n_slots)
            if j in need:
                need.remove(j)
            else:
                pack_dupes.append(j)
        need = apply_trades_on_duplicates(pack_dupes, need, eff, rng)
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
    initial_dupe_copies: list[int],
    n_slots: int,
    per_pack: int,
    trade_repeat_p: float,
    trading_partners: int,
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
            initial_dupe_copies=initial_dupe_copies,
            n_slots=n_slots,
            per_pack=per_pack,
            trade_repeat_p=trade_repeat_p,
            trading_partners=trading_partners,
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
    trading_partners: int = 5,
    per_pack: int = 7,
    trials: int = 1200,
    seed: int | None = None,
    max_packs: int = 500_000,
) -> dict[str, Any]:
    """
    ``trade_repeat_p``: share of duplicate copies you close when a match exists (0–1).
    ``trading_partners``: how many people you swap with; scales reach via ``network_reach``.
    """
    p = max(0.0, min(1.0, float(trade_repeat_p)))
    partners = max(0, min(50, int(trading_partners)))
    reach = network_reach(partners)
    eff = effective_trade_p(p, partners)
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
            "trading_partners": partners,
            "network_reach": round(reach, 4),
            "effective_trade_p": round(eff, 4),
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

    need, initial_dupes = load_album_state(conn)
    results, warn = run_monte_carlo(
        need,
        initial_dupe_copies=initial_dupes,
        n_slots=n_slots,
        per_pack=per_pack,
        trade_repeat_p=p,
        trading_partners=partners,
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
        "trading_partners": partners,
        "network_reach": round(reach, 4),
        "effective_trade_p": round(eff, 4),
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
            "Toy model: random stickers per pack; duplicate success × trading network reach. "
            "Not financial or completion advice — use for ballpark sense only."
        ),
    }
