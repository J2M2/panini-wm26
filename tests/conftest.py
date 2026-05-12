"""Pytest fixtures."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from init_db import seed  # noqa: E402


@pytest.fixture
def db_conn(tmp_path):
    from panini_service.migrate import ensure_schema

    p = tmp_path / "test.sqlite"
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    seed(conn, album_owned=True)
    ensure_schema(conn)
    conn.commit()
    try:
        yield conn
    finally:
        conn.close()
