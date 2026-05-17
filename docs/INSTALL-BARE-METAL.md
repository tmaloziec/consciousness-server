# Bare-metal install

Docker is the recommended path (see `deploy/docker-compose.yml` and
the root [`README.md`](../README.md)). Use bare-metal install only if
you cannot run Docker — for example on a managed host without the
Docker daemon, or on a small VM where the per-container overhead
matters.

The same code runs in both modes; the difference is how you supply
ports, environment variables, and the Redis backend.

## 1. Prerequisites

- **Node.js 20 LTS or newer.** The Dockerfiles ship on `node:20-alpine`
  (see `core/Dockerfile`). Older 18.x works for most code paths but is
  not what we test against.
- **Redis 7+** reachable on the host. consciousness-server connects
  unconditionally at startup (`core/server.js:50–62`) and uses it for
  tasks, agent state, chat logs, and the agent bus — there is no
  in-memory fallback.
- **Python 3 with PyYAML**, *only* if you plan to regenerate ports or
  schema artifacts via `bin/sync-schema` (`bin/requirements.txt`).
  Not needed to run the server.
- **Ollama**, optional. Required only by `GET /api/ollama/tags`
  (`core/server.js:1478`). Skip if you do not query that endpoint.
- **key-server**, optional. Required only when `AUTH_MODE` is
  `observe` or `enforce` (`core/middleware/verify-signed.js`). See
  [`docs/AUTH-MODE.md`](AUTH-MODE.md).

## 2. Environment setup

```bash
git clone https://github.com/build-on-ai/consciousness-server.git
cd consciousness-server

# Install runtime deps for the core service.
cd core && npm ci --omit=dev && cd ..

# Copy the env template and edit values for your host.
cp .env.example .env
$EDITOR .env
```

Every variable in `.env.example` carries a `Used at: file:line`
comment pointing at the exact `process.env.*` read in the source, so
you can audit the effect before changing it. At minimum check:

- `REDIS_HOST` / `REDIS_PORT` — must point at your Redis.
- `AGENTS_DIR` / `SKILLS_DIR` — default to `./agents` and `./skills`
  (bundled in the repo). Override if you keep roles outside the
  checkout.
- `CONSCIOUSNESS_HOST` — `0.0.0.0` binds all interfaces; set to
  `127.0.0.1` to restrict to loopback.
- `PORT` — overrides `ports.yaml`. Leave unset to use 3032 (the
  registry default).

## 3. Preflight

Run the bare-metal preflight before the first launch:

```bash
bin/preflight-bare-metal
```

It checks Node version, Redis reachability, port availability, that
`AGENTS_DIR` exists and contains at least one role, and that
`SEMANTIC_SEARCH_URL` answers. The script only reads — it does not
install anything. Fix any `FAIL` line and re-run.

## 4. Launch

### Option A — one-shot (foreground)

```bash
set -a; . ./.env; set +a
node core/server.js
```

Useful for smoke-testing the config. `Ctrl-C` to stop.

### Option B — systemd (recommended for long-running hosts)

A unit template ships at
[`deploy/consciousness-server.service.example`](../deploy/consciousness-server.service.example).
Copy it, edit `User=`, `WorkingDirectory=`, and `EnvironmentFile=`
for your install, then:

```bash
sudo cp deploy/consciousness-server.service.example \
        /etc/systemd/system/consciousness-server.service
sudo cp .env /etc/consciousness-server.env
sudo systemctl daemon-reload
sudo systemctl enable --now consciousness-server
journalctl -u consciousness-server -f
```

The template runs `node core/server.js`, restarts on failure, and
reads its environment from `/etc/consciousness-server.env` so the
`.env` in the repo can stay out of `/etc`.

## 5. Verify

```bash
curl -fsS http://127.0.0.1:3032/health | jq
```

A healthy response includes `status: "ok"` plus the semantic-search
probe result. If `semanticHealth` is `misconfigured`, the value of
`SEMANTIC_SEARCH_URL` did not pass scheme/allowlist validation
(`core/server.js:593` and `:624`).
