# Ecosystem Architecture

**Authoritative reference.** This document defines the structure
and semantics of the `consciousness-server` ecosystem. If the code
ever drifts from this document, **the code is wrong and must be
fixed** — the document is not updated to match the drift.

Version: v1 (public release). Last structural review: 2026-04-22.

---

## 0. Purpose in one paragraph

Consciousness-server is a pluggable ecosystem of small HTTP
services that together give a fleet of AI agents a shared brain:
durable memory, semantic recall, a character registry, skill
library, host/infrastructure awareness, and opt-in cryptographic
request signing. Any agent that speaks HTTP — Claude Code, Cortex,
a custom worker — can connect, read/write shared state, coordinate
through chat and mentions, and hand work off to other agents. The
system is designed for a single operator or a small team running
on a trusted LAN; it is not a public multi-tenant service.

---

## 1. Repo layout

```
consciousness-server/              ← repo root (after git clone)
│
├── agents/                        ← byty: character profiles (operator edit)
│   ├── designer.md                ·   one .md per role
│   ├── observer.md
│   ├── validator.md
│   └── writer.md
│
├── skills/                        ← worek: skill definitions (operator edit)
│   ├── search-memory.md
│   └── summarize-session.md
│
├── machines/                      ← byty: machine definitions (.yaml)
│
├── core/                          ← consciousness-server block (Node, 3032)
│   ├── server.js
│   ├── package.json
│   ├── Dockerfile
│   └── middleware/
│
├── semantic-search/               ← block (Flask + ChromaDB, 3037)
├── key-server/                    ← block (Node + ed25519, 3040, opt-in)
│   └── keys/                      ·   pub keys for bootstrap (per-deployment)
├── machines-server/               ← block (Flask + psutil, 3038)
├── test-runner/                   ← block (Flask, 3041)
├── git-workflow/                  ← block (Python stdlib, 3042)
│
├── deploy/                        ← docker-compose, runtime state
│   ├── docker-compose.yml
│   ├── README.md
│   └── volumes/                   ·   ALL runtime state (gitignored)
│       ├── redis/                 ·   Redis AOF
│       ├── chroma/                ·   ChromaDB vectors
│       ├── training/              ·   session mirror drop-zone (v2)
│       └── *-logs/                ·   per-block stderr/stdout
│
├── bin/                           ← operator scripts
│   ├── preflight                  ·   dependency check
│   ├── launch-agent               ·   start Claude Code with a role
│   ├── sign-request               ·   CLI signer (observe/enforce)
│   └── sync-middleware            ·   copy lib/ masters to block middleware/
│
├── lib/                           ← shared middleware masters
│   ├── verify-signed.js           ·   Node middleware master
│   └── verify_signed.py           ·   Python middleware master
│
├── docs/                          ← operator-facing documentation
│   ├── AUTH-MODE.md
│   ├── SIGNING-PROTOCOL.md
│   ├── MULTI-AGENT.md
│   └── TRAINING-DATA.md
│
├── LICENSE                        ← AGPL-3.0
├── README.md                      ← entry point
└── ARCHITECTURE.md                ← this document
```

### 1.1 Categories

Top-level directories split into **four semantic categories**:

| Category | Dirs | Who edits | Git-tracked |
|---|---|---|---|
| **Byty** (tangible things) | `agents/`, `machines/` | Operator | YES |
| **Zasoby** (attached resources) | `skills/` | Operator | YES |
| **Blocks** (runnable services) | `core/`, `semantic-search/`, `key-server/`, `machines-server/`, `test-runner/`, `git-workflow/` | Developers | YES |
| **Infrastructure** | `deploy/`, `bin/`, `lib/`, `docs/` | Developers + operator | YES (except `deploy/volumes/`) |

**One rule of thumb:** if you are a new operator and want to *change
what the system knows about*, you edit `agents/`, `skills/`, or
`machines/`. If you want to *change what the system does*, you edit
a block. If you want to *change how it deploys*, you edit `deploy/`.

### 1.2 Names worth knowing

- **`core`** is the code of the consciousness-server block itself.
  The repo is named `consciousness-server` because the whole
  ecosystem is organised around it. Avoid `consciousness-server/`
  as a path inside the repo — that name belongs to the repo root.
- **`block`** is the unit of composition in this codebase. Each
  block has a directory, a Dockerfile, and one long-running process.
  Blocks are **not** plugins at runtime — they are separate
  containers talking over HTTP.
- **`ecosystem`** is the set of blocks running together. No process
  is called "the ecosystem"; it only exists as a configuration.

---

## 2. Blocks

Six blocks in the default profile, one opt-in under `--profile full`.

| Block | Port | Profile | Lang | Purpose |
|---|---|---|---|---|
| **consciousness-server** (core) | 3032 | default | Node | Tasks, notes, chat, memory (conversations + training + summaries), agent registry, skills registry, embedded WS |
| **semantic-search** | 3037 | default | Flask | ChromaDB vector store + Ollama embeddings. `/api/embed`, `/api/search`, `/api/index-project-memory` |
| **machines-server** | 3038 | default | Flask | `/api/system` realtime telemetry (psutil + nvidia-smi), `/api/machines` static YAMLs, MCP surface |
| **test-runner** | 3041 | default | Flask | Async pytest/npm/vitest execution. Validated test-type allowlist, no shell interpolation |
| **git-workflow** | 3042 | default | stdlib | `POST /api/git/hook/post-commit` receiver → SQLite |
| **key-server** | 3040 | `full` | Node | ed25519 signed-request verification. Pub keys in `key-server/keys/agents/*.pub`. Audit log at `deploy/volumes/key-server-logs/audit.jsonl` |

### 2.1 External dependencies (not in repo)

- **Redis** (port 6379) — shared memory store + pub/sub. Hard
  dependency of consciousness-server. Packaged in `deploy/docker-compose.yml`.
- **Ollama** (port 11434) — host-side LLM runtime. Used by
  semantic-search for embeddings (`nomic-embed-text` model
  required). Not containerised because it needs host GPU access.

### 2.2 Categorisation — "what does this block do with data"

**Providers** (passive — serve data when asked, no side-effects
outside their own state):
- consciousness-server — serves memory/tasks/chat/agents/skills
- semantic-search — serves vector search results
- machines-server — serves host telemetry + machine YAMLs
- key-server — serves auth verdicts

**Actors** (active — do things to the system):
- test-runner — spawns subprocesses (pytest/npm)
- git-workflow — receives hooks, writes DB

A deployment that cares about blast radius should pay extra attention
to **actors** — they are the ones with a kill switch (see
`docs/AUTH-MODE.md` for gating them behind `enforce`).

---

## 3. Data flow

### 3.1 Where each kind of data physically lives

| Kind | Location | Mechanism | Gitignored? |
|---|---|---|---|
| Agent character profiles | `agents/*.md` | operator edits + git | NO |
| Skill definitions | `skills/*.md` | operator edits + git | NO |
| Machine definitions | `machines/*.yaml` | operator edits + git | NO |
| Conversations | Redis `conversation:<id>` (TTL 90 days) | CS `POST /api/memory/conversations` | runtime |
| Training records | Redis `training:<id>` (no TTL) | CS `POST /api/memory/training` | runtime |
| Session summaries | Redis `summary:<id>` + ChromaDB `session_summaries` collection | CS `POST /api/memory/summaries` (auto-embedded) | runtime |
| Notes | Redis `note:<id>` | CS `POST /api/notes` | runtime |
| Embeddings / vector search | ChromaDB (`deploy/volumes/chroma/`) | semantic-search `/api/embed`, `/api/index-project-memory` | runtime |
| Tasks | Redis `task:<id>` | CS `POST /api/tasks` | runtime |
| Chat messages | Redis (stream/list) + mention index | CS `POST /api/chat` with `@mentions` in content | runtime |
| Logs | Redis `log:<id>` (TTL 7 days) + `deploy/volumes/*-logs/*.log` | CS `saveLog()` + container stdout | runtime |
| Agent pub keys | `key-server/keys/agents/<id>.pub` | operator bootstrap (scp) | gitignored per-deployment |
| Commit history (git-workflow) | SQLite at `deploy/volumes/git-workflow/commits.db` | `POST /api/git/hook/post-commit` | runtime |
| Claude Code session mirror (v2) | `deploy/volumes/training/sessions/*.jsonl` | mirror timer (v2, not shipped) | runtime |

### 3.2 Auto-forwarding rules (today)

Only **session summaries** are auto-embedded into ChromaDB on POST.
`conversations` and `training` records are written to Redis but
**not** auto-pushed to ChromaDB. Callers who want them searchable
must POST to `/api/embed` on semantic-search explicitly. This is
intentional — it keeps the embedding pipeline opt-in and predictable.

### 3.3 Request lifecycle under `enforce`

```
agent ──POST /api/x──▶ block ──POST /api/verify──▶ key-server
        (4 signed                  (canonical           │
         headers +                  message +           │  verify:
         body)                      body_sha256)        │  - timestamp window
                                                        │  - nonce cache (Redis SET NX EX 300)
                                                        │  - pub key lookup
                                                        │  - ed25519 verify
                                                        │  - audit log
                                                        ▼
        ◀──────────────────── 200 or 401 ──────────────
```

See `docs/SIGNING-PROTOCOL.md` for the canonical message format,
header names, and per-field rules.

---

## 4. API surface (authoritative, abbreviated)

### 4.1 consciousness-server (3032)

| Method | Path | What |
|---|---|---|
| GET | `/health` | Always-open status |
| GET | `/api/agents` | Online agents registry |
| POST | `/api/agents/register` | Register this agent |
| GET | `/api/identity/claude-md/:agent` | Agent's CLAUDE.md (from `agents/<agent>.md`) |
| GET | `/api/identity/claude-md` | List agents |
| GET | `/api/skills` | Skills registry (from `skills/*.md`) |
| GET | `/api/skills/:name` | One skill |
| POST | `/api/notes` | Write a note |
| GET | `/api/notes` | List notes |
| POST | `/api/chat` | Post a chat message — body `{from, content}`, `@mentions` in `content` |
| GET | `/api/chat` | Global chat stream (query: `limit`, `since`) |
| GET | `/api/chat/mentions/:agent` | Agent's mention inbox |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks/pending/:role` | Tasks assigned to a role |
| POST | `/api/memory/conversations` | Store a conversation |
| PATCH | `/api/memory/conversations/:id` | Append messages to existing conversation |
| GET | `/api/memory/conversations` | List (pagination: `limit`, `offset`) |
| GET | `/api/memory/conversations/:id` | One conversation |
| GET | `/api/memory/search` | Keyword search in memory |
| POST | `/api/memory/training` | Store training record. **`type` REQUIRED**: one of `troubleshooting`/`exploration`/`implementation`/`explanation`/`architecture`/`ui_mapping` |
| PATCH | `/api/memory/training/:id` | Update training record |
| GET | `/api/memory/training` | List (pagination) |
| POST | `/api/memory/summaries` | Store summary (auto-embedded to ChromaDB) |
| GET | `/api/memory/summaries` | List |
| GET | `/api/memory/stats` | Counts per collection |
| WS | `/ws` | Embedded WebSocket for push events |

### 4.2 semantic-search (3037)

| Method | Path | What |
|---|---|---|
| GET | `/health` | Always-open status + collection counts |
| POST | `/api/embed` | Write embedding — body `{collection, id, text, metadata}`. 503 with `{reason, fix}` if Ollama unreachable |
| GET/POST | `/api/search` | Vector search — body or query `{query, collection?, limit?}` |
| POST | `/api/index-project-memory` | Recursively index `**/*.md` from a path |

### 4.3 key-server (3040, `--profile full`)

| Method | Path | What |
|---|---|---|
| GET | `/health` | Always-open |
| POST | `/api/verify` | Verify a signed request (see `docs/SIGNING-PROTOCOL.md`) |
| GET | `/api/agents/identity/:id` | Check a pub key is registered |
| GET | `/keys/ssh/:name` | Dispense a stored SSH key (IP-whitelist + X-API-Key gated) |
| GET | `/keys/api/:service` | Dispense a stored API key (IP-whitelist + X-API-Key gated) |
| GET | `/audit` | Recent audit entries |

Secrets dispensing is for **single-user / small-team LAN** deployments
only. Never expose port 3040 publicly.

### 4.4 machines-server (3038)

| Method | Path | What |
|---|---|---|
| GET | `/health` | Always-open |
| GET | `/api/system` | Realtime CPU/RAM/GPU/disk from host |
| GET | `/api/machines` | Static machine definitions from `machines/*.yaml` |
| GET | `/api/infrastructure` | Combined static + realtime |
| GET | `/api/services` | Service check across all blocks |
| GET | `/mcp/tools`, POST `/mcp/call` | MCP surface for Claude Desktop etc. |

### 4.5 test-runner (3041)

| Method | Path | What |
|---|---|---|
| GET | `/health` | Always-open |
| POST | `/api/test` | Run tests — body `{test_type: pytest\|npm\|vitest, project_path}`. **No arbitrary `command` — types are allowlisted, shell=False** |
| GET | `/api/test/:id` | Check result |

### 4.6 git-workflow (3042)

| Method | Path | What |
|---|---|---|
| GET | `/health` | Always-open |
| POST | `/api/git/hook/post-commit` | Receive a commit record |
| GET | `/api/git/commits` | List recent commits |

---

## 5. Authentication (AUTH_MODE)

Three modes, set per-block via env:

| Value | Behaviour | Primary use |
|---|---|---|
| `off` (default) | Pass through. No key-server call, no log | Solo user, trusted LAN, CI smoke |
| `observe` | Verify; on failure, log to `auth-observe.log` and pass through | Migration from unsigned to signed |
| `enforce` | Verify; on failure, `401` (or `503` if key-server down) | Multi-agent / production |

**Never fail-open.** In `enforce`, if key-server is unreachable,
the block returns `503`. This is deliberate — it prevents a
compromised or silenced key-server from silently de-authenticating
the ecosystem.

Always-open endpoints (ignore AUTH_MODE): `GET /health`,
`GET /metrics`, `OPTIONS *`, WebSocket upgrade on CS.

Full details: `docs/AUTH-MODE.md`. Protocol spec: `docs/SIGNING-PROTOCOL.md`.

---

## 6. How to add things

### 6.1 Add a new agent role

1. Write `agents/<role>.md` with the character profile.
2. If running under `observe`/`enforce`: generate an ed25519 keypair,
   drop the pub key into `key-server/keys/agents/<AGENT>.pub`.
3. `bin/launch-agent <role> <project-path>` to start Claude Code
   with that role.
4. Inside the agent: `POST /api/agents/register` happens automatically.

### 6.2 Add a new skill

1. Write `skills/<skill>.md` with the skill description.
2. CS reloads on first miss — no restart needed.
3. Agents query `GET /api/skills/<skill>` to retrieve.

### 6.3 Add a new machine definition

1. Write `machines/<host>.yaml` with specs, roles, contacts.
2. machines-server reloads on first request.

### 6.4 Add a new block

1. Create `<block-name>/` with `Dockerfile` + `server.js`/`server.py`.
2. If it speaks the signed protocol: `mkdir <block-name>/middleware`
   + `echo verify_signed.py > <block-name>/middleware/.sync-target`
   + `bin/sync-middleware` copies master from `lib/`.
3. Register the block in `deploy/docker-compose.yml`, `ports.yaml`,
   `services.yaml`.
4. Update `ARCHITECTURE.md` §2 and `bin/preflight` (port check).

### 6.5 Change an endpoint contract

1. Update this document first.
2. Update the code to match.
3. Update `docs/` if there's an operator-facing impact.

The document leads the code.

---

## 7. Scope decisions

### 7.1 What ships in v1

- Six blocks (above) + Redis + Ollama (host) + three AUTH_MODEs
- Memory API: conversations, training, summaries, notes, tasks
- ChromaDB auto-embedding only for summaries
- ed25519 signed-request protocol with nonce anti-replay
- `bin/preflight`, `bin/launch-agent`, `bin/sign-request`
- Four example agent roles, two example skills

### 7.2 What is NOT in v1 (explicitly deferred to v2+)

- **Mirror timer** for `~/.claude/projects/*.jsonl` → `deploy/volumes/training/sessions/`.
  Placeholder only. Implementation deferred.
- **PDF / DOCX upload endpoints.** Text/JSON only today. Preprocess
  binaries on the host before POST.
- **Auto-embed conversations and training** into ChromaDB. Only
  summaries auto-embed today.
- **Block-to-block signing** (CS calling SS on behalf of an agent).
  Inbound signing only.
- **Full TLS / encrypted transport.** LAN / VPN assumption.
- **Per-endpoint authorization (ACL/RBAC).** An authenticated agent
  is allowed on every endpoint.
- **Multi-tenant isolation.** Single-operator / small-team model.

### 7.3 Non-goals (not planned)

- Running CS as a global SaaS.
- Holding credentials for third-party LLM providers beyond what
  `key-server/keys/api/*` already does as a secrets dispenser.
- Replacing a proper identity provider (LDAP/OIDC/SAML).

---

## 8. The rule about this document

**Architecture is the contract. Code follows.**

When the code drifts from this document:
- Do not edit this document to match the code.
- Do not add a "known deviation" note here.
- Fix the code.

When the architecture genuinely needs to change (new block, new
endpoint, changed data flow):
- Edit this document first.
- Only then edit the code.
- Include both in the same commit.

This ensures there is always exactly one source of truth, and that
the document reflects intent rather than accreted implementation
quirks.
