---
name: debate-protocol
description: Detailed CLI protocol reference for the council skill. Load when orchestrating a debate and you need the exact command sequence and failure modes.
tags: [council, debate, protocol, cli]
---

# Council debate protocol — CLI reference

This is the exact sequence of CLI calls for the council skill, with failure modes
and idempotency notes.

## Commands (14 sub-commands)

### Main-agent commands

| Command | Purpose | Notes |
|---|---|---|
| `council create <topic> --rounds N [--interrupt]` | Create debate folder | Returns `debate_id` on last stdout line. Topic can span multiple args. |
| `council agent create <id> <slug> --model <m> --aspects <a,b,c>` | Create persona | Body from `--body` or stdin. `--force` to overwrite. |
| `council round start <id> <N>` | Start round N | Idempotent. For N≥2 injects peer summaries from round N-1 into each persona. |
| `council round end <id> <N>` | Close round N | Fails if any persona missing. |
| `council summaries <id> <N>` | Read exec summaries | **This is the only thing the main agent reads per round.** |
| `council synthesize <id>` | Prepare synthesis | Prints manifest. Status → `synthesizing`. |
| `council complete <id>` | Finalize | Requires `final-report.md` to exist. |
| `council promote <id>` | Copy to knowledge/ | Trims to Verdict + Why + Minority views + Open risks. Skips What-was-debated + Appendix. |
| `council list [--unpromoted\|--all]` | Triage | `--unpromoted` used by rem-sleep agent. |
| `council show <id>` | Inspection | Prints debate metadata + round-log. |

### Sub-agent commands

| Command | Purpose | Notes |
|---|---|---|
| `council round-context <id> <slug>` | Load persona + peer cross-context | **First call every round.** |
| `council report append <id> <slug>` | Submit round report | **Last call every round.** Body from `--body` or stdin. Validates required subsections. |
| `council research add <id> <slug> <topic>` | Persist a research note | Body from `--body` or stdin. Soft-fail if WebFetch/WebSearch unavailable. |
| `council research list <id> <slug>` | List prior researches | Used across rounds to avoid re-searching. |

## Required report subsections

`council report append` **rejects** a report missing any of:
- `### Executive Summary` (≤150 words recommended — soft-warn if longer)
- `### Position`
- `### Reasoning`
- `### Reactions to peers`
- `### Open questions`

## Failure modes and recovery

- **Sub-agent submits report without Executive Summary** → `report append` exits
  non-zero. Re-dispatch the sub-agent with a corrected prompt.
- **`round end` fails with "missing reports from…"** → one or more sub-agents didn't
  finish. Re-dispatch only the missing ones.
- **`round start` called twice on same round** → idempotent; no-op if cross-context
  already injected.
- **User cancels mid-round** → state is recoverable; `debate.md` frontmatter stores
  `current_round` and `status`. Resume with `round start` (same N) or `round end`.
- **Research tools unavailable** → sub-agent proceeds without researches/; not an
  error.
- **`promote` refuses** because status ≠ `complete` → call `council complete` first
  (requires `final-report.md` to exist).

## File layout (on disk, after a 2-round 3-persona debate)

```
_dream_context/council/
├── index.json
└── council_xYz123/
    ├── debate.md              # frontmatter + Question + Constraints & Known Facts
    ├── round-log.md           # append-only timeline
    ├── final-report.md        # written by synthesizer
    ├── migration-risk-auditor/
    │   ├── context-and-persona.md   # persona body + per-round cross-context
    │   ├── report.md                # round entries LIFO
    │   └── researches/              # optional
    │       ├── index.json
    │       └── firestore-rollback-patterns.md
    ├── dx-champion/
    └── user-advocate/
```

## Context-budget discipline

The orchestrator (main agent) should only read:
- `council create` output (debate_id)
- `council summaries <id> <N>` output (one per round)
- `council synthesize <id>` output (manifest)
- The `## Verdict` section of `final-report.md` (read via a single Read tool call,
  section only — not the whole file)

If the orchestrator reads full `report.md` files, the design is being violated.
