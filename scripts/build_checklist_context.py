#!/usr/bin/env python3
"""Build slim checklist context JSON keyed by app ref (category:slot)."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from panini_catalog import FWC_CODE, TEAM_CODES, fwc_slot_codes, team_slot_codes  # noqa: E402

RAW_DEFAULT = ROOT / "raw_temp_json_stickers_data.json"
OUT = ROOT / "panini_service" / "data" / "checklist_context.json"


def json_code_to_ref(code: str) -> str | None:
    code = code.strip()
    if code == "00":
        return f"{FWC_CODE}:20"
    m = re.match(r"^([A-Z]{2,4})(\d+)$", code)
    if not m:
        return None
    return f"{m.group(1)}:{m.group(2)}"


def main() -> None:
    raw_path = Path(sys.argv[1]) if len(sys.argv) > 1 else RAW_DEFAULT
    if not raw_path.is_file():
        raise SystemExit(f"Raw checklist not found: {raw_path}")

    with raw_path.open(encoding="utf-8") as f:
        raw = json.load(f)

    by_ref: dict[str, dict[str, str]] = {}
    skipped = 0
    for row in raw.get("stickers", []):
        ref = json_code_to_ref(str(row.get("code", "")))
        if ref is None:
            skipped += 1
            continue
        by_ref[ref] = {
            "name": str(row.get("name", "")).strip(),
            "team": str(row.get("team", "")).strip(),
        }

    expected = {
        f"{FWC_CODE}:{slot}" for slot in fwc_slot_codes()
    } | {
        f"{team}:{slot}" for team in TEAM_CODES for slot in team_slot_codes()
    }
    missing = sorted(expected - set(by_ref))
    if missing:
        raise SystemExit(f"Checklist missing {len(missing)} album refs, e.g. {missing[:5]}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "source": raw.get("source", "laststicker.com"),
        "edition": raw.get("edition", ""),
        "by_ref": by_ref,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(by_ref)} refs to {OUT} (skipped {skipped} non-album codes)")


if __name__ == "__main__":
    main()
