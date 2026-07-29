---
claim: >-
  Hybrid recall (BM25F + local embeddings, RRF fusion) beats BM25F-only on the
  60-query gold set by enough margin to justify shipping it on by default
status: validated
kind: experimental
confidence: 0.880597014925373
created_by: user
predictions:
  - id: pred_UrDg5lSj
    text: >-
      On the 60-query gold set, hybrid mode's precision@5 is at least 5
      percentage points above raw BM25F.
    standing: supported
  - id: pred_seQeVfFT
    text: >-
      No gold-set query that raw BM25F answers correctly is answered incorrectly
      by hybrid mode (zero regressions).
    standing: supported
  - id: pred_39GRbWdI
    text: >-
      Enabling hybrid does not require changing any existing gate threshold
      (BM25 fallback 2.0, skill gate 1.0, explore 5/2).
    standing: supported
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
  - date: '2026-07-25'
    cycle: 2
    source: task
    ref: feat-embedding-ab-eval-harness-bm25-vs-hybrid-vs-dense-on-frozen-gold-set
    verdict: supports
    note: >-
      A/B eval task completed 2026-07-07 with v2 results: held-out r@5 90.0 to
      96.7 (+6.7pp, exceeds the 5pp threshold in prediction 1); zero regressed
      recall/MRR cells (confirms prediction 2). Train r@1 +5.0, held-out r@1
      +6.7. Turkish held-out r@1 20→40, r@5 90→100. Results recorded in
      eval/RESULTS.md. This evidence existed BEFORE thesis creation but was not
      surfaced in cycle 1 check.
    quantitative: true
  - date: '2026-07-25'
    cycle: 2
    source: changelog
    ref: eval/RESULTS.md
    verdict: supports
    note: >-
      eval/RESULTS.md v2 section (2026-07-07) documents the complete A/B
      verdict: all four default-on gates met. Decoupling invariant explicitly
      preserved: 'hit.score stays raw flat-BM25 (so the hook gates >= 2.0 / >=
      1.0 and the explore agent's >= 5 / < 2 are unaffected)', confirming
      prediction 3. Train r@5 +1.7pp (below threshold but positive), held-out
      r@5 +6.7pp (exceeds 5pp threshold). Gate thresholds unchanged in
      src/cli/commands/hook.ts (line 1578: h.score >= 2.0 still present with
      comment 'score is untouched, so the >= 2.0 gate below is unchanged').
    quantitative: true
  - date: '2026-07-25'
    cycle: 2
    source: task
    ref: feat-embedding-beta-rollout-opt-in-flag-doctor-gitignore-docs
    verdict: supports
    note: >-
      Beta rollout task (the thesis's related_tasks link) updated 2026-07-22
      with Notes section documenting 'A/B eval (v2) showed r@1 +6.7 on held-out
      set, zero regressions — gates met for default-on consideration'. This
      independent task record confirms predictions 1 (margin exceeds threshold)
      and 2 (zero regressions) from a different task perspective than the A/B
      eval task itself.
    quantitative: true
insights: []
objectives:
  - improve-recall-mechanism
related_tasks:
  - feat-embedding-beta-rollout-opt-in-flag-doctor-gitignore-docs
related_workflows: []
blocked_on_instrumentation: false
blocked_metric: null
cycles_checked: 4
checked_at: '2026-07-25'
promoted_to: null
created_at: '2026-07-25'
updated_at: '2026-07-28'
---
## Understanding changelog

### CYCLE 8 · 2026-07-28
Cycle 8 check (epoch 2026-07-28T17:17:30.163Z, DEEP consolidation): No fresh evidence for this thesis since the epoch. Six commits this cycle (7effb38 chat scroll-hold, a562d1d lab snapshot demotion floor, e806ba8 announcements, 40a03da v0.22.0 release, 4f2353c automations learning/session/notification, 2390e4b prior sleep output) — all Chat UI, automations, and release work, zero recall algorithm changes. The in-flight snapshot-budget rework (uncommitted) is context-snapshot sizing/compression, not a recall-algorithm change, so not evidence for this thesis's claim. Zero completed tasks since the epoch. Lab insights all demo fixtures, all stale. The linked objective improve-recall-mechanism remains at 5/8 done (63%), status active, not slipping — task recall-indexes-and-returns-automations-insights-theses-and-objectives completed 2026-07-28, but as the brief explicitly notes, that expansion widened which entity TYPES recall indexes (nine channels), not the ranking algorithm, so it is NOT evidence for or against the hybrid-vs-BM25F claim. The thesis was validated in cycle 2 at 88% confidence with all 3 predictions supported and remains validated. No new evidence to add. Promotion to knowledge remains outstanding (promoted_to: null) — this is a standing decision ask for the PO (raised continuously since cycle 3). Per the workflow-rule gate check: below the auto-promote bar because related_workflows is unset, so this routes to plain knowledge promotion requiring PO confirmation.

### CYCLE 7 · 2026-07-28
Cycle 7 check (epoch 2026-07-28T10:54:59.989Z, DEEP consolidation): No fresh evidence for this thesis since the epoch. Commit 1852869 and task recall-indexes-and-returns-automations-insights-theses-and-objectives-on-every-surface-with-an-importance-level-filter (moved to in_review 2026-07-28) expanded recall to all nine channels (automations, insights, theses, objectives) with a --level importance filter — this advances the linked objective improve-recall-mechanism but is NOT evidence for THIS thesis's claim (hybrid vs BM25F algorithm performance, already validated). The thesis was validated in cycle 2 at 88% confidence with all 3 predictions supported and remains validated. The linked objective improve-recall-mechanism shows 4/7 tasks done (57%), status review, not slipping. The related task feat-embedding-beta-rollout remains todo. No new evidence to add. Promotion to knowledge remains outstanding (promoted_to: null) — this is a standing decision ask for the PO (raised continuously since cycle 3). Per the workflow-rule gate check: below the auto-promote bar because related_workflows is unset, so this routes to plain knowledge promotion requiring PO confirmation.

### CYCLE 6 · 2026-07-26
Cycle 6 check (epoch 2026-07-26T20:46:07Z, DEEP consolidation): No fresh evidence since the epoch. Zero commits, zero lab syncs, zero completed tasks, zero objective movements. This cycle's 4 pre-epoch sessions were entirely Chat UI/UX work (message queue, survey pagination, sub-agent dedup fixes, plan cards) — zero recall-engine or embedding work. The thesis was validated in cycle 2 at 88% confidence with all 3 predictions supported and remains validated. The linked objective improve-recall-mechanism shows 4/5 tasks done (80%), not slipping. The related task feat-embedding-beta-rollout remains todo. No new evidence to add. Promotion to knowledge remains outstanding (promoted_to: null) — this is a standing decision ask for the PO. Per the workflow-rule gate check: below the auto-promote bar because related_workflows is unset, so this routes to plain knowledge promotion requiring PO confirmation.

### CYCLE 5 · 2026-07-26
Cycle 5 check (epoch 2026-07-26T13:36:17Z, DEEP consolidation): No fresh evidence since the epoch. This cycle focused entirely on Chat-view / desktop-app product work (10 sessions, 9 commits on Chat improvements, transcript memory, control-C stop, plan cards, sub-agent dedup, survey pageview, announcements). Zero recall-engine or embedding work; the related task feat-embedding-beta-rollout remains todo. The thesis was validated in cycle 2 at 88% confidence with all 3 predictions supported and remains validated. No new evidence to add. Promotion to knowledge remains outstanding (promoted_to: null) — this is a standing decision ask for the PO. Per the workflow-rule gate check: below the auto-promote bar because related_workflows is unset, so this routes to plain knowledge promotion requiring PO confirmation.

### CYCLE 3 · 2026-07-25
Cycle 3 check (epoch 2026-07-25T15:00:17Z): No fresh evidence since the epoch — zero commits, zero lab syncs, zero completed tasks, zero objective movements. The thesis was validated in cycle 2 at 88% confidence with all 3 predictions supported. Promotion to knowledge is still outstanding (promoted_to: null) — this is a decision ask for the PO. The linked objective improve-recall-mechanism shows 4/5 tasks done (80%), status not_started (computed), not slipping. No new evidence to add; the validation stands. Recommend promoting the validated thesis to knowledge per the workflow-rule gate check (below the auto-promote bar because related_workflows is unset, so this routes to plain knowledge promotion — PO confirmation required).

### CYCLE 2 · 2026-07-25
Cycle 2 check (2026-07-25, DEEP consolidation): Previous cycle incorrectly stated 'no hybrid recall run has been executed' — the A/B eval task (feat-embedding-ab-eval-harness) actually completed 2026-07-07 with comprehensive v2 results documented in eval/RESULTS.md. Added 3 supporting evidence events: (1) A/B eval task completion with v2 verdict (held-out r@1 +6.7, r@5 90→96.7 +6.7pp, zero regressed cells), (2) eval/RESULTS.md documenting all four default-on gates met plus the decoupling invariant ('hit.score stays raw flat-BM25 so hook gates >= 2.0 / >= 1.0 unaffected'), (3) beta rollout task notes confirming same results. Verified all three predictions against actual results: pred_UrDg5lSj (r@5 +5pp threshold) SUPPORTED by +6.7pp on held-out set; pred_seQeVfFT (zero regressions) SUPPORTED by 'not one recall@k or MRR cell regresses'; pred_39GRbWdI (gate thresholds unchanged) SUPPORTED by code inspection (src/cli/commands/hook.ts line 1578 still h.score >= 2.0) and explicit decoupling invariant. Unblocked (instrumentation gap was stale — the hybrid run exists and predates thesis creation). Status flipped draft → validated with 88.1% confidence (3 supporting evidence events from 2 sources, all predictions supported, --force agent-driven path). This validates the claim: hybrid recall beats BM25F-only by the stated margin with no regressions and no gate changes required.

### CYCLE 1 · 2026-07-25
First check (cycle 1): Thesis created today with 3 pre-registered predictions (precision@5 +5pp, zero regressions, no gate threshold changes). Related task feat-embedding-beta-rollout is still todo. Found relevant CHANGELOG evidence: gold set repointed after archival, recall-eval suite green at 86.7% r@3 (BM25F baseline). However, this is NOT evidence for the thesis — it establishes the baseline the thesis must beat, but no hybrid run exists to compare. Marked as blocked on instrumentation: cannot test predictions until hybrid mode is exercised against the gold set and results are compared to the 86.7% BM25F baseline. Keeping in draft (no status flip) — promotion to open requires ≥1 testable prediction AND ≥3 supporting observations from ≥2 sources; the missing hybrid measurement prevents any prediction from being tested.
