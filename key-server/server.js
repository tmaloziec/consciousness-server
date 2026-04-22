#!/usr/bin/env node
/**
 * Key Server - Centralized Secrets Management
 *
 * Provides secure HTTP API for retrieving SSH keys, API tokens, and other secrets.
 *
 * Port: 3040
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const sshpk = require('sshpk');
const redis = require('redis');
const { getPort } = require('./middleware/ports');

const PORT = parseInt(process.env.KEY_SERVER_PORT, 10) || getPort('key-server', 3040);
const HOST = process.env.KEY_SERVER_HOST || '0.0.0.0';
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || getPort('redis', 6379);
const BASE_DIR = __dirname;
const KEYS_DIR = path.join(BASE_DIR, 'keys');
const AUTH_CONFIG = path.join(BASE_DIR, 'auth', 'allowed-clients.json');
const AUDIT_LOG = path.join(BASE_DIR, 'logs', 'audit.log');
const AUDIT_JSONL = path.join(BASE_DIR, 'logs', 'audit.jsonl');
const AUTH_OBSERVE_LOG = path.join(BASE_DIR, 'logs', 'auth-observe.log');

// Auth mode for key-server's own sensitive endpoints (same semantics as
// the ecosystem-wide verify-signed middleware): off | observe | enforce.
// off: IP whitelist only — solo developer on localhost.
// observe: IP + log what enforce would reject, but pass through.
// enforce: IP + ed25519-signed request required on sensitive endpoints.
const VALID_AUTH_MODES = new Set(['off', 'observe', 'enforce']);
let AUTH_MODE = (process.env.AUTH_MODE || 'off').trim().toLowerCase();
if (!VALID_AUTH_MODES.has(AUTH_MODE)) {
  console.warn(`[key-server] AUTH_MODE=${AUTH_MODE} not recognised, falling back to 'off'`);
  AUTH_MODE = 'off';
}

// Endpoints that gate behind ed25519 sig under AUTH_MODE=enforce.
// /health, /api/agents/identity*, /api/verify stay open: liveness, public-pubkey
// listing, and the verify endpoint itself (which validates signed payloads in
// its own body — recursion would be circular).
const SENSITIVE_PREFIXES = ['/keys/'];
const SENSITIVE_EXACT = new Set(['/audit']);

// Signed-request tunables (see docs/SIGNING-PROTOCOL.md).
const PUB_KEY_MAX_BYTES = 4 * 1024;           // anti-DoS on pub key upload
const AUDIT_ROTATE_BYTES = 50 * 1024 * 1024;  // self-rotation at 50 MB
const AUDIT_ROTATE_CHECK_EVERY = 100;         // check log size every N writes
const TS_WINDOW_BACK_MS = 300 * 1000;         // accept timestamps up to 300s old
const TS_WINDOW_FWD_MS = 60 * 1000;           // reject timestamps >60s in the future
const NONCE_TTL_SECONDS = 300;                // Redis TTL for anti-replay cache
const NONCE_MIN_HEX = 16;                     // allow ≥8 bytes of entropy
const NONCE_MAX_HEX = 128;
const SIG_B64_MAX = 256;                      // 64 raw bytes → 88 b64; slack for noise

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function auditLog(ip, endpoint, result, details = '') {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] IP=${ip} ENDPOINT=${endpoint} RESULT=${result} ${details}\n`;

  fs.appendFile(AUDIT_LOG, logEntry, (err) => {
    if (err) console.error('Failed to write audit log:', err);
  });

  log(`AUDIT: ${ip} → ${endpoint} → ${result}`, 'AUDIT');
}

function loadAuthConfig() {
  try {
    const data = fs.readFileSync(AUTH_CONFIG, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    log(`Failed to load auth config: ${err.message}`, 'ERROR');
    return { allowed_ips: ['127.0.0.1', '::1'] };
  }
}

function isIpAllowed(clientIp, allowedRanges) {
  // Simple IP check - allow localhost and private network
  if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
    return true;
  }

  // Check if IP starts with allowed ranges (simple prefix match)
  for (const range of allowedRanges) {
    if (range.includes('/')) {
      // CIDR notation (e.g., 10.0.0.0/24)
      const prefix = range.split('/')[0].split('.').slice(0, 3).join('.');
      const clientPrefix = clientIp.split('.').slice(0, 3).join('.');
      if (prefix === clientPrefix) return true;
    } else if (clientIp === range) {
      return true;
    }
  }

  return false;
}

function checkIp(req) {
  const authConfig = loadAuthConfig();
  const clientIp = req.socket.remoteAddress;

  if (!isIpAllowed(clientIp, authConfig.allowed_ips)) {
    return { allowed: false, reason: 'IP not whitelisted', ip: clientIp };
  }
  return { allowed: true, ip: clientIp };
}

function isSensitivePath(pathname) {
  if (SENSITIVE_EXACT.has(pathname)) return true;
  for (const prefix of SENSITIVE_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

function sendResponse(res, statusCode, body, contentType = 'application/json') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Id, X-Timestamp, X-Nonce, X-Signature'
  });

  if (contentType === 'application/json') {
    res.end(JSON.stringify(body, null, 2));
  } else {
    res.end(body);
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

function handleHealth(req, res, auth) {
  auditLog(auth.ip, '/health', 'OK');
  sendResponse(res, 200, {
    status: 'ok',
    service: 'key-server',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
}

function handleGetSshKey(req, res, auth, keyName) {
  const keyPath = path.join(KEYS_DIR, 'ssh', keyName);

  // Security: prevent path traversal
  if (keyName.includes('..') || keyName.includes('/')) {
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'REJECTED', 'path_traversal_attempt');
    sendResponse(res, 400, { error: 'Invalid key name' });
    return;
  }

  // Check if key exists
  if (!fs.existsSync(keyPath)) {
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'NOT_FOUND');
    sendResponse(res, 404, { error: 'Key not found' });
    return;
  }

  // Read and return key
  try {
    const keyContent = fs.readFileSync(keyPath, 'utf8');
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'SUCCESS', `size=${keyContent.length}`);
    sendResponse(res, 200, keyContent, 'text/plain');
  } catch (err) {
    auditLog(auth.ip, `/keys/ssh/${keyName}`, 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to read key' });
  }
}

function handleGetApiKey(req, res, auth, service) {
  const keyPath = path.join(KEYS_DIR, service, 'api-key.txt');

  // Security: prevent path traversal
  if (service.includes('..') || service.includes('/')) {
    auditLog(auth.ip, `/keys/api/${service}`, 'REJECTED', 'path_traversal_attempt');
    sendResponse(res, 400, { error: 'Invalid service name' });
    return;
  }

  // Check if key exists
  if (!fs.existsSync(keyPath)) {
    auditLog(auth.ip, `/keys/api/${service}`, 'NOT_FOUND');
    sendResponse(res, 404, { error: 'API key not found' });
    return;
  }

  // Read and return key
  try {
    const keyContent = fs.readFileSync(keyPath, 'utf8').trim();
    auditLog(auth.ip, `/keys/api/${service}`, 'SUCCESS');
    sendResponse(res, 200, { service, api_key: keyContent });
  } catch (err) {
    auditLog(auth.ip, `/keys/api/${service}`, 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to read API key' });
  }
}

function handleListKeys(req, res, auth) {
  try {
    const sshKeys = fs.readdirSync(path.join(KEYS_DIR, 'ssh'))
      .filter(f => !f.endsWith('.pub'));

    const apiServices = fs.readdirSync(KEYS_DIR)
      .filter(f => f !== 'ssh' && fs.statSync(path.join(KEYS_DIR, f)).isDirectory());

    auditLog(auth.ip, '/keys/list', 'SUCCESS');
    sendResponse(res, 200, {
      ssh_keys: sshKeys,
      api_services: apiServices
    });
  } catch (err) {
    auditLog(auth.ip, '/keys/list', 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to list keys' });
  }
}

// ============================================================================
// AGENT IDENTITY + SIGNED-REQUEST HELPERS (see docs/SIGNING-PROTOCOL.md)
// ============================================================================
// Per-agent public key bootstrap. Bootstrap is manual: drop a pub key into
// keys/agents/<AGENT>.pub. Files are read on each request (no cache) — so
// revocation is just `rm keys/agents/<AGENT>.pub`, with zero propagation
// delay and zero session state.

// Load an agent's OpenSSH ed25519 pub key and return a Node KeyObject
// ready for crypto.verify. Returns null on any failure (missing, too big,
// wrong type, malformed) — callers treat that uniformly as "unknown_agent".
function loadAgentPubKey(agentId) {
  // Path traversal guard (same pattern as ssh/api handlers).
  if (!agentId || agentId.includes('..') || agentId.includes('/')) return null;

  const keyPath = path.join(KEYS_DIR, 'agents', `${agentId}.pub`);
  let stat;
  try {
    stat = fs.statSync(keyPath);
  } catch {
    return null;
  }
  // Anti-DoS: reject absurdly large pub-key files before readFile.
  if (stat.size > PUB_KEY_MAX_BYTES) return null;

  let text;
  try {
    text = fs.readFileSync(keyPath, 'utf8');
  } catch {
    return null;
  }

  try {
    const sshKey = sshpk.parseKey(text, 'ssh');
    // Only ed25519 keys are accepted.
    if (sshKey.type !== 'ed25519') return null;
    return crypto.createPublicKey(sshKey.toString('pem'));
  } catch {
    return null;
  }
}

// Build the canonical message that agent + block + key-server must all
// reproduce byte-for-byte (see docs/SIGNING-PROTOCOL.md). Separator is literal LF (\n).
function buildCanonicalMessage({ method, path: reqPath, timestamp, nonce, body_sha256 }) {
  return [
    String(method || '').toUpperCase(),
    String(reqPath || ''),
    String(timestamp || ''),
    String(nonce || ''),
    String(body_sha256 || '')
  ].join('\n');
}

// Verify an ed25519 signature over a canonical message. Length check
// runs before crypto.verify so timing does not leak "agent exists vs not".
// Pre-condition: `pubKey` already resolved via loadAgentPubKey (caller
// already short-circuits on unknown agent).
function verifyEd25519({ pubKey, canonicalMessage, signatureB64 }) {
  if (!pubKey) return { valid: false, reason: 'unknown_agent' };
  if (typeof signatureB64 !== 'string' || signatureB64.length === 0 ||
      signatureB64.length > SIG_B64_MAX) {
    return { valid: false, reason: 'bad_signature' };
  }
  let sig;
  try {
    sig = Buffer.from(signatureB64, 'base64');
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
  if (sig.length !== 64) return { valid: false, reason: 'bad_signature' };

  const msgBytes = Buffer.from(canonicalMessage, 'utf8');
  let ok = false;
  try {
    ok = crypto.verify(null, msgBytes, pubKey, sig);
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
  return ok ? { valid: true } : { valid: false, reason: 'bad_signature' };
}

// Append one JSON line to logs/audit.jsonl. Self-rotates at 50MB.
// Size check amortised across AUDIT_ROTATE_CHECK_EVERY writes.
let auditWriteCounter = 0;
function appendAuditEntry(entry) {
  const logsDir = path.dirname(AUDIT_JSONL);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch { /* best-effort */ }

  auditWriteCounter++;
  if (auditWriteCounter >= AUDIT_ROTATE_CHECK_EVERY) {
    auditWriteCounter = 0;
    try {
      const st = fs.statSync(AUDIT_JSONL);
      if (st.size > AUDIT_ROTATE_BYTES) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
        const archived = path.join(logsDir, `audit.${ts}.jsonl`);
        fs.renameSync(AUDIT_JSONL, archived);
      }
    } catch { /* file may not exist yet */ }
  }

  const line = { ts: new Date().toISOString(), ...entry };
  try {
    fs.appendFileSync(AUDIT_JSONL, JSON.stringify(line) + '\n');
  } catch (err) {
    console.error('audit write failed:', err.message);
  }
}

function sshKeyFingerprint(pubKeyText) {
  // Format: "ssh-<alg> <base64> [comment]". Fingerprint = SHA256 of base64 decoded.
  const parts = pubKeyText.trim().split(/\s+/);
  if (parts.length < 2) return null;
  try {
    const raw = Buffer.from(parts[1], 'base64');
    const hash = crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
    return `SHA256:${hash}`;
  } catch {
    return null;
  }
}

function handleGetAgentIdentity(req, res, auth, agentId) {
  // Path traversal guard (same pattern as ssh/api handlers)
  if (agentId.includes('..') || agentId.includes('/')) {
    auditLog(auth.ip, `/api/agents/identity/${agentId}`, 'REJECTED', 'path_traversal_attempt');
    sendResponse(res, 400, { error: 'Invalid agent id' });
    return;
  }

  const keyPath = path.join(KEYS_DIR, 'agents', `${agentId}.pub`);
  if (!fs.existsSync(keyPath)) {
    auditLog(auth.ip, `/api/agents/identity/${agentId}`, 'NOT_FOUND');
    sendResponse(res, 404, {
      error: 'Agent identity not registered',
      hint: `Bootstrap: place pub key at keys/agents/${agentId}.pub`
    });
    return;
  }

  try {
    const pubKey = fs.readFileSync(keyPath, 'utf8').trim();
    const stat = fs.statSync(keyPath);
    auditLog(auth.ip, `/api/agents/identity/${agentId}`, 'SUCCESS');
    sendResponse(res, 200, {
      agent_id: agentId,
      pub_key: pubKey,
      fingerprint: sshKeyFingerprint(pubKey),
      registered_at: stat.mtime.toISOString()
    });
  } catch (err) {
    auditLog(auth.ip, `/api/agents/identity/${agentId}`, 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to read agent identity' });
  }
}

function handleListAgentIdentities(req, res, auth) {
  const agentsDir = path.join(KEYS_DIR, 'agents');
  try {
    if (!fs.existsSync(agentsDir)) {
      auditLog(auth.ip, '/api/agents/identity', 'SUCCESS', 'empty');
      sendResponse(res, 200, { agents: [], count: 0 });
      return;
    }
    const agents = fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.pub'))
      .map(f => f.slice(0, -4))
      .sort();
    auditLog(auth.ip, '/api/agents/identity', 'SUCCESS', `count=${agents.length}`);
    sendResponse(res, 200, { agents, count: agents.length });
  } catch (err) {
    auditLog(auth.ip, '/api/agents/identity', 'ERROR', err.message);
    sendResponse(res, 500, { error: 'Failed to list agent identities' });
  }
}

function handleAudit(req, res, auth) {
  // Read last 100 lines of audit log
  try {
    const logContent = fs.readFileSync(AUDIT_LOG, 'utf8');
    const lines = logContent.split('\n').filter(l => l.trim()).slice(-100);

    auditLog(auth.ip, '/audit', 'SUCCESS');
    sendResponse(res, 200, {
      total_entries: lines.length,
      recent_entries: lines
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendResponse(res, 200, { total_entries: 0, recent_entries: [] });
    } else {
      auditLog(auth.ip, '/audit', 'ERROR', err.message);
      sendResponse(res, 500, { error: 'Failed to read audit log' });
    }
  }
}

// ============================================================================
// POST /api/verify — signed-request verification
// ============================================================================
// Redis client shared across handlers. `redisReady` flips true once the
// initial connect finishes; handleVerify short-circuits to 503 while Redis
// is unreachable (halt rather than skip anti-replay).

const redisClient = redis.createClient({
  socket: { host: REDIS_HOST, port: REDIS_PORT }
});
let redisReady = false;
redisClient.on('ready', () => { redisReady = true; log(`Redis ready at ${REDIS_HOST}:${REDIS_PORT}`); });
redisClient.on('end',   () => { redisReady = false; log('Redis connection ended', 'WARN'); });
redisClient.on('error', (err) => {
  redisReady = false;
  log(`Redis error: ${err.message}`, 'ERROR');
});

function parseBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isHex(s) { return typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s); }
function looksIso8601(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s); }

function observeLogLine(entry) {
  try {
    fs.mkdirSync(path.dirname(AUTH_OBSERVE_LOG), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(AUTH_OBSERVE_LOG, line + '\n');
  } catch { /* logging must never break a request */ }
}

// Verify a signed request that targets key-server's OWN sensitive endpoints.
// Mirrors the ecosystem-wide protocol (X-Agent-Id / X-Timestamp / X-Nonce /
// X-Signature) but resolves the pub key locally — key-server is the root of
// trust and cannot recurse into its own /api/verify.
//
// Returns { valid: true, agent_id } or { valid: false, reason, status? }.
async function verifySensitiveRequest({ headers, method, path: reqPath, bodyBytes }) {
  const agentId = headers['x-agent-id'];
  const timestamp = headers['x-timestamp'];
  const nonce = headers['x-nonce'];
  const signature = headers['x-signature'];

  if (!agentId || !timestamp || !nonce || !signature) {
    return { valid: false, reason: 'missing_headers' };
  }
  if (typeof agentId !== 'string' || agentId.includes('..') || agentId.includes('/')) {
    return { valid: false, reason: 'bad_agent_id' };
  }
  if (typeof timestamp !== 'string' || !looksIso8601(timestamp)) {
    return { valid: false, reason: 'bad_timestamp' };
  }
  if (typeof nonce !== 'string' || !isHex(nonce) ||
      nonce.length < NONCE_MIN_HEX || nonce.length > NONCE_MAX_HEX) {
    return { valid: false, reason: 'bad_nonce' };
  }
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > SIG_B64_MAX) {
    return { valid: false, reason: 'bad_signature' };
  }

  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'timestamp_out_of_window' };
  const now = Date.now();
  if (ts < now - TS_WINDOW_BACK_MS || ts > now + TS_WINDOW_FWD_MS) {
    return { valid: false, reason: 'timestamp_out_of_window' };
  }

  // Anti-replay requires Redis; halt rather than skip if it's down.
  if (!redisReady) return { valid: false, reason: 'redis_unavailable', status: 503 };

  const nonceKey = `ks:nonce_seen:${nonce}`;
  let claimed;
  try {
    claimed = await redisClient.set(nonceKey, '1', { NX: true, EX: NONCE_TTL_SECONDS });
  } catch {
    return { valid: false, reason: 'redis_error', status: 503 };
  }
  if (claimed === null) return { valid: false, reason: 'nonce_replayed' };

  const pubKey = loadAgentPubKey(agentId);
  if (!pubKey) return { valid: false, reason: 'unknown_agent' };

  const bodySha256 = crypto.createHash('sha256').update(bodyBytes || Buffer.alloc(0)).digest('hex');
  const canonicalMessage = buildCanonicalMessage({
    method, path: reqPath, timestamp, nonce, body_sha256: bodySha256
  });
  const verdict = verifyEd25519({ pubKey, canonicalMessage, signatureB64: signature });
  if (!verdict.valid) return { valid: false, reason: verdict.reason || 'bad_signature' };

  return { valid: true, agent_id: agentId };
}

function readRequestBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleVerify(req, res, auth) {
  // 1. Parse + validate body (400 on malformed — distinct from 401).
  let raw;
  try {
    raw = await parseBody(req);
  } catch (err) {
    sendResponse(res, 400, { error: 'bad_request', reason: err.message });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendResponse(res, 400, { error: 'bad_request', reason: 'invalid_json' });
    return;
  }

  const { agent_id, timestamp, nonce, method, path: reqPath, body_sha256, signature } = body || {};

  if (typeof agent_id !== 'string'    || agent_id.length === 0 ||
      typeof method !== 'string'      || method.length === 0 ||
      typeof reqPath !== 'string'     || reqPath.length === 0 ||
      typeof timestamp !== 'string'   || !looksIso8601(timestamp) ||
      typeof nonce !== 'string'       || !isHex(nonce) ||
      nonce.length < NONCE_MIN_HEX    || nonce.length > NONCE_MAX_HEX ||
      typeof body_sha256 !== 'string' || !isHex(body_sha256) || body_sha256.length !== 64 ||
      typeof signature !== 'string'   || signature.length === 0 || signature.length > SIG_B64_MAX) {
    sendResponse(res, 400, { error: 'bad_request', reason: 'missing_or_invalid_fields' });
    return;
  }

  const respondFail = (reason) => {
    appendAuditEntry({
      event: 'verify', agent_id, method, path: reqPath,
      result: 'fail', reason, ip: auth.ip
    });
    sendResponse(res, 401, { valid: false, reason });
  };

  // 2. Timestamp window (±300s back, +60s forward).
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) {
    respondFail('timestamp_out_of_window');
    return;
  }
  const now = Date.now();
  if (ts < now - TS_WINDOW_BACK_MS || ts > now + TS_WINDOW_FWD_MS) {
    respondFail('timestamp_out_of_window');
    return;
  }

  // Redis is required for anti-replay — if it's down we halt everything (halt beats skip).
  if (!redisReady) {
    appendAuditEntry({
      event: 'verify', agent_id, method, path: reqPath,
      result: 'error', reason: 'redis_unavailable', ip: auth.ip
    });
    sendResponse(res, 503, { error: 'service_unavailable', reason: 'redis_unavailable' });
    return;
  }

  // 3. SET NX EX on nonce — atomic claim. Duplicate → replay.
  const nonceKey = `ks:nonce_seen:${nonce}`;
  let claimed;
  try {
    claimed = await redisClient.set(nonceKey, '1', { NX: true, EX: NONCE_TTL_SECONDS });
  } catch (err) {
    appendAuditEntry({
      event: 'verify', agent_id, method, path: reqPath,
      result: 'error', reason: 'redis_error', ip: auth.ip
    });
    sendResponse(res, 503, { error: 'service_unavailable', reason: 'redis_error' });
    return;
  }
  if (claimed === null) {
    respondFail('nonce_replayed');
    return;
  }

  // 4. Load agent pub key.
  const pubKey = loadAgentPubKey(agent_id);
  if (!pubKey) {
    respondFail('unknown_agent');
    return;
  }

  // 5. Reconstruct canonical message and verify signature.
  const canonicalMessage = buildCanonicalMessage({
    method, path: reqPath, timestamp, nonce, body_sha256
  });
  const verdict = verifyEd25519({ pubKey, canonicalMessage, signatureB64: signature });
  if (!verdict.valid) {
    respondFail(verdict.reason || 'bad_signature');
    return;
  }

  // 6. Audit success + 200.
  appendAuditEntry({
    event: 'verify', agent_id, method, path: reqPath,
    result: 'ok', ip: auth.ip
  });
  sendResponse(res, 200, { valid: true, agent_id });
}

// ============================================================================
// REQUEST ROUTER
// ============================================================================

function dispatch(req, res, auth, pathname) {
  if (pathname === '/health') {
    handleHealth(req, res, auth);
  } else if (pathname === '/keys/list') {
    handleListKeys(req, res, auth);
  } else if (pathname === '/audit') {
    handleAudit(req, res, auth);
  } else if (pathname.startsWith('/keys/ssh/')) {
    const keyName = pathname.split('/keys/ssh/')[1];
    handleGetSshKey(req, res, auth, keyName);
  } else if (pathname.startsWith('/keys/api/')) {
    const service = pathname.split('/keys/api/')[1];
    handleGetApiKey(req, res, auth, service);
  } else if (pathname === '/api/agents/identity' || pathname === '/api/agents/identity/') {
    handleListAgentIdentities(req, res, auth);
  } else if (pathname.startsWith('/api/agents/identity/')) {
    const agentId = pathname.split('/api/agents/identity/')[1];
    handleGetAgentIdentity(req, res, auth, agentId);
  } else if (pathname === '/api/verify' && req.method === 'POST') {
    handleVerify(req, res, auth).catch((err) => {
      log(`verify handler crash: ${err.message}`, 'ERROR');
      try { sendResponse(res, 500, { error: 'internal_error' }); } catch { /* headers sent */ }
    });
  } else {
    auditLog(auth.ip, pathname, 'NOT_FOUND');
    sendResponse(res, 404, { error: 'Endpoint not found' });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  log(`${req.method} ${pathname} from ${req.socket.remoteAddress}`);

  if (req.method === 'OPTIONS') {
    sendResponse(res, 200, {});
    return;
  }

  // Layer 1: IP whitelist (always on, defence-in-depth).
  const auth = checkIp(req);
  if (!auth.allowed) {
    auditLog(auth.ip, pathname, 'FORBIDDEN', auth.reason);
    sendResponse(res, 403, { error: 'Forbidden', reason: auth.reason });
    return;
  }

  // Layer 2: signed-request gate on sensitive endpoints (when AUTH_MODE != off).
  // Sensitive = anything that dispenses secrets or audit history. Open paths
  // (/health, /api/agents/identity*, /api/verify) bypass the gate by design.
  if (AUTH_MODE !== 'off' && isSensitivePath(pathname)) {
    let bodyBytes;
    try {
      bodyBytes = await readRequestBody(req);
    } catch (err) {
      sendResponse(res, 400, { error: 'bad_request', reason: err.message });
      return;
    }

    const verdict = await verifySensitiveRequest({
      headers: req.headers,
      method: req.method,
      path: pathname,
      bodyBytes,
    });

    if (!verdict.valid) {
      if (AUTH_MODE === 'observe') {
        observeLogLine({
          event: 'would_reject',
          method: req.method, path: pathname,
          reason: verdict.reason,
          agent_id: req.headers['x-agent-id'] || null,
          ip: auth.ip,
        });
        // observe → fall through to handler
      } else {
        // enforce
        const status = verdict.status || 401;
        auditLog(auth.ip, pathname, 'UNAUTHORIZED', verdict.reason);
        appendAuditEntry({
          event: 'sensitive_gate', method: req.method, path: pathname,
          result: 'fail', reason: verdict.reason, ip: auth.ip,
          agent_id: req.headers['x-agent-id'] || null,
        });
        sendResponse(res, status, { error: 'unauthorized', reason: verdict.reason });
        return;
      }
    } else {
      auth.agent_id = verdict.agent_id;
      appendAuditEntry({
        event: 'sensitive_gate', method: req.method, path: pathname,
        result: 'ok', ip: auth.ip, agent_id: verdict.agent_id,
      });
    }
  }

  dispatch(req, res, auth, pathname);
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log(`unhandled request error: ${err.message}`, 'ERROR');
    try { sendResponse(res, 500, { error: 'internal_error' }); } catch { /* headers sent */ }
  });
});

// Connect to Redis in the background; keep the HTTP server available even
// if Redis is slow to come up. handleVerify gates on `redisReady` and
// returns 503 until the connection succeeds (halt beats skip).
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    log(`Initial Redis connect failed: ${err.message} (will retry in background)`, 'WARN');
  }
})();

server.listen(PORT, HOST, () => {
  log(`🔐 Key Server started on ${HOST}:${PORT}`);
  log(`📁 Keys directory: ${KEYS_DIR}`);
  log(`🔒 Auth config: ${AUTH_CONFIG}`);
  log(`🛂 AUTH_MODE: ${AUTH_MODE} (sensitive endpoints: ${[...SENSITIVE_PREFIXES, ...SENSITIVE_EXACT].join(', ')})`);
  log(`📝 Audit log: ${AUDIT_LOG}`);
  log(`📝 Audit JSONL: ${AUDIT_JSONL}`);
  log(`🧠 Redis: ${REDIS_HOST}:${REDIS_PORT}`);
  log('');
  log('Available endpoints:');
  log('  GET  /health                      - Server health check');
  log('  GET  /keys/list                   - List available keys');
  log('  GET  /keys/ssh/:name              - Get SSH private key');
  log('  GET  /keys/api/:service           - Get API key for service');
  log('  GET  /audit                       - View audit log (last 100 entries)');
  log('  GET  /api/agents/identity         - List registered agent identities');
  log('  GET  /api/agents/identity/:id     - Get one agent identity');
  log('  POST /api/verify                  - Verify signed request');
  log('');
  log('🚀 Ready to serve keys!');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use`, 'ERROR');
  } else {
    log(`Server error: ${err.message}`, 'ERROR');
  }
  process.exit(1);
});

// Handle graceful shutdown
async function shutdown(signal) {
  log(`${signal} received, shutting down gracefully...`, 'INFO');
  server.close(() => log('Server closed', 'INFO'));
  try { await redisClient.quit(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
