# Skill: summarize-session

Reduce a long conversation transcript into a dense, faithful summary
that downstream agents can use as grounding without re-reading the
whole thing.

## When to use

- Context window is filling and the user expects continuity.
- Handoff between agents (outgoing agent writes the summary;
  incoming one reads it).
- End-of-session archival into `training-data/`.

## Inputs

- `transcript` — array of `{role, content, timestamp}` messages, or
  a path to a `.jsonl` session file.
- `max_tokens` — soft target for the summary length (default 800).

## Output

Markdown document with three sections:

1. **What happened** — chronological bullets, one per decision or
   outcome. No chit-chat. Keep file paths + commit hashes verbatim.
2. **Open threads** — things left undone, questions unanswered,
   follow-ups the next agent should pick up.
3. **Context for continuation** — facts, environment state,
   assumptions that a fresh agent would need to continue.

## Rules

- Preserve every concrete reference (paths, ports, commit hashes,
  agent names) exactly as they appeared.
- Drop greetings, acknowledgements ("ok", "got it"), self-corrections
  that were superseded.
- If the session contained a mistake that was later fixed, record
  the fix — not the mistake — unless the mistake explains a decision
  that still matters.
- Never invent. If something is ambiguous, write "unclear: …".

## Related

- `chunk-session` — finer-grained split for embedding into the
  vector store.
- `extract-decisions` — pulls just the decision register from a
  session.
