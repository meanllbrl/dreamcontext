---
id: sleep-specialist-roster-decision
name: "Sleep Specialist Roster Decision (issue #9 WS3)"
description: "Evidence-based decision on whether to add a dedicated sleep-features specialist to the 3-specialist sleep roster. Measured feature-doc upkeep health (stale ratio, churn) and concluded: KEEP 3 + mandatory feature-upkeep self-report line."
tags: ["decisions", "topic:agents", "topic:sleep"]
date: "2026-06-14"
---

## Why this exists

Issue #9 (360° sleep quality) asked whether the sleep consolidation roster needs a
fourth, dedicated `sleep-features` specialist, or whether the existing three
(`sleep-tasks`, `sleep-state`, `sleep-product` — `sleep-product` owns feature PRDs)
keep feature docs healthy enough. The decision rule was pre-committed so it could not be
rationalized after the fact.

## Decision rule (pre-committed)

> Add a dedicated `sleep-features` specialist ONLY IF **stale ratio > ~40%** AND
> sleep-product cycles **routinely skip feature writes**. Otherwise KEEP 3 specialists and
> add a mandatory "feature upkeep considered: yes/no + why" self-report line to sleep-product.

## Measured evidence

Source: `scripts/feature-upkeep-evidence.ts` (runs `analyzeFeatures()` over this project's
`_dream_context/core/features/*.md` + task `related_feature` back-refs, plus a 90-day git
churn ratio). Measured 2026-06-14 on the dreamcontext repo:```json
{
  "total": 23,
  "stale": 2,
  "stalePct": 9,
  "orphaned": 5,
  "dangling": 0,
  "freshPct": 91,
  "git90d": { "featureDocCommits": 24, "srcCommits": 105, "churnRatio": 0.229 }
}```The three measured numbers that drive the decision:

1. **Stale ratio = 9%** (2 of 23 feature PRDs stale >30d). Far below the ~40% threshold.
2. **Fresh ratio = 91%** — feature docs are overwhelmingly current.
3. **Git churn ratio = 0.229** (24 feature-doc commits vs 105 src commits, 90d) — roughly one
   feature-doc touch per ~4 src commits. Feature writes are clearly NOT being routinely skipped;
   sleep-product is keeping PRDs in step with code.

(`orphaned: 5` and `dangling: 0` are health context, not part of the decision rule — orphaned
PRDs are a tagging/back-ref gap, not a staleness/skip signal.)

## Decision

**KEEP the 3-specialist roster. Do NOT add a `sleep-features` specialist.**

Both gate conditions fail decisively: stale ratio (9%) is ~4x below the 40% threshold, and the
churn ratio (0.229) shows feature docs are actively maintained, not skipped. A fourth specialist
would add orchestration cost and a fourth file-domain seam for a problem the evidence says does
not exist.

Instead, the existing `sleep-product` specialist already carries the feature domain; the
"Dropped-but-load-bearing self-check" report line (added in WS4) plus its existing No-op
feature-signals reporting cover the "did feature upkeep get considered?" audit need without a new
agent. If a future cycle measures stale ratio climbing past ~40% with a falling churn ratio, this
decision should be revisited with the same script.

## Sources

- `scripts/feature-upkeep-evidence.ts` (the reproducible measurement)
- `src/lib/feature-freshness.ts` (`analyzeFeatures`)
- Issue #9 plan: `docs/issue-9-sleep-plan.md` (WS3)
- Last verified: 2026-06-14
