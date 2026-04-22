# deploy/

Docker-compose stack for running the ecosystem locally: **redis +
consciousness-server + semantic-search + machines-server + test-runner
+ git-workflow**, with **key-server** as an opt-in under
`--profile full`.

Ollama is not containerised here — it runs on the host at
`127.0.0.1:11434` with the `nomic-embed-text` model pulled. CS
reaches it via `host.docker.internal`; semantic-search uses
`network_mode: host` and talks to `localhost:11434` directly.

## Prerequisites

- Docker + docker compose v2
- Ollama running on the host with the embedding model:
  ```bash
  ollama list | grep nomic-embed-text   # or: ollama pull nomic-embed-text
  ```

Run `bin/preflight` at repo root to verify everything before the
first `docker compose up`.

## Usage

```bash
cd deploy

# Solo profile (default) — CS + semantic-search + machines + test-runner
# + git-workflow + redis. AUTH_MODE=off, no keys needed.
docker compose up -d

# Full profile — adds key-server for AUTH_MODE=observe/enforce
docker compose --profile full up -d

# Authenticated deployment
AUTH_MODE=enforce docker compose --profile full up -d

docker compose ps                  # status
docker compose logs -f             # live logs
docker compose down                # stop + remove containers
docker compose down -v             # stop + remove named volumes
sudo rm -rf volumes                # reset to pristine state (bind mounts are root-owned)
```

See [`../docs/AUTH-MODE.md`](../docs/AUTH-MODE.md) for the three
auth modes and the migration path.

## Ports (mapped to host)

| Block | Port | Profile | Health |
|---|---|---|---|
| redis | 6379 | default | `redis-cli ping` |
| consciousness-server | 3032 | default | `curl localhost:3032/health` |
| semantic-search | 3037 | default | `curl localhost:3037/health` |
| machines-server | 3038 | default | `curl localhost:3038/health` |
| test-runner | 3041 | default | `curl localhost:3041/health` |
| git-workflow | 3042 | default | `curl localhost:3042/health` |
| key-server | 3040 | **full** only | `curl localhost:3040/health` |

## Runtime state (volumes/)

Everything in `deploy/volumes/` is **gitignored** — regenerable
runtime state:

- `redis/` — Redis AOF persistence
- `chroma/` — ChromaDB vector store
- `training/` — session mirror drop-zone (v2 timer, placeholder today)
- `cs-logs/`, `key-server-logs/`, `machines-logs/`, `test-runner-logs/`,
  `git-workflow-logs/`, `semantic-search-logs/` — per-block stderr/stdout
- `git-workflow/commits.db` — SQLite DB of commit records
- `test-runner-workspaces/` — cloned test workspaces

Containers run as root; bind mounts end up owned by root on the
host. `sudo rm -rf volumes/` wipes everything to pristine state.

## Debugging

```bash
docker compose logs semantic-search | tail -50
docker compose logs consciousness-server | tail -50
docker exec -it cs-redis redis-cli     # shell into redis
curl -s localhost:3032/health | jq
curl -s localhost:3037/health | jq
```

Authoritative architecture doc: [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
