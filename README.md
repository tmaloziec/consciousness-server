# consciousness-server

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

A pluggable 6-service ecosystem for multi-agent AI: shared memory,
semantic search, skills + agent registry, machines awareness, and
ed25519 auth — all wired up with `docker compose up`.

Not a framework. Not a library. A set of small HTTP services that
your agents (Claude Code, your own CLI, any HTTP client) hit
directly. You bring the agents; the ecosystem gives them a shared
brain.

Authoritative structure and semantics: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Prerequisites

- **Docker Engine** + **Docker Compose v2**
- **Ollama** on the host (`http://127.0.0.1:11434`), with the
  `nomic-embed-text` model pulled. Both `semantic-search` and
  `consciousness-server` reach Ollama on the host — semantic-search
  uses `network_mode: host`, consciousness-server uses the
  `host.docker.internal` alias. Without Ollama running, `/api/search`
  responds with a precise `503 ollama_unreachable` instead of
  pretending to work.

There's a one-shot check script that verifies everything for you:

```bash
bin/preflight
```

Exits `0` when the host is ready, or prints exactly what's missing
and how to install it (e.g. `ollama pull nomic-embed-text`). Run it
before the first `docker compose up`.

## Quick Start

```bash
git clone https://github.com/build-on-ai/consciousness-server.git
cd consciousness-server
bin/preflight                     # verify host deps, abort early if missing
cd deploy
docker compose up -d
```

The default profile brings up six blocks with `AUTH_MODE=off` so a
solo user gets a working ecosystem without generating any keys.
Key-server is opt-in via `--profile full`.

Verify:

```bash
for p in 3032 3037 3038 3041 3042; do
  curl -sf "http://127.0.0.1:$p/health" >/dev/null && echo "port $p OK"
done
```

### Ports already in use on your host?

The ecosystem reserves `3030–3049` for current and future blocks.
If a default is already taken on your machine, the fix is a
one-file edit — `ports.yaml` is the single source of truth for
every layer (native servers, compose, preflight, tooling).

```bash
# Shift the whole palette by 10000 (or any offset that's free):
sed -i -E 's/^(  [a-z-]+: )3([0-9]{3})$/\113\2/' ports.yaml
sed -i -E 's/^(  redis: )6379$/\116379/' ports.yaml

# Regenerate deploy/.env, re-run preflight, bring the stack up:
bin/sync-ports
bin/preflight
cd deploy && docker compose up -d
```

Container-internal ports (PORT env vars, inter-service URLs via
docker DNS, the redis container's own port) stay hard-coded by
design — they live inside the docker network and never collide
with the host. Only the host-side ports move.

## Adding a Cortex agent (5-minute walkthrough)

[Cortex](https://github.com/build-on-ai/cortex) is the reference agent for this ecosystem — a local-first AI agent powered by Ollama. With the stack above already running, plugging Cortex in takes one terminal:

```bash
# Clone Cortex (separate repo)
git clone https://github.com/build-on-ai/cortex.git
cd cortex

# Make sure the Ollama model is pulled
ollama pull gemma4:e4b

# Start Cortex — auto-discovers CS at localhost:3032
./run.sh agent
```

You should see in the banner:

```
+ Discovered Consciousness Server at http://localhost:3032
+ Briefing from Consciousness Server loaded
```

That's it — Cortex is now part of the ecosystem. It will register itself with CS, receive tasks, and contribute to chat/notes/memory.

**Multiple Cortex agents** coordinating via CS chat + task queue:

```bash
# Three Cortex instances in tmux panes — workers + operator
tmux new-session -d -s cortex-demo
tmux send-keys -t cortex-demo "AGENT_NAME=worker-A ./run.sh worker" Enter
tmux split-window -t cortex-demo -h
tmux send-keys -t cortex-demo "AGENT_NAME=worker-B ./run.sh worker" Enter
tmux split-window -t cortex-demo -v
tmux send-keys -t cortex-demo "AGENT_NAME=operator ./run.sh agent" Enter
tmux attach -t cortex-demo
```

Workers register with CS, poll `/api/tasks/pending/<AGENT_NAME>`, execute, and report back as notes. The operator (interactive CLI) creates tasks and watches results land. Protocol details: [`docs/MULTI-AGENT.md`](docs/MULTI-AGENT.md).

**Different host?** If CS runs on another machine, set `CS_URL` explicitly:

```bash
CS_URL=http://10.0.0.5:3032 AGENT_NAME=cortex-laptop ./run.sh agent
```

## What you get

| Port  | Service              | Role |
|-------|----------------------|------|
| 3032  | consciousness-server | Core — tasks, notes, chat, memory, agents, skills, embedded WS |
| 3037  | semantic-search      | Flask + ChromaDB; embeddings via Ollama |
| 3038  | machines-server      | Infrastructure awareness + realtime telemetry |
| 3040  | key-server           | ed25519 auth — opt-in via `--profile full` |
| 3041  | test-runner          | Async pytest/jest/npm execution |
| 3042  | git-workflow         | Post-commit hook receiver |

External dependencies: **Redis** (hard dependency — packaged in the
compose) and **Ollama** (host-side; see Prerequisites).

## Where things live

Everything the operator edits sits at the repo root:

```
agents/          character profiles (.md — one per role)
skills/          skill definitions (.md — served by CS)
machines/        machine definitions (.yaml — served by machines-server)
```

Runtime state (Redis AOF, ChromaDB files, block logs) lives under
`deploy/volumes/*` and is gitignored. Block source code lives in
`core/`, `semantic-search/`, `key-server/`, `machines-server/`,
`test-runner/`, `git-workflow/`.

## Memory layer (ready out of the box)

`consciousness-server` exposes a full memory API on port 3032. No
extra setup beyond `docker compose up`.

```bash
# Store a conversation
curl -X POST http://127.0.0.1:3032/api/memory/conversations \
  -H 'Content-Type: application/json' \
  -d '{"agent":"agent1","session_id":"s1","messages":[{"role":"user","content":"hi"}]}'

# Append to an ongoing conversation
curl -X PATCH http://127.0.0.1:3032/api/memory/conversations/<id> \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"assistant","content":"next turn"}]}'

# Store a training record. `type` is REQUIRED — one of:
#   troubleshooting | exploration | implementation | explanation | architecture | ui_mapping
curl -X POST http://127.0.0.1:3032/api/memory/training \
  -H 'Content-Type: application/json' \
  -d '{"agent":"agent1","type":"implementation","goal":"summarize","instruction":"...","input":"...","output":"..."}'

# Semantic search across everything embedded into ChromaDB
curl -X POST http://127.0.0.1:3037/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"how did we fix the redis timeout"}'
```

Full reference: [`ARCHITECTURE.md`](ARCHITECTURE.md) §API contracts.
For the fine-tune export workflow: [`docs/TRAINING-DATA.md`](docs/TRAINING-DATA.md).

## Auth modes

Three values for `AUTH_MODE`:

- `off` (default) — no signatures required, everything accepts anonymous requests
- `observe` — requests without a valid ed25519 signature are logged but still served
- `enforce` — unsigned requests get `401`; key-server must be up

Full guide: [`docs/AUTH-MODE.md`](docs/AUTH-MODE.md). Protocol
reference: [`docs/SIGNING-PROTOCOL.md`](docs/SIGNING-PROTOCOL.md).

## Multiple agents

Any number of agents can share the same ecosystem. Each agent gets
a name (any string) and, under `observe`/`enforce`, an ed25519 key
pair registered with key-server. Coordination happens through
shared Redis state and the chat channel on consciousness-server,
not direct IPC.

Character profiles are plain Markdown files in `agents/`. Four
examples ship — `designer.md`, `observer.md`, `validator.md`,
`writer.md`. Add more by dropping new `.md` files; CS reloads on
first missing lookup.

Full guide: [`docs/MULTI-AGENT.md`](docs/MULTI-AGENT.md).

## Clients

Anything that speaks HTTP works. In practice most users pair this
ecosystem with one of:

- **[Claude Code](https://claude.com/claude-code)** — Anthropic's
  agentic CLI. Direct fit: every agent is a `claude` process with a
  role-specific `CLAUDE.md`, hitting CS endpoints for memory, tasks,
  notes, chat. `bin/launch-agent <role>` starts one with a
  character profile from `agents/`. This is the path that has the
  most mileage.
- **[Cortex](https://github.com/build-on-ai/cortex)** — a local-first
  agent built by the same author. Runs entirely on the host via
  Ollama. Use it when you want a GPU-backed local model instead of
  a remote API. Cortex already ships a CS integration, so the same
  agents can transparently swap back and forth.
- **Your own** — any curl/fetch/`requests` client works. The HTTP
  surface is documented in [`ARCHITECTURE.md`](ARCHITECTURE.md) and
  [`docs/SIGNING-PROTOCOL.md`](docs/SIGNING-PROTOCOL.md).

## Cleaning up

`deploy/volumes/*` (ChromaDB store, per-block logs, Redis dump) is
written by containers running as `root`. That's by design — it lets
every block bind-mount a writable location without asking the
operator to align UIDs. The one downside: removing those
directories from the host needs sudo.

```bash
cd deploy
docker compose down              # stops containers, volumes stay
docker compose down -v           # stops + removes named volumes
sudo rm -rf volumes              # fully reset to a pristine state
```

## License

Dual-licensed:

- **AGPL-3.0** for open source, personal, and research use. Running
  a modified version as a network service obliges you to publish the
  modifications — that is the point of AGPL. See [LICENSE](LICENSE).
- **Commercial License** for organisations that cannot accept the
  AGPL obligations. See [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).

Copyright (C) Tomasz Małoziec.

## Security

For threat model, deliberate trade-offs, and vulnerability reporting
see [SECURITY.md](SECURITY.md).

## Contributing

Pull requests are welcome. Before we can merge, every contributor
must sign the [Contributor License Agreement](CLA.md) — the
CLA Assistant bot will prompt you on your first PR. Workflow,
branch naming, and review process live in
[CONTRIBUTING.md](CONTRIBUTING.md). Area owners are listed in
[CODEOWNERS](CODEOWNERS).

## Status

Actively used and iterated on. This repository is the sterile
public form of a system that has been running in private since
mid-2025; the public cut is intentionally a minimal core without
any operator-specific agents, keys, or data.
