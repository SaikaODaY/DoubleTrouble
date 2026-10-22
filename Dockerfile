# Stage 1: Build React/Vite frontend
FROM node:20-slim AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Stage 2: Python FastAPI backend + static frontend
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DOUBLE_TROUBLE_HOST=0.0.0.0 \
    DOUBLE_TROUBLE_PORT=8017 \
    DOUBLE_TROUBLE_ALLOW_EXTERNAL=true \
    DOUBLE_TROUBLE_OPEN_BROWSER=false \
    DOUBLE_TROUBLE_DATA_ROOT=/data \
    DOUBLE_TROUBLE_CONFIG_PATH=/data/config.yaml

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/ /app/backend/
COPY builtin-extensions/ /app/builtin-extensions/
COPY presets/ /app/presets/
COPY run.py /app/run.py
COPY --from=frontend-builder /build/frontend/dist /app/frontend/dist

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 8017

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8017/api/health', timeout=4)" || exit 1

CMD ["python", "run.py"]
