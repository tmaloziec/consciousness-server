FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY db ./db
COPY middleware ./middleware

ENV PORT=3032 \
    CONSCIOUSNESS_HOST=0.0.0.0 \
    REDIS_HOST=redis \
    REDIS_PORT=6379 \
    AGENTS_DIR=/data/agents \
    OLLAMA_URL=http://host.docker.internal:11434 \
    SEMANTIC_SEARCH_URL=http://semantic-search:3037

EXPOSE 3032

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]
