"""Read-only checklist metadata (player names, teams) keyed by app ref."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent / "data" / "checklist_context.json"


@lru_cache(maxsize=1)
def _load_catalog() -> dict[str, Any]:
    if not _DATA_PATH.is_file():
        return {"by_ref": {}, "source": ""}
    with _DATA_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def checklist_source() -> str:
    return str(_load_catalog().get("source", "")).strip()


def checklist_context_for(category_code: str, slot_code: str) -> dict[str, str] | None:
    """Return ``{name, team}`` for a catalog slot, or None if unknown."""
    key = f"{category_code.upper()}:{str(slot_code).strip()}"
    row = _load_catalog().get("by_ref", {}).get(key)
    if not isinstance(row, dict):
        return None
    name = str(row.get("name", "")).strip()
    team = str(row.get("team", "")).strip()
    if not name and not team:
        return None
    out: dict[str, str] = {}
    if name:
        out["name"] = name
    if team:
        out["team"] = team
    return out


def attach_checklist_context(item: dict[str, Any], category_code: str, slot_code: str) -> None:
    """Add optional ``checklist_*`` fields to a sticker row dict (in place)."""
    ctx = checklist_context_for(category_code, slot_code)
    if not ctx:
        return
    if "name" in ctx:
        item["checklist_name"] = ctx["name"]
    if "team" in ctx:
        item["checklist_team"] = ctx["team"]
    src = checklist_source()
    if src:
        item["checklist_source"] = src
