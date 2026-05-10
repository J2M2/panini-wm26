"""FastAPI application."""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dataclasses import asdict

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from panini_service.db import connect  # noqa: E402
from panini_service.inventory_ops import (  # noqa: E402
    PackOpenResult,
    StrictTradeError,
    TradeImpossibleError,
    TradeResult,
    add_stickers,
    execute_trade,
    open_pack,
    remove_stickers,
)
from panini_service.migrate import ensure_schema  # noqa: E402
from panini_service.queries import (  # noqa: E402
    analytics,
    format_compact_duplicates,
    format_compact_missing,
    format_printable_lists,
    format_table_duplicates,
    format_table_missing,
    inventory_metrics,
    list_duplicates,
    list_missing,
    get_category,
    get_sticker,
)
from panini_service.refs import (  # noqa: E402
    FWC_CODE,
    is_album_only_00_shorthand,
    parse_category_slot_path,
)
from panini_service.session_store import set_session_stats  # noqa: E402
from panini_service.snapshot import build_full_snapshot, import_album_snapshot  # noqa: E402

from .schemas import PackOpen, SessionPatch, StickerAdd, StickerRemove, TradeRequest  # noqa: E402


def get_db():
    conn = connect()
    ensure_schema(conn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = connect()
    ensure_schema(conn)
    conn.commit()
    conn.close()
    yield


app = FastAPI(title="Panini WM26", version="1.0.0", lifespan=lifespan)


@app.exception_handler(StrictTradeError)
async def strict_trade_handler(_, exc: StrictTradeError):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(TradeImpossibleError)
async def trade_impossible_handler(_, exc: TradeImpossibleError):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/metrics")
def get_metrics(conn=Depends(get_db)):
    return inventory_metrics(conn)


@app.patch("/session")
def patch_session(body: SessionPatch, conn=Depends(get_db)):
    return asdict(
        set_session_stats(
            conn,
            packs_opened=body.packs_opened,
            traded_out_count=body.traded_out_count,
            traded_in_count=body.traded_in_count,
        )
    )


@app.get("/analytics")
def get_analytics(
    include: str | None = Query(
        None,
        description="Comma-separated: most_repeated,most_completed_team,most_missing_team,fwc_summary,most_difficult_sticker",
    ),
    conn=Depends(get_db),
):
    keys = (
        {x.strip() for x in include.split(",") if x.strip()}
        if include
        else {"most_repeated", "most_completed_team", "most_missing_team"}
    )
    return analytics(conn, include=keys)


@app.get("/lists/missing")
def get_missing(
    format: str = Query(
        "json",
        description="json | table (TSV) | compact (grouped lines, good for sharing/print)",
    ),
    conn=Depends(get_db),
):
    rows = list_missing(conn)
    if format == "table":
        return PlainTextResponse(format_table_missing(rows))
    if format == "compact":
        return PlainTextResponse(format_compact_missing(conn))
    return rows


@app.get("/lists/duplicates")
def get_duplicates(
    format: str = Query(
        "json",
        description="json | table | compact (one line per category, sticker numbers only)",
    ),
    conn=Depends(get_db),
):
    rows = list_duplicates(conn)
    if format == "table":
        return PlainTextResponse(format_table_duplicates(rows))
    if format == "compact":
        return PlainTextResponse(format_compact_duplicates(conn))
    return rows


@app.get("/lists/print", response_class=PlainTextResponse)
def get_lists_printable(conn=Depends(get_db)):
    """One page: progress summary + missing + duplicates (print from browser)."""
    return format_printable_lists(conn)


@app.post("/packs/open")
def post_pack_open(body: PackOpen, conn=Depends(get_db)):
    try:
        r: PackOpenResult = open_pack(conn, body.stickers, per_pack=body.per_pack)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    from dataclasses import asdict

    return asdict(r)


@app.post("/stickers/add")
def post_add(body: StickerAdd, conn=Depends(get_db)):
    try:
        return add_stickers(conn, body.ref, body.count)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/stickers/remove")
def post_remove(body: StickerRemove, conn=Depends(get_db)):
    try:
        return remove_stickers(conn, body.ref, body.count)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/trades")
def post_trade(body: TradeRequest, conn=Depends(get_db)):
    try:
        r: TradeResult = execute_trade(
            conn,
            body.give,
            body.take,
            strict_duplicates_only=body.strict_duplicates_only,
            allow_uneven=body.allow_uneven,
        )
    except StrictTradeError:
        raise
    except TradeImpossibleError:
        raise
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"warnings": r.warnings, "gave": r.gave, "received": r.received}


@app.get("/stickers/{category}/{slot}")
def get_one_sticker(category: str, slot: str, conn=Depends(get_db)):
    try:
        cat, sc = parse_category_slot_path(category, slot)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    row = get_sticker(conn, cat, sc)
    if row is None:
        raise HTTPException(404, "sticker not found")
    return row


@app.get("/stickers/{solo}")
def get_sticker_album_00_only(solo: str, conn=Depends(get_db)):
    """Short URL for the standalone album sticker printed **00** only: `/stickers/00`."""
    if not is_album_only_00_shorthand(solo):
        raise HTTPException(
            404,
            "Use /stickers/CATEGORY/SLOT (e.g. /stickers/MEX/5). "
            "Album sticker '00' only: /stickers/00 or /stickers/FWC/00.",
        )
    try:
        cat, sc = parse_category_slot_path(FWC_CODE, solo.strip())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    row = get_sticker(conn, cat, sc)
    if row is None:
        raise HTTPException(404, "sticker not found")
    return row


@app.get("/categories/{code}")
def get_cat(code: str, conn=Depends(get_db)):
    row = get_category(conn, code.upper())
    if row is None:
        raise HTTPException(404, "category not found")
    return row


@app.get("/snapshot")
def get_snapshot_export(conn=Depends(get_db)):
    """Export full album state: categories, stickers + qty, optional session metadata."""
    return build_full_snapshot(conn)


@app.post("/snapshot/import")
def post_snapshot_import(
    body: dict[str, Any],
    apply_session: bool = Query(
        True,
        description="When true, restore session counters if the JSON includes a `session` object",
    ),
    conn=Depends(get_db),
):
    """Restore inventory from a prior export; session fields are optional informational metadata."""
    try:
        return import_album_snapshot(conn, body, apply_session=apply_session)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/health")
def health():
    return {"ok": True}
