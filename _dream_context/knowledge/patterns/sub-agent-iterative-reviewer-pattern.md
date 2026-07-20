---
id: sub-agent-iterative-reviewer-pattern
name: "Sub-Agent with Iterative Reviewer Pattern"
description: "Pattern for orchestrating parallel sub-agent workstreams with a holistic reviewer sub-agent doing final sign-off. Used in v0.4 multi-workstream session to catch cross-domain regressions and scope creep."
tags: ["architecture", "decisions"]
pinned: false
date: "2026-07-20"
---

## Why This Exists

The v0.4 session ran three parallel workstreams (WS-1 manifest install, WS-2 sleep specialist fixes, WS-4 dashboard). Coordinating these as direct work in a single agent context led to attention fragmentation. The pattern that succeeded: spawn focused sub-agents per workstream, then run a holistic reviewer sub-agent at the end that reads all outputs and gives a final pass/fail with blocking vs non-blocking notes.

This is worth capturing because it applies to any session with 2+ large parallel workstreams and serves as a blueprint for future multi-workstream orchestration.

## The Pattern

**Structure:**
1. Main agent decomposes work into N non-overlapping workstreams (each workstream has a clear file-domain boundary).
2. Dispatch N specialized sub-agents in parallel (one per workstream). Each sub-agent:
   - Receives a focused brief with only the context relevant to its domain.
   - Writes to its own file partition — no cross-domain writes.
   - Returns a short structured report.
3. Main agent collects all reports.
4. Dispatch a single **holistic reviewer sub-agent** with all N reports + the full diff (`git diff --stat`).
   - Reviewer's job: verify cross-workstream consistency, flag regressions, classify non-blocking scope creep.
   - Returns PASS / FAIL / CONDITIONAL-PASS with blocking items and non-blocking notes.
5. Main agent acts on reviewer output: fix blockers before committing, note non-blockers in changelog.

**Why a reviewer, not just the main agent?**
The main agent accumulates context from all workstreams and starts to lose judgment at the boundary of its context window. A fresh reviewer sub-agent has zero prior context — it evaluates the diff cleanly. The reviewer found the WS-4 scope creep (Linear Midnight overhaul) in v0.4 that would have been missed in a tired main-agent pass.

## Key Decisions from v0.4

- Reviewer classified the WS-4 dashboard design-system overhaul as "additive + non-breaking" (confirmed: old `--glass-*` and `--color-brand-*` variables preserved, no selectors deleted). This cleared a potential regression flag.
- Reviewer flagged `font-weight: 510/590` as requiring Inter variable font — logged as a non-blocking note in the PRD rather than a blocker.
- Scope creep detected at review time (not during work): the reviewer role is the safety net for work that expands beyond the original brief.

## When to Use

Apply this pattern when:
- A session has ≥2 workstreams that touch different file domains.
- Individual workstreams are large enough to saturate a sub-agent context (>50 tool uses expected).
- Cross-workstream regressions are a real risk (e.g., shared types, shared config files).

Skip when:
- Work is a single coherent workstream (reviewer adds no value over a self-review pass).
- Workstreams share file domains (parallel writes cause conflicts; serialize instead).

## Relationship to other review patterns

- **vs `multi-review` skill** (2026-05-24): the `/multi-review` skill is the productized, post-implementation evolution of this pattern. It adds a **router** (classifies tier + picks specialists by domain) and a **niche-specialist roster** (security / cloud-functions / frontend / edge-cases) instead of one holistic reviewer. Use `/multi-review` for any non-trivial diff that crosses domains; this pattern survives for in-session multi-workstream orchestration where the work itself is sub-agent-driven.
- **vs `three-reviewer-parallel-mandates-pattern`**: that pattern is pre-implementation (critic/pragmatist/security against a draft plan). This and `/multi-review` are post-implementation.

## Sources

- v0.4 session (2026-05-22): session IDs `2d3b13d1-1faa-4ee8-a879-9573c632c719`, `bdb5cee6-b531-4986-b775-cc753c6f43cc`.
- Reviewer finding captured in `last_assistant_message` of session `2d3b13d1`.

## Last Verified

2026-07-20 — pattern still valid; `/multi-review` (productized evolution) remains distinct from this in-session multi-workstream orchestration pattern.
