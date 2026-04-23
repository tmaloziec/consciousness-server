/**
 * verify-signed — shared middleware for signed-request enforcement.
 *
 * Single source of truth for Node blocks in the CS ecosystem.
 * `bin/sync-middleware` copies this file into each block's
 * middleware/ directory; CI drift check refuses to merge if any
 * copy diverges from this master.
 *
 * Protocol: docs/SIGNING-PROTOCOL.md. Mode semantics: docs/AUTH-MODE.md.
 *
 * Env:
 *   AUTH_MODE        off | observe | enforce  (default: off)
 *   KEY_SERVER_URL   http://key-server:3040    (default shown; ignored if off)
 *   AUTH_OBSERVE_LOG path to observe-mode log  (default: logs/auth-observe.log)
 *
 * Exports:
 *   verifySignedRequest({headers, method, path, bodyBytes}) → {valid, reason?}
 *   attachToServer(server, handler)   — wraps handler with the gate
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Readable } = require('stream');
const { URL } = require('url');

const VALID_MODES = ['off', 'observe', 'enforce'];
let AUTH_MODE = (process.env.AUTH_MODE || 'off').trim().toLowerCase();
if (!VALID_MODES.includes(AUTH_MODE)) {
  // eslint-disable-next-line no-console
  console.warn(`[verify-signed] AUTH_MODE=${AUTH_MODE} not recognised, falling back to 'off'`);
  AUTH_MODE = 'off';
}

const KEY_SERVER_URL = (process.env.KEY_SERVER_URL || 'http://key-server:3040').replace(/\/$/, '');
const AUTH_OBSERVE_LOG = process.env.AUTH_OBSERVE_LOG || 'logs/auth-observe.log';
const VERIFY_TIMEOUT_MS = parseInt(process.env.AUTH_VERIFY_TIMEOUT_MS || '2000', 10);

// Endpoints that skip the gate in every mode (see docs/AUTH-MODE.md "Always-open endpoints").
const ALWAYS_OPEN_PATHS = new Set(['/health', '/metrics']);

function headerValue(headers, name) {
  if (!headers) return null;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  // http.IncomingMessage headers are always lower-cased.
  return headers[name.toLowerCase()] ?? null;
}

function shouldSkip(method, reqPath, headers) {
  if ((method || '').toUpperCase() === 'OPTIONS') return true;
  if (ALWAYS_OPEN_PATHS.has(reqPath)) return true;
  // WebSocket upgrade: the WS layer does its own auth.
  const upgrade = headerValue(headers, 'upgrade');
  if (upgrade && String(upgrade).toLowerCase() === 'websocket') return true;
  return false;
}

function bodySha256(bodyBytes) {
  return crypto.createHash('sha256').update(bodyBytes || Buffer.alloc(0)).digest('hex');
}

function observeLogLine(entry) {
  try {
    fs.mkdirSync(path.dirname(AUTH_OBSERVE_LOG), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(AUTH_OBSERVE_LOG, line + '\n');
  } catch (_err) {
    // Logging must never break a request.
  }
}

/**
 * Ask key-server whether this request is authentic.
 *
 * Returns a Promise resolving to { valid: true, agent_id } on success,
 * or { valid: false, reason } otherwise. Never rejects.
 */
function verifySignedRequest({ headers, method, path: reqPath, bodyBytes }) {
  return new Promise((resolve) => {
    const agentId = headerValue(headers, 'X-Agent-Id');
    const timestamp = headerValue(headers, 'X-Timestamp');
    const nonce = headerValue(headers, 'X-Nonce');
    const signature = headerValue(headers, 'X-Signature');

    if (!agentId || !timestamp || !nonce || !signature) {
      resolve({ valid: false, reason: 'missing_headers' });
      return;
    }

    const payload = JSON.stringify({
      agent_id: agentId,
      timestamp,
      nonce,
      method: String(method || '').toUpperCase(),
      path: reqPath || '/',
      body_sha256: bodySha256(bodyBytes),
      signature,
    });

    let url;
    try {
      url = new URL(`${KEY_SERVER_URL}/api/verify`);
    } catch (_err) {
      resolve({ valid: false, reason: 'key_server_url_invalid' });
      return;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: VERIFY_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_e) { /* tolerate */ }

          if (parsed && parsed.valid === true) {
            resolve({ valid: true, agent_id: parsed.agent_id || agentId });
            return;
          }
          if (parsed && parsed.reason) {
            resolve({ valid: false, reason: String(parsed.reason) });
            return;
          }
          resolve({ valid: false, reason: `key_server_http_${res.statusCode}` });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, reason: 'key_server_unreachable' });
    });
    req.on('error', () => {
      resolve({ valid: false, reason: 'key_server_unreachable' });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Make the buffered body visible to downstream handlers without them
 * having to know the gate exists.
 *
 * Two presentation paths, chosen by Content-Type:
 *
 * 1. `application/json`: the gate parses the body and sets
 *    `req.body = <object>` + `req._body = true`. Express's body
 *    parser (`raw-body` under the hood) checks `_body` and
 *    short-circuits if set, so `app.use(express.json())` becomes a
 *    no-op for this request — no more "stream is not readable"
 *    errors because body-parser never touches the stream.
 *
 * 2. Everything else: `req.body = <Buffer>` plus stream replay
 *    (on/data, pipe, read, async-iter) via a Readable that emits
 *    the buffered bytes. Raw handlers that do `req.on('data', ...)`
 *    or `for await (const c of req)` get the body back.
 *
 * WebSocket upgrade requests never reach this function — they are
 * skipped upstream (`shouldSkip`).
 */
function reinjectBody(req, bodyBytes) {
  const ct = headerValue(req.headers, 'content-type') || '';
  const isJson = /^application\/json\b/i.test(ct);

  if (isJson) {
    // Pre-parse for Express. Empty body is valid per HTTP — match
    // Express's default treatment (parse as {} rather than crash).
    try {
      req.body = bodyBytes.length ? JSON.parse(bodyBytes.toString('utf8')) : {};
    } catch (_e) {
      req.body = {};
    }
    // Express body-parser (raw-body) honours `_body=true` as "already
    // consumed, move along". This is the stable contract since
    // express 4 / body-parser 1.x.
    req._body = true;
  } else {
    req.body = bodyBytes;
  }

  // Stream replay for any handler that still reads the raw stream
  // directly (rare outside Express, but CS has one or two places).
  const replay = Readable.from(bodyBytes.length ? [bodyBytes] : []);
  req.read  = replay.read.bind(replay);
  req.pipe  = replay.pipe.bind(replay);
  req.unpipe = replay.unpipe.bind(replay);
  req[Symbol.asyncIterator] = replay[Symbol.asyncIterator].bind(replay);

  const origOn = req.on.bind(req);
  req.on = (event, listener) => {
    if (event === 'data' || event === 'end' || event === 'readable' || event === 'close') {
      return replay.on(event, listener);
    }
    return origOn(event, listener);
  };
  const origOnce = req.once.bind(req);
  req.once = (event, listener) => {
    if (event === 'data' || event === 'end' || event === 'readable' || event === 'close') {
      return replay.once(event, listener);
    }
    return origOnce(event, listener);
  };
}

/**
 * Wrap an existing http request handler with the auth gate.
 *
 * @param {http.Server} server   — existing server (unused; kept for symmetry / future hooks).
 * @param {function} handler     — original `handleRequest(req, res)` or Express `app`.
 * @returns {function}           — replacement handler; MUST be wired into `http.createServer(...)`.
 *
 * Usage (plain http):
 *   const server = http.createServer(attachToServer(null, handleRequest));
 *
 * Usage (Express):
 *   const server = http.createServer(attachToServer(null, app));
 *
 * Transparency guarantee: after the gate resolves, `req` looks to the
 * downstream handler exactly like a fresh request — all stream APIs
 * (on/data, pipe, async iter, read) replay the buffered body.
 */
function attachToServer(server, handler) {
  return function gatedHandler(req, res) {
    const method = req.method || 'GET';
    const reqPath = (req.url || '/').split('?', 1)[0];

    if (shouldSkip(method, reqPath, req.headers)) {
      handler(req, res);
      return;
    }
    if (AUTH_MODE === 'off') {
      handler(req, res);
      return;
    }

    // Buffer the body so both the middleware and the downstream
    // handler can consume it. Cap at 16 MiB as a belt-and-braces
    // DoS guard — individual blocks may impose their own stricter
    // limits on top.
    const MAX_BODY = 16 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', async () => {
      if (aborted) return;
      const bodyBytes = Buffer.concat(chunks);

      const verdict = await verifySignedRequest({
        headers: req.headers,
        method,
        path: reqPath,
        bodyBytes,
      });

      if (verdict.valid) {
        reinjectBody(req, bodyBytes);
        req._verifiedAgent = verdict.agent_id;
        handler(req, res);
        return;
      }

      const reason = verdict.reason || 'invalid';

      if (AUTH_MODE === 'observe') {
        observeLogLine({
          event: 'would_reject',
          method,
          path: reqPath,
          reason,
          agent_id: headerValue(req.headers, 'X-Agent-Id'),
        });
        reinjectBody(req, bodyBytes);
        handler(req, res);
        return;
      }

      // enforce
      const status = reason === 'key_server_unreachable' ? 503 : 401;
      const payload = JSON.stringify({ error: 'unauthorized', reason });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });

    req.on('error', () => {
      try {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
      } catch (_err) { /* headers may already be sent */ }
    });
  };
}

module.exports = {
  AUTH_MODE,
  KEY_SERVER_URL,
  verifySignedRequest,
  attachToServer,
};
