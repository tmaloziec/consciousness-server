# Changelog

All notable changes to consciousness-server, public release line.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-16

### Added
- **F4.6 contracts + codegen pipeline.** `lib/schemas/*.openapi.yaml`
  is now the single source of truth for chat / notes / tasks /
  common schemas. `bin/sync-schema` (Python; deps in
  `bin/requirements.txt`) bundles each contract into
  `generated/openapi/<name>.bundle.openapi.json` and emits Node
  consumers in `core/generated/schemas/*.js`. The full pipeline also
  emits TypeScript + Python when a `dashboard-v3/` tree is present.
- `POST /api/tasks` is the canonical task-creation route, matching
  ARCHITECTURE.md and `lib/schemas/tasks.openapi.yaml`. The legacy
  `POST /api/tasks/create` keeps working as an alias.
- `NoteType` value `'audit'` for audit notes. Was previously rejected
  with `400 Invalid type`, forcing agents into a
  `type=observation` + `[AUDIT]` title-prefix workaround.
- `/health` reports a top-level `semantic_search` field
  (`ok | misconfigured | http_NNN | timeout | unreachable`) so
  monitoring can distinguish empty vs unreachable vs misconfigured
  cleanly.
- `HEALTH_SEMANTIC_TIMEOUT_MS` env var (default `3000`) for tuning the
  semantic-search probe timeout in `/health`.

### Changed
- **`POST /api/tasks`** and `POST /api/tasks/create` now return the
  full `Task` per `lib/schemas/tasks.openapi.yaml`, not just
  `{task_id, status, created_at}`. The new payload is a strict
  superset — clients that only read `task_id` / `status` /
  `created_at` keep working if they switch to the canonical `id`
  field (alias `task_id` is not preserved).
- **`POST /api/notes`** now returns the full `Note` per
  `lib/schemas/notes.openapi.yaml`. Same superset story — switch
  reads of `note_id` to `id`.
- Mentions parser is now driven by the live agent registry instead
  of a hardcoded `(CCA|CCL|CD|all)` allowlist. Any agent registered
  via `POST /api/agents/register` becomes a valid `@mention` target,
  including names with digits/dashes/underscores
  (`@CC-TESTER`, `@agent-001`). `@ALL` is preserved as the broadcast
  token.
- `/health` semantic-search probe timeout raised from 500 ms to
  3000 ms — the old value was tighter than an Ollama cold-start and
  conflated "still warming up" with "dead".

### Fixed (BREAKING for some `/health` consumers)
- **`/health` field rename: `memory.conversations` → `memory.chat_messages`
  + `memory.conversation_embeddings`.** The old single field
  conflated two layers (chat sessions in CS core vs vectorised
  chunks in semantic-search). Monitoring that read
  `memory.conversations` directly **will not find it in v1.1.0** —
  either read both new fields or update aggregate-status logic to
  the new shape. `conversation_embeddings` is `null` (not `0`) when
  semantic-search is unreachable, so downstream alerts must
  null-check before comparing.
- `/health` was also reporting `chat_messages` from the wrong
  in-memory array (`conversations.length` instead of
  `chatMessages.length`). The value is now realtime chat messages
  as documented.
- `validTypes` for `POST /api/notes` and `validStatuses` for
  `PATCH /api/tasks/:id/status` are now imported from the generated
  schemas (`core/generated/schemas → NoteTypeValues, TaskStatusValues`)
  instead of being maintained by hand in `core/server.js`. Previously,
  adding a value to `lib/schemas/*.openapi.yaml` silently drifted from
  the runtime acceptance list.
- `SEMANTIC_SEARCH_URL` is now validated before the `/health` and
  `/api/memory/summaries` auto-embed probes fire — both consumers
  share `isValidSemanticSearchUrl()`. The validator accepts only
  `http(s)://` URLs, and, when the optional
  `SEMANTIC_SEARCH_ALLOWED_HOSTS` env (comma-separated) is set,
  rejects hosts outside the allowlist. A misconfig logs a warning
  and skips the probe instead of letting the health check issue an
  arbitrary outbound request.
- `bin/sync-schema` now fails the JS barrel build with a clear error
  if two contracts export the same symbol — `Object.assign()` would
  otherwise silently overwrite one definition.
- `bin/sync-schema --check` now works out of the box on a fresh
  clone of the public repo. The previous build looked for
  `consciousness-server/generated/schemas/` (mirror layout) and
  required `dashboard-v3/package.json`. The script now writes JS
  to `core/generated/schemas/` and auto-disables `ts` / `python`
  targets when `dashboard-v3/` is absent.

### Migration from v1.0.0 → v1.1.0

For most operators the upgrade is drop-in — the BREAKING changes
above only affect callers that read specific JSON fields directly.

**Checklist:**

1. **Update `/health` consumers.** Replace
   `memory.conversations` reads with either
   `memory.chat_messages + memory.conversation_embeddings` or your
   chosen aggregate. Treat `conversation_embeddings: null` as
   "unknown", not "zero". Optionally consume the new top-level
   `semantic_search` field for explicit reason codes.
2. **Update task-creation clients.** The response is now a full
   `Task`; the previous `task_id` field is now `id`. The legacy
   `POST /api/tasks/create` still accepts the same request body,
   so only the response parsing needs to change. New code should
   target `POST /api/tasks`.
3. **Update notes-creation clients.** Same shape change for
   `POST /api/notes` — `note_id` is now `id`, and the full note
   object is returned.
4. **Optional: install Python deps.** Only required if you plan to
   edit `lib/schemas/*.yaml` and regenerate:
   `pip install -r bin/requirements.txt`.

No data migration is required — Redis state is forward-compatible.

## [1.0.0] — 2026-04-22

Initial public release.
