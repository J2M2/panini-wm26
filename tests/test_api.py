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
    assert "Printed album page 0" in (data.get("album_location") or "")
    assert data.get("album_team_ordinal") is None
    assert data.get("album_index_group") is None


def test_sticker_team_album_hints(client):
    r = client.get("/stickers/MEX/1")
    assert r.status_code == 200
    data = r.json()
    assert data.get("album_paste_line") == "MEX 1 | p.8"
    assert data.get("album_printed_page") == 8
    assert "MEX" in (data.get("album_location") or "")
    assert data.get("album_team_ordinal") == 1
    assert data.get("album_index_group") == "A"
    assert "Group A" in (data.get("album_location") or "")

    r11 = client.get("/stickers/MEX/11")
    assert r11.status_code == 200
    d11 = r11.json()
    assert d11.get("album_printed_page") == 9
    assert d11.get("album_paste_line") == "MEX 11 | p.9"


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
    assert len(teams) == 48
    row0 = teams[0]
    assert "code" in row0
    assert "pct_complete" in row0
    assert "shield_ok" in row0
    assert "team_photo_ok" in row0
