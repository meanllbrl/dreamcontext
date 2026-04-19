---
name: council
description: >
  Structured multi-agent debate for non-trivial decisions. Load when the user asks to
  "debate this", "get second opinions", "help me decide", "run this by council", or
  invokes `/council`. Orchestrates 3–10 persona sub-agents across N rounds, then a
  dedicated synthesizer writes a final decision report.
tags: [council, debate, decision, sub-agents, orchestration]
alwaysApply: false
---

# Council — structured multi-agent debate

You are orchestrating a **council**: a small cast of persona sub-agents that debate
a non-trivial decision across multiple rounds, then a dedicated synthesizer writes
the final report. You stay **light** — you never read full sub-agent output, only
executive summaries. Sub-agents build their own context on disk via the dreamcontext
CLI so rounds compound without ballooning your context.

## When to invoke

Trigger phrases / explicit invocations:
- `/council`
- "debate this"
- "get a second opinion on…"
- "help me decide…"
- "run this by council"
- "council mode"

**Use it for**: architecture choices, vendor switches, hiring decisions, product
scope calls, incident post-mortems — anything where perspective diversity matters.

**Do NOT use it for**: quick factual lookups, mechanical refactors, "what's the
best variable name", or anything where the answer is knowable without debate.

## Flow (follow this exactly)

### 0. Scope with the user

Ask before starting:
1. **Rounds** — 1 (quick), 2 (default), or 3 (deep)? Recommend based on complexity.
2. **Interrupt between rounds?** — do they want to add constraints mid-debate?
3. **Confirm the question** — write it back verbatim.

### 1. Create the debate

```
dreamcontext council create "<topic>" --rounds <N> [--interrupt]
```

Capture the returned `debate_id` (printed on its own last line).

### 2. Generate personas (3–10)

Generate personas **specific to this topic**. No preset library. Each persona should
have:
- A **slug** (kebab-case): `migration-risk-auditor`, `growth-cfo`, `user-advocate`
- A **model**: `opus` for strategy/synthesis-adjacent roles; `sonnet` for most;
  `haiku` for narrow/focused advocates. Vary them — cognitive diversity matters.
- 2–5 **aspects** (focus areas): `[data-integrity, downtime, rollback]`
- A **body** (100–250 words): who they are, what they obsess over, what biases they
  bring, what would make them push back.

For each persona:
```
echo "<body>" | dreamcontext council agent create <debate_id> <slug> \
  --model <model> --aspects "<aspect1,aspect2,aspect3>"
```

Show the roster to the user and let them adjust before proceeding.

### 3. Run each round

```
dreamcontext council round start <debate_id> <N>
```

For round N ≥ 2, this injects prior-round peer summaries into each persona's context
automatically.

**Dispatch N parallel sub-agents** (one per persona) in a single message. Use the
`council-persona` agent type. Each dispatch prompt MUST include:
- The debate_id and persona slug
- The persona's model (pass via the `model` parameter)
- Reminder: first call is `dreamcontext council round-context <id> <slug>`; last call
  is `dreamcontext council report append <id> <slug>`.

After all sub-agents finish:
```
dreamcontext council round end <debate_id> <N>
dreamcontext council summaries <debate_id> <N>
```

Show summaries to the user. If `--interrupt` is set, ask for any additions to
`## Constraints & Known Facts` in `debate.md` before starting the next round.

### 4. Synthesize

```
dreamcontext council synthesize <debate_id>
```

This prints the manifest of files the synthesizer must read. Dispatch the
`council-synthesizer` sub-agent (single call, model: opus) with the manifest.

The synthesizer writes `_dream_context/council/<debate_id>/final-report.md`.

After the synthesizer reports back:
```
dreamcontext council complete <debate_id>
```

### 5. Promote to knowledge

Show the verdict (read just the `## Verdict` section) and final-report location to
the user. Ask:

> "Promote this decision to knowledge? (y / n / later)"

- **y** → `dreamcontext council promote <debate_id>` (writes
  `_dream_context/knowledge/decision-<slug>.md`)
- **n / later** → leave as-is. The rem-sleep agent will pick it up during the next
  consolidation cycle and decide based on your engagement signals.

## Hard rules

- **You never read full sub-agent reports.** Only `council summaries` output.
- **Sub-agents run in parallel each round** (single message, N Agent calls).
- **Synthesizer is a dedicated sub-agent** — not you.
- **Persona slugs are unique per debate.**
- **Do not skip the scope step.** If the user invoked with just "debate this",
  still ask about rounds and interrupt.
- **Context budget**: your per-debate total should stay under ~20K tokens. If it
  doesn't, you are reading full reports somewhere — stop.
