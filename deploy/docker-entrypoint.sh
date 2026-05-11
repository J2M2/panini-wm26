#!/bin/sh
set -e
DB="${PANINI_DB_PATH:-/data/panini_wm26.sqlite}"
mkdir -p "$(dirname "$DB")"
if [ ! -f "$DB" ]; then
  python scripts/init_db.py --db "$DB"
fi
exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8080}"
