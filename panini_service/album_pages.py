"""Printed album page numbers (WM26) — manual index from the album contents page.

National teams: each team uses **two** consecutive printed pages: the **left** page
holds stickers **1–10**, the **right** page holds **11–20**. The number before each
team on the index is the **starting** (left) page.

FWC (internal slot 20 = physical sticker ``00``; internal 1–19 = album numbers 1–19):

- ``00`` / slot 20 → printed page **0**
- FWC stickers **1–4** → page **1**
- **5–6** → page **2**
- **7–8** → page **3**
- **9–10** → page **106**
- **11–13** → page **107**
- **14–15** → page **108**
- **16–19** → page **109**
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from panini_catalog import FWC_CODE, TEAM_CODES, fwc_album_code_for_internal_slot  # noqa: E402

# Contents-page index: printed page where each team's **left** (1–10) spread starts.
# Order matches ``TEAM_CODES`` (same row order as the physical index A→L blocks).
_TEAM_INDEX_START_PAGE: tuple[int, ...] = (
    8,
    10,
    12,
    14,
    16,
    18,
    20,
    22,
    24,
    26,
    28,
    30,
    32,
    34,
    36,
    38,
    40,
    42,
    44,
    46,
    48,
    50,
    52,
    54,
    58,
    60,
    62,
    64,
    66,
    68,
    70,
    72,
    74,
    76,
    78,
    80,
    82,
    84,
    86,
    88,
    90,
    92,
    94,
    96,
    98,
    100,
    102,
    104,
)

assert len(_TEAM_INDEX_START_PAGE) == len(TEAM_CODES), "team page list must match TEAM_CODES"


def printed_album_page(category_code: str, slot_code: str) -> int:
    """One printed page number for this sticker (0-based page 0 for FWC 00 is allowed)."""
    cat = category_code.upper()
    s = int(str(slot_code).strip())
    if cat == FWC_CODE:
        return _fwc_printed_page(s)
    if cat not in TEAM_CODES:
        raise ValueError(f"unknown team {category_code!r}")
    start = _TEAM_INDEX_START_PAGE[TEAM_CODES.index(cat)]
    if 1 <= s <= 10:
        return start
    if 11 <= s <= 20:
        return start + 1
    raise ValueError(f"invalid team slot {slot_code!r}")


def _fwc_printed_page(internal_slot: int) -> int:
    """FWC internal slot 1–20 (20 = album sticker 00) → printed album page."""
    if internal_slot == 20:
        return 0
    if 1 <= internal_slot <= 4:
        return 1
    if 5 <= internal_slot <= 6:
        return 2
    if 7 <= internal_slot <= 8:
        return 3
    if 9 <= internal_slot <= 10:
        return 106
    if 11 <= internal_slot <= 13:
        return 107
    if 14 <= internal_slot <= 15:
        return 108
    if 16 <= internal_slot <= 19:
        return 109
    raise ValueError(f"invalid FWC internal slot {internal_slot!r}")


def album_index_group(category_code: str) -> str | None:
    """Album contents index group A-L; four teams per group. ``None`` for FWC."""
    cat = category_code.upper()
    if cat == FWC_CODE or cat not in TEAM_CODES:
        return None
    idx = TEAM_CODES.index(cat)
    return chr(ord("A") + idx // 4)


_ROLE_LABEL: dict[str, str] = {
    "shield": "Shield",
    "team_photo": "Team photo",
    "fwc_special": "FWC special (00)",
    "fwc": "FWC",
}


def _role_line(role: str | None) -> str:
    if not role:
        return "Player slot"
    return _ROLE_LABEL.get(role, str(role))


def album_list_hover_hint(category_code: str, slot_code: str, role: str | None) -> str:
    """Single-line hint for list row tooltips; mirrors lookup facts without parentheses."""
    cat = category_code.upper()
    sc = str(slot_code).strip()
    page = printed_album_page(cat, sc)
    rl = _role_line(role)
    if cat == FWC_CODE:
        ac = fwc_album_code_for_internal_slot(sc)
        paste = f"FWC {ac} | p.{page}"
        return f"Page {page} | {rl} | {paste} | {fwc_index_blurb(int(sc))}"
    g = album_index_group(cat)
    n = TEAM_CODES.index(cat) + 1
    spread = "stickers 1-10" if int(sc) <= 10 else "stickers 11-20"
    paste = f"{cat} {sc} | p.{page}"
    return f"Page {page} | Group {g} | Team #{n}/48 | {spread} | {rl} | {paste}"


def team_spread_description(slot_code: str) -> str:
    """Which side of the team's two-page spread (slots 1-10 vs 11-20)."""
    s = int(str(slot_code).strip())
    if s <= 10:
        return "left page, stickers 1-10"
    return "right page, stickers 11-20"


def fwc_index_blurb(internal_slot: int) -> str:
    """Short reminder of front/back FWC page clusters."""
    p = _fwc_printed_page(internal_slot)
    if p <= 3:
        return "FWC block at the front of the album (printed pages 0-3; 00 on page 0; slots 1-8 on pages 1-3)."
    return "FWC block near the back of the album (printed pages 106-109)."
