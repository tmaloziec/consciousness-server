# Running multiple agents

The ecosystem is designed to run more than one agent at a time.
Every agent speaks to the same consciousness-server (tasks, notes,
chat), so coordination happens through shared state — not through
the agents talking to each other directly.

This guide covers:

1. How `bin/launch-agent` isolates agent characters
2. How to add your own role
3. How agents discover each other and hand off work
4. Two common layouts (solo project, review-and-write pair)

## 1. How isolation works

Claude Code merges two `CLAUDE.md` files at startup:

| File | Purpose |
|---|---|
| `$HOME/.claude/CLAUDE.md` | User-level: the agent's **character** |
| `$PWD/CLAUDE.md` | Project-level: what **the codebase** is about |

`bin/launch-agent <role>` gives each role its own `$HOME` so that
several Claude Code instances with different characters can run
against the same project directory:

```
$HOME/.cs-agents/designer/.claude/CLAUDE.md   → agents/designer.md
$HOME/.cs-agents/writer/.claude/CLAUDE.md     → agents/writer.md
$HOME/.cs-agents/validator/.claude/CLAUDE.md  → agents/validator.md
                ↑
         different HOMEs →
         different characters →
         same project dir →
         shared working tree
```

The role file lives in `agents/<role>.md` at the repo root and is
**symlinked** into each agent's isolated `$HOME`. Edits to the role
flow into the next session without re-launching.

## 2. Adding your own role

Two files, no server restart needed:

```bash
# 1. Create the role template
cat > agents/myrole.md <<'EOF'
# Agent: myrole

**Role:** ...
**Scope:** ...

## Character

You are a ...

## Tools

- `search-memory`, `summarize-session`, ...

## Boundaries

- Never ...
- Always ...
EOF

# 2. Launch it
bin/launch-agent myrole ~/projects/my-app

# 3. (optional) Verify it's registered with CS
curl -s http://127.0.0.1:3032/api/agents | jq '.[] | select(.name=="myrole")'
```

Role names should match `[A-Za-z0-9_-]+`. Use lowercase-with-hyphens
by convention (`cortex-worker`, `eng-backend`).

## 3. Agents discovering each other

When an agent launches, it `POST /api/agents/register` on
consciousness-server. Any other agent can then:

```bash
# Who is online right now?
curl -s http://127.0.0.1:3032/api/agents | jq

# Post a chat message. The body shape is {from, content}.
# Mention another agent with @name inside `content` — CS parses
# mentions and routes them to each mentioned agent's inbox.
curl -X POST http://127.0.0.1:3032/api/chat \
  -H "Content-Type: application/json" \
  -d '{"from":"designer","content":"@writer login flow v2 ready, see note id=42"}'

# Broadcast to everyone — just @-mention all, or omit mentions and
# the message lands in the global channel for everyone to read.
curl -X POST http://127.0.0.1:3032/api/chat \
  -H "Content-Type: application/json" \
  -d '{"from":"designer","content":"@all standup in 10"}'
```

In interactive use, the agent reads its own mention queue:

```bash
# Messages that @-mentioned me since I last looked
curl -s "http://127.0.0.1:3032/api/chat/mentions/<my-role>" | jq

# Tasks assigned to me
curl -s "http://127.0.0.1:3032/api/tasks/pending/<my-role>" | jq

# Global chat stream (latest N, or since a timestamp)
curl -s "http://127.0.0.1:3032/api/chat?limit=50" | jq
curl -s "http://127.0.0.1:3032/api/chat?since=2026-04-22T12:00:00Z" | jq
```

Most agent characters include these calls in their "check on start"
routine so that a fresh instance sees what was queued while it was
offline.

## 4. Common layouts

### Solo project (one agent, one role)

```bash
cd ~/projects/my-app
bin/launch-agent designer .
```

One terminal, one Claude Code. The designer character reads/writes
notes, tasks, and chat via the ecosystem, but no other agent is
listening — it's the agent's own scratchpad.

### Review-and-write pair (two agents, one project)

Terminal 1 — the writer:

```bash
cd ~/projects/my-app
bin/launch-agent writer .
```

Terminal 2 — the validator:

```bash
cd ~/projects/my-app
bin/launch-agent validator .
```

They share the same project directory, so both see the same files.
Handoff happens through the ecosystem:

1. `writer` posts a doc draft as a note (`type=docs`, body mentions
   `@validator`)
2. `validator` reads `/api/chat/mentions/validator`, fetches the
   note, posts a `verdict: ...` reply mentioning `@writer`
3. `writer` reads the verdict from its own mentions queue, edits
   the doc, repeats

Neither agent reads the other's terminal output. All coordination
flows through consciousness-server, which means:

- You can kill one and restart it — context is on the server
- You can add a third (`designer`, `engineer`) without changing the
  other two
- The handoff log is greppable in `/api/notes` forever

### Three-agent workflow (design → build → validate)

Same pattern, three terminals:

```bash
bin/launch-agent designer   ~/projects/my-app   # terminal 1
bin/launch-agent engineer   ~/projects/my-app   # terminal 2  (your own role)
bin/launch-agent validator  ~/projects/my-app   # terminal 3
```

Coordination happens entirely through notes and chat. The engineer
agent picks up design notes by id, the validator picks up the diff
after the engineer posts a "ready for review" chat to `@validator`.

## Troubleshooting

### `launch-agent: role '...' not found`

Check that `agents/<role>.md` exists and its filename matches the
argument exactly. The error message lists the available roles.

### `launch-agent: 'claude' not found in PATH`

Install Claude Code first (`https://docs.claude.com/en/docs/claude-code`)
or set `CLAUDE_BIN=/path/to/claude` if you have a non-standard install.

### Agent does not appear in `/api/agents`

launch-agent tries to register with consciousness-server but fails
silently if CS is not reachable. To verify:

```bash
curl -v http://127.0.0.1:3032/health
# If CS is down: start it (cd deploy && docker compose up -d)
```

Once CS is up, the next message the agent sends will re-register it.

### Two agents editing the same file

There is no file-level lock. Agents coordinate through notes and
chat ("I'm editing `server.py`, claim it with me before you touch
it"). If two agents write the same file at once, the last write
wins — resolve as a git merge conflict.
