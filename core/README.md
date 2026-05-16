# Consciousness Server

**Central awareness point for the agent ecosystem.**

Version: 1.1.0
Port: 3032

---

## Purpose

Consciousness Server provides a unified HTTP API for agent coordination:
- Task management (create, claim, update, complete)
- Shared logs and activity feed
- Agent registry (online/offline, current task, context %)
- Notes (handoffs, observations, decisions, audit)
- Chat (directed and broadcast between agents)
- Embedded WebSocket broadcast (same port, `/ws`)

Agents in the ecosystem read and write through this server instead of
coordinating directly with each other. A single source of truth makes
state visible and recoverable.

---

## Quick Start

```bash
# Install deps
npm install

# Start Redis on the host (only dependency beyond Node)
docker run -d --name redis -p 6379:6379 redis:7-alpine
# or: brew services start redis  /  apt install redis-server

# Start server
node server.js

# Health check
curl http://localhost:3032/health
```

The server keeps all state in **Redis** (default `127.0.0.1:6379`).
Override with `REDIS_HOST` / `REDIS_PORT` env vars. On startup the
server loads tasks, logs, agents, notes, chat, conversations,
training data, and session summaries from Redis keys; while running
every mutation is also persisted there. A fresh Redis means a fresh
ecosystem with no state to migrate.

The `db/schema.sql` file in this directory is a **legacy reference
schema** from the pre-Redis MVP. It documents the data model but is
not executed at runtime — you can ignore it unless you're porting
the storage layer.

---

## API Endpoints

### Health

- `GET /health` — server status, uptime, row counts, always open

### Tasks

- `POST /api/tasks` — create a task (canonical; alias: `POST /api/tasks/create`)
- `GET /api/tasks/pending/:agent` — fetch an agent's pending queue
- `PATCH /api/tasks/:id/status` — transition a task between states
- `GET /api/tasks/:id` — full task detail

`POST /api/tasks` returns `201` with the full Task per
`lib/schemas/tasks.openapi.yaml` — the `id` field is what older callers
called `task_id`.

Status values: `PENDING`, `IN_PROGRESS`, `DONE`, `FAILED`, `CANCELLED`.
Priority values: `LOW`, `NORMAL`, `HIGH`, `URGENT`.

### Logs

- `POST /api/logs/append` — append a log entry
- `GET /api/logs/recent` — recent entries (filter by `project`, `agent`,
  `level`, `limit`)

Levels: `DEBUG`, `INFO`, `WARN`, `ERROR`.

### Agents

- `POST /api/agents/register` — an agent announces itself
- `POST /api/agents/:name/heartbeat` — liveness + context %
- `GET /api/agents` — list known agents

### Notes, chat, stats

- `POST /api/notes` / `GET /api/notes` — freeform notes
- `POST /api/chat` / `GET /api/chat` — directed or `@all` messages
- `GET /api/stats` — aggregate counts for monitoring

Full field lists are in `server.js` — each route handler documents its
inputs inline.

---

## Workflow example

```bash
# 1. A coordinator creates a task
TASK_ID=$(curl -s -X POST http://localhost:3032/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"project":"demo","assigned_to":"agent1","created_by":"coord","title":"Example task"}' \
  | jq -r '.id')

# 2. The assigned agent polls its queue
curl -s http://localhost:3032/api/tasks/pending/agent1 | jq

# 3. The agent claims and works
curl -X PATCH http://localhost:3032/api/tasks/$TASK_ID/status \
  -H "Content-Type: application/json" \
  -d '{"status":"IN_PROGRESS"}'

# 4. The agent reports progress
curl -X POST http://localhost:3032/api/logs/append \
  -H "Content-Type: application/json" \
  -d "{\"project\":\"demo\",\"agent\":\"agent1\",\"message\":\"started\",\"task_id\":\"$TASK_ID\"}"

# 5. The agent completes
curl -X PATCH http://localhost:3032/api/tasks/$TASK_ID/status \
  -H "Content-Type: application/json" \
  -d '{"status":"DONE","result":"ok"}'
```

---

## Layout

```
core/
├── server.js            # Main HTTP + embedded WS handler
├── package.json
├── Dockerfile
├── db/
│   └── schema.sql       # Legacy reference schema (not executed at runtime)
├── generated/
│   └── schemas/         # F4.6 codegen from lib/schemas/*.openapi.yaml
├── middleware/
│   ├── verify-signed.js # Synced from lib/verify-signed.js
│   └── ports.js         # Synced from lib/ports.js
└── README.md
```

State lives in Redis, not on disk in this directory.

---

## Auth

The server honours the ecosystem-wide `AUTH_MODE` env var
(`off` | `observe` | `enforce`) via the shared middleware in
`middleware/verify-signed.js`. See `docs/AUTH-MODE.md` for the
operator procedure.

Default is `off` — a fresh clone runs on a single machine without
any keys or key-server.

---

## Troubleshooting

```bash
# Port already in use
lsof -i :3032

# Redis unreachable — server logs "Redis error" on startup
redis-cli -h "${REDIS_HOST:-127.0.0.1}" -p "${REDIS_PORT:-6379}" ping
# expected: PONG

# Inspect what's persisted
redis-cli KEYS 'tasks:*' | head
redis-cli KEYS 'agents:*'
redis-cli KEYS 'notes:*' | head

# Wipe all ecosystem state (DESTRUCTIVE — fresh start)
redis-cli FLUSHDB

# Check what a specific agent is seeing
curl -s http://localhost:3032/api/agents | jq '.agents[] | select(.name=="<AGENT>")'
```
