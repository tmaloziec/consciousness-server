FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache curl

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY db ./db
COPY middleware ./middleware

ENV MEMORY_SERVER_HOST=0.0.0.0 \
    MEMORY_PG_HOST=memory-postgres \
    MEMORY_PG_PORT=5432 \
    MEMORY_PG_DB=memory \
    MEMORY_PG_USER=memory \
    MEMORY_PG_PASSWORD=memory \
    OLLAMA_URL=http://host.docker.internal:11434 \
    EMBED_MODEL=nomic-embed-text

EXPOSE 3045

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:3045/health | grep -q '"db_ready":true' || exit 1

CMD ["node", "server.js"]
