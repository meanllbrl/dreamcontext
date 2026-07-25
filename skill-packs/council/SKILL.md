---
name: council
description: >
  Structured multi-agent debate for non-trivial decisions. Load when the user asks to
  "debate this", "get second opinions", "help me decide", "run this by council", or
  invokes `/council`. Orchestrates 3-10 persona CLI sessions across N rounds with
  structured verdicts, a live chamber board, and interactive interludes, then a clean
  synthesizer sub-agent writes the final decision report.
tags: [council, debate, decision, sub-agents, orchestration, verdicts]
alwaysApply: false
---

# Council v2, The Chamber: persona sessions debate, a clean judge decides

You are the **orchestrator** of a council: a cast of persona sessions that debate a
non-trivial decision across rounds, submitting structured verdicts as they go, while
you run the chamber. You stay **light**: you never argue a side yourself, and you
never read full persona reports, only `council summaries`, `council board`, and
`council timeline` output. Personas build their own context on disk via the
dreamcontext CLI so rounds compound without ballooning your context.

You are also the **single writer** of `debate.md`. Personas write only their own
persona folder; the session registry and any mid-debate constraint edits go through
you (or through the CLI commands built for them).

## When to invoke

- `/council` (primary entry)
- "debate this" / "get a second opinion on..." / "help me decide..."
- "run this by council" / "council mode"

**Use it for**: architecture choices, vendor switches, hiring decisions, product
scope calls, incident post-mortems, anything where perspective diversity matters.

**Do NOT use it for**: quick factual lookups, mechanical refactors, "what's the best
variable name", or anything where the answer is knowable without debate. A debate
spends real tokens; if the answer is obvious, say so and answer.

## Commitment ritual (do this FIRST, non-negotiable)

Before creating anything, **YOU MUST**:

1. **Announce**: restate the decision question back to the user in one sentence, and
   say "I'm convening the council."
2. **Create a TodoWrite list** with the phases as items: scope, create + roster,
   one item per round, synthesis, report + promote. A phase is not done until its
   exit condition holds.
3. **Track round state in TodoWrite**: each round's todo carries the live state,
   e.g. `Round 2: 3/5 verdicts in, waiting on user-advocate`. This keeps the debate
   externally observable, so you cannot silently skip a round or a missing persona.

Skipping the ritual is the first step toward a sloppy debate. Don't.

## Depth router

| Depth | Rounds | Personas | Interludes | Use when |
|---|---|---|---|---|
| **Quick** | 1 | 3 | none | Low-stakes, reversible, you just want three angles fast |
| **Standard** (DEFAULT) | 2 | 4-6 | after round 1 | Most real decisions |
| **Deep** | 3 | 5-8 | after every round, cross-examination expected | High-stakes, contested, many dimensions |

**Hot override:** if the decision is **irreversible or costly to reverse** (vendor
lock-in, public API contract, layoff, migration with no rollback), force **Deep**
regardless of what the user picked. Say you did and why.

## Phase 0: scope (ONE batched ask)

Ask the user **one batched message** covering everything, then go hands-off until
the first interlude:

1. **Confirm the question verbatim** ("Is this the question: ...?").
2. **Depth**: Quick / Standard / Deep (recommend one, note the hot override).
3. **Decision options**: named options (A/B/...) or open-ended? If named, capture
   `key=label` pairs for `--options`.
4. **Interludes on or off**: do they want to intervene between rounds?

**Autonomous fallback**: running with no user available, default to Standard depth,
open options, interludes off. Record the chosen defaults in `debate.md` constraints
via `council inject` so the record shows they were defaults, not answers.

## The two-lane model (read before dispatching anything)

| Lane | Who | Context | Rule |
|---|---|---|---|
| **Debaters** | persona ×N | CLI sessions, spawned once at round 1, resumed each later round | Resume pays only the delta; the persona keeps its own memory of the debate |
| **Judge** | `council-synthesizer` | Claude Code Agent-tool subagent | Always clean and fresh, meets the debate only through files and CLI output, **never forked, never resumed** |

**Never make the judge a debater.** A synthesizer that lived through the debate
inherits its framing and anchors toward the loudest persona. The clean-context
Agent-tool synthesizer is the design, not an option.

### Persona session mechanics (proven flags, use exactly these)

Personas are spawned and driven via the `claude` CLI, not the Agent tool:

1. **Spawn each persona at round 1** (one spawn per persona, run them in parallel
   as background Bash calls):
   ```
   claude -p "<brief>" --model <m> --output-format json \
     --permission-mode acceptEdits \
     --allowedTools "Bash" "Read" "WebSearch" "WebFetch" < /dev/null
   ```
   `< /dev/null` matters: a headless `-p` invocation with no stdin redirect can hang
   waiting for input. The permission flags are not optional: without them a headless
   session stalls at its first CLI write with a "please approve" message and zero
   work done. Parse the JSON response for `session_id`.

   The `<brief>` contains: debate_id, persona slug, round number, and the standing
   orders: first call `dreamcontext council round-context <id> <slug>`, submit
   `dreamcontext council verdict` before `dreamcontext council report append`,
   follow the council-persona contract.

2. **Record session ids in the Session registry.** You (single writer) append this
   block to `debate.md` after the round-1 spawns, and keep it updated:
   ```
   ## Session registry
   <persona-slug>:        <session_id>
   <persona-slug>-refork: <session_id | ->
   ```

3. **Resume each persona for round N ≥ 2** with only the delta (the round number
   and any directives; the persona re-reads peers itself via `round-context`):
   ```
   claude -p --resume <session_id> "<round N brief, delta only>" \
     --output-format json --permission-mode acceptEdits \
     --allowedTools "Bash" "Read" "WebSearch" "WebFetch" < /dev/null
   ```

4. **Re-fork rule**: a persona that stops engaging (repeats its prior round nearly
   verbatim, ignores directives) gets **ONE** fresh spawn with the original brief
   plus a note of what it must react to. Record the new id under
   `<slug>-refork`. If the fresh spawn also disengages, note it for the
   synthesizer and move on; do not loop.

5. **Verify before trusting**: after each round's sessions return, `council round
   end` lists any personas whose report is missing. A confident session reply plus
   a missing report means the session stalled; resume it with the reminder, or
   re-fork.

**Fallback mode (no CLI spawn available)**: dispatch `council-persona` Agent-tool
subagents in parallel instead, one per persona per round, in a single message,
passing debate_id, slug, round, and model. Everything else (verdict before report,
round-context first, board, interludes) works identically. Document in the debate
log which mode ran.

## Orchestration flow

```mermaid
flowchart TD
    P0[Phase 0, one batched ask: question, depth, options, interludes] --> DR[Depth router: Quick / Standard / Deep, irreversible forces Deep]
    DR --> C[council create with --rounds and --options]
    C --> R[Generate roster, council agent create per persona, show to user]
    R --> RS[Round N: council round start]
    RS --> D[Dispatch personas in parallel: spawn round 1, resume later rounds]
    D --> RE[council round end, re-dispatch any missing personas]
    RE --> B[council board, SHOW the output to the user]
    B --> CONV{Convergence check}
    CONV -->|90 percent or more, two rounds in a row| CV[Offer Call the vote]
    CONV -->|rounds remain| I{Interludes on?}
    I -->|yes| IC[Intervention cards 1-6]
    IC --> RS
    I -->|no| RS
    CONV -->|rounds done, convergence under 40 percent| ESC[ESCALATE: offer one extra round or a split verdict]
    CV --> S
    CONV -->|rounds done| S[council synthesize, dispatch clean council-synthesizer]
    ESC -->|extra round| RS
    ESC -->|split verdict| S
    S --> X[Optional: Excalidraw decision board, soft-skip if pack absent]
    X --> F[council complete, show Verdict, promote y/n/later]
    F --> L[council live clear]
```

## Phase 1: create the debate

```
dreamcontext council create "<topic>" --rounds <N> [--interrupt] [--options "A=Keep sync,B=Drop it"]
```

Capture the returned `debate_id` (printed on its own last line). Pass `--options`
when the user named options in Phase 0; stances then must match an option key. With
no `--options`, stances are free-form and first-seen stances become dynamic options.

## Phase 2: generate personas (3-10, per depth)

Generate personas **specific to this topic**. No preset library. Each persona has:
- A **slug** (kebab-case): `migration-risk-auditor`, `growth-cfo`, `user-advocate`
- A **model**: `opus` for strategy-heavy roles, `sonnet` for most, `haiku` for
  narrow advocates. Vary them; cognitive diversity matters.
- 2-5 **aspects**: `[data-integrity, downtime, rollback]`
- A **body** (100-250 words): who they are, what they obsess over, what biases they
  bring, what would make them push back.

For each persona:
```
echo "<body>" | dreamcontext council agent create <debate_id> <slug> \
  --model <model> --aspects "<aspect1,aspect2,aspect3>"
```

Show the roster to the user and let them adjust before round 1 (skip the pause in
autonomous mode).

## Phase 3: run each round

```
dreamcontext council round start <debate_id> <N>
```

For N ≥ 2 this injects prior-round peer summaries into each persona's context.

**Dispatch all personas in parallel** (round 1: spawn; round N ≥ 2: resume; see
mechanics above). Every persona MUST, per its contract:
1. First call: `dreamcontext council round-context <id> <slug>` (now includes the
   verdict landscape, injected facts, and its pending directives).
2. Submit its verdict **before** its report:
   `dreamcontext council verdict <id> <slug> <round> --stance <s> --conviction <n> --headline "<h>" [--concession "<c>"]`
3. Last call: `dreamcontext council report append <id> <slug>`.

After all personas return:
```
dreamcontext council round end <debate_id> <N>
dreamcontext council summaries <debate_id> <N>
dreamcontext council board <debate_id>
```

**Show the `council board` output to the user every round.** It is the chamber's
scoreboard: per-persona stance, conviction bars, shift markers, convergence meter.
`summaries` now appends each persona's stance and conviction line; read it, never
the full reports.

## Interludes (the interactive layer)

When interludes are on and a user is present, offer these **intervention cards**
after each non-final round, as a numbered pick list:

| # | Card | What you run |
|---|---|---|
| 1 | **Inject fact** | `dreamcontext council inject <id> <fact...>` appends it to Constraints & Known Facts; personas see it next round |
| 2 | **Cross-examine** | `dreamcontext council question <id> <slug> <question...>` queues a directive; the persona must answer in `### Cross-examination` next round |
| 3 | **Steelman swap** | a `council question` directive ordering the persona to argue the OPPOSING stance for one round, then return to honest conviction |
| 4 | **Wildcard persona** | `council agent create` a new persona mid-debate, spawn it fresh next round |
| 5 | **Call the vote** | skip remaining rounds, go straight to synthesis |
| 6 | **Continue** | no intervention, next round |

Multiple cards can stack in one interlude (e.g. inject a fact AND cross-examine).
With interludes off, go straight to the next round.

## Convergence rules (how the debate ends)

- The debate ends when **the planned rounds are done**, OR
- **Convergence ≥ 90% two rounds in a row**: early consensus, offer **Call the
  vote** rather than grinding out remaining rounds, OR
- **The user calls the vote** at any interlude.
- **Escalate instead of forcing a verdict** when convergence is **< 40% after the
  planned rounds**: tell the user the chamber is genuinely split and offer either
  one extra round or a split verdict (the synthesizer records both positions with
  revisit conditions). Never paper over a split with fake confidence.

## Phase 4: synthesize

```
dreamcontext council synthesize <debate_id>
```

This prints the manifest of files the synthesizer must read. Dispatch the
`council-synthesizer` **Agent-tool subagent** (single call, model: opus, clean
context) with the manifest. It also reads `verdicts.json` and runs
`dreamcontext council timeline <debate_id>` itself; do not paste reports into its
prompt.

The synthesizer writes `_dream_context/council/<debate_id>/final-report.md` with
the v2 section order: Verdict, Decision card, Why, Position timeline, What was
debated, Minority view & revisit conditions, Open risks, Appendix.

### Optional: Excalidraw decision board

If the excalidraw skill/pack is available in this session, generate
`_dream_context/council/<debate_id>/decision-board.excalidraw.md` from
`dreamcontext council timeline <debate_id> --json`: a verdict KPI tile, a
per-persona conviction line chart across rounds, the decision-card table, and a
minority panel. **Soft-skip silently when the pack is absent**; the debate is
complete without it.

## Phase 5: complete + promote

```
dreamcontext council complete <debate_id>
```

Show the user the `## Verdict` section (read just that section) and the report
location. Ask:

> "Promote this decision to knowledge? (y / n / later)"

- **y** → `dreamcontext council promote <debate_id>` (writes
  `_dream_context/knowledge/decision-<slug>.md`, trimmed to Verdict, Decision card,
  Why, Minority view & revisit conditions, Open risks)
- **n / later** → leave as-is. The next sleep consolidation picks it up
  (`dreamcontext council list --unpromoted`) and decides from engagement signals.

Then clean up the live surface:
```
dreamcontext council live clear
```

## Live surfaces

The CLI writes `_dream_context/tmp/.council-live.json` **automatically** on every
state-changing command (create, verdicts, round start/end, inject, synthesize,
complete). Your only live-state duties:

1. **Show `council board` output to the user each round** (the terminal surface).
2. **Run `dreamcontext council live clear` after the final report** (or after an
   abandoned debate).

The dreamcontext app renders a live chamber panel automatically from the same file —
above the composer in Terminal view, on the live rail in Chat view: round dots, persona
stance dots, convergence meter, click for the full chamber view. **There is no browser
viewer to start**; do not launch one.
Live-file writes are telemetry, never a gate: a failed write never blocks a round.
`dreamcontext council demo-live` fakes a live state to preview the panel.

## Red Flags: STOP, you're about to break the chamber

| Thought | Reality |
|---|---|
| "I'll read one full report, just to be sure." | You never read full reports. Board, summaries, timeline. That's it. |
| "I'll add my own take as a seventh voice." | You never debate. Your opinions belong nowhere in the record; add a persona if a lens is missing. |
| "The verdicts are obvious, I'll skip the board." | The board is shown to the user every round. It is the product surface of the debate. |
| "I'll synthesize myself, dispatching is overhead." | The synthesizer is always a clean Agent-tool subagent. You have been staring at summaries for N rounds; you are anchored. |
| "This persona went quiet, I'll write its verdict for it." | Never fabricate a verdict. Resume it, re-fork once, or let `round end` record it missing. |
| "Convergence is 95%, but the plan says 3 rounds, so 3 rounds." | Two rounds at ≥ 90% means offer Call the vote. Grinding a settled debate wastes tokens. |
| "Convergence is 30% but I'll force a confident verdict anyway." | Below 40% after planned rounds you escalate: extra round or split verdict. Fake confidence is worse than a recorded split. |
| "I'll resume the synthesizer from a persona session, it has context." | Never. Inherited framing produces a rubber stamp, not a judgment. |
| "Interludes slow things down, I'll skip offering them." | If the user turned interludes on, the cards are offered every non-final round. |
| "The live file write failed, abort the round." | Live state is telemetry. Swallow it and continue. |

## Rationalization table

| If you think... | The truth is... | So... |
|---|---|---|
| "Personas will converge anyway, why spawn sessions?" | Sessions give personas memory: round 3 reactions to round 1 claims are what make a debate compound. | Spawn once, resume with deltas. |
| "Asking the user about options up front is friction." | Registered options make verdicts comparable and the board readable. | One batched Phase 0 ask, then hands-off. |
| "A repeating persona just has strong convictions." | Verbatim repetition is disengagement, not conviction. | One fresh re-fork with what it must react to. |
| "The minority view lost, it barely needs a mention." | The minority view plus observable revisit conditions is half the report's long-term value. | Make sure the synthesizer states when the minority becomes right. |
| "Skipping `council verdict` saves the persona a call." | Without verdicts there is no board, no timeline, no convergence signal. | Verdict before report, every persona, every round. |

## Hard rules

- **You never debate yourself.** No orchestrator opinions in reports, constraints,
  or synthesis. Missing lens → add a persona.
- **You never read full persona reports.** Only `council summaries`,
  `council board`, `council timeline`, and the `## Verdict` section of the final
  report. Per-debate orchestrator budget stays under ~20K tokens; if it doesn't,
  you are reading full reports somewhere. Stop.
- **Personas are CLI sessions** (spawn round 1, resume with deltas, one re-fork on
  disengagement, parallel via background Bash). **The synthesizer is always a
  clean Agent-tool subagent**, never forked, never resumed. Fallback: Agent-tool
  personas when CLI spawn is unavailable.
- **You are the single writer of `debate.md`** (session registry included).
  Personas touch only their own `<slug>/` folder.
- **Every persona submits `council verdict` before `report append`**, every round.
- **Show `council board` to the user every round.** Run `council live clear` after
  the final report. No browser viewer exists for council; never launch one.
- **Do not skip Phase 0.** One batched ask; autonomous fallback is Standard, open
  options, interludes off, defaults recorded.
- **Persona slugs are unique per debate.**
- **Irreversible decisions force Deep depth.**

## Relationship to other orchestration surfaces

| Surface | Stage | Relationship |
|---|---|---|
| `council` (this) | Decide between options | Owns the debate → verdict lifecycle; produces a decision, not code. |
| `goal-skill` | End-to-end build of a goal | Use *after* council when the decision needs building; council's promoted decision becomes goal-skill's input. |
| `multi-review` | Post-implementation review | Reviews a diff, not a decision. A council may cite review findings as injected facts. |
| `council-synthesizer` agent | Final judgment gate | The only reader of full reports; always clean. |

## Slash command wiring

`/council` invokes this skill. Natural-language triggers in **When to invoke** also
load it. `debate-protocol.md` (sub-skill) holds the exact command table, failure
modes, and file layout; load it when you need the precise sequence.
