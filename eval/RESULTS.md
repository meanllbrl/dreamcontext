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
