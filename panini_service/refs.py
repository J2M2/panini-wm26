"""Parse sticker references like MEX:5, FWC:00 (album) -> internal slot 20."""

from __future__ import annotations

import re
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from panini_catalog import FWC_CODE, TEAM_CODES, fwc_slot_codes, team_slot_codes  # noqa: E402

ALLOWED_FWC = set(fwc_slot_codes())
ALLOWED_TEAM = set(team_slot_codes())
_ZEROISH = re.compile(r"^0+$")
_ALL_CATEGORIES = {FWC_CODE} | set(TEAM_CODES)


def is_album_only_00_shorthand(token: str) -> bool:
    """True when `token` is only the album-printed sticker **00** (single URL segment)."""
    s = token.strip()
    return bool(_ZEROISH.match(s)) or s in ("00", "0")


def fwc_album_cell_to_internal(s: str) -> str:
    """Album FWC **00** -> internal **20**; **1-19** unchanged; **20** -> **20**."""
    s = s.strip()
    if _ZEROISH.match(s) or s in ("00", "0"):
        return "20"
    n = int(s)
    if n == 0:
        return "20"
    if n == 20:
        return "20"
    if 1 <= n <= 19:
        return str(n)
    raise ValueError(f"FWC album number must be 00/0 or 1-20, got {s!r}")


def validate_slot(category: str, slot_code: str) -> None:
    if category == FWC_CODE:
        if slot_code not in ALLOWED_FWC:
            raise ValueError(f"Invalid FWC slot {slot_code!r}")
    elif category in TEAM_CODES:
        if slot_code not in ALLOWED_TEAM:
            raise ValueError(f"Invalid team slot {slot_code!r}; need 1-20")
    else:
        raise ValueError(f"Unknown category {category!r}")


def parse_sticker_ref(ref: str) -> tuple[str, str]:
    """
    Accept CATEGORY:SLOT with CATEGORY = FWC or team code.
    FWC accepts album 00/0 as slot 20.
    """
    s = ref.strip()
    if ":" not in s:
        raise ValueError("Sticker ref must be CATEGORY:SLOT (e.g. MEX:5 or FWC:00)")
    cat_raw, slot_raw = s.split(":", 1)
    cat = cat_raw.strip().upper()
    slot_raw = slot_raw.strip()
    if cat not in _ALL_CATEGORIES:
        raise ValueError(f"Unknown category {cat!r}; use FWC or a team code")
    if cat == FWC_CODE:
        slot = fwc_album_cell_to_internal(slot_raw)
    else:
        try:
            n = int(slot_raw)
        except ValueError as e:
            raise ValueError(f"Team slot must be integer 1-20, got {slot_raw!r}") from e
        slot = str(n)
    validate_slot(cat, slot)
    return cat, slot


def parse_category_slot_path(category: str, slot: str) -> tuple[str, str]:
    """For URL path segments (slot may be 00 for FWC album)."""
    cat = category.strip().upper()
    if cat not in _ALL_CATEGORIES:
        raise ValueError(f"Unknown category {cat!r}")
    slot = slot.strip()
    if cat == FWC_CODE:
        slot_code = fwc_album_cell_to_internal(slot)
    else:
        slot_code = str(int(slot))
    validate_slot(cat, slot_code)
    return cat, slot_code


def format_sticker_ref(category_code: str, slot_code: str) -> str:
    """Canonical ref string for API (FWC slot 20 stays as FWC:20 internally)."""
    return f"{category_code}:{slot_code}"
