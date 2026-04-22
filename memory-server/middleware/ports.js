// ports — single source of truth for ecosystem port numbers.
//
// Order of precedence at runtime (highest first):
//   1. process.env.PORT — the canonical "what port THIS process listens on" var.
//   2. process.env.PORT_<NAME>  — service-specific override, e.g. PORT_KEY_SERVER=13040.
//   3. ports.yaml — the file in the repo root, edited once to retune the whole palette.
//   4. The fallback argument passed by the caller (last-ditch hardcode).
//
// ports.yaml format is fixed and minimal:
//   ports:
//     consciousness-server: 3032
//     semantic-search: 3037
//
// We parse it with regex instead of pulling in js-yaml so every block
// (core, key-server, …) stays dep-free. Comments and other YAML
// structure is ignored — only `<name>: <number>` lines under a top-
// level `ports:` key matter.

'use strict';

const fs = require('fs');
const path = require('path');

let _cache = null;

function _findPortsFile() {
  if (process.env.CS_PORTS_FILE) return process.env.CS_PORTS_FILE;
  // Walk up from this file's directory; ports.yaml sits next to lib/.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'ports.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function _loadPorts() {
  if (_cache !== null) return _cache;
  const file = _findPortsFile();
  if (!file) {
    _cache = {};
    return _cache;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_e) {
    _cache = {};
    return _cache;
  }
  const out = {};
  let inPorts = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, ''); // strip inline comments
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[A-Za-z][\w-]*\s*:\s*$/.test(trimmed)) {
      inPorts = trimmed.replace(/\s*:\s*$/, '') === 'ports';
      continue;
    }
    if (inPorts) {
      const m = trimmed.match(/^([A-Za-z][\w-]*)\s*:\s*(\d+)\b/);
      if (m) out[m[1]] = parseInt(m[2], 10);
    }
  }
  _cache = out;
  return _cache;
}

function getPort(serviceName, fallback) {
  // 1. PORT_<NAME> wins
  const envSpecific = process.env[`PORT_${serviceName.toUpperCase().replace(/-/g, '_')}`];
  if (envSpecific) {
    const n = parseInt(envSpecific, 10);
    if (Number.isFinite(n)) return n;
  }
  // 2. Generic PORT — only for the canonical "primary listener" of a process.
  // Caller passes own service name; if PORT is set we trust it as that listener.
  if (process.env.PORT && process.env._CS_PORT_OWNER === serviceName) {
    const n = parseInt(process.env.PORT, 10);
    if (Number.isFinite(n)) return n;
  }
  // 3. ports.yaml
  const cfg = _loadPorts();
  if (cfg[serviceName] != null) return cfg[serviceName];
  // 4. caller-provided fallback
  if (fallback != null) return fallback;
  throw new Error(`ports: no entry for '${serviceName}' (no PORT_${serviceName.toUpperCase()} env, no ports.yaml entry, no fallback)`);
}

// Convenience: use this in a block's server.js when it owns the generic PORT
// var. Pattern: `const PORT = ownPort('consciousness-server', 3032)` — picks
// up `PORT=<n>` if set, else falls through to ports.yaml, else the hardcoded
// fallback. The hardcoded fallback exists only so a developer who deletes
// ports.yaml still gets a working default.
function ownPort(serviceName, fallback) {
  if (process.env.PORT) {
    const n = parseInt(process.env.PORT, 10);
    if (Number.isFinite(n)) return n;
  }
  return getPort(serviceName, fallback);
}

module.exports = { getPort, ownPort, _loadPorts };
