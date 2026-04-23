FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY middleware ./middleware

ENV PORT=3037 \
    CHROMA_PATH=/data/chroma \
    OLLAMA_URL=http://host.docker.internal:11434 \
    EMBEDDING_MODEL=nomic-embed-text

EXPOSE 3037

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["python", "server.py"]
