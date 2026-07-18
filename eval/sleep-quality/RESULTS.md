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

**Status: AFTER-only run completed 2026-07-18.** BEFORE not reproducible this
run (see note below the table). These metrics require a real specialist
fan-out and are tallied by hand.

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

> **Fixture note (2026-07-18):** the committed `eval/sleep-quality/fixture/`
> does **not** actually contain "two near-duplicate knowledge files" as this
> procedure's step 3 describes — it has only `fixture-meta.json` and
> `state/{.config.json,.sleep.json}` (verified: `find eval/sleep-quality/fixture
> -type f` returns exactly those 3 files, no `knowledge/`, no `core/`). The
> fixture *does* contain the two duplicate bookmark pairs (bm-2/bm-3, bm-4/bm-5)
> and the salience-3 decision bookmark (bm-1) the procedure names. The 2026-07-18
> run below measured what the fixture actually seeds (bookmark-level dedup +
> bm-1 promotion); the knowledge-file-merge half of metric (4) remains
> unmeasured pending a fixture update (fixture dirs are frozen for this task —
> not fixed here).

### Layer-2 table

| metric                     |            BEFORE            |                 AFTER                | Δ |
|-----------------------------|:-----------------------------:|:--------------------------------------:|:---:|
| (4) dedup discipline        | not reproducible (see note) | 2/2 dup. bookmark pairs (100%) — knowledge-file half unmeasured | N/A |
| (6) capture→promote rate    | not reproducible (see note) | 1/1 named target (100%); 1/2 broader load-bearing set (50%) | N/A |

**BEFORE-column disposition:** not reproducible this run. The AC1–AC9 fix
package is present only as **uncommitted working-tree changes** on this
checkout, not a separate commit — reproducing BEFORE would require stashing
~60 modified files (including this very task's own state) and re-dispatching
a second live specialist fan-out against a stashed checkout, which is outside
this run's sanctioned scope (RESULTS.md only) and unsafe alongside the
in-progress consolidation lock active on this repo at run time. No BEFORE
number is fabricated; the comparison is deferred to a future run with a real
pre-change commit to check out.

### 2026-07-18 run — method and findings

Executed the documented procedure for real: copied `eval/sleep-quality/fixture/`
into a scratch `_dream_context/` (outside the repo's own vault, never
committed), ran `dreamcontext sleep start`, dispatched the real `sleep-state`
and `sleep-tasks` specialist agents against it in parallel with a brief naming
the epoch and the bookmark set, then `dreamcontext sleep done`. Findings below
are read from the resulting files on disk, not from the agents' self-reports.

- **(4) dedup discipline — 2/2 bookmark pairs, 100% (knowledge-file half
  unmeasured — see fixture note).** Neither `sleep-state` nor `sleep-tasks`
  double-recorded bm-2/bm-3 ("rate limiting on all auth endpoints") or bm-4/bm-5
  ("CSS modules over styled-components") — both pairs were explicitly
  recognized as exact duplicates and each contributed at most once to any
  output. Depth resolved to `standard` for this cycle (debt 8), consistent with
  the "flag, don't merge" tier — correct behavior for non-deep consolidation.
- **(6) capture→promote rate — mixed, reported honestly rather than rounded up.**
  The salience-3 bookmark the procedure names explicitly (bm-1, "Switched from
  REST to GraphQL") **was promoted**: `sleep-state` created
  `core/2.memory.md` with a Technical Decision entry for it, and `sleep-tasks`
  independently created `state/api-design.md` referencing the same decision —
  1/1 (100%) on the one item the procedure singles out. But taking the metric's
  literal definition ("promoted / load-bearing-captured") over the full
  salience-≥2 set in this fixture — bm-1 **and** the bm-2/bm-3 rate-limiting
  requirement (salience 2, a genuine constraint) — only bm-1 reached a durable
  artifact. `sleep-tasks` explicitly declined to create an `auth-refactor` task
  for the rate-limiting requirement ("a requirement without implementation
  doesn't warrant a task file yet"), which is a defensible conservative call
  per its own protocol, not silent dropping — but it means that requirement did
  **not** survive `sleep done` (bookmarks are cleared at consolidation; nothing
  else records it) — **1/2 (50%)** on the broader set. Recorded as-is per the
  integrity rule: the named-target number is a genuine 100%, the broader
  capture-survival number is a genuine 50%, and both are reported rather than
  picking the flattering one.

> Layer 2 is the human-facing demonstration and is **explicitly not CI-asserted.**
> The Layer-1 table above is the reproducible proof of measurable improvement.
