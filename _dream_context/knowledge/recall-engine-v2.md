---
id: recall-engine-v2
name: "Recall Engine v2 — BM25F + Stemming + Synonyms + Continuous Capture"
description: "BM25F field-weighted recall engine v2: stemming, synonyms, recency/status re-rank, continuous capture, eval harness, and the score/rankScore decoupling invariant. Supersedes the original flat-BM25 implementation. Deterministic benchmark: overall recall@1 68.3→85.0%, recall@3 81.7→95.0%."
tags: ["architecture", "decisions", "memory", "search"]
pinned: false
date: "2026-06-02"
---

## Why This Exists

The v1 BM25 recall engine (flat field tokenization, k1=1.5/b=0.75, raw BM25 sort) was validated on a 20-query benchmark and shipped in 2026-05. A 60-query deterministic gold set (authored blind by a separate sub-agent) revealed three structural weaknesses:

1. **Turkish recall catastrophically low** (37.5% recall@1) — agglutinative suffix inflections were unfolded, so `veritabanları` never matched `veritabanı`.
2. **Paraphrase recall mediocre** (41.7% recall@1) — synonyms like "retrieval" vs "recall" or "embedding" vs "vector" were invisible to BM25.
3. **All fields weighted equally** — a query for a doc's exact title term didn't reliably surface that doc over a body-heavy doc with many keyword co-occurrences.

v2 was shipped across PR #1 (`memory-uplift`) and PR #2 (`memory-capture-harden`) to main in the 2026-06-01 cycle.

## Architecture

### BM25F Field Weighting (B2)

Key file: `src/lib/recall.ts`, `buildFields()`, `FIELD_WEIGHTS`.

```
FIELD_WEIGHTS = { title: 3, tags: 2, description: 2, body: 1 }
```

Each field's token frequencies are multiplied by its weight and summed into `fieldFreq`. This `fieldFreq` feeds the `rankScore` (the derived sorting signal) — NOT the raw `score` (see Decoupling Invariant below). Result: title+tag hits dominate ordering; body-only matches are still findable but don't crowd out named docs. Pushed exact-term and field-match categories to 100% recall@1.

### Stemming — English + Turkish (B4)

Key file: `src/lib/recall.ts`, `stemToken()`, `stemEn()`, `stemTr()`, `TR_SUFFIXES`.

Applied symmetrically at index-build time AND query time. Both paths go through the same `stemToken()` → `stemTr(stemEn(token))` pipeline, keeping them aligned.

**English**: conservative suffix strip — removes `-ing`, `-ed`, `-es`, `-s` with a length gate (>4 chars, no double-s). Targets plurals and verb inflections only; won't mangle short tokens.

**Turkish**: strip ONE common case/plural suffix from long tokens (>`4` chars base length after strip). Suffix list: `lerinden, larından, lerine, larına, leri, ları, ler, lar, den, dan, nin, nın, nun, nün, de, da, yi, yı, yu, yü`. Conservative — one hop only, no recursive stripping.

This was the **biggest metric mover**: Turkish recall@1 37.5→75.0%, recall@3 37.5→87.5%.

### Query-Time Synonym Expansion (B4)

Key file: `src/lib/recall-synonyms.ts`, `expandQueryTerms()`.

A hand-curated, stemmed map. Surface terms are run through the same `stemToken()` pipeline before being stored, keeping them aligned with the index. At query time, each stemmed query term is looked up; matching entries add their synonym set to the BM25 query. Example families:

- `recall / retriev / search / lookup / find`
- `embed / vector / semant`
- `bookmark / salience / ripple`
- `consolid / sleep / rem`
- `digest / distil / summar`
- `captur / record / log`

Lifted paraphrase recall: 41.7→66.7% recall@1, 75.0→91.7% recall@3.

### Recency + Status Re-Rank (B3)

Key file: `src/lib/recall.ts`, `recencyMultiplier()`, `STATUS_PENALTY`, `statusMultiplier()`.

**Status penalty**: `completed` docs get a 0.85× `rankScore` multiplier (not 0.6 — a 0.6 penalty buried completed tasks that were the clear BM25 winner for topical queries). Down-ranked but still surfaceable.

**Recency decay**: exponential half-life of 120 days, floor at 0.85. A doc updated 120 days ago scores ~0.875× vs a fresh doc. This is a tie-breaker, NOT a content override — a strong match that happens to be old still wins over a weak recent match.

Recency category: 75.0→87.5% recall@1.

### Haiku Index Relevance-Ranking (B6)

Key file: `src/lib/recall-query-extractor.ts`, `buildCorpusIndex()`.

The v1 Haiku index used a positional 8000-char slice of the corpus. This silently omitted ~half the corpus (all changelog entries, many tasks) from the Haiku path. v2 ranks the corpus by BM25 relevance to the query before slicing — the 8K window now contains the most-relevant docs, not the most-recently-added ones.

### Link-Aware Boost (B5) — BUILT, OFF BY DEFAULT

Key file: `src/lib/recall.ts`, `buildLinkAdjacency()`, `LINK_DECAY = 0.3`.

Mechanism: after BM25 scoring, parse `[[wikilink]]` references in top-K hits. Boost each linked doc's `rankScore` by `0.3 × parent_rankScore` (per hop, capped at 2 hops). The adjacency map is built from `[[slug]]` patterns in doc bodies.

**Why off**: the live corpus has ~0 real wikilinks at time of shipping. Enabling it would be a no-op and complicates future debugging. The deferral condition from `decision-link-aware-vs-embedding-recall.md` ("gold set first") has now been satisfied by the 60-query gold set, so the mechanism was built and unit-tested as promised — activation remains a single `enableLinkBoost: true` option in `Bm25Options`. See [[decision-link-aware-vs-embedding-recall]] for the original defer rationale.

## The Decoupling Invariant

**This is the load-bearing design constraint of v2.** Two parallel score signals exist on every `RecallHit`:

| Field | What it is | Who reads it |
|---|---|---|
| `hit.score` | Raw flat-BM25 (unchanged from v1 scale) | Hook thresholds (`>= 2.0` BM25 fallback, `>= 1.0` skill gate), explore agent (`>= 5 / < 2` tiers) |
| `hit.rankScore` | Derived: BM25F × recency × status × capture-penalty | Sorting / ordering only |

All v2 signals (field weighting, synonyms, recency, status, capture penalty, link boost) feed `rankScore`. None touch `score`. The hook gates remain stable — a doc that scored 2.1 before v2 still scores 2.1 after v2 (on identical text). **The thresholds do not need retuning.**

This invariant is regression-locked by `tests/unit/recall-weighting.test.ts`.

## Continuous Capture (C1–C4)

### Auto Transcript Digest (C1)

Key file: `src/lib/session-digest.ts`.

On the **SessionStart catch-up path** (never the latency-sensitive Stop hook), the hook processes any undigested sessions: calls `transcript distill`, produces a bounded digest (≤8KB), writes it as a task-type corpus doc (`slug: digest#<session_id>`). Per-session try/catch — a bad transcript never blocks the session.

### Auto-Salience Detectors (C2)

Key file: `src/lib/salience.ts`, `detectSalience()`.

Pure structural pattern matching (no AI). Three detector classes:

1. **User corrections** (salience 2): user message contains `no, actually, wrong, instead, hayır, yanlış, değil` (word-boundary anchored, EN+TR).
2. **Error→fix** (salience 1): any `distilled.errors` present AND `distilled.codeChanges` present → the session hit an error and then changed code.
3. **Decision keywords** (salience 2): agent decision or user message containing `decided, chose, switched to, will use, karar, seçtik`.

Cap: 5 moments per session. A clean session yields an empty array — deliberately conservative.

**Impact**: previously 30/32 consolidations had zero bookmarks (the brain model's "awake-ripple tagging" was designed for but rarely used). Auto-salience fires automatically — the brain now captures the high-signal slice of every session without manual bookmarks.

### Capture Indexing (C3)

Digests and auto-bookmarks are indexed into `buildCorpus` (flagged `capture: true`) so a decision captured in session N is recallable in N+1, before any sleep consolidation.

### Knowledge Access Bump (C4)

Recall hits call `bumpKnowledgeAccess(slug)` so recalled docs stop decaying to "stale" in the `knowledge_access` map.

## Capture Guard (PR #2)

### Problem Measured

A stress test (`tests/unit/recall-capture-stress.test.ts`) with 200 auto-digest + 200 auto-bookmark docs showed:
- recall@3 degraded −3.3 pts vs a capture-free corpus
- recall@1 degraded −8.3 pts
- Mediocre auto-captures were crowding out curated knowledge

### Fix: CAPTURE_RANK_PENALTY = 0.5

`rankScore` of all `capture: true` docs is multiplied by 0.5. The raw `score` is untouched (decoupling invariant preserved). Effect: on an equal content match, a curated doc beats a capture doc. But a capture doc whose match is clearly the strongest wins (`0.5 × big_number` still tops `1.0 × small_number`).

### K=50 Digest Cap

Only the 50 most-recent session digests are indexed per corpus build. Older digests are excluded. Prevents unbounded corpus growth from accumulating old digests.

### Guard Proof

`recall-capture-stress.test.ts` verifies: under a worst-case capture flood, ZERO gold targets that ranked in top-3 on the capture-free corpus are knocked out by a capture. (A weak-match gold doc that already missed top-3 without captures is a query recall limit, not capture displacement.)

### Latent Bug Fixed

A `Date.parse(session.created_at)` call was receiving pre-formatted strings ("3 days ago"), causing NaN comparisons. Fixed: `session_id` is sanitized in digest frontmatter; raw ISO timestamps are used.

## Eval Harness + Gold Set

Key files: `eval/gold.jsonl`, `eval/harness.ts`, `eval/BASELINE.md`, `eval/RESULTS.md`.

**Methodology**: 60 queries authored blind (by a separate sub-agent) to the improvements, on the live committed corpus. Categories: exact-term, field-match, paraphrase, turkish, recency, mixed TR/EN, topical-adjacency. Reproduced deterministically: `npx vitest run tests/unit/recall-eval.test.ts`.

**Before/after results:**

| Metric | Before | After | Delta |
|---|---|---|---|
| Overall recall@1 | 68.3% | **85.0%** | +16.7 pts |
| Overall recall@3 | 81.7% | **95.0%** | +13.3 pts |
| Overall MRR | 0.768 | 0.903 | +0.135 |
| Turkish recall@1 | 37.5% | **75.0%** | +37.5 pts |
| Paraphrase recall@1 | 41.7% | **66.7%** | +25.0 pts |
| Exact-term recall@1 | 83.3% | **100.0%** | +16.7 pts |
| Field-match recall@1 | 87.5% | **100.0%** | +12.5 pts |

No category regressed. 1063 tests passing (post-build).

**Caveats**: 60-query gold set is one author's view of realistic queries on one corpus. The +16.7 pt overall r@1 is a strong signal, not a proof of identical gains on every project. Continuous capture (C1–C4) is NOT reflected in these percentages — it grows the corpus over time; the benchmark measures a fixed committed snapshot.

## Decision Document Status Updates

- **[[decision-mem0-vs-bm25-recall]]**: still canonical. The gold-set now EXISTS and validates the BM25 path. The "conditions to revisit" criteria (corpus >500 docs + recall@5 <85%) have not been met.
- **[[decision-link-aware-vs-embedding-recall]]**: link-aware boost (Option A) is now **implemented** (`buildLinkAdjacency()` + LINK_DECAY logic), shipped **OFF by default** pending real `[[wikilink]]` adoption in the corpus. The gold-set precondition ("gather misses before building") is satisfied — the mechanism was built. The file's "deferral" language is now outdated; see status note in that file.
- **[[haiku-recall-architecture]]**: still accurate for the Haiku query strategy. v2 adds that the corpus index sent to Haiku is now **relevance-ranked** (B6) rather than positional, fixing the silent half-corpus omission.

## Sources

- PR #1 `memory-uplift`: commits `a56f9d4` (Batch 1 engine), `125e029` (tests), `a5edce7` (Batch 2 capture), `1451ab5` (Batch 3 correctness), `e31b2e3` (Phase-5 review), `bf3711a` (RESULTS.md), `248a4c5` (Batch 2 handoff).
- PR #2 `memory-capture-harden`: commit `4585612` (capture guard).
- Key files: `src/lib/recall.ts`, `src/lib/recall-synonyms.ts`, `src/lib/salience.ts`, `src/lib/session-digest.ts`, `eval/RESULTS.md`, `eval/gold.jsonl`.
- Related knowledge: `haiku-recall-architecture.md`, `decision-mem0-vs-bm25-recall.md`, `decision-link-aware-vs-embedding-recall.md`.

## Last Verified

2026-06-02.
