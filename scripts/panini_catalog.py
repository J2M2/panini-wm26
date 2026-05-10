"""
Canonical WM26 album catalog: 980 stickers = FWC (20) + 48 teams × 20.

FWC is stored like teams: internal slot codes "1"–"20". Slot "20" is the physical
sticker printed as **00** only (no FWC prefix on the album); UI can map via
`fwc_album_code_for_internal_slot`. Slots "1"–"19" are the other FWC stickers.

Team: slots 1–20 (1 = shield, 13 = team photo).
"""

from __future__ import annotations

TEAM_CODES: list[str] = [
    "MEX",
    "RSA",
    "KOR",
    "CZE",
    "CAN",
    "BIH",
    "QAT",
    "SUI",
    "BRA",
    "MAR",
    "HAI",
    "SCO",
    "USA",
    "PAR",
    "AUS",
    "TUR",
    "GER",
    "CUW",
    "CIV",
    "ECU",
    "NED",
    "JPN",
    "SWE",
    "TUN",
    "BEL",
    "EGY",
    "IRN",
    "NZL",
    "ESP",
    "CPV",
    "KSA",
    "URU",
    "FRA",
    "SEN",
    "IRQ",
    "NOR",
    "ARG",
    "ALG",
    "AUT",
    "JOR",
    "POR",
    "COD",
    "UZB",
    "COL",
    "ENG",
    "CRO",
    "GHA",
    "PAN",
]

FWC_CODE = "FWC"


def fwc_slot_codes() -> list[str]:
    """Internal FWC slots 1–20 (same shape as a team page); 20 = album sticker 00."""
    return [str(i) for i in range(1, 21)]


def fwc_album_code_for_internal_slot(slot_code: str) -> str:
    """Printed album code for UI (physical **00** is stored as internal slot "20")."""
    if slot_code == "20":
        return "00"
    return slot_code


def team_slot_codes() -> list[str]:
    return [str(i) for i in range(1, 21)]


def expected_sticker_count() -> int:
    return len(fwc_slot_codes()) + len(TEAM_CODES) * len(team_slot_codes())


def team_role_for_slot(slot_code: str) -> str | None:
    if slot_code == "1":
        return "shield"
    if slot_code == "13":
        return "team_photo"
    return None


def fwc_role_for_slot(slot_code: str) -> str | None:
    if slot_code == "20":
        return "fwc_special"
    return "fwc"
