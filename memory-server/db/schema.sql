-- =============================================================================
-- memory-server schema — Stage 1 of the BuildOnAI Mesh roadmap.
-- =============================================================================
--
-- This schema captures every document the ecosystem ingests, with enough
-- structural metadata that later stages (knowledge graph, density field,
-- discrete derivatives) can be built on top WITHOUT re-processing the
-- corpus from scratch.
--
-- Stage 1 is intentionally graph-free. We record:
--   - sources       (immutable raw documents, deduplicated by SHA-256)
--   - primary_indices (chunked text WITH BYTE OFFSETS in the source —
--                     this is what enables future highlight + chunk×node
--                     density. If you ingest without offsets, future Mesh
--                     work has to re-chunk the corpus.)
--   - entity_mentions (NER output, populated lazily by a background pass)
--
-- The "knowledge_nodes" / "knowledge_edges" / "chunk_node_density" tables
-- from the v0.3 architecture document are explicitly NOT here. Those belong
-- to Stage 2 (Mesh PoC on the CPK domain), once we have enough Stage 1 data
-- to validate the density field empirically.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so applying this on an
-- already-migrated database is a no-op.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector for embeddings

-- ----------------------------------------------------------------------------
-- knowledge_sources — one row per ingested document. Immutable.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_sources (
    source_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Where the document came from. Path is informational; the canonical
    -- identity is file_hash, so re-ingesting the same bytes from a
    -- different path is detected and rejected.
    file_path       TEXT NOT NULL,
    file_hash       TEXT NOT NULL,
    file_size       BIGINT,

    -- Coarse classification of how the document arrived. Free-form to keep
    -- the schema stable; new types do not require migration.
    source_type     TEXT NOT NULL,
        -- typical values:
        --   'email', 'pdf', 'docx', 'txt',
        --   'conversation' (agent ↔ agent or human ↔ agent),
        --   'web_page', 'transcript',
        --   'offer', 'spec_sheet', 'contract', 'invoice'

    -- Detected language (ISO 639-1). NULL if detection failed; do not block
    -- ingest on language detection.
    language        TEXT,

    -- Provenance: which agent or process introduced this document. Helps
    -- audits ("who ingested the offer that contradicts the contract?").
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ingested_by     TEXT NOT NULL,

    -- Provenance chain. If a document was extracted from another document
    -- (e.g. an attachment from an email, a quoted reply, a conversation
    -- segment), parent_source links to the originating record.
    parent_source   UUID REFERENCES knowledge_sources(source_id),

    -- Free-form per-source metadata. Sender, project tag, sender's role,
    -- email subject, anything that helps later filtering. JSONB so we
    -- never need a schema migration to add a field.
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT knowledge_sources_hash_unique UNIQUE (file_hash)
);

CREATE INDEX IF NOT EXISTS idx_sources_type
    ON knowledge_sources(source_type);
CREATE INDEX IF NOT EXISTS idx_sources_ingested_at
    ON knowledge_sources(ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_sources_parent
    ON knowledge_sources(parent_source);
CREATE INDEX IF NOT EXISTS idx_sources_metadata
    ON knowledge_sources USING gin(metadata);

-- ----------------------------------------------------------------------------
-- primary_indices — chunked text with BYTE OFFSETS in the source.
--
-- The byte offsets are the load-bearing field of this table. They enable:
--   - precise highlighting in the original document (Legal-Assistant style)
--   - re-chunking later without losing provenance
--   - the chunk×node density matrix that Stage 2 (Mesh) will build
--
-- Without offsets, every Stage 2 operation has to re-tokenise the source.
-- Recording them now costs one INT pair per chunk; not recording them costs
-- a full re-process of the corpus when Stage 2 lands.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS primary_indices (
    chunk_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL
        REFERENCES knowledge_sources(source_id) ON DELETE CASCADE,

    -- Chunk position in the source. chunk_seq starts at 0, monotonically
    -- increasing. Offsets are in BYTES of the original document text.
    chunk_seq       INT  NOT NULL,
    start_offset    INT  NOT NULL,
    end_offset      INT  NOT NULL,

    text            TEXT NOT NULL,
    text_hash       TEXT NOT NULL,
    token_count     INT,

    -- 768-dim embedding from nomic-embed-text. NULL if embedding deferred
    -- (e.g. the chunk was inserted before the embedding service came up;
    -- a background sweep re-fills NULL rows).
    embedding       vector(768),
    embedded_at     TIMESTAMPTZ,
    embedding_model TEXT,

    CONSTRAINT primary_indices_seq_unique UNIQUE (source_id, chunk_seq),
    CONSTRAINT primary_indices_offsets_valid CHECK (end_offset > start_offset)
);

-- ANN index for cosine similarity search. ivfflat lists=100 is a sane
-- default for up to ~1M chunks; tune higher when corpus grows.
CREATE INDEX IF NOT EXISTS idx_primary_embedding
    ON primary_indices USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_primary_source
    ON primary_indices(source_id);
CREATE INDEX IF NOT EXISTS idx_primary_pending_embed
    ON primary_indices(source_id) WHERE embedding IS NULL;

-- ----------------------------------------------------------------------------
-- entity_mentions — NER output, lazily populated.
--
-- Entity recognition is expensive (LLM call). We don't block ingest on it;
-- a background worker fills this table in batches. A NULL row in this
-- table for a given chunk is normal — it just means NER hasn't run yet.
--
-- The same entity (e.g. "Acme Pump X75") will appear as many rows as it is
-- mentioned across chunks. Stage 2 will resolve these into knowledge_nodes
-- (one node per canonical entity); Stage 1 only records the raw mentions.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_mentions (
    mention_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id        UUID NOT NULL
        REFERENCES primary_indices(chunk_id) ON DELETE CASCADE,

    -- The literal substring that triggered the mention. Together with
    -- start_offset / end_offset (relative to the chunk's text, NOT the
    -- source) this is enough to highlight in the UI.
    entity_text     TEXT NOT NULL,
    entity_type     TEXT,
        -- typical values:
        --   'person', 'organisation', 'product', 'project',
        --   'location', 'date', 'money', 'document_ref',
        --   'certification', 'concept'

    start_offset    INT,
    end_offset      INT,

    confidence      REAL,
    extracted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    extracted_by    TEXT NOT NULL  -- e.g. 'ollama:gemma4:e4b', 'spacy:pl_core', ...
);

CREATE INDEX IF NOT EXISTS idx_mentions_chunk
    ON entity_mentions(chunk_id);
CREATE INDEX IF NOT EXISTS idx_mentions_text_lower
    ON entity_mentions(LOWER(entity_text));
CREATE INDEX IF NOT EXISTS idx_mentions_type
    ON entity_mentions(entity_type);

-- ----------------------------------------------------------------------------
-- ingest_audit — structured log of every ingest attempt.
--
-- Successful or not, every ingest call writes a row here. Lets the operator
-- answer "was that document we worried about ever ingested?" without
-- grepping logs.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_audit (
    audit_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    file_path       TEXT,
    file_hash       TEXT,
    source_id       UUID,           -- set on success
    ingested_by     TEXT,
    result          TEXT NOT NULL,
        -- 'inserted'    — new source created
        -- 'duplicate'   — file_hash already present, no insert
        -- 'failed'      — error during ingest, see error_message
    error_message   TEXT,
    chunks_created  INT
);

CREATE INDEX IF NOT EXISTS idx_audit_time
    ON ingest_audit(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_result
    ON ingest_audit(result);
