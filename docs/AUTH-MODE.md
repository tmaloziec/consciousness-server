# AUTH_MODE — operator guide

Every HTTP block in the ecosystem reads a single environment variable,
`AUTH_MODE`, at startup. It has three valid values. They determine
how strictly requests from agents are authenticated.

| Value     | Behaviour | Primary use-case |
|-----------|-----------|-------------------|
| `off`     | Middleware is a no-op. Unsigned requests flow straight through. Key-server is not consulted. | Solo user, single host, home network, CI smoke |
| `observe` | Unsigned / invalid requests **pass** but their rejection reason is logged to `logs/auth-observe.log`. | Migration from an unsigned deployment to a signed one |
| `enforce` | Signed requests pass. Unsigned / invalid requests return `401 Unauthorized` (or `503` if key-server is unreachable). | Multi-agent deployment, shared host, production |

Default is **`off`**. A fresh `git clone` of the ecosystem stands up
without any keys, any key-server, any Redis. You generate keys only
when you decide you need authentication — not as a condition of
running the system at all.

### Why three modes instead of a boolean

A single `AUTH_ENFORCED=true/false` kills the migration path. In a
real deployment you turn auth on *after* agents are already running.
If the flip is binary, the day you enforce is the day half your
agents break because somebody forgot to wire their signing client.

Three modes give you a safe sequence:

1. Day 0: everything is `off`. System works. No keys needed.
2. Day N (decided by you): flip to `observe`. Watch
   `logs/auth-observe.log`. Fix every agent whose requests would be
   rejected. Iterate until the log stays clean for a few days.
3. Day N+M: flip to `enforce`. No surprises — the `observe` run
   proved every live agent is already signing correctly.

The value can differ between blocks during migration. You might have
consciousness-server in `enforce` while test-runner is still in
`observe` because one of the test agents isn't signing yet.

## Choosing a mode

**Pick `off` if:** you run the ecosystem alone on one machine, or
inside a trusted LAN where the blocks are not reachable from
outside, or you're exercising the system for the first time and just
want it to work.

**Pick `observe` when:** you've been running in `off` and want to
turn authentication on, but you're not sure every agent / script /
scheduled task is already signing its requests. `observe` tells you
exactly which callers would break *before* they actually break.

**Pick `enforce` when:** you've run a day or two of `observe` with
a clean `auth-observe.log` (no would_reject entries from real
traffic), or your deployment starts already signed from day one.
Once in `enforce`, unsigned callers get a hard 401.

## Migration path: off → observe → enforce

The three-mode knob exists so you never have to flip authentication
on as a big bang. Procedure:

```bash
# Day 0 — system runs with AUTH_MODE=off.
# You want to turn on auth. Follow these steps.

# 1. Bootstrap every agent's pub key on the key-server host.
#    (See key-server/keys/agents/README.md for the detailed
#    ssh-keygen + scp procedure.)
scp ~/.ssh/ecosystem-<AGENT>.pub \
    operator@key-server-host:/opt/ecosystem/key-server/keys/agents/<AGENT>.pub
# ... repeat for each agent you expect to authenticate ...

# 2. Flip each block to observe. Restart so env takes effect.
AUTH_MODE=observe docker compose up -d

# 3. Watch the logs for a day or two:
tail -f deploy/volumes/*-logs/auth-observe.log
#    Each line is a request that would have been rejected in
#    enforce. Fix the caller (add signing) or decide to allow it.
#    Reasons you'll see:
#      - missing_headers    : caller isn't signing yet
#      - unknown_agent      : signing but with a key that isn't
#                             bootstrapped on key-server
#      - bad_signature      : protocol mismatch
#      - timestamp_out_of_window : caller's clock is drifting
#      - nonce_replayed     : caller is reusing nonces

# 4. When the log stays clean for a couple of days, flip to enforce.
AUTH_MODE=enforce docker compose up -d

# Day N — rollback if anything goes wrong is `AUTH_MODE=off`. No
# state migrations needed.
```

## Where AUTH_MODE is read

Every block's docker-compose entry exposes `AUTH_MODE` with
`${AUTH_MODE:-off}` interpolation. You control it from your shell:

```bash
AUTH_MODE=enforce docker compose up -d              # all blocks
AUTH_MODE=enforce docker compose up -d --force-recreate test-runner
                                                    # one block, for rollouts
```

Or write it into an `.env` file next to `docker-compose.yml`:

```
AUTH_MODE=observe
```

Systemd users: set `Environment=AUTH_MODE=enforce` in the unit file
for each block.

## Always-open endpoints

The middleware never gates these, regardless of mode:

- `GET /health` — Docker healthchecks, monitoring probes
- `GET /metrics` — Prometheus scraping (future)
- HTTP `OPTIONS` preflight — CORS from browsers (cannot be signed)
- WebSocket upgrade handshake on consciousness-server — authenticated
  separately via `X-Agent-Name` during setup; full WS signing is a
  future iteration.

If a block needs additional always-open endpoints (e.g. public
read-only status), that's a per-block decision — it lives inside
the block's code, not in the shared middleware.

## Signing a request

See [key-server/keys/agents/README.md](../key-server/keys/agents/README.md)
for the agent-side procedure. TL;DR:

```bash
# From the ecosystem root, with a bootstrapped agent key at
# ~/.ssh/ecosystem-agent1 and agent1.pub already on the key-server:

bin/sign-request agent1 POST /api/notes '{"title":"hello"}'
# → prints four X-* headers. Pass them to curl / your HTTP client.
```

For programmatic signing: `key-server/keys/agents/README.md`
ships Node and Python snippets.

## When enforcement hurts

**`enforce` + key-server down = 503 on every request.** This is
deliberate: failing open would let a compromised key-server (or a
DoS that silences it) silently de-authenticate the entire ecosystem.
If the outage will last longer than you can afford the downtime,
flip affected blocks back to `off` or `observe` — that's ~10 s per
block (`compose up --force-recreate`) and beats improvising around
it.

**`enforce` + clock skew >300 s = timestamp_out_of_window.** If a
container has lost NTP sync, its signed requests will be rejected
until the clock is back inside the ±300 s window. Fix NTP, don't
widen the window.

**`enforce` + agent keys rotated without key-server refresh =
unknown_agent.** Key rotation procedure is `scp new.pub` + `rm old.pub`
on the key-server host. There's no DB migration; files are the
authority.

## Where to look when it breaks

```bash
# Key-server's own audit log of every verify call:
cat deploy/volumes/key-server-logs/audit.jsonl | tail -50

# A specific block's observe-mode log:
cat deploy/volumes/<block>-logs/auth-observe.log

# Is key-server even reachable from the block's network?
docker compose exec <block> curl -s http://key-server:3040/health

# Is the pub key on the key-server?
curl -s http://127.0.0.1:3040/api/agents/identity/<AGENT> | jq
```

## What `AUTH_MODE` does NOT do

- Does not authorize — an authenticated agent is allowed to call
  every endpoint. Per-endpoint authorization (ACL / RBAC) is out
  of scope for this revision.
- Does not encrypt transport — LAN / VPN assumption. Full TLS is
  out of scope for this revision.
- Does not sign block-to-block calls (e.g. one block calling another
  on behalf of an agent). Inbound only. Outbound signing is a
  future iteration.

## Related docs

- [SIGNING-PROTOCOL.md](SIGNING-PROTOCOL.md) — headers, canonical message, `/api/verify` API, client examples
- [key-server/keys/agents/README.md](../key-server/keys/agents/README.md) — agent bootstrap procedure
