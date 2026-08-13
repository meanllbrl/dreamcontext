# Baseline — branch feat/project-tabs @ 8b4eed4, BEFORE any implementer wrote

Established 2026-08-09, so a wave-gate failure is attributable to implementers rather than
to pre-existing breakage.

| check | result |
|---|---|
| `npx tsc --noEmit` (root) | CLEAN — zero diagnostics |
| `cd dashboard && npx tsc --noEmit` | CLEAN — zero diagnostics |
| `npm test` (full suite) | 380 passed / 1 failed / 2 skipped — see below |

## The one failure is a known CONTENTION FLAKE, not a regression

The full-suite run failed with `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`
inside `tests/integration/sleep.test.ts`. That is verbatim the failure mode the repo's own
`vitest.config.ts` header describes and switched the `forks` pool to mitigate: CPU-bound
files starve the worker→main reporter RPC and the run fails even though every test passed.

It fired here because THREE plan-review agents were saturating the machine during the run.

Re-run evidence for `tests/integration/sleep.test.ts` in isolation:
- run 1 — 1 failed / 29 passed (a DIFFERENT test than the full-suite one: `sleep status
  shows sessions after adds`, not `sleep start --json carries automationOutputs`)
- run 2 — passed
- run 3 — **30 passed / 30, exit 0**

A different test failing each time, and a clean pass once the machine is quiet, is load
sensitivity — not a broken assertion.

## OPERATIONAL RULE for every wave gate (binding)

**Never run `npm test` while implementer forks are still running.** Wait for the wave's
forks to exit, then run the suite on a quiet machine. If A3 still fails, re-run the failing
FILE in isolation up to 3×: passing in isolation while failing only under parallel load is
this documented flake and is reported as such, with the evidence, rather than silently
waved through. Anything that fails in isolation is a real FAIL.

---

# CONCURRENCY HAZARD — a second goal-skill run shares this working tree

Discovered mid-Wave-1. Another goal-skill run (the `automations` goal) is writing into the
SAME checkout and the SAME branch (`feat/project-tabs`) at the same time as this one. Its
files appeared in `git status` alongside T18's:

  M  src/lib/automations/types.ts
  ?? src/lib/automations/queue.ts
  ?? src/lib/automations/session-registry.ts
  ?? tests/unit/automations-queue.test.ts
  ?? tests/unit/automations-session-registry.test.ts

## The two runs are FILE-DISJOINT — verified, not assumed

| | this run (project-tabs) | the other run (automations) |
|---|---|---|
| owns | `dashboard/src/**`, 2 files in `tests/unit/`, `_dream_context/workspace/project-tabs/**` | `src/lib/automations/**`, `tests/unit/automations-*.test.ts` |

Checked mechanically: the dependency map's `files owned` cells contain **zero** `src/` paths
(the single `src/server/index.ts:659` occurrence in the plan is a citation inside finding S3,
not an owned file). So neither run can overwrite the other's work.

## What this DOES break: gate attribution

`tsconfig.json` at the root has `"include": ["src"]` — this run's code is not in its scope at
all. Therefore:

| gate | attribution rule while the other run is live |
|---|---|
| **A2 `cd dashboard && npx tsc --noEmit`** | **THE REAL TYPECHECK GATE for this run.** Covers `dashboard/src/**` and nothing else. Must be clean. Any failure is ours. |
| A1 `npx tsc --noEmit` (root) | Covers `src/` ONLY — which this run never touches. A failure here is the other run's, always. Still run it, but it can neither pass nor fail on our account. |
| A3 `npm test` | Shared. A failure in `tests/*automations*` or originating in `src/lib/automations/**` is the other run's. Anything else is ours. Re-check any ambiguous failure with `git stash` on a clean tree before calling it. |

## Consequence for Phase 5 (code review)

The reviewer must NOT be pointed at a bare `git diff` against the base ref — that would sweep
in the other run's work and produce findings against code this goal never wrote. Scope it to
`dashboard/src`, `tests/unit/scoped-storage.test.ts` and
`tests/unit/agent-status-project-rollup.test.ts`.

## Consequence for Phase 6 (validation)

A1 and A3 as written in the task's acceptance criteria assume a quiet tree. The validator gets
this attribution table with the criteria, and reports "PASS with the other run's failures
enumerated and shown to be outside our owned paths" rather than a bare PASS — or a real FAIL
if any failure lands inside them.


---

# WAVE-2 EMPIRICAL GATE — DEFERRED TO PHASE 6 (a stated, bounded risk)

The plan's Wave-2 gate had two empirical items, M-x1 (the xterm is correctly sized after
switching away and back, five times, and `ensureOpen` never steals focus) and M-x2 (StrictMode
spawns exactly one PTY per session). A validator was dispatched to measure them against a real
server with an isolated scratch vault. It ran 39 tool calls and **returned no verdict, left no
script and no evidence**. Per this run's own discipline — report ≠ work, and a check without
evidence is not a pass — that is recorded as NO RESULT, not as a PASS.

**Decision: build the harness ONCE, at Phase 6.** Phase 6 must stand up the same apparatus
anyway (a real server, `DREAMCONTEXT_DESKTOP=1`, an isolated scratch vault, two registered
vaults, a driven browser) to run the nine-item B checklist — and B4 IS the M-x1 measurement.
Paying for that harness twice, after one attempt already produced nothing, is waste.

**Why deferring is bounded rather than reckless:**
- T8's change is small, was written against a reviewer-verified description of the defect, and
  typechecks clean.
- **No task in Waves 3 or 4 owns `agentSession.ts` or `AgentSurface.tsx`'s fit/open machinery.**
  If Phase 6 shows the re-drive is wrong, the fix lands by resuming T8's own session against
  files that later waves never touched — no rework of Wave 3 or 4.
- The red line that actually protects a live conversation was verified mechanically and does
  hold: `grep -n "isActive" agentSession.ts chatSession.ts` → zero matches. Visibility never
  reaches a WebSocket.

**What Phase 6 must therefore prove, not assume:** M-x1 and M-x2 are promoted into the Phase-6
run as first-class items alongside B1-B9, and the validator is told that a NOT REACHABLE on
either one is reported as such — never silently folded into a PASS.
