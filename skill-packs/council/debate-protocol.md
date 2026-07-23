---
name: debate-protocol
description: Detailed CLI protocol reference for the council skill. Load when orchestrating a debate and you need the exact command sequence, verdict rubric, and failure modes.
tags: [council, debate, protocol, cli, verdicts]
---

# Council debate protocol, CLI reference (v2)

This is the exact CLI surface for the council skill, with failure modes and
idempotency notes. Every command is `dreamcontext council ...`.

## Commands

### Orchestrator commands

| Command | Purpose | Notes |
|---|---|---|
| `council create <topic> --rounds N [--interrupt] [--options "A=Keep sync,B=Drop it"]` | Create debate folder | Returns `debate_id` on last stdout line. Topic can span multiple args. `--options` registers named options in `verdicts.json` and mirrors them into `debate.md` frontmatter; without it, stances are free-form and first-seen stances become dynamic options. Initializes the live file. |
| `council agent create <id> <slug> --model <m> --aspects <a,b,c>` | Create persona | Body from `--body` or stdin. `--force` to overwrite. Also used mid-debate for a wildcard persona. |
| `council round start <id> <N>` | Start round N | Idempotent. For N ≥ 2 injects peer summaries from round N-1 into each persona. Live: all roster personas → `think`. |
| `council round end <id> <N>` | Close round N | Fails if any persona's report is missing, and lists exactly which. Live: phase → `interlude`. |
| `council summaries <id> <N>` | Read exec summaries | The main per-round read. v2 appends one line per persona: `stance=<s> conviction=<n> (<shift>)` when a verdict exists. |
| `council board <id> [--round N] [--plain]` | Render the chamber board | Per-persona stance, 10-cell conviction bars, shift markers, convergence meter, options tally. `--plain` strips ANSI (auto when not a TTY). **Show this to the user every round.** |
| `council timeline <id> [--json]` | Per-round stance + conviction table | Markdown table for embedding in the report; `--json` returns `{options, rounds:[{round, verdicts, convergence, leading}]}` for machine use (Excalidraw board). |
| `council inject <id> <fact...>` | Inject a fact mid-debate | Appends `- **[Interlude R<n>]** <fact>` to `## Constraints & Known Facts` in `debate.md`. Personas see it next round via `round-context`. |
| `council question <id> <slug> <question...>` | Queue a directive for one persona | Appended under `## Round <next> — Directives` in the persona's `context-and-persona.md`; surfaced by its next `round-context`. Also carries cross-examinations and steelman-swap orders. |
| `council synthesize <id>` | Prepare synthesis | Prints manifest. Status → `synthesizing`. Live: phase → `synthesis`. |
| `council complete <id>` | Finalize | Requires `final-report.md` to exist. Live: phase → `done`. |
| `council promote <id>` | Copy to knowledge/ | v2 trims to Verdict + Decision card + Why + Minority view & revisit conditions + Open risks. Skips Position timeline, What-was-debated, Appendix. |
| `council list [--unpromoted\|--all]` | Triage | `--unpromoted` used during sleep consolidation (council-promote check). |
| `council show <id>` | Inspection | Prints debate metadata + round-log. |
| `council live clear` | Delete the live file | Run after the final report, or when abandoning a debate. |
| `council demo-live [--phase <p>]` | Fake live state | Writes a plausible `.council-live.json` (roster of 4, mid-round) for previewing the app panel without a debate. Dev/demo only. |

### Persona commands

| Command | Purpose | Notes |
|---|---|---|
| `council round-context <id> <slug>` | Load persona + cross-context | **First call every round.** v2 adds: the current verdict landscape (compact stance table of the last completed round), facts injected since last round, and pending directives for THIS persona. |
| `council verdict <id> <slug> <round> --stance <s> --conviction <n> --headline "<h>" [--concession "<c>"]` | Submit the round verdict | **Before `report append`, every round.** Conviction 0-100. With registered options, `--stance` must match an option key (case-insensitive). Idempotent per (round, slug); last write wins. |
| `council report append <id> <slug>` | Submit round report | **Last call every round.** Body from `--body` or stdin. Validates required subsections; warns (does not fail) when no verdict was submitted for the current round. |
| `council research add <id> <slug> <topic>` | Persist a research note | Body from `--body` or stdin. Soft-fail if WebFetch/WebSearch unavailable. |
| `council research list <id> <slug>` | List prior researches | Used across rounds to avoid re-searching. |

## Required report subsections

`council report append` **rejects** a report missing any of:
- `### Executive Summary` (≤150 words recommended, soft-warn if longer)
- `### Position`
- `### Reasoning`
- `### Reactions to peers`
- `### Open questions`

Optional, accepted when present:
- `### Cross-examination` (required in practice when the persona has a pending
  cross-examination directive; answer the question directly, in character)

## Verdict conviction rubric

Conviction is an honest self-report, not advocacy volume:

| Conviction | Meaning |
|---|---|
| 90-100 | Would bet the project on this stance |
| 70-89 | Confident; a specific new fact could still move me |
| 50-69 | Genuinely torn; leaning this way on balance |
| 30-49 | Weakly held; arguing it because the lens demands it |
| < 30 | Leaning against my own stance; close to switching |

`--concession` records the strongest opposing point the persona accepts. A verdict
with a concession is more credible than one without.

## Failure modes and recovery

- **Persona skipped `council verdict`** → `report append` succeeds but prints a
  warning. Resume the persona with a one-line reminder to submit its verdict; the
  command is idempotent per (round, slug).
- **`round end` fails with "missing reports from ..."** → it lists the personas.
  Resume (or re-dispatch, in fallback mode) only those; everyone else's work stands.
- **Report missing a required subsection** → `report append` exits non-zero.
  Resume the persona with the validation error.
- **Persona session lost** (resume errors, id gone) → spawn a fresh session with
  the original brief and continue; update the session registry. The on-disk persona
  folder carries the history, so nothing is lost.
- **Persona repeats itself verbatim across rounds** → one fresh re-fork (see
  SKILL.md mechanics), recorded under `<slug>-refork` in the registry.
- **Live file write fails** → never a gate. Every command swallows live-file
  errors; the debate proceeds. `council demo-live` and `council live clear` are the
  only commands whose sole job is the live file.
- **`round start` called twice on same round** → idempotent; no-op if cross-context
  already injected.
- **User cancels mid-round** → recoverable; `debate.md` frontmatter stores
  `current_round` and `status`. Resume with `round start` (same N) or `round end`.
- **Research tools unavailable** → persona proceeds without `researches/`; not an
  error.
- **`promote` refuses** because status ≠ `complete` → call `council complete` first
  (requires `final-report.md`).
- **CLI spawn unavailable** (no `claude` binary, restricted env) → fallback mode:
  dispatch `council-persona` Agent-tool subagents in parallel per round. All
  commands behave identically; only the session registry stays empty.
- **Debates created before v2** have no `verdicts.json`; every command tolerates
  its absence (board and timeline render empty, summaries omit stance lines).

## File layout (on disk, after a 2-round 3-persona debate)

```
_dream_context/council/
├── index.json
└── council_xYz123/
    ├── debate.md              # frontmatter (+ options) + Question + Constraints & Known Facts + Session registry
    ├── round-log.md           # append-only timeline
    ├── verdicts.json          # options + per-round per-persona {stance, conviction, headline, concession}
    ├── final-report.md        # written by synthesizer
    ├── decision-board.excalidraw.md   # optional, only when the excalidraw pack was available
    ├── migration-risk-auditor/
    │   ├── context-and-persona.md   # persona body + per-round cross-context + directives
    │   ├── report.md                # round entries LIFO
    │   └── researches/              # optional
    │       ├── index.json
    │       └── firestore-rollback-patterns.md
    ├── dx-champion/
    └── user-advocate/

_dream_context/tmp/
└── .council-live.json         # written automatically by the CLI; app panel reads it
```

## Context-budget discipline

The orchestrator (main agent) should only read:
- `council create` output (debate_id)
- `council summaries <id> <N>` output (one per round)
- `council board <id>` output (one per round, shown to the user; compact, allowed)
- `council timeline <id>` output (compact, allowed; typically once near synthesis)
- `council synthesize <id>` output (manifest)
- The `## Verdict` section of `final-report.md` (single Read call, section only,
  not the whole file)

If the orchestrator reads full `report.md` files, the design is being violated.
