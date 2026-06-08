# Frontend (Vite → web/dist)
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# API + same-origin static UI
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1
# panini_catalog / panini_db live under scripts/ (see COPY below)
ENV PYTHONPATH=/app:/app/scripts
ENV PANINI_DB_PATH=/data/panini_wm26.sqlite

COPY requirements-api.txt .
RUN pip install --no-cache-dir -r requirements-api.txt

COPY panini_service/ ./panini_service/
# checklist_context.json ships under panini_service/data/
COPY api/ ./api/
COPY scripts/panini_catalog.py scripts/init_db.py scripts/panini_db.py ./scripts/
COPY --from=web /web/dist ./web/dist

COPY deploy/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
