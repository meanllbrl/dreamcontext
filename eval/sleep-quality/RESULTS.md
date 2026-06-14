# Sleep-Quality Eval — Results

Two layers, with a hard boundary (see `docs/issue-9-sleep-plan.md` WS-EVAL):

- **Layer 1 — automated, deterministic, no LLM.** Pure functions of our code over
  the committed fixture + gold. This is what the vitest test asserts and what
  proves "measurable improvement." Reproduce with one command.
- **Layer 2 — manual, documented live-LLM run.** Agent-behavior quality metrics
  that cannot be computed without running the real specialist agents. Tallied by
  hand; **not CI-asserted.**

---

## Layer 1 — BEFORE → AFTER (CI-asserted)

Reproduce: `npx vitest run tests/unit/sleep-quality-eval.test.ts`

| metric                | BEFORE | AFTER |   Δ   | role             |
|-----------------------|-------:|------:|:-----:|------------------|
| epoch safety          |    100 |   100 |  +0   | regression guard |
| debt correctness      |    100 |   100 |  +0   | regression guard |
| no double-count       |    100 |   100 |  +0   | regression guard |
| **attribution (5)**   |      0 |   100 | **+100** | **mover**     |
| trigger expiry        |    100 |   100 |  +0   | regression guard |
| **substance (8)**     |      0 |   100 | **+100** | **mover**     |
| **depth gating (9)**  |      0 |   100 | **+100** | **mover**     |
| **OVERALL**           | **57.1** | **100.0** | **+42.9** | — |

**Headline: overall +42.9 (57.1 → 100.0).** All three movers go 0 → 100; no
regression guard drops (all stay 100).

### What each mover measures

- **(5) attribution coverage** — `attributeByPerson(commits, roster)` buckets the
  2-author fixture commit list per person (bots filtered) AND yields zero phantom
  buckets on the single-person control fixture. BEFORE the helper existed: 0%.
- **(8) substance scoring** — the edit-free-but-dense fixture session
  (`s-dense`: `change_count 0`, `tool_count 5`) scores `max(change,tool) = 1`
  BEFORE (below the quality bar of 2) and `max(change,tool,substance) = 3` AFTER.
- **(9) depth gating** — `isDestructiveAllowed(consolidationDepth(debt).depth)`
  authorizes destructive knowledge ops **only at `deep`**. BEFORE there was no
  gate (always allowed → wrong at `light`/`standard`).

The regression guards (1 epoch safety, 2 debt correctness, 3 no-double-count,
7 trigger expiry) exercise the WS1 pure functions identically in both profiles;
they exist to prove the refactor changed nothing.

---

## Layer 2 — manual live-LLM run (procedure)

**Status: manual run pending.** These metrics require a real specialist fan-out
and are tallied by hand, BEFORE vs AFTER the prompt changes.

### Procedure

1. Copy the fixture to a throwaway working project:
   ```bash
   cp -R eval/sleep-quality/fixture /tmp/dc-sleep-eval-run
   cd /tmp/dc-sleep-eval-run
   ```
2. Point the agent at this `_dream_context`-shaped fixture and run the real
   sleep flow per SKILL.md:
   ```bash
   dreamcontext sleep start        # pins the epoch
   # main agent dispatches sleep-tasks + sleep-state (+ sleep-product) in parallel
   dreamcontext sleep done "<one-paragraph summary>"
   ```
3. Hand-tally the two Layer-2 metrics from the resulting `_dream_context/`:

   - **(4) dedup discipline** — the fixture seeds two near-duplicate knowledge
     files (and duplicate bookmarks `bm-2`/`bm-3`, `bm-4`/`bm-5`). Did the agent
     MERGE the near-duplicates (deep tier) or correctly FLAG them (light/standard)
     rather than fork new fragments? Score = merged-or-flagged / total duplicate
     pairs.
   - **(6) capture→promote rate** — did the seeded digests / auto-bookmarks
     (especially the salience-3 `bm-1` GraphQL decision) reach durable
     `core/`/`knowledge/`/feature/changelog after `sleep done`? Score =
     promoted / load-bearing-captured.

4. Run the same procedure on a checkout BEFORE the WS-DEPTH/prompt changes for
   the BEFORE column.

### Layer-2 table (manual run pending)

| metric                     | BEFORE | AFTER |  Δ  |
|----------------------------|:------:|:-----:|:---:|
| (4) dedup discipline       |  TBD   |  TBD  | TBD |
| (6) capture→promote rate   |  TBD   |  TBD  | TBD |

> Layer 2 is the human-facing demonstration and is **explicitly not CI-asserted.**
> The Layer-1 table above is the reproducible proof of measurable improvement.
