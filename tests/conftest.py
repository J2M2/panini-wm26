"""Pytest fixtures."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_test_panini_data = Path(tempfile.mkdtemp(prefix="panini-pytest-"))
os.environ.setdefault("PANINI_DATA_DIR", str(_test_panini_data))
os.environ.pop("PANINI_USE_LEGACY_DB", None)
_SCRIPTS = ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from panini_service.bootstrap_db import seed  # noqa: E402


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
