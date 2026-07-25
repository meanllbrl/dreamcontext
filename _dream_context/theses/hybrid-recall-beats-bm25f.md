---
claim: >-
  Hybrid recall (BM25F + local embeddings, RRF fusion) beats BM25F-only on the
  60-query gold set by enough margin to justify shipping it on by default
status: draft
kind: experimental
confidence: 0.5
created_by: user
predictions:
  - id: pred_UrDg5lSj
    text: >-
      On the 60-query gold set, hybrid mode's precision@5 is at least 5
      percentage points above raw BM25F.
    standing: untested
  - id: pred_seQeVfFT
    text: >-
      No gold-set query that raw BM25F answers correctly is answered incorrectly
      by hybrid mode (zero regressions).
    standing: untested
  - id: pred_39GRbWdI
    text: >-
      Enabling hybrid does not require changing any existing gate threshold
      (BM25 fallback 2.0, skill gate 1.0, explore 5/2).
    standing: untested
evidence:
  - date: '2026-07-25'
    cycle: 1
    source: changelog
    ref: CHANGELOG.json 2026-07-25
    verdict: no-signal
    note: >-
      Gold set repointed after archival; recall-eval suite green again at 86.7%
      r@3 over 60 queries. This is the BM25F-only baseline, NOT a hybrid
      measurement. The thesis requires a hybrid vs BM25F head-to-head run, which
      does not exist yet.
    quantitative: false
insights: []
objectives:
  - improve-recall-mechanism
related_tasks:
  - feat-embedding-beta-rollout-opt-in-flag-doctor-gitignore-docs
related_workflows: []
blocked_on_instrumentation: true
blocked_metric: >-
  No hybrid recall run has been executed against the 60-query gold set. The
  thesis cannot progress without a hybrid vs BM25F head-to-head measurement. The
  related task (feat-embedding-beta-rollout) is still todo; once that ships and
  hybrid mode is testable, we need to run recall-eval in hybrid mode and compare
  the results to the 86.7% BM25F baseline.
cycles_checked: 1
checked_at: '2026-07-25'
promoted_to: null
created_at: '2026-07-25'
updated_at: '2026-07-25'
---
## Understanding changelog

### CYCLE 1 · 2026-07-25
First check (cycle 1): Thesis created today with 3 pre-registered predictions (precision@5 +5pp, zero regressions, no gate threshold changes). Related task feat-embedding-beta-rollout is still todo. Found relevant CHANGELOG evidence: gold set repointed after archival, recall-eval suite green at 86.7% r@3 (BM25F baseline). However, this is NOT evidence for the thesis — it establishes the baseline the thesis must beat, but no hybrid run exists to compare. Marked as blocked on instrumentation: cannot test predictions until hybrid mode is exercised against the gold set and results are compared to the 86.7% BM25F baseline. Keeping in draft (no status flip) — promotion to open requires ≥1 testable prediction AND ≥3 supporting observations from ≥2 sources; the missing hybrid measurement prevents any prediction from being tested.
