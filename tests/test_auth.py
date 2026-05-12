"""Multi-user auth, album reset, and cookie-scoped DB."""

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
    with TestClient(app) as c:
        yield c


def test_auth_me_guest(client):
    r = client.get("/auth/me")
    assert r.status_code == 200
    data = r.json()
    assert data["mode"] == "guest"
    assert data["username"] is None
    assert data["user_id"] is None


def test_register_login_me_and_reset(client):
    r = client.post("/auth/register", json={"username": "alice_test", "password": "hunter222"})
    assert r.status_code == 200
    assert r.json()["username"] == "alice_test"

    r2 = client.get("/auth/me")
    assert r2.json()["mode"] == "user"
    assert r2.json()["username"] == "alice_test"

    client.post("/stickers/add", json={"ref": "MEX:1", "count": 1})
    m = client.get("/metrics").json()
    assert m["unique_slots_filled"] >= 1

    r3 = client.post("/album/reset")
    assert r3.status_code == 200
    m2 = client.get("/metrics").json()
    assert m2["unique_slots_missing"] == m2["album_unique_slots"]

    client.post("/auth/logout")
    r4 = client.get("/auth/me")
    assert r4.json()["mode"] == "guest"


def test_login_bad_password(client):
    client.post("/auth/register", json={"username": "bob_test", "password": "correcthorse"})
    client.cookies.clear()
    r = client.post("/auth/login", json={"username": "bob_test", "password": "wrongpassword"})
    assert r.status_code == 401


def test_login_invalid_username_format_returns_400(client):
    """Invalid username must not become a 500 (validate_username raises ValueError)."""
    r = client.post("/auth/login", json={"username": "ab", "password": "whatever12"})
    assert r.status_code == 400
    detail = r.json().get("detail", "")
    assert isinstance(detail, str)
    assert "lowercase" in detail.lower() or "24" in detail


def test_user_cap(monkeypatch):
    monkeypatch.setattr("panini_service.registry.count_users", lambda: 50)
    with TestClient(app) as c:
        r = c.post("/auth/register", json={"username": "newuser_cap", "password": "password88"})
        assert r.status_code == 400
        assert "50" in str(r.json())
