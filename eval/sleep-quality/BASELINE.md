# Sleep-Quality Eval — Frozen BASELINE (BEFORE profile)

Deterministic Layer-1 numbers from the **BEFORE** profile — i.e. the
pre-refinement behavior, emulated by the scorer:

- **(5) attribution coverage** — the `attributeByPerson` helper did not exist, so
  per-person bucketing was 0%.
- **(8) substance scoring** — session score was `max(scoreFromChangeCount,
  scoreFromToolCount)` only; the edit-free-but-dense fixture session scores **1**,
  below the quality bar of 2.
- **(9) depth gating** — no depth gate existed; destructive ops were always
  allowed, which is wrong at `light`/`standard`.

The regression guards (1 epoch safety, 2 debt correctness, 3 no-double-count,
7 trigger expiry) exercise the same shipped WS1 pure functions in both profiles
and are 100 in BEFORE — they exist to prove the refactor changed nothing.

Reproduce: `npx vitest run tests/unit/sleep-quality-eval.test.ts`

| metric                | BEFORE |
|-----------------------|-------:|
| epoch safety          |    100 |
| debt correctness      |    100 |
| no double-count       |    100 |
| attribution coverage  |      0 |
| trigger expiry        |    100 |
| substance scoring     |      0 |
| depth gating          |      0 |
| **OVERALL**           | **57.1** |

`OVERALL = (100 + 100 + 100 + 0 + 100 + 0 + 0) / 7 = 400 / 7 ≈ 57.14`

This value is frozen as `BASELINE_OVERALL` in
`tests/unit/sleep-quality-eval.test.ts`; the AFTER overall must be `>=` it.
