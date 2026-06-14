RESULT: PASS

# Issue #9 (sleep-360-quality) Validation Report

Date: 2026-06-14
Validation method: Tests + measurable eval

---

## 1. npm run build

Command: `npm run build`

Result: PASS — no errors.

- `build:dashboard`: `vite build` succeeded, 120 files built.
- `build:cli`: `tsup` produced `dist/index.js` (2.15 MB), no TypeScript errors.

---

## 2. Full test suite — npx vitest run

Command: `npx vitest run`

Result: PASS

```
Test Files  156 passed | 2 skipped (158)
     Tests  1922 passed | 1 skipped | 19 todo (1942)
  Start at  21:24:38
  Duration  49.07s
```

0 failures. No test regression.

---

## 3. tests/unit/sleep-system-360.test.ts

Command: `npx vitest run tests/unit/sleep-system-360.test.ts`

Result: PASS

```
✓ tests/unit/sleep-system-360.test.ts (35 tests | 1 skipped)
Tests  34 passed | 1 todo (35)
```

Exactly 1 remaining `it.todo`. Confirmed by grep at line 445:

```
445:  it.todo('feature PRD upkeep is reliably exercised each cycle (Layer-2 live-LLM only — see RESULTS.md)');
```

Surrounding comment (lines 439-444) documents this as Layer-2/live-LLM-only:

> INTEGRATION-ONLY / not a pure-function assertion: feature-PRD upkeep being
> "reliably exercised each cycle" is an agent-behavior property of the live
> sleep-product specialist (prompt-driven), not of any exported pure function.
> WS3 resolved this via an evidence-based roster decision
> (knowledge/sleep-specialist-roster-decision.md), not a unit test. Left as
> todo deliberately — it cannot be asserted without a live-LLM run (Layer 2).

This is the WS3 feature-PRD-upkeep item. Not a shipped-behavior gap.

---

## 4. tests/unit/sleep-quality-eval.test.ts — measurable improvement proof

Command: `npx vitest run tests/unit/sleep-quality-eval.test.ts`

Result: PASS

Printed output:

```
sleep-quality eval — BEFORE → AFTER (deterministic, Layer 1)
metric                 |  before |   after |      Δ |  mover
-----------------------+---------+---------+--------+-------
epoch safety           |     100 |     100 |     +0 |      ·
debt correctness       |     100 |     100 |     +0 |      ·
no double-count        |     100 |     100 |     +0 |      ·
attribution coverage   |       0 |     100 |   +100 |    yes
trigger expiry         |     100 |     100 |     +0 |      ·
substance scoring      |       0 |     100 |   +100 |    yes
depth gating           |       0 |     100 |   +100 |    yes
-----------------------+---------+---------+--------+-------
OVERALL                |    57.1 |   100.0 |  +42.9 |

Tests  11 passed (11)
```

Criteria check:
- AFTER overall (100.0) strictly greater than BEFORE/BASELINE (57.1): PASS
- Movers (attribution coverage, substance scoring, depth gating) each go 0→100 (+100): PASS
- Regression guards (epoch safety, debt correctness, no-double-count, trigger expiry) do not drop (all stay 100): PASS

---

## 5. eval/sleep-quality/RESULTS.md

File: eval/sleep-quality/RESULTS.md

Result: PASS

RESULTS.md contains:
- Layer 1 BEFORE→AFTER Δ table with all 7 metrics, OVERALL row (57.1→100.0, +42.9), and per-mover annotations. Matches live test output exactly.
- Layer 2 manual procedure section documenting the live-LLM run steps for dedup (4) and capture-promote (6) metrics, with a "manual run pending" table. Explicitly documented as not CI-asserted.

---

## Summary

All 5 checks pass:
1. Build: clean, no errors.
2. Full suite: 1922 passed, 0 failed, 156/158 test files passed.
3. sleep-system-360: 34 passed, 1 todo (the single remaining todo is the documented Layer-2/live-LLM-only WS3 item, not a shipped-behavior gap).
4. sleep-quality-eval: 11 passed, OVERALL 57.1→100.0 (+42.9), all movers improved, no regression guards dropped.
5. RESULTS.md: documents the BEFORE→AFTER Δ table (Layer 1) and Layer-2 manual procedure.
