"""User accounts stored in ``registry.sqlite`` (separate from each user's album DB)."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import bcrypt

from panini_service.data_layout import registry_db_path

MAX_USERS = 50

_USERNAME_RE = re.compile(r"^[a-z0-9_]{3,24}$")


@dataclass
class UserRow:
    id: int
    username: str


def _connect_registry() -> sqlite3.Connection:
    p = registry_db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def ensure_registry_schema() -> None:
    conn = _connect_registry()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
            """
        )
        conn.commit()
    finally:
        conn.close()


def count_users() -> int:
    conn = _connect_registry()
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()
        return int(row["c"]) if row else 0
    finally:
        conn.close()


def validate_username(username: str) -> str:
    u = username.strip().lower()
    if not _USERNAME_RE.match(u):
        raise ValueError(
            "Username must be 3–24 characters: lowercase letters, digits, underscore only.",
        )
    return u


def validate_password(password: str) -> None:
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters.")


def create_user(username: str, password: str) -> UserRow:
    validate_password(password)
    u = validate_username(username)
    if count_users() >= MAX_USERS:
        raise ValueError(f"Server user limit reached ({MAX_USERS} accounts).")

    pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12))

    conn = _connect_registry()
    try:
        try:
            conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (u, pw_hash),
            )
            conn.commit()
            rid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
            uid = int(rid["id"])
        except sqlite3.IntegrityError as e:
            conn.rollback()
            raise ValueError("That username is already taken.") from e
    finally:
        conn.close()

    return UserRow(id=uid, username=u)


def verify_login(username: str, password: str) -> UserRow | None:
    u = validate_username(username)
    conn = _connect_registry()
    try:
        row = conn.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ?",
            (u,),
        ).fetchone()
        if row is None:
            return None
        if not bcrypt.checkpw(password.encode("utf-8"), row["password_hash"]):
            return None
        return UserRow(id=int(row["id"]), username=str(row["username"]))
    finally:
        conn.close()


def get_user_by_id(user_id: int) -> UserRow | None:
    conn = _connect_registry()
    try:
        row = conn.execute(
            "SELECT id, username FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            return None
        return UserRow(id=int(row["id"]), username=str(row["username"]))
    finally:
        conn.close()


def user_album_path(user_id: int) -> Path:
    from panini_service.data_layout import albums_dir

    return albums_dir() / f"user_{user_id}.sqlite"


def guest_album_path(guest_token: str) -> Path:
    from panini_service.data_layout import albums_dir

    # token is hex uuid without hyphens
    safe = "".join(c for c in guest_token.lower() if c in "0123456789abcdef")
    if len(safe) != 32:
        raise ValueError("invalid guest token")
    return albums_dir() / f"guest_{safe}.sqlite"
