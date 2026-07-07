# Memory-uplift RESULTS — recall before/after

Branch `memory-uplift`. Deterministic benchmark: 60-query gold set (`eval/gold.jsonl`), authored blind to the improvements by a separate sub-agent from corpus reality. Reproduce: `npx vitest run tests/unit/recall-eval.test.ts`.

## Headline

| metric | BEFORE (baseline) | AFTER | Δ |
|---|---|---|---|
| **overall recall@1** | **68.3%** | **85.0%** | **+16.7 pts** |
| **overall recall@3** | **81.7%** | **95.0%** | **+13.3 pts** |
| overall MRR | 0.768 | 0.903 | +0.135 |

No category regressed. The two weakest categories improved the most.

## Per-category (recall@1 / recall@3)

| category | before r@1 | after r@1 | before r@3 | after r@3 |
|---|---|---|---|---|
| turkish | 37.5% | **75.0%** (+37.5) | 37.5% | **87.5%** (+50.0) |
| paraphrase | 41.7% | **66.7%** (+25.0) | 75.0% | 91.7% (+16.7) |
| exact-term | 83.3% | 100.0% (+16.7) | 100.0% | 100.0% |
| field-match | 87.5% | 100.0% (+12.5) | 87.5% | 100.0% |
| recency | 75.0% | 87.5% (+12.5) | 87.5% | 87.5% |
| mixed (TR/EN) | 83.3% | 83.3% | 83.3% | 100.0% (+16.7) |
| topical-adjacency | 83.3% | 83.3% | 100.0% | 100.0% |

## What shipped (all on `memory-uplift`, all tests green)

**Batch 0 — measurement** (`f560fd8`): deterministic vitest harness + 60-query gold set + frozen `eval/BASELINE.md`. `docKey()` added.

**Batch 1 — recall engine** (`a56f9d4`, tests `125e029`): the metric movers.
- **B4 stemming + synonyms** (biggest mover): EN suffix stripping + Turkish suffix folding in `tokenize()` + a query-time synonym map (`recall-synonyms.ts`). This is what doubled Turkish (37.5→75) and lifted paraphrase (41.7→66.7).
- **B2 BM25F** field weighting (title×3/tags×2/desc×2/body×1) — pushed exact-term and field-match to 100%.
- **B3 recency + status** re-rank (down-weight `completed`, light recency decay) — recency 75→87.5.
- **B6** Haiku index relevance-ranking — replaced the 8000-char positional slice that silently hid ~half the corpus (all changelog) from the Haiku recall path.
- **B5** link-aware boost — built + unit-tested, shipped **OFF by default** (the live corpus has ~0 real wikilinks, so enabling it would be a no-op; honors the existing deferral discipline).
- **Decoupling invariant:** `hit.score` stays raw flat-BM25 (so the hook gates `>= 2.0` / `>= 1.0` and the explore agent's `>= 5 / < 2` are unaffected); all new signals feed a derived `rankScore` used only for ordering. Regression-locked by `recall-weighting.test.ts`.

**Batch 2 — continuous capture** (`a5edce7`): the corpus now enriches itself automatically.
- **C1** auto transcript digest (`session-digest.ts`) on the SessionStart catch-up path (never the latency-sensitive Stop hook), per-session try/catch, bounded ≤8KB.
- **C2** auto-salience (`salience.ts`): user-correction / error→fix / decision-keyword detectors (EN+TR) → auto-bookmarks. This finally implements the "awake-ripple tagging" the brain model is built on (previously 30/32 consolidations had zero bookmarks).
- **C3** digests + bookmarks indexed into `buildCorpus` so a decision in session N is recallable in N+1, before any sleep.
- **C4** recall hits bump `knowledge_access` (shared `bumpKnowledgeAccess`) so recalled docs stop rotting to "stale".

**Batch 3 — correctness** (`1451ab5`): explore agent's Bash allowlist now includes `dreamcontext memory recall` + `transcript distill` (the headline context-first-explore optimization was non-functional before); the dead `marketing/.env` PreToolUse write-block was revived (it never fired under matcher `Agent` only).

**Phase-5 review fixes** (`e31b2e3`): BM25-fallback gate uses `.some()` so re-ranking can't suppress a strong raw match; `session_id` sanitized in digest frontmatter.

## Test + build status
- `npm test`: **1038/1038 passing** (76 files; +47 new tests for this work).
- `npm run build`: clean (CLI + dashboard).
- Note: integration tests require a build first (project convention); the 1038 figure is post-build.

## Honest caveats
- **60-query gold set is suggestive, not proof.** It was authored blind to the improvements, but it is one author's view of "realistic queries" on one corpus. A +16.7 pt overall r@1 is a strong signal, not a guarantee of identical gains on every project.
- **Continuous capture (Batch 2) is not reflected in the % above** — it grows the corpus *over time*; the benchmark measures a fixed committed snapshot (digests/bookmarks contribute 0 docs there by design, so the number is comparable before/after). Its payoff is qualitative: the brain now captures the high-signal slice of every session automatically instead of only what someone remembered to bookmark before running sleep.
- **B5 (link-aware) is off** — mechanism shipped + tested, but a no-op until the corpus actually grows wikilinks.
- Embeddings/vector overlay and WAVE 3/4 items remain out of scope (separate future work).

## Not auto-merged
Left on `memory-uplift` for review. The recall engine touches a hot path; suggest a skim of `src/lib/recall.ts` (rankScore vs score) and `src/cli/commands/hook.ts` (capture wiring) before merging to main.

---

## v3 (2026-06-10) — TR morphology + directed bridges + canonical-first

Tuned on `gold.jsonl` (60q), validated on `gold-heldout.jsonl` (30q, authored blind — see knowledge/recall-engine-v2.md v3 update). Frozen 242-doc corpus via `scripts/recall-ab.ts`.

| Metric | Train old | Train v3 | Held-out old | Held-out v3 |
|---|---|---|---|---|
| overall recall@1 | 86.7 | **91.7** | 83.3 | **93.3** |
| overall recall@3 | 93.3 | **96.7** | 90.0 | **96.7** |
| overall MRR | 0.906 | **0.943** | 0.875 | **0.957** |
| turkish recall@1 | 75.0 | 75.0 | 70.0 | **90.0** |
| turkish recall@3 | 87.5 | **100.0** | 80.0 | **100.0** |
| paraphrase recall@1 | 66.7 | **91.7** | 87.5 | 87.5 |

No category regressed on either set. linkAware was benchmarked and rejected (train r@1 68.3 with it ON). Regression locks: `tests/unit/recall-engine-v3.test.ts`.

---

## Embedding A/B (2026-07-07) — BM25 vs hybrid vs dense on the frozen gold sets

The prove-it-or-kill-it gate for the experimental local embedding layer
(knowledge/decisions/decision-embedding-layer.md). Reproduce:
`npx tsx scripts/embed-ab.ts` (train) / `--heldout`. Corpus discipline as v3:
git-tracked stable corpus (675 docs, captures + in-flight noise excluded),
frozen gold sets untouched. Model: `Xenova/multilingual-e5-small` q8 (384-dim,
113 MB), chunked at heading boundaries (2503 chunks), content-hash cache at
`_dream_context/.embeddings/` (gitignored, incremental: warm refresh ~15 ms).

**IMPORTANT context:** the corpus nearly tripled since v3 froze its 242-doc
snapshot (675 docs now, mostly changelog + new knowledge), so absolute numbers
are NOT comparable to the v3 table above — the same queries face far more
distractors. All three modes below face the identical corpus, so the A/B is
internally fair.

### Fusion journey (what was tried, in order)

1. **Plain RRF (k=60, per the decision doc's "start here")** — KILLED. Overall
   train r@1 68.3 vs bm25 75.0; exact-term r@1 100 → 83.3 (the forbidden
   regression). Equal-vote rank fusion lets dense flip decisive lexical wins.
2. **Convex-weighted RRF (w_bm25 swept 0.5–0.9)** — KILLED. Best (w=0.8) r@1
   76.7 but exact-term stuck at 91.7 at EVERY weight: rank fusion erases BM25's
   score margins, so near-ties flip regardless of weight.
3. **Relative-score fusion (min-max convex, λ swept)** — safe but toothless.
   λ ≤ 0.2 holds exact-term at 100 but is a near-no-op; λ ≥ 0.25 regresses.
4. **Adaptive fusion-type switch (SHIPPED)** — topRaw ≥ 18 → relative fusion
   λ=0.1 (margins preserved, exact wins can't flip); topRaw < 18 → weighted RRF
   w_bm25=0.6 (weak-BM25 score gaps are noise; rank fusion lets dense rescue
   buried docs). Tuned on train ONLY; held-out validated untouched.

### Headline (adaptive hybrid vs bm25)

| metric | train bm25 | train hybrid | held-out bm25 | held-out hybrid |
|---|---|---|---|---|
| recall@1 | 75.0 | **78.3** (+3.3) | 60.0 | **63.3** (+3.3) |
| recall@3 | 90.0 | **93.3** (+3.3) | 86.7 | **90.0** (+3.3) |
| recall@5 | 95.0 | 95.0 (=) | 90.0 | **93.3** (+3.3) |
| MRR | 0.832 | **0.853** | 0.740 | **0.751** |
| nDCG@10 | 0.869 | **0.881** | 0.796 | **0.805** |
| exact-term r@1 | 100.0 | **100.0 (no regression)** | 75.0 | 75.0 (=) |

### Where hybrid wins (the "multiple scenarios" answer)

- **turkish**: train r@3 62.5 → **87.5** (+25); held-out r@1 20 → **40** (×2),
  r@3 80 → 90, r@5 90 → **100**. The multilingual dense channel bridges TR→EN
  natively — this is the strongest scenario win.
- **recency**: train r@1 50 → **75** (+25), nDCG 0.720 → 0.868.
- **field-match**: train r@3 87.5 → **100**.
- **exact-term / mixed**: byte-identical to bm25 (the adaptive guard working).

### Where it costs

- train paraphrase r@3 91.7 → 83.3 (one query, q014-adjacent zone; r@5 equal).
- held-out topical-adjacency r@1 75 → 50 (ONE query, h027, topRaw 17.7 — right
  at the cutoff boundary; drops rank 1 → 2). n=4 category, so ±25pt swings are
  single queries.
- Latency: +40 ms/query over bm25 (219 vs 181 ms mean; embed+dot is ~20 ms of
  that). Cold start: ~1 s model load (cached at ~/.dreamcontext/models); first
  full-corpus index ~4 min one-time (2503 chunks), then incremental (~15 ms
  warm, content-hash keyed, survives git checkout).

### Dense-only (why the overlay architecture is right)

Dense alone is catastrophically worse: train r@1 38.3, exact-term 58.3, mixed
0.0. BEIR's "dense fails on exact tokens" fully reproduced on this corpus. BM25
stays the backbone; dense is an overlay. (Dense query latency itself is ~20 ms
— cheaper than BM25's ~180 ms df-scan — an optimization lead, not a mode.)

### Verdict vs the graduation gates (decision-embedding-layer)

1. hybrid r@5 + MRR strictly beat bm25 — **MRR yes both sets; r@5 yes on
   held-out, TIE (95.0) on train**. Partially met.
2. exact-term & field-match r@1 no regression — **MET** (train 100/87.5
   preserved; held-out equal).
3. laptop latency acceptable — **MET** (+40 ms warm; interactive).
4. no category regresses — **NOT met to the letter**: two single-query dips
   (train paraphrase r@3, held-out topical r@1) against much larger wins.

**Call: hybrid is a real but CATEGORY-SHAPED win — big for Turkish/cross-lingual
and recency-style weak-BM25 queries, neutral-to-marginal for English
exact/paraphrase queries. It stays opt-in beta (`DREAMCONTEXT_RECALL_MODE=hybrid`
/ `dreamcontext recall hybrid`), NOT default: gates 1 and 4 are not cleanly met.
Recommended for TR-heavy / multilingual vaults; unnecessary for EN-only vaults.**
Regression locks: `tests/unit/embeddings.test.ts` (17 tests: chunker
determinism, incremental cache, fusion math, raw-score decoupling invariant,
BM25 fallback).

### v2 (same day) — pin guard + changelog-free dense channel: ALL FOUR GATES MET

Per-query forensics on the v1 regressions found two independent root causes,
each with a targeted fix:

1. **Pin guard (`ADAPTIVE_PIN_MARGIN = 1.35`).** The worst English regression
   (train q021: gold at rank 1 → out of top-10) had a signature: BM25's OWN
   rankScore margin over its runner-up was decisive (1.55×) while every
   measured dense displacement WIN had a flat margin (1.05–1.32). So in the
   unconfident RRF zone, a BM25 top-1 with margin ≥ 1.35 is pinned at rank 1 —
   dense keeps its vote on ranks 2+.
2. **Changelog docs excluded from the dense channel (`DENSE_EXCLUDED_TYPES`).**
   One-line pointer docs make unusually focused vectors that match broadly and
   crowd out canonical docs — the same canonical-first finding the
   CHANGELOG_RANK_FACTOR encoded for BM25, reproduced in the dense space.
   (Dense-only overall r@1 jumped 38.3 → 43.3 train / 36.7 → 56.7 held-out from
   this alone.) BM25 still surfaces changelogs; only the dense candidate list
   is filtered.

Same protocol: designed on train forensics, validated untouched on held-out.
(bm25 baseline shifted slightly vs the v1 table — the live corpus absorbed the
embedding tasks' own updates between runs; every comparison below is within-run.)

| metric | train bm25 | train hybrid v2 | held-out bm25 | held-out hybrid v2 |
|---|---|---|---|---|
| recall@1 | 76.7 | **81.7** (+5.0) | 60.0 | **66.7** (+6.7) |
| recall@3 | 90.0 | **95.0** (+5.0) | 86.7 | 86.7 (=) |
| recall@5 | 95.0 | **96.7** (+1.7) | 90.0 | **96.7** (+6.7) |
| MRR | 0.840 | **0.878** | 0.740 | **0.772** |
| nDCG@10 | 0.875 | **0.904** | 0.796 | **0.820** |

Category highlights (within-run deltas):
- **paraphrase (EN)**: train r@1 66.7 → **83.3** (+16.7), r@5 91.7 → **100**,
  MRR 0.800 → 0.892 — the pin guard turned v1's English *regression* into the
  second-largest English *win*.
- **turkish**: train r@3 62.5 → **87.5**; held-out r@1 20 → **40**, r@5 90 →
  **100** (all v1 wins kept).
- **recency**: train r@1 62.5 → **75.0**, nDCG 0.766 → 0.868.
- **topical-adjacency (held-out)**: v1's h027 regression GONE (r@1 75 = 75);
  r@5 75 → **100** (+25).
- **exact-term / field-match / mixed**: identical to bm25 everywhere (guards
  working).

**Not one recall@k or MRR cell regresses on either gold set.** Sole blemish:
train turkish nDCG@10 0.763 → 0.750 (one query, q031, rank 7 → 11; its
r@1/r@3/r@5 cells are unchanged).

**Gate check (decision-embedding-layer "Conditions to Make It Default"):**
1. r@5 + MRR strictly beat bm25 — **MET** (both sets).
2. exact-term & field-match r@1 no regression — **MET** (identical).
3. laptop latency — **MET** (~232 ms vs ~183 ms warm; +50 ms).
4. no category regresses — **MET** on recall@1/3/5 + MRR (nDCG footnote above).

**Call v2: the quality gates for default-on are now met. Remaining blockers are
purely operational (113 MB first model download, ~4 min first full-corpus
index) — recommended rollout is staged: opt-in beta → auto-enable when the
model + cache are already warm on the machine (never a surprise download on
first prompt). That wiring belongs to the beta-rollout task.** Regression
locks extended to 19 tests (pin guard, dense-channel exclusion).
