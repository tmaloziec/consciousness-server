# Contributing to consciousness-server

Thanks for your interest in contributing! This document explains how to get involved.

## Quick Start

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Test locally (see [Testing](#testing) below)
5. Open a Pull Request
6. Sign the CLA (one click via [CLA Assistant bot](https://cla-assistant.io/))

## Contributor License Agreement (CLA)

Before your Pull Request can be merged, you must sign the [consciousness-server CLA](CLA.md).

The CLA Assistant bot will automatically prompt you on your first PR. Signing is a one-time action — all your future contributions are covered.

**Why a CLA?** consciousness-server is dual-licensed (AGPLv3 + commercial). To offer commercial licenses to organizations that need them, the project must hold the rights to all contributed code. Without a CLA, a single contributor could block commercial licensing of the entire project.

The CLA does **not** transfer ownership of your code to anyone. You retain copyright. You simply grant the Maintainer the right to license the project (including your contributions) under multiple licenses.

This is the same model used by Apache Software Foundation, Google, MongoDB, Grafana Labs, and most dual-licensed open source projects.

## What to Contribute

We welcome:

- **Bug fixes** — open an issue first if it's a non-trivial change.
- **Block improvements** — touch one block at a time
  (`core/`, `key-server/`, `memory-server/`, `semantic-search/`,
  `machines-server/`, `test-runner/`, `git-workflow/`).
- **Documentation** — `README.md`, `ARCHITECTURE.md`,
  `SECURITY.md`, and the focused docs under `docs/` (`AUTH-MODE.md`,
  `MULTI-AGENT.md`, `SIGNING-PROTOCOL.md`, `INSTALL-BARE-METAL.md`,
  `MESH-STAGE1.md`).
- **Agent role templates and skills** — `agents/*.md` and
  `skills/*.md`. Treat the shipped ones as starting points.
- **Schema changes** — edit `lib/schemas/*.openapi.yaml`, then
  run `bin/sync-schema` to regenerate `generated/openapi/` and
  `core/generated/schemas/`. Commit the regenerated artifacts.
- **Tooling under `bin/`** — preflight, sign-request, launch-agent,
  ingest-document, sync-* helpers.

We're cautious about:

- **Cross-block API changes** — open an issue first; these need
  ARCHITECTURE.md updates and may break agents in the wild.
- **New runtime dependencies** — `core/`, `key-server/`,
  `memory-server/` are deliberately small Node services.
- **Breaking changes to the signing protocol** — open RFC issue
  first; see `docs/SIGNING-PROTOCOL.md`.

## Stack

| Block | Language | Notes |
|---|---|---|
| `core/`, `key-server/`, `memory-server/` | Node 20+ | `npm` for deps, `node --check` for syntax |
| `semantic-search/`, `machines-server/`, `test-runner/` | Python 3.12 / Flask | `pip install -r requirements.txt` |
| `git-workflow/` | Python stdlib | no third-party deps by design |
| `bin/sync-schema` | Python 3.9+ | `PyYAML` (see `bin/requirements.txt`) |

## Code Style

- **JavaScript/Node**: 2-space indent, single quotes, no semicolons-as-statement-separators only where unambiguous — follow whatever the surrounding file does.
- **Python**: PEP 8, 4-space indent, type hints where helpful.
- **Comments**: explain *why*, not *what*. Code should be self-documenting.
- **No emojis in code** unless functional.
- **Polish-language comments are welcome** in operator-facing docs and bin/ scripts where the audience is solo-operator Polish speakers; keep block source and public docs in English.

## Testing

Before submitting, run the checks relevant to what you touched.

```bash
# Syntax check (all blocks)
node --check core/server.js
node --check key-server/server.js
node --check memory-server/server.js
python3 -m py_compile semantic-search/server.py
python3 -m py_compile machines-server/server.py
python3 -m py_compile test-runner/server.py

# Docker compose config sanity (catches yaml drift early)
docker compose -f deploy/docker-compose.yml config > /dev/null

# Schema artifacts in sync (after editing lib/schemas/*.yaml)
bin/sync-schema --check

# Bring the stack up and smoke-test blocks end-to-end
bin/preflight                          # verify host deps
cd deploy && docker compose up -d
bin/test-blocks.sh                     # /health on each block
bin/test-integrations.sh               # mention routing, signing, ...
```

For bare-metal contributors who do not run Docker, see
[`docs/INSTALL-BARE-METAL.md`](docs/INSTALL-BARE-METAL.md) and
`bin/preflight-bare-metal`.

For non-trivial changes, describe your testing in the PR description.

## Reporting Bugs / Security Issues

- **Bugs**: Open an issue with reproduction steps, environment
  (OS, Docker / Node / Python versions, Ollama version + model),
  and expected vs. actual behavior.
- **Security vulnerabilities**: Do **not** open a public issue.
  Contact the maintainer privately via
  [github.com/build-on-ai](https://github.com/build-on-ai) with
  details. We aim to respond within 7 days. See
  [`SECURITY.md`](SECURITY.md) for the threat model.

## Pull Request Checklist

- [ ] CLA signed (CLA Assistant bot will check automatically)
- [ ] Branch from `main`, rebased on latest `main`
- [ ] Touched code follows the style of the surrounding file
- [ ] `node --check` / `python3 -m py_compile` passes on changed files
- [ ] `docker compose -f deploy/docker-compose.yml config` still parses
- [ ] If you changed `lib/schemas/*`, `bin/sync-schema --check` passes
- [ ] PR description explains *what* and *why*
- [ ] No private data (IPs, API keys, internal paths) in commits

## Code of Conduct

Be respectful. Disagreements happen — keep them about code, not people. Maintainer reserves the right to lock or close PRs/issues that violate this principle.

## License

By contributing, you agree that your contributions will be licensed under the project's dual license (AGPLv3 + commercial), as described in the [CLA](CLA.md).

---

Questions? Open a [Discussion](https://github.com/build-on-ai/consciousness-server/discussions) or file an issue.
