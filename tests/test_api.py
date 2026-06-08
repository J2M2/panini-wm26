"""Smoke tests for FastAPI app."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api.main import app  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_metrics(client):
    r = client.get("/metrics")
    assert r.status_code == 200
    data = r.json()
    assert "album_unique_slots" in data
    assert "session" in data
    assert "duplicate_trade_rate" in data["session"]


def test_lists_compact(client):
    r = client.get("/lists/missing", params={"format": "compact"})
    assert r.status_code == 200
    assert "Missing" in r.text

    r2 = client.get("/lists/duplicates", params={"format": "compact"})
    assert r2.status_code == 200
    assert "Duplicates" in r2.text


def test_lists_print(client):
    r = client.get("/lists/print")
    assert r.status_code == 200
    assert "Panini WM26" in r.text
    assert "Missing" in r.text


def test_sticker_00_solo(client):
    r = client.get("/stickers/00")
    assert r.status_code == 200
    data = r.json()
    assert data["category_code"] == "FWC"
    assert data["slot_code"] == "20"
    assert data.get("album_code") == "00"
    assert data.get("album_paste_line") == "FWC 00 | p.0"
    assert data.get("album_printed_page") == 0
    assert data.get("album_location") == "Page: 0"
    assert data.get("album_team_ordinal") is None
    assert data.get("album_index_group") is None


def test_sticker_team_album_hints(client):
    r = client.get("/stickers/MEX/1")
    assert r.status_code == 200
    data = r.json()
    assert data.get("album_paste_line") == "MEX 1 | p.8"
    assert data.get("album_printed_page") == 8
    assert data.get("album_location") == "Group: A\nPage: 8"
    assert data.get("album_team_ordinal") == 1
    assert data.get("album_index_group") == "A"

    r11 = client.get("/stickers/MEX/11")
    assert r11.status_code == 200
    d11 = r11.json()
    assert d11.get("album_printed_page") == 9
    assert d11.get("album_paste_line") == "MEX 11 | p.9"
    assert d11.get("album_location") == "Group: A\nPage: 9"


def test_sticker_checklist_context(client):
    r = client.get("/stickers/MEX/5")
    assert r.status_code == 200
    data = r.json()
    assert data.get("checklist_name") == "Cesar Montes"
    assert data.get("checklist_team") == "Mexico"
    assert "laststicker" in (data.get("checklist_source") or "").lower()


def test_lists_json_includes_album_hover(client):
    r = client.get("/lists/missing", params={"format": "json"})
    assert r.status_code == 200
    rows = r.json()
    assert isinstance(rows, list)
    if len(rows) > 0:
        assert "album_hover_hint" in rows[0]
        assert "album_printed_page" in rows[0]


def test_sticker_fwc_printed_pages(client):
    assert client.get("/stickers/FWC/1").json().get("album_printed_page") == 1
    assert client.get("/stickers/FWC/5").json().get("album_printed_page") == 2
    assert client.get("/stickers/FWC/9").json().get("album_printed_page") == 106
    assert client.get("/stickers/FWC/16").json().get("album_printed_page") == 109


def test_sticker_solo_not_team(client):
    r = client.get("/stickers/MEX")
    assert r.status_code == 404


def test_snapshot_get(client):
    r = client.get("/snapshot")
    assert r.status_code == 200
    data = r.json()
    assert data.get("schema_version") >= 3
    assert "session" in data
    assert len(data.get("stickers", [])) == 980


def test_catalog_sticker_refs(client):
    r = client.get("/catalog/sticker-refs")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data.get("refs"), list)
    assert len(data["refs"]) == 980
    assert "MEX:1" in data["refs"]
    assert "FWC:20" in data["refs"]


def test_lists_album_table(client):
    r = client.get("/lists/album-table")
    assert r.status_code == 200
    rows = r.json()
    assert isinstance(rows, list)
    assert len(rows) == 980
    assert rows[0].get("category_code") == "FWC"
    assert any(row.get("ref") == "MEX:1" for row in rows)


def test_analytics_team_progress_leaders(client):
    r = client.get("/analytics")
    assert r.status_code == 200
    data = r.json()
    mct = data.get("most_completed_team")
    assert mct is not None
    if mct.get("all_teams_complete"):
        assert mct.get("code") is None
        assert mct.get("pct_complete") == 100
        assert mct.get("tied") is False
    else:
        assert mct.get("code") is not None
        assert "slots_with_copy" in mct
        assert "slots_missing" in mct
        assert "pct_complete" in mct
        assert "tied" in mct
        assert isinstance(mct.get("codes"), list)

    mmt = data.get("most_missing_team")
    if mmt is not None:
        assert mmt.get("code") is not None
        assert "slots_missing" in mmt
        assert "tied" in mmt
        assert "tie_note" in mmt
        assert isinstance(mmt.get("codes"), list)

    mdt = data.get("most_duplicated_team")
    assert "most_duplicated_team" in data
    if mdt is not None:
        assert mdt.get("code") is not None
        assert "spare_copies" in mdt
        assert "slots_with_duplicates" in mdt
        assert "pct_slots_with_dup" in mdt
        assert "tied" in mdt
        assert "tie_note" in mdt
        assert isinstance(mdt.get("codes"), list)


def test_analytics_team_shield_photo(client):
    r = client.get("/analytics", params={"include": "team_shield_photo"})
    assert r.status_code == 200
    data = r.json()
    tsp = data.get("team_shield_photo")
    assert tsp is not None
    assert tsp["shield"]["total"] == 48
    assert tsp["team_photo"]["total"] == 48
    assert tsp["shield"]["with_copy"] + tsp["shield"]["missing"] == 48
    assert tsp["team_photo"]["with_copy"] + tsp["team_photo"]["missing"] == 48
    full = data.get("teams_fully_complete")
    assert full is not None
    assert full["teams_total"] == 48
    assert 0 <= full["teams_fully_complete"] <= 48
    assert full["pct_teams_fully_complete"] == round(100.0 * int(full["teams_fully_complete"]) / 48.0, 2)


def test_analytics_teams(client):
    r = client.get("/analytics/teams")
    assert r.status_code == 200
    data = r.json()
    teams = data.get("teams", [])
    # FWC specials page first, then the 48 national teams.
    assert len(teams) == 49
    row0 = teams[0]
    assert row0["code"] == "FWC"
    assert row0["kind"] == "fwc"
    assert row0["shield_ok"] is False
    assert row0["team_photo_ok"] is False
    assert "pct_complete" in row0
    assert "total_stickers" in row0
    assert isinstance(row0["total_stickers"], int)
    national = teams[1:]
    assert len(national) == 48
    assert all(t["kind"] == "team" for t in national)
    assert all("shield_ok" in t and "team_photo_ok" in t for t in national)


def test_album_sticker_type_label_and_hover():
    from panini_service.album_pages import album_list_hover_hint, album_sticker_type_label

    assert album_sticker_type_label("MEX", "shield") == "Shield"
    assert album_sticker_type_label("MEX", "team_photo") == "Team picture"
    assert album_sticker_type_label("MEX", None) == "Player"
    assert album_sticker_type_label("FWC", "fwc_special") == "Special"
    assert album_sticker_type_label("FWC", "fwc") == "Special"
    assert "Type: Shield" in album_list_hover_hint("MEX", "1", "shield")
    assert "Type: Special" in album_list_hover_hint("FWC", "20", "fwc_special")
    assert "Type: Special" in album_list_hover_hint("FWC", "1", "fwc")
