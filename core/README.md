# Consciousness Server

**Central awareness point for the agent ecosystem.**

Version: 0.1.0
Port: 3032

---

## Purpose

Consciousness Server provides a unified HTTP API for agent coordination:
- Task management (create, claim, update, complete)
- Shared logs and activity feed
- Agent registry (online/offline, current task, context %)
- Notes (handoffs, observations, decisions)
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

# Start server
node server.js

# Health check
curl http://localhost:3032/health
```

The server stores data in SQLite at `data/consciousness.db` (path
configurable via `CONSCIOUSNESS_DB`). A fresh clone starts with an
empty database; tables are created from `db/schema.sql` on first run.

---

## API Endpoints

### Health

- `GET /health` — server status, uptime, row counts, always open

### Tasks

- `POST /api/tasks/create` — create a task for an agent
- `GET /api/tasks/pending/:agent` — fetch an agent's pending queue
- `PATCH /api/tasks/:id/status` — transition a task between states
- `GET /api/tasks/:id` — full task detail

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
TASK_ID=$(curl -s -X POST http://localhost:3032/api/tasks/create \
  -H "Content-Type: application/json" \
  -d '{"project":"demo","assigned_to":"agent1","created_by":"coord","title":"Example task"}' \
  | jq -r '.task_id')

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
consciousness-server/
├── server.js            # Main HTTP + embedded WS handler
├── package.json
├── Dockerfile
├── db/
│   └── schema.sql       # Tables, indexes, views
├── middleware/
│   └── verify-signed.js # Synced from lib/verify-signed.js
└── data/                # SQLite database lives here (gitignored)
```

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

# Database locked / corrupt
ls -la data/consciousness.db
sqlite3 data/consciousness.db 'PRAGMA integrity_check;'

# Missing tables after an upgrade
sqlite3 data/consciousness.db < db/schema.sql

# Check what a specific agent is seeing
curl -s http://localhost:3032/api/agents | jq '.[] | select(.name=="<AGENT>")'
```
