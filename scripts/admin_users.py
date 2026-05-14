"""
Local admin CLI for Panini user management.

Reads API_BASE and PANINI_ADMIN_TOKEN from .env (repo root) or environment.

Usage:
    python scripts/admin_users.py list
    python scripts/admin_users.py delete <username>
"""

from __future__ import annotations

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    env_file = Path(__file__).parent.parent / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    import os
    for k in ("API_BASE", "PANINI_ADMIN_TOKEN"):
        if k in os.environ:
            env[k] = os.environ[k]
    return env


def _request(method: str, url: str, token: str) -> dict:
    req = urllib.request.Request(
        url,
        method=method,
        headers={"X-Panini-Admin": token, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)


def cmd_list(base: str, token: str) -> None:
    data = _request("GET", f"{base}/admin/registry-users", token)
    users = data.get("users", [])
    count = data.get("count", len(users))
    max_u = data.get("max_users", "?")
    print(f"Users: {count}/{max_u}")
    print()
    if not users:
        print("  (no registered users)")
        return
    for u in users:
        size_kb = u.get("album_file_bytes", 0) // 1024
        print(f"  [{u['id']:>3}] {u['username']:<24} created: {u['created_at']}  album: {size_kb} KB")


def cmd_delete(base: str, token: str, username: str) -> None:
    confirm = input(f"Delete user '{username}' and their album? [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        return
    data = _request("DELETE", f"{base}/admin/users/{username}", token)
    print(f"Deleted: {data.get('deleted')}")


def main() -> None:
    env = _load_env()
    base = env.get("API_BASE", "").rstrip("/")
    token = env.get("PANINI_ADMIN_TOKEN", "")

    if not base or not token or token == "replace-me":
        print("Error: set API_BASE and PANINI_ADMIN_TOKEN in .env first.", file=sys.stderr)
        sys.exit(1)

    args = sys.argv[1:]
    if not args or args[0] == "list":
        cmd_list(base, token)
    elif args[0] == "delete" and len(args) == 2:
        cmd_delete(base, token, args[1])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
