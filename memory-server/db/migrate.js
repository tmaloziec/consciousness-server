#!/usr/bin/env node
/**
 * migrate — apply memory-server schema to the configured Postgres.
 *
 * Idempotent: every CREATE in schema.sql uses IF NOT EXISTS, so running
 * this on an already-migrated database is a no-op. The whole schema runs
 * inside one transaction; if any statement fails the database is left
 * untouched.
 *
 * Connection comes from the same env vars memory-server uses (MEMORY_PG_*
 * with PGHOST/PGPORT/etc. as fallback). Run from inside the container:
 *
 *   node db/migrate.js
 *
 * Or from the host pointing at a published port:
 *
 *   MEMORY_PG_HOST=127.0.0.1 MEMORY_PG_PORT=15432 \
 *   node memory-server/db/migrate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PG_HOST = process.env.MEMORY_PG_HOST || process.env.PGHOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.MEMORY_PG_PORT || process.env.PGPORT || '5432', 10);
const PG_DB   = process.env.MEMORY_PG_DB   || process.env.PGDATABASE || 'memory';
const PG_USER = process.env.MEMORY_PG_USER || process.env.PGUSER || 'memory';
const PG_PASS = process.env.MEMORY_PG_PASSWORD || process.env.PGPASSWORD || 'memory';

(async () => {
  const schemaSql = fs.readFileSync(
    path.join(__dirname, 'schema.sql'), 'utf8'
  );

  const client = new Client({
    host: PG_HOST, port: PG_PORT,
    database: PG_DB, user: PG_USER, password: PG_PASS,
  });

  try {
    await client.connect();
    console.log(`[migrate] connected to ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}`);

    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');

    const tables = await client.query(`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('knowledge_sources','primary_indices',
                           'entity_mentions','ingest_audit')
       ORDER BY tablename
    `);
    console.log('[migrate] tables present:');
    for (const r of tables.rows) console.log(`  - ${r.tablename}`);

    const ext = await client.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto')`
    );
    console.log('[migrate] extensions:');
    for (const r of ext.rows) console.log(`  - ${r.extname}`);

    process.exit(0);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    console.error('[migrate] failed:', e.message);
    process.exit(1);
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
})();
