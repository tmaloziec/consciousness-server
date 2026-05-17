# Upgrade: v0.1.0 → v1.1.0

This guide is for operators who run an older consciousness-server (`0.1.0-mvp`
or similar) and want to move to `1.1.0` without losing data.

If you are installing fresh, ignore this document and follow
[`INSTALL-BARE-METAL.md`](INSTALL-BARE-METAL.md) (no Docker) or
`deploy/docker-compose.yml` (Docker).

## What changes between v0.1.0 and v1.1.0

- **Agent identity files** — v0.1.0 stored each agent as a JSON wrapper with a
  `claude_md` string field (`<NAME>.json`). v1.1.0 reads bare markdown files
  (`<NAME>.md`) from `AGENTS_DIR`. You convert once with the script below.
- **`AGENTS_DIR` env var** — v1.1.0 reads it explicitly. v0.1.0 used a
  hardcoded path. Set it in your service environment.
- **Application state (notes, chat, tasks)** — lives in **Redis**, not in the
  on-disk SQLite file. Both versions use the same Redis schema, so your data
  carries over **if you keep the same Redis instance**. Back it up first.

## Step-by-step

The upgrade takes ~10 minutes and includes a short service downtime
(seconds, while the new code starts).

### 1. Back up Redis

```bash
./bin/backup-redis-before-upgrade ~/backups/cs-pre-1.1.0
```

This runs `BGSAVE` against your live Redis and copies the resulting `dump.rdb`
to the target directory. If the Redis dump file lives in a directory only
`root` can read (the production default on most distros), run the script as
the `redis` user, or copy the dump with `sudo` after the script reports the
path.

### 2. Back up the old install directory

```bash
tar -czf ~/backups/cs-pre-1.1.0/old-install.tar.gz /path/to/old/consciousness-server
tar -czf ~/backups/cs-pre-1.1.0/old-agents.tar.gz /path/to/old/agents
```

### 3. Convert agent identity files

```bash
./bin/convert-agents-json-to-md /path/to/old/agents ~/new-agents-md
```

Verify the output:

```bash
ls ~/new-agents-md
head -20 ~/new-agents-md/<one-of-your-agents>.md
```

You should see one `.md` per agent, with the same identity text the old
`/api/identity/claude-md/<agent>` endpoint returned.

### 4. Install v1.1.0 code

Two paths, pick one:

- **Bare-metal**: follow [`INSTALL-BARE-METAL.md`](INSTALL-BARE-METAL.md),
  but instead of pointing `AGENTS_DIR` at the bundled `./agents` (which holds
  role templates), point it at the directory you produced in step 3.
- **Docker**: edit `deploy/docker-compose.yml` to bind-mount your converted
  agents directory in place of the repository's `./agents`. The
  `AGENTS_DIR` env var inside the container stays at `/data/agents`.

Keep the same Redis instance — do not start a fresh one, otherwise you lose
all notes, chat and tasks.

### 5. Restart the service

```bash
sudo systemctl restart consciousness-server
# or for a foreground sanity check first:
node core/server.js
```

### 6. Verify

```bash
curl -s http://localhost:3032/health | jq
curl -s http://localhost:3032/api/agents | jq '.agents | length'
curl -s http://localhost:3032/api/identity/claude-md/<one-of-your-agents> | jq -r .claude_md | head
```

Expected:

- `/health` returns `"version": "1.1.0"`.
- `/api/agents` lists the same agents you had before.
- `/api/identity/claude-md/<agent>` returns the same text as in the old install.

If the agent list is empty, your `AGENTS_DIR` is not pointing at the converted
directory — check the environment variable in the systemd unit (or in your
shell if running foreground) and restart.

## Rollback

If anything goes wrong, point the systemd unit back at the old install
directory and restart. Redis was not modified by the upgrade, so once the
old binary is back, the system returns to its pre-upgrade state. Keep both
installs side-by-side for at least one week before deleting the old one.
