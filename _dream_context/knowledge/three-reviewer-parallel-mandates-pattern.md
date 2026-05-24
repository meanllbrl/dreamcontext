---
id: three-reviewer-parallel-mandates-pattern
name: "Three-reviewer parallel-mandates pattern"
description: "Pre-implementation adversarial review using 3 parallel reviewer sub-agents with DIFFERENT mandates (critic / pragmatist / security). They converge on the same fundamentals from different angles, producing a much stronger reject/accept signal than any single review. Distinct from the post-implementation iterative-reviewer pattern."
tags: ["architecture", "decisions", "agents"]
pinned: false
date: "2026-05-23"
---

## Why This Exists

Single-reviewer agent review of a non-trivial plan has a known failure mode: the reviewer's mandate biases what they see. A "find bugs" reviewer misses scope issues; a "cut scope" reviewer misses security issues; a "find security issues" reviewer misses architectural premise issues. Stacking these as sequential rounds works but is slow.

The pattern that worked: dispatch 3 reviewers IN PARALLEL with explicitly DIFFERENT mandates. They each find issues their mandate biases them to find. When they converge on the same fundamental issue from different angles, that issue is load-bearing. When they diverge, the divergence itself reveals tradeoffs.

This is **pre-implementation**: the goal is to decide "should we build this at all, and if so what scope?" — distinct from the post-implementation `sub-agent-iterative-reviewer-pattern` (holistic final review across parallel workstreams).

## The Pattern

**Structure (parallel, single round):**

1. Edge case agent enumerates failure modes (50-150 ECs).
2. Planning agent drafts a comprehensive plan with explicit decisions, tasks, risk register.
3. Three reviewer sub-agents dispatched in parallel, each with a DIFFERENT mandate:

| Reviewer | Mandate | Will flag |
|---|---|---|
| **critic** | Find unsupported claims, hidden assumptions, inconsistencies, missed edge cases, premise weaknesses. Output verdict: PASS / PASS WITH CONCERNS / FAIL. | Architectural premise issues, untested numbers, contradiction between sections, missed edge cases, the "is this even the right tool" question. |
| **pragmatist** | Ruthlessly cut scope. Identify what should be deferred. Recommend MVP boundaries. Estimate days-to-ship. Output recommended v1 in/out list. | Overscoped MVP, premature optimization, "we'll see in v2" for blockers, anti-patterns like "comprehensive before working", build-vs-buy mistakes. |
| **security** | Find data loss scenarios, secret leakage, corruption, concurrency hazards. Output verdict: SAFE / NEEDS HARDENING / UNSAFE. | Redaction order bugs, embedding/encryption oversights, race conditions, exfil paths, missing consent UX, audit log integrity, recovery flow gaps. |

4. Main agent collects all 3 reports. CONVERGENCE = strong signal. DIVERGENCE = explicit tradeoff for the user to decide.

5. User makes the call. If all three converge on REJECT, the plan dies. If they converge on accept-with-changes, the changes get folded into v1 scope.

## Why this works

- **Different mandates surface different categories of issues.** Critic sees premise problems; pragmatist sees scope problems; security sees safety problems. None of these are interchangeable.
- **Parallel dispatch is cheap and fast.** 3 sub-agents in parallel cost roughly the same as 1 sub-agent's time, not 3×.
- **Convergence is the gold signal.** When critic says "premise wrong", pragmatist says "scope too big", security says "5 critical blockers" — and they all point at the same architectural choices — the signal is undeniable. A single reviewer can be argued with; three independent reviewers cannot.
- **It's a forcing function for the user.** "All three reviewers said no" creates a clear decision point that's harder to wave away than "the reviewer raised concerns".

## When to use it

- Non-trivial architectural decisions where the cost of being wrong is high (new dependencies, new runtime requirements, new storage layers, new agent topology, new release cadence).
- Any plan where you find yourself defending the premise more than the execution. If the plan needs defending, the premise needs reviewing.
- Plans with measurable claims that haven't been measured ("X is fast", "Y is small", "Z is reliable"). The critic mandate forces this to surface.

## When NOT to use it

- Trivial decisions or pure execution work. Three reviewers reviewing "rename this function" is theatre.
- Time-sensitive emergencies. The pattern adds ~30 minutes of wall-clock to a decision.
- When you already have a strong external constraint (e.g., "we must ship by Friday for the demo"). The pattern's value is in deciding scope; if scope is fixed, you don't need it.

## Case study: mem0 vs BM25 (2026-05-23)

The original goal was to integrate mem0 (vector store + LLM-extracted facts) into dreamcontext.

- Critic verdict: **FAIL** — premise not steel-manned (BM25 alternative not compared), latency/footprint claims unsupported, Python+Ollama cliff downplayed, sleep-finalizer reverses 5→3 collapse, determinism tier leakage contradiction.
- Pragmatist verdict: **OVERSCOPED** — cut 65-70% (26 tasks → 8). Explicit endorsement of BM25 alternative ("Just use grep" section: "BM25 keyword search may be a stronger move than mem0 for v0.5").
- Security verdict: **NEEDS HARDENING** — 5 critical blockers (redaction order, embedding inversion, rebase data loss, crash recovery, OpenAI exfil-by-config).

Convergence on 5 fundamental issue categories. User chose the BM25 alternative (Path A) on the strength of this convergence. Decision documented in `decision-mem0-vs-bm25-recall.md`.

This was the first use of the pattern and it worked exactly as designed: three reviewers, three different angles, same conclusion.

## Relationship to other review patterns

- **vs `sub-agent-iterative-reviewer-pattern`** (existing): that pattern is POST-implementation, ONE holistic reviewer reading parallel workstream outputs for cross-domain regressions. This pattern is PRE-implementation, THREE parallel reviewers with different mandates. Both are useful; they apply at different stages.
- **vs `/multi-review` skill** (2026-05-24): the `/multi-review` skill is POST-implementation, router-dispatched **niche specialists** (security / cloud-functions / frontend / edge-cases) with a coordinator that dedupes. This pattern is PRE-implementation, **mandate-diverse generalists** (critic / pragmatist / security) attacking a plan. The two are complementary: this one decides whether to build; `/multi-review` reviews what was built.
- **vs council debates** (`/council` skill): council is for decisions WITHOUT a draft plan — N personas debating across rounds. This pattern is for decisions WITH a draft plan — N reviewers attacking the plan with different mandates. If you don't have a plan yet, run council. If you have a plan and want to know whether to ship it, run this pattern.

## Sources

- Case study session: 2026-05-23 mem0 vs BM25 decision.
- Persisted artifacts: `_dream_context/knowledge/decision-mem0-vs-bm25-recall.md`, `_dream_context/core/features/memory-recall-bm25.md`.
- Reviewer-report artifacts were session-scoped to `/tmp/` and may not persist.

## Last verified

2026-05-23.
