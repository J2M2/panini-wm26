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
