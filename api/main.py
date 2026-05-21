"""FastAPI application."""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dataclasses import asdict

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

_ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS = _ROOT / "scripts"
for _p in (_ROOT, _SCRIPTS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from panini_service.album_reset import reset_album_collection  # noqa: E402
from panini_service.auth_context import (  # noqa: E402
    AlbumContext,
    apply_cookie_to_response,
    delete_guest_album_for_cookie,
    make_user_cookie_value,
    resolve_album_context,
)
from panini_service.data_layout import ensure_data_directories, legacy_db_path, use_legacy_single_db  # noqa: E402
from panini_service.db import connect  # noqa: E402
from panini_service.inventory_ops import (  # noqa: E402
    PackOpenResult,
    StrictTradeError,
    TradeImpossibleError,
    TradeResult,
    add_stickers,
    check_pack,
    execute_trade,
    open_pack,
    remove_stickers,
    reverse_pack_open,
    reverse_trade,
)
from panini_service.migrate import ensure_schema  # noqa: E402
from panini_service.pack_projection import pack_outlook_projection  # noqa: E402
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
    list_album_table,
    list_sticker_canonical_refs,
    get_category,
    get_sticker,
    team_analytics_pages,
)
from panini_service.refs import (  # noqa: E402
    FWC_CODE,
    is_album_only_00_shorthand,
    parse_category_slot_path,
)
from panini_service.session_store import set_session_stats  # noqa: E402
from panini_service.bootstrap_db import copy_album_database_file, create_fresh_album_file  # noqa: E402
from panini_service.registry import MAX_USERS, create_user, delete_user, ensure_registry_schema, get_user_by_id, list_users_summary, verify_login  # noqa: E402
from panini_service.snapshot import build_full_snapshot, import_album_snapshot  # noqa: E402

from .schemas import (  # noqa: E402
    LoginBody,
    PackOpen,
    PackUndo,
    RegisterBody,
    SessionPatch,
    StickerAdd,
    StickerRemove,
    TradeRequest,
    TradeUndoBody,
)


def _cors_allow_origins() -> list[str]:
    """Local Vite dev origins plus optional ``PANINI_CORS_ORIGINS`` (comma-separated, e.g. GitHub Pages)."""
    defaults = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ]
    extra = os.environ.get("PANINI_CORS_ORIGINS", "").strip()
    if not extra:
        return defaults
    out: list[str] = []
    seen: set[str] = set()
    for o in defaults + [x.strip() for x in extra.split(",") if x.strip()]:
        if o not in seen:
            seen.add(o)
            out.append(o)
    return out


def get_album_context(request: Request, response: Response) -> AlbumContext:
    ctx = resolve_album_context(dict(request.cookies))
    if ctx.set_cookie_token:
        apply_cookie_to_response(response, ctx.set_cookie_token)
    if ctx.kind == "user" and ctx.user_id is not None:
        row = get_user_by_id(ctx.user_id)
        if row:
            ctx.username = row.username
    return ctx


def get_db(ctx: AlbumContext = Depends(get_album_context)):
    conn = connect(ctx.db_path)
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
    ensure_data_directories()
    if use_legacy_single_db():
        p = legacy_db_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.is_file():
            create_fresh_album_file(p)
    else:
        ensure_registry_schema()
    yield


app = FastAPI(title="Panini WM26", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_WEB_DIST = _ROOT / "web" / "dist"
_WEB_ASSETS = _WEB_DIST / "assets"
_FAVICON_SVG = _ROOT / "web" / "public" / "favicon.svg"


@app.exception_handler(StrictTradeError)
async def strict_trade_handler(_, exc: StrictTradeError):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(TradeImpossibleError)
async def trade_impossible_handler(_, exc: TradeImpossibleError):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/auth/me")
def get_auth_me(ctx: AlbumContext = Depends(get_album_context)):
    return {
        "mode": ctx.kind,
        "username": ctx.username,
        "user_id": ctx.user_id if ctx.kind == "user" else None,
    }


def _require_panini_admin(x_panini_admin: str | None = Header(default=None, alias="X-Panini-Admin")) -> None:
    """Optional operator control plane: set ``PANINI_ADMIN_TOKEN`` on the server."""
    expected = os.environ.get("PANINI_ADMIN_TOKEN", "").strip()
    if not expected:
        raise HTTPException(status_code=404, detail="Not found")
    if not x_panini_admin or x_panini_admin != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/admin/registry-users")
def get_admin_registry_users(_: None = Depends(_require_panini_admin)):
    users = list_users_summary()
    return {
        "max_users": MAX_USERS,
        "count": len(users),
        "users": users,
    }


@app.delete("/admin/users/{username}")
def delete_admin_user(username: str, _: None = Depends(_require_panini_admin)):
    found = delete_user(username)
    if not found:
        raise HTTPException(status_code=404, detail=f"User '{username}' not found.")
    return {"ok": True, "deleted": username}


@app.post("/auth/register")
def post_auth_register(
    body: RegisterBody,
    request: Request,
    response: Response,
    ctx: AlbumContext = Depends(get_album_context),
):
    if ctx.kind == "user":
        raise HTTPException(
            400,
            "Already signed in. Log out first if you need to create another account.",
        )
    try:
        row = create_user(body.username, body.password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    from panini_service.registry import user_album_path

    dest = user_album_path(row.id)
    if ctx.kind == "guest" and ctx.db_path.is_file():
        try:
            copy_album_database_file(ctx.db_path, dest)
        except (OSError, FileNotFoundError):
            create_fresh_album_file(dest)
        delete_guest_album_for_cookie(dict(request.cookies))
    else:
        create_fresh_album_file(dest)
    apply_cookie_to_response(response, make_user_cookie_value(row.id))
    return {"ok": True, "username": row.username, "id": row.id}


@app.post("/auth/login")
def post_auth_login(body: LoginBody, response: Response):
    try:
        row = verify_login(body.username, body.password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if row is None:
        raise HTTPException(401, "Invalid username or password.")
    apply_cookie_to_response(response, make_user_cookie_value(row.id))
    return {"ok": True, "username": row.username, "id": row.id}


@app.post("/auth/logout")
def post_auth_logout(request: Request, response: Response):
    delete_guest_album_for_cookie(dict(request.cookies))
    ctx = resolve_album_context({}, force_new_guest=True)
    if ctx.set_cookie_token:
        apply_cookie_to_response(response, ctx.set_cookie_token)
    return {"ok": True}


@app.post("/album/reset")
def post_album_reset(conn=Depends(get_db)):
    reset_album_collection(conn)
    return {"ok": True}


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
        description="Comma-separated: most_repeated,most_completed_team,most_missing_team,most_duplicated_team,fwc_summary,most_difficult_sticker,team_shield_photo",
    ),
    conn=Depends(get_db),
):
    keys = (
        {x.strip() for x in include.split(",") if x.strip()}
        if include
        else {"most_repeated", "most_completed_team", "most_missing_team", "most_duplicated_team"}
    )
    return analytics(conn, include=keys)


@app.get("/analytics/pack-outlook")
def get_pack_outlook(
    trade_repeat_p: float = Query(
        0.0,
        ge=0.0,
        le=1.0,
        description=(
            "Share of duplicate stickers (0–1) successfully traded for missing slots. "
            "Each duplicate — starting inventory or from a pack — is an independent idealized trade try."
        ),
    ),
    trading_partners: int = Query(
        5,
        ge=0,
        le=50,
        description=(
            "How many people you trade with. Scales market reach (0 = no trades even if success rate > 0)."
        ),
    ),
    per_pack: int = Query(7, ge=1, le=50),
    trials: int = Query(1200, ge=50, le=10_000),
    seed: int | None = Query(None, description="Optional RNG seed for reproducible runs"),
    conn=Depends(get_db),
):
    """Monte Carlo estimate of packs (and implied sticker pulls) still needed from current album state."""
    return pack_outlook_projection(
        conn,
        trade_repeat_p=trade_repeat_p,
        trading_partners=trading_partners,
        per_pack=per_pack,
        trials=trials,
        seed=seed,
    )


@app.get("/analytics/teams")
def get_analytics_teams(conn=Depends(get_db)):
    """Per team (48 pages): completion %, shield (slot 1) and team photo (slot 13) flags."""
    return {"teams": team_analytics_pages(conn)}


@app.get("/catalog/sticker-refs")
def get_sticker_refs_catalog(conn=Depends(get_db)):
    """Canonical refs for all stickers (autocomplete / quick search in the UI)."""
    return {"refs": list_sticker_canonical_refs(conn)}


@app.get("/lists/album-table")
def get_lists_album_table(conn=Depends(get_db)):
    """Full album (980 rows): ref, qty, status, printed page, paste line, etc."""
    return list_album_table(conn)


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


@app.post("/packs/check")
def post_pack_check(body: PackOpen, conn=Depends(get_db)):
    """Preview pack: new vs duplicate slots, album order, in-pack repeats — no DB writes."""
    try:
        return check_pack(conn, body.stickers, per_pack=body.per_pack)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/packs/open")
def post_pack_open(body: PackOpen, conn=Depends(get_db)):
    try:
        r: PackOpenResult = open_pack(conn, body.stickers, per_pack=body.per_pack)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return asdict(r)


@app.post("/packs/undo")
def post_pack_undo(body: PackUndo, conn=Depends(get_db)):
    """Reverse one registered pack (same sticker list + packs_opened_delta from the open response)."""
    try:
        r = reverse_pack_open(conn, body.stickers, packs_opened_delta=body.packs_opened_delta)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
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


@app.post("/trades/undo")
def post_trade_undo(body: TradeUndoBody, conn=Depends(get_db)):
    """Reverse inventory + session counters for one forward trade (same give/take lists)."""
    try:
        r: TradeResult = reverse_trade(conn, body.give, body.take)
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


@app.get("/favicon.ico", include_in_schema=False)
@app.get("/favicon.svg", include_in_schema=False)
def favicon():
    """Avoid 404 noise when browsers request a favicon."""
    if _FAVICON_SVG.is_file():
        return FileResponse(_FAVICON_SVG, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/site.webmanifest", include_in_schema=False)
def site_webmanifest():
    """PWA manifest from Vite ``public/`` (copied to ``web/dist``)."""
    path = _WEB_DIST / "site.webmanifest"
    if path.is_file():
        return FileResponse(path, media_type="application/manifest+json")
    return Response(status_code=404)


@app.get("/")
def spa_root():
    """Serve built Vite UI when `web/dist` exists (optional)."""
    index = _WEB_DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return {
        "detail": "Web UI not built. From repo root: cd web && npm install && npm run build",
    }


if _WEB_ASSETS.is_dir():
    app.mount("/assets", StaticFiles(directory=_WEB_ASSETS), name="ui_assets")
