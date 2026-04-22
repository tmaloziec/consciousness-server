# Mesh Stage 1 — ingest substrate

This is the first deployable piece of the BuildOnAI Mesh roadmap. It is
intentionally graph-free: we only persist the *substrate* that future
graph + density work needs, with no commitment to any particular Mesh
architecture yet.

## What it does

`memory-server` (port 3045) accepts a document, deduplicates by SHA-256,
chunks the text with character-level offsets, embeds each chunk via
Ollama, and stores the result in PostgreSQL+pgvector.

## What it does NOT do

- No knowledge graph (no `knowledge_nodes`, no `knowledge_edges`, no
  density field). Those are Stage 2.
- No NER on the ingest path. Entity mentions are extracted lazily by a
  background pass into `entity_mentions`. Slowing ingest on every
  document by an LLM call would block the firehose.
- No PDF / DOCX text extraction. The CLI shipped with this stage assumes
  the document is already text. Binary-format extractors belong to a
  later iteration.

## Why it has its own service and database

Two reasons:

1. **The hot path** (chat, tasks, agent FSM in `consciousness-server`) is
   served from Redis and tuned for low latency. Knowledge ingest is a
   cold path with very different access patterns: large writes,
   vector-similarity reads, eventual consistency. Mixing them inside CS
   would force compromises on both.
2. **Optionality**. A solo developer running `docker compose up` should
   not be required to spin up a 200-MB Postgres just to chat with an
   agent. `memory-server` lives behind the `mesh` profile in the compose
   file. The default `up` brings up six blocks; `--profile mesh` adds
   memory-server and its Postgres.

## What is captured per document

| Table | What it holds | Why this matters for Stage 2 |
|---|---|---|
| `knowledge_sources` | Immutable raw documents, deduplicated by SHA-256 | Stage 2 builds nodes by aggregating mentions across many sources — needs the source set to be stable and deduplicated |
| `primary_indices` | Chunked text with **byte offsets** in the original document, plus pgvector embeddings | Offsets enable highlighting in source UI and chunk×node density (Stage 2). Embeddings drive the wector pre-filter in routing |
| `entity_mentions` | NER output, populated lazily | Candidates for the eventual canonical `knowledge_nodes` |
| `ingest_audit` | Every ingest attempt: success, duplicate, failure | Operator can answer "did that document we worried about ever land?" |

The byte offsets in `primary_indices` are the load-bearing field. Without
them, Stage 2 has to re-chunk and re-embed the entire corpus to recover
provenance. Recording them now costs one INT pair per chunk.

## Quick start

### Run on a fresh laptop

```bash
git clone https://github.com/build-on-ai/consciousness-server.git
cd consciousness-server/deploy
docker compose --profile mesh up -d

# Apply the schema (one-shot, idempotent):
docker compose exec memory-server node db/migrate.js

# Verify:
curl -s http://localhost:3045/health | jq
# → {"db_ready": true, ...}

# Ingest a file:
../bin/ingest-document ../README.md --type txt
```

### Run in an existing ecosystem (laptop / ADAX / HP)

```bash
git -C /path/to/consciousness-server pull origin main
cd /path/to/consciousness-server/deploy
docker compose --profile mesh up -d memory-postgres memory-server
docker compose exec memory-server node db/migrate.js
```

The `--profile mesh` filter starts only the new services without
restarting CS / semantic-search / etc.

### HTTP API at a glance

```
GET  /health                        liveness + db readiness
POST /api/sources/ingest            ingest a document
GET  /api/sources                   recent sources
GET  /api/sources/:id               source + chunk count
GET  /api/sources/:id/chunks        paginated chunks (with offsets)
POST /api/search                    semantic search across all chunks
GET  /api/audit                     recent ingest attempts (success / duplicate / fail)
```

Body shape for `POST /api/sources/ingest`:

```json
{
  "file_path": "absolute or relative path (informational)",
  "source_type": "email|pdf|conversation|offer|spec_sheet|...",
  "ingested_by": "agent name or human identifier",
  "content": "the text" ,
  "language": "pl|en|it (optional, autodetected)",
  "parent_source": "uuid of parent doc (optional)",
  "metadata": { "any": "json", "you": "want" }
}
```

`content` may be replaced with `content_b64` (base64-encoded UTF-8) when
the operator does not want to deal with shell quoting around long text.

## Backfill strategy

For an ecosystem that already has months of agent conversations stored
elsewhere (e.g. in Redis / `~/.claude/projects/*.jsonl`), backfill
incrementally:

```bash
# Skeleton — one source per session log, parent_source links for replies:
for session in ~/.claude/projects/*.jsonl; do
  bin/ingest-document "$session" --type conversation \
      --by "$(basename "$session" .jsonl)" \
      --metadata-json '{"backfill": true}'
done
```

Re-running is safe: the `file_hash` unique constraint silently dedupes.

## What Stage 2 builds on this

Stage 2 (Mesh PoC on the CPK domain) reads `primary_indices` and
`entity_mentions`, resolves canonical entities into `knowledge_nodes`,
computes a `chunk_node_density` matrix (one row per chunk×node pair with
a continuous density value), and starts crystallising
`knowledge_edges` once density exceeds the per-domain threshold. That
work uses the same Postgres database — no migration of existing data.

Until then, Stage 1 stands alone: every byte logged today is usable
substrate, regardless of how Stage 2 evolves.
