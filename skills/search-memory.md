# Skill: search-memory

Query the CS ecosystem's shared memory (notes, past sessions, skill
definitions) to find prior work relevant to a new task before
starting it.

## When to use

- The task sounds familiar — check if someone already solved it.
- Before a design session — pull decisions already made on the topic.
- When an agent claims "X was established earlier" and you want to
  verify.

## Inputs

- `query` — free-text search string. Be specific: "BEC investigation
  2026-03-06" beats "email fraud".
- `collections` — optional allowlist: `notes`, `session_summaries`,
  `training_data`, `project_memory`, `conversations`. Default = all.
- `limit` — max results (default 5).

## Output

Ranked list of `{collection, id, score, excerpt}`. The caller decides
whether to read the full document.

## Rules

- A single hit with score < 0.3 is noise — ask for a clearer query
  instead of parroting the hit.
- If multiple hits contradict each other, surface that explicitly:
  "memory gives two answers: A (2026-03-06), B (2026-04-15)". Let
  the human decide which is current.
- Memory records are frozen in time. If the question is about
  *current* state, prefer reading live code / config before quoting
  memory.

## Backend

Hits the semantic-search block at `$SEMANTIC_SEARCH_URL/api/search`
(default `http://semantic-search:3037`). The block embeds the query
through Ollama's `nomic-embed-text` model and compares against
ChromaDB collections.
