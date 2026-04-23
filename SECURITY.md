# Security

This document describes the threat model consciousness-server is
designed for, the deliberate trade-offs the default configuration
makes, and how to report a vulnerability.

## Intended deployment

consciousness-server is designed for a **single operator or a small
team on a trusted network** — typically a home LAN, a VPN, or a
shared host at one organisation. It is **not** designed as a public
multi-tenant service and is not hardened against an adversary with
arbitrary network access to its ports.

Concrete assumptions in the default configuration:

- The host Docker daemon and any peers that can reach ports 3032,
  3037, 3038, 3041, 3042, 6379 are trusted.
- Under `AUTH_MODE=off` (the default), there is no authentication
  at all. Any caller that can open a TCP connection to the service
  ports can read and write everything.
- Agents launched via `bin/launch-agent` are trusted characters —
  they run `claude` processes under the operator's account with the
  operator's credentials.
- Port 3040 (key-server, opt-in) is expected to be reachable only
  from the other blocks in the ecosystem. Do not expose it publicly.

If any of these assumptions do not hold in your environment, read
`docs/AUTH-MODE.md` and switch to `observe` or `enforce`.

## Deliberate trade-offs (not bugs)

These behaviours are **by design**. If you find one surprising,
this section explains why.

### Agent-to-agent orchestration via tmux

`POST /api/agents/:name/restart` on consciousness-server sends
`C-c` + `claude` + `Enter` into a tmux session named after the
target agent. This is an **intentional orchestration channel** —
it lets a supervisor agent (like an observer / reviewer role) restart a
stuck peer without manual intervention.

The endpoint validates the agent name against `[A-Za-z0-9._-]+` and
invokes tmux via `execFile` with an argv array (no shell
interpolation), so the attack surface is limited to what tmux
itself exposes. But an agent that can reach CS at all can also
restart other registered agents by design. Under `enforce`, the
caller must present a valid ed25519 signature; under `off`, nothing
gates it.

### systemctl service control on consciousness-server

`POST /api/system/services/:name/:action` lets a caller
start/stop/restart/enable/disable a systemd **user** unit. The
`action` is validated against an allowlist; the `name` is validated
against `[a-zA-Z0-9._@:-]+` and invoked via `execFile`. But it is
still a control surface — do not enable it on a host where the
Linux user running CS can touch units you do not want a network
caller to reach.

### Key-server secrets dispenser

`GET /keys/ssh/:name` and `GET /keys/api/:service` on key-server
hand out SSH private keys and stored API keys over HTTP. This is
convenient for a single-user deployment that wants one place to
rotate credentials; it is **unsafe on a reachable network**.

Protections in place:
- IP allowlist (CIDR-style prefix match)
- Optional `X-API-Key` header, checked when configured
- Every request written to `deploy/volumes/key-server-logs/audit.jsonl`

If you use this dispenser, keep port 3040 on loopback or a VPN
interface, and rotate keys the moment the host is compromised.

### test-runner executes processes

`POST /api/test` on test-runner spawns a subprocess. The
`test_type` is allowlisted (`pytest` / `npm` / `vitest`) and
invoked as `execve` argv (no shell), but the process does run with
the container's privileges and can write anywhere inside the
container. Under `off` the endpoint is unauthenticated. A
deployment that cares must run test-runner under `enforce`.

### AUTH_MODE=off is the default

A fresh clone + `docker compose up` gives you a working ecosystem
with zero authentication. This is a deliberate choice — the common
case is a solo developer who wants the system to work immediately
on localhost. For anything beyond that, flip blocks to `observe`
first, then `enforce`. `docs/AUTH-MODE.md` walks through the
migration.

## What this document does NOT cover

- Authorisation between authenticated agents. An agent that
  successfully authenticates (under `enforce`) is trusted on
  every endpoint. Per-endpoint ACL/RBAC is not in v1.
- Transport encryption. LAN / VPN is assumed. Ports are plaintext
  HTTP. TLS is not in v1.
- Protection against a compromised block. If key-server is taken
  over, every signed request can be forged. If Redis is taken
  over, every stored memory can be tampered. Isolation between
  blocks is container-level, not trust-level.
- Supply-chain attacks on dependencies. Dependencies are pinned in
  `core/package.json`, `*/requirements.txt` and not audited per
  release.

## Reporting a vulnerability

Please report security issues **privately**, not in public GitHub
issues.

- **Email:** buildonai.tm@gmail.com

Include:

1. A clear description of the issue and its impact
2. Steps to reproduce (ideally a minimal PoC)
3. Your preferred credit / disclosure terms

Expect an acknowledgement within a few business days. For critical
issues (remote code execution, auth bypass, secret disclosure), a
fix or mitigation advisory will be prioritised over any other work.
Non-critical issues are handled on a best-effort basis.

There is no bug bounty programme today.

## Hardening checklist for operators

If you deploy consciousness-server somewhere that is not "a laptop
on my desk":

- [ ] Set `AUTH_MODE=observe` for a week, watch `auth-observe.log`,
      then flip to `enforce`.
- [ ] Run key-server under `--profile full`; never expose port 3040
      outside the ecosystem network.
- [ ] Bind the public ports (3032, 3037, 3038, 3041, 3042) to
      loopback or a VPN interface, not `0.0.0.0`, unless you
      actually want remote access.
- [ ] Back up `deploy/volumes/redis/` and `deploy/volumes/chroma/`
      on a schedule — they contain all the durable state.
- [ ] Do not drop real SSH private keys into `key-server/keys/ssh/`
      on a deployment where multiple people can reach port 3040.
      Consider a proper secret manager (Vault, 1Password CLI, AWS
      Secrets Manager) instead of the built-in dispenser.
- [ ] Review `docs/AUTH-MODE.md` and `docs/SIGNING-PROTOCOL.md`
      before enabling enforcement in production.
