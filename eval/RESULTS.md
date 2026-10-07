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

## 2026-10-07 — `whiteboard` channel added (no regression)

`scripts/recall-ab.ts` on the stable corpus, before vs after adding the tenth corpus type (3 boards, 1382 → 1385 docs):

| set | r@1 | r@3 | MRR before → after |
|---|---|---|---|
| train (`gold.jsonl`) | 66.7 = | 86.7 = | 0.766 → 0.766 (paraphrase 0.759 → 0.758) |
| held-out (`gold-heldout.jsonl`) | 50.0 = | 63.3 = | 0.581 → 0.580 (exact-term 0.800 → 0.792) |

No recall@k cell moves; the MRR deltas are IDF wobble from the three new docs.

## 2026-10-07 — `core` channel added (no regression)

Same-corpus A/B (with and without `core` evaluated on ONE `buildCorpus` in one process; the live brain grew between separate runs while another session worked). 4 core docs: 0.soul, 3.style_guide_and_branding, 4.tech_stack, 6.system_flow.

| set | r@1 | r@3 | MRR without → with |
|---|---|---|---|
| train | 66.7 = | 86.7 = | 0.766 → 0.765 |
| held-out | 50.0 = | 63.3 = | 0.580 → 0.580 |

Rank moves, all outside the top 3: q028 7→8 and q059 5→6 (`core/6.system_flow` above the gold doc), h012 8→9 (`core/0.soul` above). All three are on-topic answers, not noise.

## 2026-10-07 — Recall maintenance: Haiku retired, hybrid + EmbeddingGemma the default, gold sets repaired, ranking and latency

Task `recall-maintenance-haiku-out-hybrid-default-repaired-gold-sets-ranking-and-latency` (plan: `knowledge/plans/recall-maintenance-2026-10-plan.md`). **Aggregates only** — no per-query output and no h-f query text is in this repo; per-query output lives under `~/.dreamcontext/eval-frozen/runs/`, the h-f gold sets in the h-f repo and in `eval-frozen/gold/`.

### Method (what makes the numbers comparable)

- **Frozen corpora, pinned clock.** The dreamcontext brain (**dc**, 1449 docs) and the health-and-fitness brain (**h-f**, ~2.7k docs, many of them Turkish) were copied once to `~/.dreamcontext/eval-frozen/{dc,hf}-20261007/` (checksummed; G1 and G2 verified identical) and every run passes `--now 2026-10-07T08:47:28Z`, so recency cannot move between runs.
- **Three gold families, each a train and a held-out split** — *dc v1* (`gold.jsonl` 60q + `gold-heldout.jsonl` 30q, **repaired**: 3 stale `expected` targets repointed and 20 stale `alt` targets dropped; see `eval/REPAIRS-2026-10.md`), *dc 2026-10* (63q train + 56q held-out) and *h-f* (63q + 56q). The two new families were **authored blind** by an agent that saw only the corpus — never the engine, the old gold, the plan or any recall output — stratified by category (7 categories, 8–9 queries each per split).
- **Baseline = G1**, taken after the gold repair and before any engine change; **final = G2**, taken by a fresh validator on the frozen T10 configuration. Tuning (ranking fixes, fusion, gate) used the **train** splits only; held-out was measured once, by G2, and **never** used to retune.
- Search latency is the mean after one discarded warm-up query per mode; hook latency is `node dist/index.js hook user-prompt-submit` on a scratch copy of the frozen vault (median over the strong-match gold prompts — those whose target scores raw ≥ 2.0, i.e. the ones that print a recall header — first run discarded), always under the repo's heavy lock.

### Recall quality — G1 → G2, per set (r@1 / r@3 / r@5 in %, MRR)

`bm25` is the engine's own BM25F path (it also improved: ranking fixes below); `hybrid` is the shipped default. G1 hybrid used the pre-goal e5-small configuration.

| set (n) | mode | r@1 | r@3 | r@5 | MRR |
|---|---|---|---|---|---|
| dc v1 train (60) | bm25 | 66.7 → 71.7 | 86.7 → 86.7 | 86.7 → 88.3 | 0.765 → 0.796 |
| dc v1 train (60) | hybrid | 70.0 → 75.0 | 80.0 → 86.7 | 85.0 → 88.3 | 0.767 → 0.816 |
| dc v1 held-out (30) | bm25 | 50.0 → 53.3 | 63.3 → 63.3 | 63.3 → 63.3 | 0.580 → 0.601 |
| dc v1 held-out (30) | hybrid | 56.7 → 56.7 | 63.3 → 66.7 | 70.0 → 73.3 | 0.625 → 0.652 |
| dc 2026-10 train (63) | bm25 | 71.4 → 71.4 | 85.7 → 87.3 | 92.1 → 95.2 | 0.797 → 0.807 |
| dc 2026-10 train (63) | hybrid | 77.8 → 85.7 | 90.5 → 98.4 | 96.8 → 100.0 | 0.855 → 0.919 |
| dc 2026-10 held-out (56) | bm25 | 64.3 → 69.6 | 78.6 → 78.6 | 83.9 → 83.9 | 0.728 → 0.759 |
| dc 2026-10 held-out (56) | hybrid | 67.9 → 78.6 | 80.4 → 89.3 | 85.7 → 92.9 | 0.758 → 0.847 |
| h-f train (63) | bm25 | 65.1 → 66.7 | 76.2 → 76.2 | 77.8 → 77.8 | 0.707 → 0.720 |
| h-f train (63) | hybrid | 66.7 → 79.4 | 77.8 → 85.7 | 81.0 → 87.3 | 0.729 → 0.834 |
| h-f held-out (56) | bm25 | 71.4 → 71.4 | 83.9 → 83.9 | 83.9 → 85.7 | 0.772 → 0.780 |
| h-f held-out (56) | hybrid | 66.1 → 73.2 | 82.1 → 89.3 | 83.9 → 91.1 | 0.744 → 0.813 |

### Pooled per split (dc v1 + dc 2026-10 + h-f), and Turkish pooled

| split | mode | r@1 | r@3 | r@5 | MRR | Turkish r@1 | Turkish r@3 |
|---|---|---|---|---|---|---|---|
| train (n=186, Turkish n=26) | bm25 | 67.7 → 69.9 | 82.8 → 83.3 | 85.5 → 87.1 | 0.756 → 0.774 | 42.3 → 46.2 | 65.4 → 65.4 |
| train (n=186, Turkish n=26) | hybrid | 71.5 → 80.1 | 82.8 → 90.3 | 87.6 → 91.9 | 0.784 → 0.857 | 46.2 → 73.1 | 57.7 → 84.6 |
| held-out (n=142, Turkish n=26) | bm25 | 64.1 → 66.9 | 77.5 → 77.5 | 79.6 → 80.3 | 0.714 → 0.734 | 38.5 → 46.2 | 50.0 → 50.0 |
| held-out (n=142, Turkish n=26) | hybrid | 64.8 → 71.8 | 77.5 → 84.5 | 81.7 → 88.0 | 0.725 → 0.793 | 34.6 → 57.7 | 46.2 → 65.4 |

Hybrid's pooled held-out MRR is 0.714 (G1 BM25) → **0.793**, and its Turkish recall@3 50.0 → **65.4**; on train 0.756 → **0.857** and 65.4 → **84.6**. The Turkish category was where the pre-goal hybrid *lost* to BM25 (train r@3 65.4 → 57.7, held-out 50.0 → 46.2); it now beats BM25 on every pooled Turkish cell.

### Search latency — `embed-ab` mean per query after warm-up (ms), frozen corpora

| set | bm25 G1 → G2 | × | hybrid G1 → G2 | × |
|---|---|---|---|---|
| dc v1 train | 449 → 17 | 27× | 492 → 128 | 3.8× |
| dc v1 held-out | 445 → 20 | 22× | 488 → 124 | 3.9× |
| dc 2026-10 train | 455 → 19 | 24× | 515 → 109 | 4.7× |
| dc 2026-10 held-out | 454 → 19 | 24× | 498 → 145 | 3.4× |
| h-f train | 1444 → 32 | 45× | 1592 → 200 | 7.9× |
| h-f held-out | 1435 → 26 | 56× | 1580 → 178 | 8.9× |

Gate: each mode ≥ 3× below its own G1 mean — met on all six sets for both modes. BM25's cost was the snippet extraction (it re-tokenized every matched doc on every query); it is now computed for the returned top-K only. Hybrid's cost was the same snippet pass over its 50-doc candidate pool plus a second parse of the embedding cache per prompt; the snippet pass now covers the returned top-K only, the cache is parsed once and shared, and the dense channel is skipped when BM25 is already sure (the *dense gate*). Dense-only is informational and not gated.

### Hook latency — p50 of one `user-prompt-submit` (ms), recall header present

`floor` is the same hook with `DREAMCONTEXT_MEMORY_HOOK=0` (process start + snapshot work, no recall); *overhead* = raw − floor.

| vault | floor G1 → G2 | raw G1 → G2 | raw overhead G1 → G2 | hybrid G1 → G2 | hybrid p90 G2 |
|---|---|---|---|---|---|
| dc | 324 → 321 | 1701 → 519 | 1377 → 198 (7.0×) | 2570 → 647 (4.0×) | 2039 |
| h-f | 365 → 368 | 7096 → 1324 | 6731 → 956 (7.0×) | 8116 → 1500 (5.4×) | 3057 |

Gates: raw-recall overhead ≥ 3× below G1 on both vaults (met: ~7×); absolute raw p50 ≤ 600 ms **on the dc vault only** (met: 519 ms; the h-f vault is a 2.7k-doc brain with a federated peer and is recorded, not gated: 1324 ms); hybrid p50 ≥ 2× below G1 (met: 4.0× dc, 5.4× h-f). With no model on the machine the hook (dc vault) answers from BM25 in 538 ms and creates no model directory. `buildCorpus` p50 (cold walk, no cache): dc 820 → 766 ms, h-f 2702 → 2623 ms (unchanged by design — the hook now reads the parsed-corpus cache instead).

### Model screening (T6) — dense-only, train splits, aggregates

Fusion-independent screening first; all candidates have a working ONNX export and a verified Turkish↔English probe. dc = dc v1 train + dc 2026-10 train pooled; h-f = h-f train. Source: `eval/runs/2026-10-07-models.json`.

| model | dims / dtype | licence | dc dense MRR | h-f dense MRR | dc Turkish r@3 | h-f Turkish r@3 | cold load (dc) |
|---|---|---|---|---|---|---|---|
| multilingual-e5-small (control) | 384 / q8 | MIT | 0.719 | 0.698 | 52.9 | 77.8 | 0.76 s |
| **EmbeddingGemma-300m** | 768 / q8 | Gemma Terms of Use | **0.845** | **0.807** | **82.4** | **88.9** | 1.15 s |
| EmbeddingGemma-300m | 768 / q4 | Gemma Terms of Use | not measured (precheck only; ~187 MB) | | | | |
| granite-embedding-97m-multilingual-r2 | 384 / q8 | Apache-2.0 | 0.728 | not run (lost on dc) | 64.7 | — | 0.91 s |

Verdicts: **EmbeddingGemma q8 won** on both corpora (pooled MRR +0.126 dc / +0.109 h-f, Turkish r@3 +29.5 / +11.1 points, no gated category losing more than one query). **Granite rejected** — within noise of the control on dc, so it was not carried to h-f. **q4 not shipped** (quality never measured; q8 already cleared every latency gate). The model costs a larger download (~294 MB vs ~113 MB), a ~0.4 s slower cold load, a slower embed (~71 ms vs ~3 ms warm) and a ~2× larger index — which is why the dense gate exists. The licence is Google's **Gemma Terms of Use** (commercial use permitted, with use restrictions that flow down to downstream users; not an OSI open-source licence); the owner accepted it on 2026-10-07. The model is not bundled in the npm package.

**Reranker rejected.** A small multilingual cross-encoder (mMiniLMv2-L12, qint8) over the hybrid top-20 gave noise-level gain (rerank-and-blend MRR 0.809 → 0.812 dc, 0.732 → 0.746 h-f; rerank-only *lost*: 0.687 / 0.658) at a mean 3.4 s (dc) / 6.0 s (h-f) per query in the screening run — far outside the hook budget. `bge-reranker-v2-m3` was not run (the rule was: only if the small one showed promise).

### What changed in the engine

- **Snippet-only-top-K + parsed-corpus cache (T4).** Search cost fell as above with train top-10 keys, `rankScore`, raw `score` and snippets **identical** before vs after (123 train queries, plain and cached paths). `buildCorpusCached` stores the parsed corpus in `_dream_context/.recall-cache/` (peers' in `~/.dreamcontext/recall-cache/<hash>/`, never inside a peer), invalidated per source file by path + mtime + size and by a fingerprint of the tokenizer constants.
- **Ranking fixes (T7), `rankScore` only — `hit.score` untouched.** `BOARD_RANK_FACTOR = 0.6` for label-only boards (they took top-1 from the canonical doc on six train queries) and a table of 61 directed TR→EN bridge rows derived from corpus term frequency over the Turkish docs of both brains (no gold query used). Train MRR against G1 BM25 after T7 alone: dc v1 0.765 → 0.796, dc 2026-10 0.797 → 0.807, h-f 0.707 → 0.720, no train category below G1.
- **Per-model fusion and dense gate (T10), tuned on the three train sets.** Gemma: weighted-RRF below BM25 top-raw 12, score fusion above it with λ 0.7, BM25 weight 0.6, top-1 pin margin 1.35; the dense channel is skipped when BM25 is sure (raw ≥ 24, or ≥ 12 with a ≥ 1.25 lead over the runner-up). e5-small keeps its pre-goal constants (cutoff 18, λ 0.1, no gate). Dedup and declined-idea cosine thresholds are per model too (Gemma 0.93 / margin 0.05 / review 0.78 / declined 0.68, measured on the frozen dc corpus and an h-f sample with 0 % false merges at 0.93; e5 unchanged at 0.97 / 0.02 / 0.91 / 0.82).
- **Provisioning (T8/T9).** The model and the first index are fetched by a detached `embed ensure`; the first build checkpoints, a partial index is never used for ranking, and the hook embeds at most 8 chunks inline. Hybrid is BM25 until both are ready.

### Validation against the acceptance criteria (G2)

All gates passed except criterion 2c's letter, which the owner accepted (below). Build and the full suite were green with **0 new reds** against the pre-work baseline (2 pre-existing failures in 3 files, all outside this change); frozen checksums matched G1; the Haiku grep matched only its allow-list.

**Accepted held-out single-query category flips (owner decision, 2026-10-07; no retuning on held-out was done).** Every pooled and per-set metric improved on both splits; against G1 BM25 these five held-out cells moved by one query each:

| held-out set | category | cell | change | query id |
|---|---|---|---|---|
| dc (v1 + 2026-10 pooled) | paraphrase | r@3 | 14 → 13 | h018 (rank 3 → 4) |
| h-f | paraphrase | r@1 | 6 → 5 | hfh-022 (rank 1 → 2) |
| h-f | recency | r@1 | 5 → 4 | hfh-042 (rank 1 → 2) |
| h-f | recency | r@3 | 7 → 6 | hfh-048 (rank 2 → miss) |
| dc 2026-10 | exact-term | r@1 | category count unchanged, 9 → 9 | h26-008 (rank 1 → 2) |

These queries are the first targets of the next recall round.

### Honest caveats

- The three gold families are small (n = 8–10 per category per split); one query moves a category cell by 10–12 points, which is why the five flips above are recorded individually rather than argued away.
- G1 hybrid is the pre-goal e5-small configuration, G2 hybrid is EmbeddingGemma with per-model tuning — so the hybrid deltas bundle the model, the fusion retune and the ranking fixes; the BM25 deltas isolate the ranking fixes (which also benefit BM25 and hybrid alike).
- The absolute 600 ms hook gate is dc-only; on the h-f vault (a larger brain plus a federated peer) the raw hook is 1.3 s, about 5× faster than G1 but not under 600 ms.
- Latencies were taken on one machine under the heavy lock with the load recorded as quiet; a loaded machine inflates the floor (observed 375–391 ms vs 319–324 ms).
