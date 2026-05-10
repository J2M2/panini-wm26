"""Sticker ref parsing."""

from __future__ import annotations

import pytest

from panini_service.refs import format_sticker_ref, parse_sticker_ref


def test_fwc_00_is_slot_20():
    assert parse_sticker_ref("FWC:00") == ("FWC", "20")
    assert parse_sticker_ref("FWC:0") == ("FWC", "20")


def test_team_slot():
    assert parse_sticker_ref("MEX:13") == ("MEX", "13")


def test_format_roundtrip():
    c, s = parse_sticker_ref("FWC:19")
    assert format_sticker_ref(c, s) == "FWC:19"


def test_bad_category():
    with pytest.raises(ValueError):
        parse_sticker_ref("XXX:1")
