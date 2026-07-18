---
id: fork-resume-builder-sessions
name: "Fork/Resume Builder Sessions (CLI session lifecycle for goal-skill v2)"
description: "CLI session mechanics for goal-skill v2's builder lane: claude -p --output-format json mints a session with a session_id; claude -p --resume <id> continues that session at cache-read price (~10 new input tokens per delta); claude -p --resume <id> --fork-session mints a NEW session that inherits the full parent context while the parent stays independently resumable. The fork base must be a CLI-resumable builder session (e.g. the goal-planner), never the orchestrator's own Claude Code chat, which cannot be resumed via the CLI. Builders (planner, implementers) use this lifecycle; judges (plan-reviewers, code reviewer, validator) never fork or resume — they stay clean and fresh every round. Provenance: requested by the user post-board, as a 'learn while building it' instruction, not itself a board item."
tags: ["architecture", "topic:agents", "sdd"]
pinned: false
date: "2026-07-18"
---

> **Provenance note:** this file is not one of the items on the `goal-skill-v2` design board (`_dream_context/inbox/goal-skill-v2/goal-skill-v2.board.cjs`). It exists because the user explicitly asked to "learn while building it" — capture the fork/resume mechanics as first-class knowledge while the v2 rewrite is underway, rather than let the finding live only inside the plan/task doc. Orchestrator ruling: keep it as a standalone pattern file so it outlives this one task.

## Why This Exists

Goal-skill v1 dispatches every sub-agent fresh: the planner, the implementer, and each retry round all start blind and re-explore the repo at full token price. For a single-round goal this is wasteful but tolerable; for a plan-review loop that iterates 2–3 times, or an implementer that gets sent back after a review FAIL, it means paying full exploration cost again on every round — the dominant cost in v1's ~1.5h-per-goal wall-clock.

The fix is not "give the sub-agent more context in the prompt" (that's the orchestrator paying to re-describe what a session already knows) — it's giving the **builder its own resumable CLI session** so later rounds pay only the delta.

## The Proven Mechanics

Verified live on 2026-07-17 with a minimal codeword probe (see **Evidence** below), not just read from CLI docs:

1. **Spawn.** `claude -p "<prompt>" --output-format json < /dev/null` mints a new session and returns a JSON payload containing `session_id`. The `< /dev/null` redirect matters: `claude -p` is a non-interactive one-shot invocation, and without an explicit empty stdin it can hang waiting for input when spawned from a script/subagent context rather than a terminal.
2. **Resume.** `claude -p "<follow-up>" --resume <session_id> --output-format json` continues the same session. The prior turns are served from cache — the probe's resume round to session `d68255f2` cost roughly **10 new input tokens** for the delta prompt, with the entire prior context served at cache-read price rather than re-sent at full price. This is what makes a plan-review loop cheap: round 2 of the planner doesn't re-read the codebase, it just receives the reviewers' findings as the delta.
3. **Fork.** `claude -p "<prompt>" --resume <plannerSessionId> --fork-session --output-format json` mints a **brand-new** session id that inherits the full parent context, while the parent session remains independently resumable afterward. This is the mechanism goal-skill v2 uses to turn one planner session into N implementer sessions — each implementer starts with everything the planner knew (the plan, the codebase reads, the dependency map) without re-paying for any of it, and the planner session itself is untouched and still resumable if a later plan-review round needs it.

## The Fork-Base Rule

**The fork base must be a CLI-resumable builder session — the goal-planner's `claude -p` session — never the orchestrator's own Claude Code chat.** The orchestrator's conversation (the Claude Code session running goal-skill itself) is not a `claude -p` session with a capturable `session_id` in the same sense; it cannot be resumed or forked via the CLI. This was proven, not assumed: attempting to treat the orchestrator chat as a fork base has no CLI handle to fork from. Concretely: the orchestrator spawns the planner via `claude -p`, captures *that* session's id, and forks implementers from *it* — the orchestrator chat only ever holds the id, it is never the fork origin.

Corollary: keep the planner's base session lean. Messy, exploratory reads that don't need to survive into the plan should happen in throwaway `Explore`-style agents dispatched *before* the planner does its final grounding pass — a fat base session taxes every fork that inherits it.

## Builders Fork, Judges Never Fork

This mechanic is deliberately **one-sided**. Builders (`goal-planner`, `goal-implementer` ×N) are CLI sessions that fork and resume, because their job benefits from continuity — the implementer should build on exactly what the planner already established. Judges (`goal-plan-reviewer`, the code `reviewer`, `goal-validator`) are Claude Code Agent-tool subagents, dispatched **clean and fresh every round**, and are never forked or resumed from a builder session or from each other.

The reason is independence, not convenience: a judge that inherited the builder's framing would anchor on it and rubber-stamp rather than genuinely evaluate. A plan reviewer forked from the planner session has already been talked into the planner's own reasoning before it reads a single blocking finding. Judges meet the work only through the artifact — the plan text or the diff — never through inherited conversation state. This is why the task doc (not a shared session) is the only channel between the builder lane and the judge lane.

## Session Registry

Because builder sessions are resumable, their ids are worth persisting past the current orchestrator run. `goal-skill` v2's task doc carries a session registry recording the planner's id, any re-fork id (if plan-review convergence required a fresh re-fork), and one id per implementer (each forked from the planner). Any later session — even a different orchestrator run, days later — can `--resume` a recorded builder id and continue exactly where that builder left off, without re-establishing context. See `goal-skill`'s SKILL.md for the literal registry block format.

## Evidence

Two real probe sessions, captured as session digests under `_dream_context/state/.session-digests/`:

- **`d68255f2-eac4-4a16-9724-74dc938f0975`** — base session. Given `Remember this codeword: ZURNA-42. Reply with exactly: OK`, replied `OK`.
- **`f3657df6-2088-4b62-8784-32a4077ea3dd`** — forked from `d68255f2` via `--resume d68255f2 --fork-session`. Without being told the codeword again, asked `What is the codeword?` twice and correctly answered `ZURNA-42` both times — proving the fork inherited the parent's full context rather than starting blind.

The resume round on `d68255f2` (asking a follow-up without forking) cost approximately 10 new input tokens for the delta, with the rest of the context served at cache-read price — confirming the "resume pays only the delta" economics this pattern depends on.

## Related

- [[goal-skill]] — the orchestration skill that consumes this pattern for its Phase 1 (plan) and Phase 4 (implement) builder lanes, and defines the literal session-registry block persisted in the task doc.
- [[multi-reviewer-pattern]] — the sibling pattern for the judge lane: router + clean, fresh, skill-aware specialist subagents. Where this pattern is about builder session *continuity*, that pattern is about judge *independence*; goal-skill v2 combines both, one per lane.

## Last Verified

2026-07-18.
