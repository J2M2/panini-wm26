"""Pydantic models for FastAPI."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from panini_service.constants import STICKERS_PER_PACK


class SessionPatch(BaseModel):
    packs_opened: int | None = None
    traded_out_count: int | None = None
    traded_in_count: int | None = None


class StickerAdd(BaseModel):
    ref: str = Field(..., examples=["MEX:5"])
    count: int = Field(1, ge=1)


class StickerRemove(BaseModel):
    ref: str
    count: int = Field(1, ge=1)


class PackOpen(BaseModel):
    stickers: list[str]
    per_pack: int = Field(STICKERS_PER_PACK, ge=1, le=50)


class PackUndo(BaseModel):
    """Same ``stickers`` list and ``packs_opened_delta`` from the completed POST /packs/open response."""

    stickers: list[str] = Field(..., min_length=1)
    packs_opened_delta: int = Field(..., ge=1)


class TradeRequest(BaseModel):
    give: list[str]
    take: list[str]
    strict_duplicates_only: bool = False
    allow_uneven: bool = False


class TradeUndoBody(BaseModel):
    """Same ``give`` / ``take`` lists as the completed forward trade (POST /trades)."""

    give: list[str] = Field(..., min_length=1)
    take: list[str] = Field(..., min_length=1)


class Message(BaseModel):
    detail: str


class ErrorBody(BaseModel):
    detail: str
    warnings: list[str] | None = None
