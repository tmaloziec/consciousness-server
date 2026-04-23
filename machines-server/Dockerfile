FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./
COPY middleware ./middleware

ENV PORT=3038 \
    CS_URL=http://consciousness-server:3032 \
    MACHINES_DIR=/data/machines \
    SERVICES_YAML=/data/services.yaml

EXPOSE 3038

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["python", "server.py"]
