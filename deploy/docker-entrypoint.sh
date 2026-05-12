#!/bin/sh
set -e
export PANINI_DATA_DIR="${PANINI_DATA_DIR:-/data}"
mkdir -p "${PANINI_DATA_DIR}/albums"
exec uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8080}"
