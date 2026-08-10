---
id: knowledge_wave_by_wave_rollout
name: wave-by-wave-rollout
description: >-
  When landing a large, cross-cutting change: partition the work into sequential
  waves where each wave lands contract+behavior-neutral FIRST (the new shape
  compiles and tests green, but acts byte-for-byte like the old one), then the
  NEXT wave flips behavior once the contract is proven stable. Measured gates
  between waves (tsc + tests + explicit red-line checks) catch breaking changes
  early when blast radius is still narrow, and a late-wave failure rolls back to
  a known-good state without tearing out foundational waves.
type: knowledge
tags:
  - kind:pattern
  - architecture
  - topic:build
pinned: false
created: '2026-08-10'
---

# wave-by-wave-rollout

## Why this exists

Large architectural changes that touch 50+ files across multiple subsystems fail late and expensively when implemented as one atomic diff. A late-breaking defect 3 days into implementation forces either (a) tearing out foundational changes to isolate the bug, or (b) shipping the defect because unwinding is too costly. Wave-by-wave rollout partitions the work into sequential phases where each wave lands its contract + scaffolding FIRST (compiles green, tests green, acts byte-identical to the old code), then the NEXT wave flips behavior once the contract is proven stable. Measured gates between waves catch breaking changes early when blast radius is narrow, and a failure rolls back to a known-good checkpoint without losing the whole build.

## The pattern

1. **Partition into waves** — each wave is a semantically complete contract change (e.g., "introduce ApiClient class + useApi hook", "migrate 28 hooks off the singleton api") with a clear behavioral boundary. Waves run sequentially; no wave starts until the previous one passes its gate.

2. **Contract-first, behavior-next** — Wave N lands the new shape (types, function signatures, scaffolding) in a way that compiles and tests green but acts BYTE-FOR-BYTE like the old code (e.g., the new `ApiClient` class wraps the old singleton `api`, so every call site still hits the same code path). Wave N+1 flips behavior (e.g., per-instance `ApiClient` instead of singleton).

3. **Measured gates** — after each wave, run the full gate on a quiet machine: `tsc --noEmit` (both root and dashboard if applicable), `npm test`, and explicit red-line checks (e.g., `grep -rn 'forbiddenPattern'` returns zero). The gate MUST pass before the next wave starts. A failure is caught with N files changed, not 150.

4. **Wave-completion evidence** — each wave logs its completion (commit SHA or session ID) and its gate result (automated checks + any manual verification). The orchestrator or review panel knows which waves are done and which are still risky.

5. **Rollback-safe** — if Wave 4 fails its gate, the work rolls back to Wave 3's known-good state (revert Wave 4's changes only), diagnose, fix, and retry. The foundation (Waves 1-3) stays intact.

## When to use it

- Changes touching ≥50 files across ≥3 subsystems
- Architectural refactors where the contract change and the behavior change are separable
- Multi-reviewer builds where early waves need sign-off before later waves proceed
- Any change where "ship it all or revert it all" is unacceptable risk

## When NOT to use it

- Small, focused changes (≤10 files, one subsystem) — the overhead exceeds the benefit
- Behavior-only changes where the contract is already stable (e.g., fixing a calculation bug)
- Throwaway prototypes or spikes — the rigor is wasted on exploratory work

## Two occurrences (qualifying this as a pattern)

### Occurrence 1: automations HITL architecture (2026-08-04, 5 waves)

Task `automations-hitl-a-run-can-stop-and-ask-and-the-verdict-comes-back-from-wherever-you-are`. Final diff: +5021/-123 lines across 32 files.

- **Wave 1** (contract root): review predicates, card-registry, approval hash grew to EIGHT fields including `review: ReviewMode`, `RUN_STATUSES` gained `awaiting-review`, types extended — but `review` reads leniently toward `off` and `off` is byte-for-byte pre-feature behavior. Zero behavior change. Gate: tsc + tests green.
- **Wave 2** (propose verb): `propose` verb with sidecar-guarded process-group probe, three resume preambles, `resumeWithVerdict` spawn, steer→learn distillation. Gate: same.
- **Wave 3** (runner serial gate): `awaiting-review` refusal, `backfillCardSession`, `kind: 'output'` staging, tick/show/snapshot reporting. Gate: same.
- **Wave 4** (Telegram adapter): machine-local `~/.dreamcontext/telegram.json`, long-poll `getUpdates`, inline-keyboard verdicts. Gate: same.
- **Wave 5** (UI surfaces): dashboard review queue, card UI, run-chat steering, clickable notification, CLI verbs. Gate: same + multi-reviewer panel (caught a Critical serialization bug before merge).

### Occurrence 2: project-tabs (2026-08-09, 4 waves = 8 sub-waves)

Task `one-window-holds-every-open-project-as-a-live-chip-strip`. 20 tasks partitioned into 4 waves with max 3 concurrent per wave, mechanically audited for zero file collisions.

- **Wave 1 (Faz 0)**: contracts, `scopedStorage`, `ApiClient` class, `VaultContext`, tests. Behavior-neutral — the new `ApiClient` wraps the old singleton `api`. Gate: dashboard tsc CLEAN, `npm test` green, `grep 'getActiveVault'` returns only `api/client.ts`.
- **Wave 2 (Faz 1)**: instance shell, `ProjectInstance`, `WindowChrome`, `ProjectTabs`, xterm re-drive + unmount teardown. Still one chip, but the infrastructure is live. Gate: dashboard tsc CLEAN, `npm run build` exit 0, red-line check (`grep 'isActive'` in agentSession/chatSession returns ZERO).
- **Wave 3 (Faz 2)**: global collisions — Shell, localStorage scoping, permission split, window registry. The riskiest wave, gated hardest.
- **Wave 4 (Faz 3)**: badge + window bridge, rollup sink, duplicate-open guard.

Each wave had its own gate (A1-A9 acceptance criteria), and the orchestrator measured them on a quiet machine rather than trusting implementer reports.

**Lessons from the full run (Waves 2-4, 2026-08-09 → 2026-08-10):**
- **Ownership gaps repeat.** The dependency map derived file ownership from IMPORT graphs, missing CALL SITES. Five instances of the same gap: T11's event producers had six call sites (BrainSyncControl, SystemDependencies, DelegateComposer, authorTaskAgent, AuthorTaskComposer, AutomationDetailPanel) not in T11's lane. Each required a resume when the orchestrator caught the typecheck failure. **Lesson:** derive ownership from the full call tree, not just imports. When changing a signature, `grep -rn` for the function name and claim every call site.
- **Parallel implementers won't cross territories, even for repo-wide errors.** T15 found T11/T12 typecheck errors mid-work and correctly STOPPED rather than editing files outside its lane. This kept the single-writer discipline but meant errors accumulated until wave-gate measurement. **Lesson:** the orchestrator MUST run the gate after each batch within a wave, not only at wave boundaries.
- **Resume is cheaper than re-fork.** Five resume passes (T11r, T12r, T18r, T19r, T20r) each took <10 minutes and closed gaps the orchestrator found. Re-forking from scratch would have re-explained the entire plan. **Lesson:** when a task stops on an ownership gap, extend its lane in the map and resume it with the delta, not a full re-brief.
- **A number computed for display must never be reused as a safety predicate.** M9 (CRITICAL): `ProjectRollup.live` excluded shells because it's the chat badge count, but the eviction test read `rollup.live === 0` — so a project with only a running shell (dev server) reported `live:0`, was evicted, and had its PTY killed mid-process. Fixed by adding `ProjectRollup.alive` (any live PTY/WebSocket, shells included) as the sole eviction gate. **Lesson:** display rules drift as UX evolves (e.g., "don't count shells in the badge"); safety predicates must be independent and named for their actual gate (aliveness, not liveness).

## Related patterns

- **feature-integration-pattern** — what to do AFTER a feature lands (wire it into all nine surfaces)
- **byte-surgical-section-editing** — the same "preserve everything you're not changing" discipline, applied to file edits instead of build phases
