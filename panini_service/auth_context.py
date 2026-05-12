"""Signed cookie → which album SQLite file to open (guest vs registered user)."""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from pathlib import Path

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from panini_service.bootstrap_db import create_fresh_album_file
from panini_service.data_layout import legacy_db_path, use_legacy_single_db
from panini_service.registry import guest_album_path, user_album_path

COOKIE_NAME = "panini_album"
COOKIE_MAX_AGE = 90 * 24 * 3600  # 90 days

_TOKEN_MAX_AGE = COOKIE_MAX_AGE


def _secret() -> str:
    s = os.environ.get("PANINI_AUTH_SECRET", "").strip()
    if s:
        return s
    return "dev-insecure-change-PANINI_AUTH_SECRET"


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(_secret(), salt="panini-wm26-album-v1")


@dataclass
class AlbumContext:
    """Resolved album database for this HTTP request."""

    db_path: Path
    kind: str  # "guest" | "user" | "legacy"
    user_id: int | None = None
    username: str | None = None
    guest_token: str | None = None
    set_cookie_token: str | None = None  # when set, caller must Set-Cookie on response


def _new_guest_token() -> str:
    return uuid.uuid4().hex


def load_token(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        return _serializer().loads(raw, max_age=_TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired, TypeError):
        return None


def make_guest_cookie_value(guest_token: str) -> str:
    return _serializer().dumps({"v": 1, "role": "guest", "id": guest_token})


def make_user_cookie_value(user_id: int) -> str:
    return _serializer().dumps({"v": 1, "role": "user", "id": int(user_id)})


def resolve_album_context(
    cookies: dict[str, str],
    *,
    force_new_guest: bool = False,
) -> AlbumContext:
    """Pick DB path from signed ``panini_album`` cookie; create guest DB + cookie when absent or invalid."""
    if use_legacy_single_db():
        p = legacy_db_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        return AlbumContext(
            db_path=p,
            kind="legacy",
        )

    if force_new_guest:
        gid = _new_guest_token()
        path = guest_album_path(gid)
        create_fresh_album_file(path)
        return AlbumContext(
            db_path=path,
            kind="guest",
            guest_token=gid,
            set_cookie_token=make_guest_cookie_value(gid),
        )

    raw_cookie = cookies.get(COOKIE_NAME)
    data = load_token(raw_cookie)

    if data and data.get("v") == 1 and data.get("role") == "user" and data.get("id") is not None:
        try:
            uid = int(data["id"])
        except (TypeError, ValueError):
            uid = None
        if uid is not None:
            path = user_album_path(uid)
            if not path.is_file():
                create_fresh_album_file(path)
            return AlbumContext(
                db_path=path,
                kind="user",
                user_id=uid,
            )

    if data and data.get("v") == 1 and data.get("role") == "guest":
        gid = data.get("id")
        if isinstance(gid, str) and len(gid) == 32 and gid.isalnum():
            path = guest_album_path(gid)
            if not path.is_file():
                create_fresh_album_file(path)
            return AlbumContext(
                db_path=path,
                kind="guest",
                guest_token=gid,
            )

    # New guest session
    gid = _new_guest_token()
    path = guest_album_path(gid)
    create_fresh_album_file(path)
    return AlbumContext(
        db_path=path,
        kind="guest",
        guest_token=gid,
        set_cookie_token=make_guest_cookie_value(gid),
    )


def apply_cookie_to_response(response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=os.environ.get("PANINI_COOKIE_SECURE", "").strip() in ("1", "true", "yes"),
        path="/",
    )


def clear_album_cookie(response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


def delete_guest_album_for_cookie(cookies: dict[str, str]) -> None:
    """Best-effort remove guest SQLite when rotating session (e.g. logout)."""
    raw = cookies.get(COOKIE_NAME)
    data = load_token(raw)
    if not data or data.get("role") != "guest":
        return
    gid = data.get("id")
    if not isinstance(gid, str) or len(gid) != 32:
        return
    try:
        p = guest_album_path(gid)
        if p.is_file():
            p.unlink()
    except (ValueError, OSError):
        pass
