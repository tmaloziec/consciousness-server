# Training data pipeline

Documentation of the memory layer that agents write against, and
the training-data export workflow that reads it back out for
fine-tuning.

## How the memory layer works today

The core write/read API lives in `consciousness-server` and is live
out of the box. After `docker compose up -d`, these endpoints
accept writes immediately — they persist to Redis and, where
configured, fan out to ChromaDB via `semantic-search`:

| Endpoint | Method | What it stores |
|---|---|---|
| `/api/memory/conversations` | POST | Full session transcripts (role/content pairs + reasoning) |
| `/api/memory/conversations/:id` | PATCH | Append new messages to an existing session |
| `/api/memory/conversations` | GET | List / paginate |
| `/api/memory/conversations/:id` | GET | Fetch one |
| `/api/memory/search` | GET | Cross-field keyword search |
| `/api/memory/training` | POST | Fine-tune records — **`type` is required** (see below) |
| `/api/memory/training/:id` | PATCH | Correct / relabel |
| `/api/memory/training` | GET | List / paginate |
| `/api/memory/summaries` | POST/GET | Session summaries, indexed into ChromaDB |
| `/api/memory/stats` | GET | Counts per collection |

Your agents (Claude Code, Cortex, your own CLI, LangChain clients,
anything that speaks HTTP) write directly against these endpoints.
Nothing in `deploy/volumes/training/` is required for the memory
layer to work — that directory is the drop-zone for the optional
mirror timer described below.

## Training-record shape

`POST /api/memory/training` requires a `type` field. The server
rejects requests without it with `400 Missing required field: type`.
Valid values:

- `troubleshooting` — diagnosing and fixing a concrete failure
- `exploration` — investigating options before committing to a path
- `implementation` — building a feature per a spec
- `explanation` — producing a teaching/summary artefact
- `architecture` — top-level design decision
- `ui_mapping` — mapping UI elements to backend semantics

Example:

```bash
curl -X POST http://127.0.0.1:3032/api/memory/training \
  -H 'Content-Type: application/json' \
  -d '{
    "agent": "writer",
    "type": "implementation",
    "goal": "summarize a session",
    "instruction": "Write a 2-paragraph summary of the pasted transcript.",
    "input": "<pasted transcript>",
    "output": "<model output>",
    "metadata": {"session_id": "abc-123"}
  }'
```

The record is persisted in Redis under `training:<uuid>` and
returned with its id. `PATCH /api/memory/training/:id` lets you
relabel or correct the record later.

## What the mirror timer (v2) writes

If you run the optional mirror timer — scheduled for v2 — it writes
JSONL copies of your Claude Code session logs into
`deploy/volumes/training/`:

| Path | Written by | What |
|---|---|---|
| `sessions/*.jsonl` | mirror timer | 1:1 copy of `~/.claude/projects/**/*.jsonl` on the host |
| `.sync-manifest.jsonl` | same | Book-keeping — which files are already mirrored |
| `chunks/` (optional) | same | Intermediate per-chunk dumps when `DEBUG_CHUNKS=1` |

All of the above is gitignored. Nothing here is ever committed.
Your sessions are yours.

## What does NOT land here

- Sessions from other machines — cross-host aggregation is out of scope
- Training data from other users — you get only what your own agents produced
- PDF or DOCX uploads — the current pipeline is text/JSON only.
  To feed a PDF into memory, pre-process with `pdftotext` on your
  side, then POST the extracted text through `/api/memory/*` or
  directly to `/api/embed` on semantic-search.

## Feeding your data into a trainer

After you have conversations / training records stored, pull them
out via the memory API on CS (port 3032). A dedicated export endpoint
on semantic-search ships with the v2 mirror timer.

```bash
# Native CS pagination — works today
curl -s "http://127.0.0.1:3032/api/memory/training?limit=500&offset=0" \
  | jq -c '.training_data[]' > ~/my-fine-tune-dataset.jsonl
```

Each record has `{agent, type, goal, instruction, input, output, metadata, created_at}`.
Feed it straight into Anthropic's fine-tune API, Hugging Face
`datasets`, or `llama.cpp finetune` after a small shape adapter.

## Privacy

Training records and conversations persist verbatim by default.
Before you publish anything derived from this data, apply your own
PII pass — the bundled scrubber (API keys, SSH private keys, JWTs,
emails, phone numbers) ships with the v2 mirror timer, not with
the base memory API.

If you need an agent's sessions to skip the mirror entirely, set
`SKIP_TRAINING=1` on that agent once the mirror ships.
