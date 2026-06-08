"""Checklist context enrichment (read-only metadata)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panini_service.sticker_context import (  # noqa: E402
    attach_checklist_context,
    checklist_context_for,
    checklist_source,
)


def test_checklist_source_present():
    assert "laststicker" in checklist_source().lower()


def test_checklist_context_team_player():
    ctx = checklist_context_for("MEX", "5")
    assert ctx is not None
    assert ctx["name"] == "Cesar Montes"
    assert ctx["team"] == "Mexico"


def test_checklist_context_fwc_special():
    ctx = checklist_context_for("FWC", "20")
    assert ctx is not None
    assert ctx["name"] == "Panini Logo"


def test_attach_checklist_context_mutates_item():
    item: dict = {}
    attach_checklist_context(item, "FWC", "14")
    assert item["checklist_name"] == "Argentina 1986"
    assert item["checklist_team"] == "FIFA World Cup History"
    assert "checklist_source" in item


@pytest.mark.parametrize("cat,slot", [("XXX", "99"), ("MEX", "0")])
def test_unknown_slot_returns_none(cat: str, slot: str):
    assert checklist_context_for(cat, slot) is None
