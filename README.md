# Panini WM26 album tracker

Local toolkit for the FIFA World Cup™ sticker album: SQLite inventory, optional matrix/JSON exports, CLI metrics, and a **FastAPI** HTTP layer for queries and actions (packs, trades, lists).

## Requirements

- **Python 3.10+** (stdlib scripts work without extra packages)
- Optional HTTP/API: install dependencies from [`requirements-api.txt`](requirements-api.txt)

```bash
pip install -r requirements-api.txt
```

## Quick start

### 1. Create the database (catalog + baseline inventory)

From the repo root:

```bash
python scripts/init_db.py --force
```

This creates [`data/panini_wm26.sqlite`](data/panini_wm26.sqlite) with **980** sticker slots (FWC + 48 teams × 20) and baseline `qty = 1` per slot.

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

### 6. Tests

```bash
pip install -r requirements-api.txt
pytest
```

Track inventory changes through the API (`POST /packs/open`, `/stickers/add`, `/trades`, etc.) or by editing the DB—no separate raw spreadsheet step is required.

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
| Open one pack | `POST` | `/packs/open` | Body: `stickers` (array of refs), `per_pack` (default 7) |
| Add / remove copies | `POST` | `/stickers/add`, `/stickers/remove` | `ref` + `count` |
| Trade | `POST` | `/trades` | `give` / `take` ref lists; `strict_duplicates_only`, `allow_uneven` |
| Look up one sticker (qty + spares) | `GET` | `/stickers/{category}/{slot}` | e.g. `/stickers/MEX/5`, `/stickers/FWC/00`, or **`/stickers/00`** for the album-only **00** sticker |
| Full team or FWC page | `GET` | `/categories/{code}` | e.g. `/categories/MEX`, `/categories/FWC` |
| Export full album (backup) | `GET` | **`/snapshot`** | Same JSON as `export_json.py` (`schema_version` 3, includes **`session`**) |
| Import snapshot | `POST` | **`/snapshot/import`** | Body = exported JSON. Query **`apply_session`** (default `true`): restore packs/trade counters only if the JSON has **`session`**; use `false` to restore **`qty`** only |
| Fun aggregates | `GET` | `/analytics?include=...` | Comma-separated keys (see OpenAPI) |

Full request/response shapes are in **`/docs`**.

## Project layout (high level)

| Path | Role |
|------|------|
| [`scripts/panini_catalog.py`](scripts/panini_catalog.py) | Team codes, FWC slots, roles |
| [`scripts/init_db.py`](scripts/init_db.py) | Schema + seed |
| [`scripts/metrics.py`](scripts/metrics.py) | CLI metrics + validation + MC estimates |
| [`scripts/freeze_album.py`](scripts/freeze_album.py) | Write `data/frozen/album_*.json` + `album_latest.json` for local backup / restore after tests |
| [`panini_service/snapshot.py`](panini_service/snapshot.py) | Shared export/import logic for CLI + API |
| [`api/main.py`](api/main.py) | FastAPI app |
| [`data/panini_wm26.sqlite`](data/panini_wm26.sqlite) | Main database (generated) |
| [`web/types.ts`](web/types.ts) | TypeScript types aligned with JSON export |

## Troubleshooting

- **`cannot start a transaction`** / nested transactions: the API uses SQLite savepoints for multi-step actions; use one client connection per request (default with uvicorn).
- **Wrong sticker ref**: use `TEAM:slot` with a valid team code from the catalog and integer slot **1–20**; FWC accepts **00** for the special sticker.
- **Windows `WinError 10013`** (“socket not permitted”): often port **8000** is in use or reserved (Hyper-V/WSL). Run explicitly on localhost and another port, for example:
  `uvicorn api.main:app --reload --host 127.0.0.1 --port 8080`
  Then open `http://127.0.0.1:8080/docs`. Try **8765** or **12700** if **8080** still fails.
