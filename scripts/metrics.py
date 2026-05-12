#!/usr/bin/env python3
"""
Validate catalog/inventory structure and print metrics / rough projections.

Pack counts and trade counts you pass on the CLI are **reference only** (your notes).
They are **not** validated against sum(qty); mismatches are informational as your
collection grows (more packs, uneven trades, etc.).

**Probabilistic section** uses a *toy* model: each pack adds ``per_pack`` stickers,
each sticker independently uniform over all album slots (980). Real Panini packs
are not uniform (rarities, sheet layout) --- treat outputs as order-of-magnitude
guesses, not guarantees.

Import accounting (missing/dup CSVs on classic baseline qty=1 after optional empty lift):

  sum(qty) = 980 - (missing CSV cells) + (duplicate CSV cells)
"""

from __future__ import annotations

import argparse
import random
import sqlite3
import statistics
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_ROOT = _SCRIPTS_DIR.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from panini_catalog import expected_sticker_count  # noqa: E402
from panini_db import DEFAULT_DB_PATH, connect  # noqa: E402
from panini_service.constants import STICKERS_PER_PACK  # noqa: E402

ALBUM_UNIQUE_SLOTS = expected_sticker_count()


def validate(conn: sqlite3.Connection) -> list[str]:
    """Structural checks only; used for exit code."""
    errors: list[str] = []

    n_cat = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    if n_cat != 49:
        errors.append(f"Expected 49 categories (FWC + 48 teams), got {n_cat}")

    n_st = conn.execute("SELECT COUNT(*) FROM stickers").fetchone()[0]
    if n_st != ALBUM_UNIQUE_SLOTS:
        errors.append(f"Expected {ALBUM_UNIQUE_SLOTS} stickers in catalog, got {n_st}")

    n_inv = conn.execute("SELECT COUNT(*) FROM inventory").fetchone()[0]
    if n_inv != ALBUM_UNIQUE_SLOTS:
        errors.append(f"Expected {ALBUM_UNIQUE_SLOTS} inventory rows, got {n_inv}")

    orphan_inv = conn.execute(
        """
        SELECT COUNT(*) FROM inventory i
        LEFT JOIN stickers s ON s.id = i.sticker_id
        WHERE s.id IS NULL
        """
    ).fetchone()[0]
    if orphan_inv:
        errors.append(f"Inventory rows without sticker: {orphan_inv}")

    orphan_st = conn.execute(
        """
        SELECT COUNT(*) FROM stickers s
        LEFT JOIN inventory i ON i.sticker_id = s.id
        WHERE i.sticker_id IS NULL
        """
    ).fetchone()[0]
    if orphan_st:
        errors.append(f"Stickers without inventory row: {orphan_st}")

    bad_qty = conn.execute("SELECT COUNT(*) FROM inventory WHERE qty < 0").fetchone()[0]
    if bad_qty:
        errors.append(f"Negative qty rows: {bad_qty}")

    dup_pairs = conn.execute(
        """
        SELECT category_code, slot_code, COUNT(*) AS c
        FROM stickers
        GROUP BY category_code, slot_code
        HAVING c > 1
        """
    ).fetchall()
    if dup_pairs:
        errors.append(f"Duplicate (category, slot) in stickers: {len(dup_pairs)}")

    return errors


def metrics(conn: sqlite3.Connection) -> dict[str, int | float]:
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
    total_physical = int(row["total_physical"] or 0)
    unique_filled = int(row["unique_slots_filled"] or 0)
    unique_missing = int(row["unique_slots_missing"] or 0)
    spare = int(row["spare_copies"] or 0)
    slots_dup = int(row["slots_with_duplicates"] or 0)

    pct = 100.0 * unique_filled / ALBUM_UNIQUE_SLOTS if ALBUM_UNIQUE_SLOTS else 0.0

    return {
        "total_physical": total_physical,
        "unique_slots_filled": unique_filled,
        "unique_slots_missing": unique_missing,
        "spare_copies": spare,
        "slots_with_duplicates": slots_dup,
        "album_unique_slots": ALBUM_UNIQUE_SLOTS,
        "pct_complete_unique": pct,
    }


def load_missing_indices(conn: sqlite3.Connection) -> set[int]:
    """Sticker ids are 1..N in row order; map to 0..N-1 index for simulation."""
    rows = conn.execute(
        """
        SELECT s.id, i.qty
        FROM stickers s
        JOIN inventory i ON i.sticker_id = s.id
        ORDER BY s.id
        """
    ).fetchall()
    missing: set[int] = set()
    for r in rows:
        idx = int(r["id"]) - 1
        if int(r["qty"]) < 1:
            missing.add(idx)
    return missing


def simulate_packs_one_trial(
    missing: set[int],
    *,
    n_slots: int,
    per_pack: int,
    trade_after_pack_prob: float,
    rng: random.Random,
    max_packs: int,
) -> int:
    """
    Toy model: each pack draws ``per_pack`` i.i.d. uniform slots in [0, n_slots).
    After each pack, with probability ``trade_after_pack_prob``, one uniformly
    chosen still-missing slot is filled (idealized successful trade).
    """
    need = set(missing)
    if not need:
        return 0
    packs = 0
    while need:
        packs += 1
        if packs > max_packs:
            return -1
        for _ in range(per_pack):
            j = rng.randrange(n_slots)
            if j in need:
                need.remove(j)
        if trade_after_pack_prob > 0.0 and rng.random() < trade_after_pack_prob and need:
            need.remove(rng.choice(tuple(need)))
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
    n_slots: int,
    per_pack: int,
    trade_after_pack_prob: float,
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
            n_slots=n_slots,
            per_pack=per_pack,
            trade_after_pack_prob=trade_after_pack_prob,
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
            f"Some trials exceeded --mc-max-packs ({max_packs}); "
            "increase limit or reduce trials -- results may be biased."
        )
    return results, msg


def main() -> None:
    parser = argparse.ArgumentParser(
        description="DB validation + inventory metrics + toy probabilistic projections.",
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--packs", type=int, default=100, help="Packs opened (informational note)")
    parser.add_argument(
        "--per-pack",
        type=int,
        default=STICKERS_PER_PACK,
        help="Stickers per pack (used in toy MC too)",
    )
    parser.add_argument(
        "--traded-out",
        type=int,
        default=0,
        help="Stickers you gave in trades (informational; not stored in DB)",
    )
    parser.add_argument(
        "--traded-in",
        type=int,
        default=0,
        help="Stickers you received in trades (informational)",
    )
    parser.add_argument(
        "--mc-trials",
        type=int,
        default=2000,
        help="Monte Carlo runs for pack/trade toy simulation",
    )
    parser.add_argument("--mc-seed", type=int, default=None, help="RNG seed for reproducibility")
    parser.add_argument(
        "--trade-hit-rate",
        type=float,
        default=0.0,
        metavar="P",
        help=(
            "Toy model only: after each simulated pack, probability P that you "
            "resolve one random still-missing slot (idealized trade). 0 = packs only."
        ),
    )
    parser.add_argument(
        "--mc-max-packs",
        type=int,
        default=500_000,
        help="Safety cap per trial (avoid infinite loops if misconfigured)",
    )
    parser.add_argument(
        "--no-mc",
        action="store_true",
        help="Skip Monte Carlo section",
    )
    args = parser.parse_args()

    errors: list[str] = []
    conn = connect(args.db)
    try:
        errors = validate(conn)
        m = metrics(conn)

        print("=== Inventory metrics ===")
        print(f"  Total physical stickers (sum of qty):     {m['total_physical']}")
        print(f"  Album slots required (unique):             {m['album_unique_slots']}")
        print(f"  Unique slots with >=1 copy:               {m['unique_slots_filled']} ({m['pct_complete_unique']:.1f}% of album)")
        print(f"  Unique slots still missing (qty=0):       {m['unique_slots_missing']}")
        print(f"  Spare / duplicate copies (sum max(qty-1,0)): {m['spare_copies']} across {m['slots_with_duplicates']} slots")
        print()

        expected_pulls = args.packs * args.per_pack
        print("=== Session notes (informational only, not validated) ===")
        print(f"  Packs opened (your note):                  {args.packs}")
        print(f"  Stickers per pack (your note):             {args.per_pack}")
        print(f"  Implied pulls from note:                   {expected_pulls}")
        print(f"  Traded out / in (your note):               {args.traded_out} / {args.traded_in}")
        net_note = expected_pulls + args.traded_in - args.traded_out
        print(f"  Net pulls if notes applied (rough):        {net_note}")
        print(f"  Current sum(qty) in DB:                    {m['total_physical']}")
        if m["total_physical"] != net_note:
            print("  (Difference vs notes is OK as you add packs, trades, or change imports.)")
        print()

        lhs = m["total_physical"]
        rhs = m["unique_slots_filled"] + m["spare_copies"]
        if lhs != rhs:
            errors.append(f"Internal check failed: total_physical ({lhs}) != filled+spares ({rhs})")

        print("=== Validation (structural only) ===")
        if not errors:
            print("  OK: catalog + inventory structure is consistent.")
            print(
                f"  OK: total_physical == unique_filled + spare_copies ({lhs} == {m['unique_slots_filled']} + {m['spare_copies']})"
            )
        else:
            print("  FAILED:")
            for e in errors:
                print(f"    - {e}")

        if not args.no_mc and m["unique_slots_missing"] > 0:
            print()
            print("=== Probabilistic projections (toy uniform model, NOT Panini-accurate) ===")
            print("  Assumes each pack sticker is uniform over 980 slots; real packs have skew / rarity.")
            missing_set = load_missing_indices(conn)
            trade_p = max(0.0, min(1.0, args.trade_hit_rate))
            trials = max(1, args.mc_trials)
            raw, mc_warn = run_monte_carlo(
                missing_set,
                n_slots=ALBUM_UNIQUE_SLOTS,
                per_pack=args.per_pack,
                trade_after_pack_prob=trade_p,
                trials=trials,
                seed=args.mc_seed,
                max_packs=args.mc_max_packs,
            )
            if not raw:
                print("  (No MC results; try --mc-max-packs.)")
            else:
                raw.sort()
                mean_p = statistics.mean(raw)
                med = statistics.median(raw)
                p10 = percentile_sorted(raw, 0.10)
                p90 = percentile_sorted(raw, 0.90)
                print(f"  Simulated extra packs to finish (from today): mean={mean_p:.0f}, median={med:.0f}")
                print(f"    10th / 90th percentile packs:               ~{p10:.0f} / ~{p90:.0f}")
                print(f"    (--mc-trials {trials}, per-pack {args.per_pack}, trade-hit-rate {trade_p})")
                if mc_warn:
                    print(f"  WARNING: {mc_warn}")
            if trade_p == 0.0:
                print(
                    "  Tip: set --trade-hit-rate 0.1 (for example) to model occasional successful trades after each pack."
                )

    finally:
        conn.close()

    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
