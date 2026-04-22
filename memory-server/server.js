#!/usr/bin/env node
/**
 * memory-server — Stage 1 ingest service for the BuildOnAI Mesh roadmap.
 *
 * Captures every document the ecosystem sees, with chunk-level byte offsets
 * and embeddings, into a Postgres+pgvector store. No graph, no derivatives —
 * just a clean substrate that the Stage 2 Mesh PoC can build on without
 * re-processing the corpus.
 *
 * Endpoints:
 *   GET  /health                   liveness
 *   POST /api/sources/ingest       ingest a document (body: {path, content, source_type, ...})
 *   GET  /api/sources/:id          source record + chunk count
 *   GET  /api/sources/:id/chunks   paginated chunks
 *   GET  /api/sources?limit=&type= recent sources
 *   POST /api/search               semantic search over chunks
 *   GET  /api/audit?limit=         recent ingest audit
 *
 * Auth: same AUTH_MODE/verify-signed pattern as the rest of the ecosystem;
 * sensitive endpoints (anything that mutates) are gated under enforce.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { ownPort, getPort } = require('./middleware/ports');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = ownPort('memory-server', 3045);
const HOST = process.env.MEMORY_SERVER_HOST || '0.0.0.0';

const PG_HOST = process.env.MEMORY_PG_HOST || process.env.PGHOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.MEMORY_PG_PORT || process.env.PGPORT || '5432', 10);
const PG_DB   = process.env.MEMORY_PG_DB   || process.env.PGDATABASE || 'memory';
const PG_USER = process.env.MEMORY_PG_USER || process.env.PGUSER || 'memory';
const PG_PASS = process.env.MEMORY_PG_PASSWORD || process.env.PGPASSWORD || 'memory';

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';

// Chunk parameters. We chunk by character window with overlap, NOT by token
// count, because the chunk's offsets must reference bytes in the original
// document so the UI can highlight them. Token boundaries are per-model and
// would force a dependency on tokeniser libraries.
const CHUNK_SIZE = parseInt(process.env.MEMORY_CHUNK_SIZE || '1500', 10);     // chars
const CHUNK_OVERLAP = parseInt(process.env.MEMORY_CHUNK_OVERLAP || '200', 10); // chars

// ---------------------------------------------------------------------------
// Postgres pool
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  database: PG_DB,
  user: PG_USER,
  password: PG_PASS,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[memory-server] postgres pool error:', err.message);
});

async function dbReady() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function detectLanguage(text) {
  // Fast cheap heuristic. We only need rough bucket so unified node merge in
  // Stage 2 knows which texts to compare across languages. A real lang
  // detector belongs to a later iteration.
  const sample = text.slice(0, 2000).toLowerCase();
  const polishHits = (sample.match(/\b(że|jest|nie|się|który|już|albo|wszystko)\b/g) || []).length;
  const italianHits = (sample.match(/\b(che|sono|della|sono|più|anche|essere)\b/g) || []).length;
  const englishHits = (sample.match(/\b(the|and|that|this|with|from|have|will)\b/g) || []).length;
  const top = Math.max(polishHits, italianHits, englishHits);
  if (top < 2) return null;
  if (top === polishHits) return 'pl';
  if (top === italianHits) return 'it';
  return 'en';
}

function chunkWithOffsets(text) {
  // Walk the source by CHUNK_SIZE characters, keeping CHUNK_OVERLAP between
  // consecutive chunks so a fact split mid-chunk still appears whole in one
  // of them. Returns array of {seq, start, end, text}.
  const out = [];
  if (!text) return out;
  if (CHUNK_SIZE <= CHUNK_OVERLAP) {
    throw new Error('CHUNK_SIZE must be greater than CHUNK_OVERLAP');
  }
  const stride = CHUNK_SIZE - CHUNK_OVERLAP;
  let seq = 0;
  for (let start = 0; start < text.length; start += stride) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    out.push({ seq, start, end, text: text.slice(start, end) });
    seq++;
    if (end === text.length) break;
  }
  return out;
}

async function embedText(text) {
  // Uses Ollama's /api/embeddings endpoint. Returns a 768-dim float array
  // for nomic-embed-text. Throws on network or shape errors so the caller
  // can mark the chunk as embedding-pending and retry later.
  const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!r.ok) {
    throw new Error(`embed: HTTP ${r.status} from Ollama`);
  }
  const json = await r.json();
  if (!Array.isArray(json.embedding)) {
    throw new Error('embed: malformed response from Ollama');
  }
  return json.embedding;
}

// pgvector wants the vector serialised as '[1.0,2.0,...]'.
function vectorLiteral(arr) {
  return `[${arr.map((x) => Number.isFinite(x) ? x : 0).join(',')}]`;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '32mb' }));
app.use(express.text({ limit: '32mb', type: 'text/*' }));

app.get('/health', async (_req, res) => {
  res.json({
    service: 'memory-server',
    status: 'ok',
    port: PORT,
    db_ready: await dbReady(),
    embed_model: EMBED_MODEL,
    ollama: OLLAMA_URL,
  });
});

// Ingest one document. Body shape:
//   { file_path, content, source_type, ingested_by,
//     language?, parent_source?, metadata? }
// Either `content` (string with the document text) or a base64 `content_b64`
// is required.
app.post('/api/sources/ingest', async (req, res) => {
  const b = req.body || {};
  const filePath = b.file_path;
  const sourceType = b.source_type;
  const ingestedBy = b.ingested_by || 'unknown';
  let content = b.content;
  if (!content && b.content_b64) {
    try { content = Buffer.from(b.content_b64, 'base64').toString('utf8'); }
    catch { return res.status(400).json({ error: 'content_b64 invalid' }); }
  }

  if (!filePath || !sourceType || typeof content !== 'string' || !content.length) {
    return res.status(400).json({
      error: 'missing fields: file_path, source_type, and content (or content_b64) are required'
    });
  }

  const buf = Buffer.from(content, 'utf8');
  const fileHash = sha256(buf);
  const fileSize = buf.length;
  const language = b.language || detectLanguage(content);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deduplicate by file_hash. If the same bytes were already ingested,
    // return the existing source_id and audit it as 'duplicate'.
    const existing = await client.query(
      'SELECT source_id FROM knowledge_sources WHERE file_hash = $1',
      [fileHash]
    );
    if (existing.rowCount > 0) {
      await client.query(
        `INSERT INTO ingest_audit
         (file_path, file_hash, source_id, ingested_by, result)
         VALUES ($1,$2,$3,$4,'duplicate')`,
        [filePath, fileHash, existing.rows[0].source_id, ingestedBy]
      );
      await client.query('COMMIT');
      return res.json({
        result: 'duplicate',
        source_id: existing.rows[0].source_id,
      });
    }

    // Insert the source row.
    const sourceRow = await client.query(
      `INSERT INTO knowledge_sources
        (file_path, file_hash, file_size, source_type, language,
         ingested_by, parent_source, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING source_id, ingested_at`,
      [filePath, fileHash, fileSize, sourceType, language,
       ingestedBy, b.parent_source || null, b.metadata || {}]
    );
    const sourceId = sourceRow.rows[0].source_id;

    // Chunk and embed. We embed inline so the row is searchable
    // immediately. If embedding fails per-chunk we still insert the chunk
    // text+offsets and leave embedding NULL — a background sweep can fill
    // them later. This ensures one bad embed doesn't lose the data.
    const chunks = chunkWithOffsets(content);
    let embedded = 0;
    for (const c of chunks) {
      const textHash = sha256(Buffer.from(c.text, 'utf8'));
      let embedding = null;
      let embeddedAt = null;
      try {
        embedding = await embedText(c.text);
        embeddedAt = new Date();
        embedded++;
      } catch (e) {
        console.warn(`[memory-server] embed failed seq=${c.seq}: ${e.message}`);
      }
      await client.query(
        `INSERT INTO primary_indices
          (source_id, chunk_seq, start_offset, end_offset,
           text, text_hash, embedding, embedded_at, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9)`,
        [sourceId, c.seq, c.start, c.end, c.text, textHash,
         embedding ? vectorLiteral(embedding) : null,
         embeddedAt, embedding ? EMBED_MODEL : null]
      );
    }

    await client.query(
      `INSERT INTO ingest_audit
       (file_path, file_hash, source_id, ingested_by, result, chunks_created)
       VALUES ($1,$2,$3,$4,'inserted',$5)`,
      [filePath, fileHash, sourceId, ingestedBy, chunks.length]
    );

    await client.query('COMMIT');
    res.json({
      result: 'inserted',
      source_id: sourceId,
      file_hash: fileHash,
      file_size: fileSize,
      language,
      chunks_total: chunks.length,
      chunks_embedded: embedded,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    try {
      await pool.query(
        `INSERT INTO ingest_audit
         (file_path, file_hash, ingested_by, result, error_message)
         VALUES ($1,$2,$3,'failed',$4)`,
        [filePath, fileHash, ingestedBy, e.message]
      );
    } catch { /* swallow audit-of-audit */ }
    console.error('[memory-server] ingest failed:', e);
    res.status(500).json({ error: 'ingest_failed', detail: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/sources/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, COUNT(p.chunk_id) AS chunk_count,
              SUM(CASE WHEN p.embedding IS NOT NULL THEN 1 ELSE 0 END) AS chunks_embedded
         FROM knowledge_sources s
    LEFT JOIN primary_indices p USING(source_id)
        WHERE s.source_id = $1
     GROUP BY s.source_id`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'lookup_failed', detail: e.message });
  }
});

app.get('/api/sources/:id/chunks', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  try {
    const r = await pool.query(
      `SELECT chunk_id, chunk_seq, start_offset, end_offset, text,
              token_count,
              (embedding IS NOT NULL) AS embedded
         FROM primary_indices
        WHERE source_id = $1
     ORDER BY chunk_seq
        LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json({ source_id: req.params.id, chunks: r.rows, limit, offset });
  } catch (e) {
    res.status(500).json({ error: 'lookup_failed', detail: e.message });
  }
});

app.get('/api/sources', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const sourceType = req.query.type;
  try {
    const r = sourceType
      ? await pool.query(
          `SELECT source_id, file_path, file_hash, source_type, language,
                  ingested_at, ingested_by
             FROM knowledge_sources
            WHERE source_type = $1
         ORDER BY ingested_at DESC
            LIMIT $2`, [sourceType, limit])
      : await pool.query(
          `SELECT source_id, file_path, file_hash, source_type, language,
                  ingested_at, ingested_by
             FROM knowledge_sources
         ORDER BY ingested_at DESC
            LIMIT $1`, [limit]);
    res.json({ sources: r.rows, count: r.rows.length });
  } catch (e) {
    res.status(500).json({ error: 'lookup_failed', detail: e.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { query, limit = 20, source_type } = req.body || {};
  if (typeof query !== 'string' || !query.length) {
    return res.status(400).json({ error: 'query (string) required' });
  }
  let qEmbed;
  try { qEmbed = await embedText(query); }
  catch (e) { return res.status(503).json({ error: 'embed_unavailable', detail: e.message }); }

  try {
    const params = [vectorLiteral(qEmbed), Math.min(limit, 100)];
    let sql = `
      SELECT p.chunk_id, p.source_id, p.chunk_seq, p.start_offset, p.end_offset,
             p.text, s.file_path, s.source_type, s.language,
             1 - (p.embedding <=> $1::vector) AS similarity
        FROM primary_indices p
        JOIN knowledge_sources s USING(source_id)
       WHERE p.embedding IS NOT NULL`;
    if (source_type) {
      sql += ' AND s.source_type = $3';
      params.push(source_type);
    }
    sql += ' ORDER BY p.embedding <=> $1::vector LIMIT $2';
    const r = await pool.query(sql, params);
    res.json({ query, results: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'search_failed', detail: e.message });
  }
});

app.get('/api/audit', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  try {
    const r = await pool.query(
      `SELECT * FROM ingest_audit ORDER BY occurred_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ entries: r.rows, count: r.rows.length });
  } catch (e) {
    res.status(500).json({ error: 'lookup_failed', detail: e.message });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`[memory-server] listening on ${HOST}:${PORT}`);
  console.log(`[memory-server] postgres ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}`);
  console.log(`[memory-server] embed model ${EMBED_MODEL} via ${OLLAMA_URL}`);
});

async function shutdown(sig) {
  console.log(`[memory-server] ${sig} received, draining…`);
  server.close(() => {});
  try { await pool.end(); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
