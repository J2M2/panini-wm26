# Panini WM26 album tracker

Local toolkit for the FIFA World Cup™ sticker album: SQLite inventory, optional matrix/JSON exports, CLI metrics, and a **FastAPI** HTTP layer for queries and actions (packs, trades, lists).

## Requirements

- **Python 3.10+** (stdlib scripts work without extra packages)
- Optional HTTP/API: install dependencies from [`requirements-api.txt`](requirements-api.txt)

```bash
pip install -r requirements-api.txt
```

### Hosted web (multi-user)

- **Guest**: first visit sets a signed **`panini_album`** cookie and an empty album file under `{PANINI_DATA_DIR}/albums/guest_*.sqlite`.
- **Register / log in**: up to **50** users in `registry.sqlite`; each user has `user_<id>.sqlite` (isolated from other accounts). Passwords are stored with **bcrypt**.
- **Production**: set **`PANINI_AUTH_SECRET`** to a long random string (e.g. `fly secrets set PANINI_AUTH_SECRET=...`). With HTTPS, set **`PANINI_COOKIE_SECURE=1`** (included in [`fly.toml`](fly.toml) `[env]`).
- **Who registered?** (optional): set **`PANINI_ADMIN_TOKEN`** to a long random value. Then call **`GET /admin/registry-users`** with header **`X-Panini-Admin: <same token>`** — JSON with `count`, `max_users`, and `users` (`id`, `username`, `created_at`, `album_file_bytes`). No passwords. If `PANINI_ADMIN_TOKEN` is not set, that URL returns **404** (hidden).
- **Legacy single DB**: `PANINI_USE_LEGACY_DB=1` and `PANINI_DB_PATH` → one shared SQLite (old behavior).

## Quick start

### 1. Create the database (catalog + empty album)

From the repo root:

```bash
python scripts/init_db.py --force
```

This creates [`data/panini_wm26.sqlite`](data/panini_wm26.sqlite) with **980** sticker slots (FWC + 48 teams × 20) and **`qty = 0` everywhere** (no stickers owned yet).

The **HTTP app** (Docker / Fly) uses **`PANINI_DATA_DIR`** (default `./data` locally, `/data` on Fly): a **registry** database plus one SQLite file per **guest session** or **registered user** under `albums/` — see **Hosted web (multi-user)** above. For a single shared DB instead, set `PANINI_USE_LEGACY_DB=1` and `PANINI_DB_PATH`.

To import Panini’s semicolon **missing** / **duplicates** CSVs, use [`scripts/import_raw_csv.py`](scripts/import_raw_csv.py): if the album is still completely empty, the script temporarily sets every slot to `qty = 1`, then applies the CSV rules (same behavior as before).

### 2. Session table (existing databases)

If you already had a DB from before session counters existed:

```bash
python scripts/migrate_v2_session.py
```

Fresh installs from `init_db.py` already include the `session_stats` row.

### 3. Export matrix / JSON snapshot (optional)

```bash
python scripts/export_matrix.py --stats
python scripts/export_json.py
```

Outputs:

- [`data/matrix.csv`](data/matrix.csv) — one grid: rows slots `1–20`, columns `FWC` + teams, cells = `qty`
- [`data/panini_snapshot.json`](data/panini_snapshot.json) — **full album snapshot** (categories, every sticker `qty`, optional **session** counters `schema_version` 3) for backup or importing elsewhere

**Restore from a snapshot file (CLI):**

```bash
python scripts/import_snapshot.py path/to/panini_snapshot.json
```

Use **`--no-session`** if you only want to restore quantities and keep current packs/trade counts unchanged.

**Freeze a “gold” copy of the current DB (local, timestamped):**

```bash
python scripts/freeze_album.py
python scripts/freeze_album.py --label v1
```

Writes:

- `data/frozen/album_frozen_<timestamp>.json` — kept until you remove it
- `data/frozen/album_latest.json` — **overwritten each time**; handy to re-import after tests:

```bash
python scripts/import_snapshot.py data/frozen/album_latest.json
```

`data/frozen/*.json` is **gitignored** (your real album); the directory stays in the repo via [`data/frozen/.gitkeep`](data/frozen/.gitkeep).

### 4. Metrics and validation (CLI)

```bash
python scripts/metrics.py
```

Shows totals, completion %, spare copies, optional Monte Carlo “packs to finish” (toy uniform model). Flags: `--packs`, `--per-pack`, `--trade-hit-rate`, `--no-mc`, etc. (`python scripts/metrics.py --help`).

### 5. HTTP API (optional)

```bash
uvicorn api.main:app --reload --host 127.0.0.1 --port 8080
```

- Interactive docs: **http://127.0.0.1:8080/docs** (match the port you pass to `--port`)
- Health: `GET /health`
- Main reads/writes use the same SQLite file under [`data/panini_wm26.sqlite`](data/panini_wm26.sqlite).

On Windows, binding to `0.0.0.0:8000` can hit permission or reserved-port issues; **`127.0.0.1`** plus another port (e.g. **8080**) usually avoids `WinError 10013`.

#### Web UI ([`web/`](web/))

Minimal browser UI that calls the same HTTP API.

**Development** — run the API on port **8080**, then start Vite (it proxies `/api` → `127.0.0.1:8080`):

```bash
cd web && npm install && npm run dev
```

Open **http://127.0.0.1:5173**.

**Single server** — build the UI, then open the app from uvicorn (serves `/` and `/assets/*` when [`web/dist`](web/dist) exists):

```bash
cd web && npm install && npm run build
uvicorn api.main:app --host 127.0.0.1 --port 8080
```

Browse **http://127.0.0.1:8080/**.

### 6. Tests

```bash
pip install -r requirements-api.txt
pytest
```

Track inventory changes through the API (`POST /packs/open`, `/stickers/add`, `/trades`, etc.) or by editing the DB—no separate raw spreadsheet step is required.

## Deployment (HTTPS, phone, JSON import)

The UI talks to the API over **`fetch`**. For a **phone on cellular** or any non-localhost client you need a **public HTTPS URL** (most hosts terminate TLS for you).

### Single service (recommended)

Build the web app **without** `VITE_API_BASE` so the SPA calls `/metrics`, `/snapshot/import`, etc. on the **same origin** as uvicorn (same as local “single server” mode).

- **`PANINI_DB_PATH`** — absolute path to the SQLite file. Defaults to `data/panini_wm26.sqlite`. In Docker use a **mounted volume** (e.g. `/data/panini_wm26.sqlite`) so the DB survives container restarts.
- **`PANINI_CORS_ORIGINS`** — optional comma-separated extra origins (see GitHub Pages below). Local Vite (`localhost:5173`) stays allowed by default.

**Docker Compose** (API + UI + persistent DB volume):

```bash
docker compose up --build
```

Open **http://127.0.0.1:8080/**. Import snapshot JSON from Overview works from mobile browsers (file picker).

**Docker image only:**

```bash
docker build -t panini .
docker run --rm -p 8080:8080 -v panini-data:/data -e PANINI_DB_PATH=/data/panini_wm26.sqlite panini
```

**Fly.io:** edit [`fly.toml`](fly.toml) (`app` name), create a volume in the same region, then `fly deploy`. Set `PANINI_DB_PATH=/data/panini_wm26.sqlite` and mount `panini_data` → `/data` (see comments in `fly.toml`). HTTPS is automatic.

### GitHub Pages UI + API elsewhere

If you host only the **static** UI on `https://<user>.github.io/<repo>/`:

1. Build with the API URL baked in (must match your deployed API, **HTTPS**):

   ```bash
   cd web && VITE_API_BASE=https://your-api.example.com npm run build
   ```

2. Publish `web/dist` to Pages (Actions artifact, branch, etc.).

3. Allow that origin on the API, e.g.:

   ```bash
   export PANINI_CORS_ORIGINS=https://youruser.github.io
   ```

   (Trailing paths like `/repo` are not part of the origin—use the scheme + host only.)

### PWA (“Add to Home Screen”)

[`web/public/site.webmanifest`](web/public/site.webmanifest) is linked from the HTML and exposed at **`/site.webmanifest`** when `web/dist` is built. After deployment, use the browser’s install / Add to Home Screen option; JSON import still requires the API.

## Sticker references

Use **`CATEGORY:SLOT`** everywhere (CLI mentally; API as JSON strings):

| Example | Meaning |
|---------|---------|
| `MEX:5` | Mexico, slot 5 |
| `FWC:12` | FWC group, internal slot 12 |
| `FWC:00`, `FWC:0` | Album sticker printed **00** — stored internally as **slot 20** |

Team slots are **1–20** (1 = shield, 13 = team photo). FWC uses the same internal range **1–20**; **`FWC:20`** is the same physical sticker as **`FWC:00`** on the album.

## HTTP API — common operations

| Action | Method | Path | Notes |
|--------|--------|------|--------|
| Summary metrics + session counters | `GET` | `/metrics` | Includes `packs_opened`, trade totals from DB |
| Set session notes | `PATCH` | `/session` | Body: optional `packs_opened`, `traded_out_count`, `traded_in_count` |
| Missing / duplicates lists | `GET` | `/lists/missing`, `/lists/duplicates` | `format=json`, `table` (TSV), or **`compact`** (e.g. `MEX: 1, 5, 13` per line — duplicates compact omits how many spares) |
| Printable trading sheet | `GET` | **`/lists/print`** | Plain text: summary + missing + duplicates — open in browser and **Print** |
| Preview one pack (no writes) | `POST` | **`/packs/check`** | Body: `stickers`, `per_pack` — new vs duplicate slots, in-pack repeats, album page order, `packs_opened_delta` preview |
| Open one pack | `POST` | `/packs/open` | Body: `stickers` (any length ≥1), `per_pack` (default 7). `packs_opened` += `round(n/per_pack)` (min 1). Warns if `n` is not a multiple of `per_pack` |
| Undo last pack | `POST` | **`/packs/undo`** | Body: same `stickers` list + `packs_opened_delta` from the `/packs/open` response |
| Add / remove copies | `POST` | `/stickers/add`, `/stickers/remove` | `ref` + `count` |
| Trade | `POST` | `/trades` | `give` / `take` ref lists; `strict_duplicates_only`, `allow_uneven` |
| Undo last trade | `POST` | **`/trades/undo`** | Body: same `give` / `take` as the forward trade; restores qty and rolls back session trade counters |
| Look up one sticker (qty + spares) | `GET` | `/stickers/{category}/{slot}` | e.g. `/stickers/MEX/5`, `/stickers/FWC/00`, or **`/stickers/00`** for the album-only **00** sticker |
| Full team or FWC page | `GET` | `/categories/{code}` | e.g. `/categories/MEX`, `/categories/FWC` |
| Export full album (backup) | `GET` | **`/snapshot`** | Same JSON as `export_json.py` (`schema_version` 3, includes **`session`**) |
| Import snapshot | `POST` | **`/snapshot/import`** | Body = exported JSON. Query **`apply_session`** (default `true`): restore packs/trade counters only if the JSON has **`session`**; use `false` to restore **`qty`** only |
| Fun aggregates | `GET` | `/analytics?include=...` | Comma-separated keys (see OpenAPI); includes `team_shield_photo` |
| Per-team pages | `GET` | **`/analytics/teams`** | All 48 teams: `%` complete, `shield_ok`, `team_photo_ok` (slot 1 / 13) |

Full request/response shapes are in **`/docs`**.

## Project layout (high level)

| Path | Role |
|------|------|
| [`scripts/panini_catalog.py`](scripts/panini_catalog.py) | Team codes, FWC slots, roles |
| [`scripts/init_db.py`](scripts/init_db.py) | Schema + catalog; empty album (`qty=0`) |
| [`scripts/metrics.py`](scripts/metrics.py) | CLI metrics + validation + MC estimates |
| [`scripts/freeze_album.py`](scripts/freeze_album.py) | Write `data/frozen/album_*.json` + `album_latest.json` for local backup / restore after tests |
| [`panini_service/snapshot.py`](panini_service/snapshot.py) | Shared export/import logic for CLI + API |
| [`api/main.py`](api/main.py) | FastAPI app |
| [`data/panini_wm26.sqlite`](data/panini_wm26.sqlite) | Main database (generated) |
| [`web/src`](web/src) | Browser UI (Vite + TypeScript; [`web/src/types.ts`](web/src/types.ts) mirrors JSON export shape) |
| [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml), [`deploy/docker-entrypoint.sh`](deploy/docker-entrypoint.sh) | Production image: API + `web/dist`, optional volume for SQLite |
| [`fly.toml`](fly.toml) | Example Fly.io app + volume mount for `/data` |

## Troubleshooting

- **`cannot start a transaction`** / nested transactions: the API uses SQLite savepoints for multi-step actions; use one client connection per request (default with uvicorn).
- **Wrong sticker ref**: use `TEAM:slot` with a valid team code from the catalog and integer slot **1–20**; FWC accepts **00** for the special sticker.
- **Windows `WinError 10013`** (“socket not permitted”): often port **8000** is in use or reserved (Hyper-V/WSL). Run explicitly on localhost and another port, for example:
  `uvicorn api.main:app --reload --host 127.0.0.1 --port 8080`
  Then open `http://127.0.0.1:8080/docs`. Try **8765** or **12700** if **8080** still fails.
