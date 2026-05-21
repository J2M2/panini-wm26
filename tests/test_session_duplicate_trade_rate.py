"""Session duplicate trade rate helper."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from panini_service.session_store import session_duplicate_trade_rate  # noqa: E402


def test_session_duplicate_trade_rate_none_when_empty_pool():
    assert session_duplicate_trade_rate(0, 0) is None


def test_session_duplicate_trade_rate_computed():
    assert session_duplicate_trade_rate(3, 7) == 0.3
    assert session_duplicate_trade_rate(10, 0) == 1.0
    assert session_duplicate_trade_rate(0, 5) == 0.0
