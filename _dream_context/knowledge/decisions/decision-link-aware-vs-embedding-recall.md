---
id: decision-link-aware-vs-embedding-recall
name: "Decision: link-aware BM25 boost (implemented, OFF by default) vs embedding overlay (deferred)"
description: "Two proposed BM25 recall improvements. Link-aware boost (Option A) was built and shipped OFF by default in 2026-06 (gold set precondition satisfied, but live corpus has ~0 wikilinks). Embedding overlay (Option B) remains deferred. See recall-engine-v2.md for the shipped implementation."
tags: ["decisions", "architecture", "domain:knowledge", "topic:recall"]
pinned: false
date: "2026-05-23"
updated: "2026-06-02"
---

## Status Update (2026-06-02)

**Option A (link-aware BM25 boost) is now IMPLEMENTED** — shipped in the `memory-uplift` PR as part of the v2 recall engine. The 60-query gold set that was the stated precondition for building it now exists (`eval/gold.jsonl`, deterministic harness in `tests/unit/recall-eval.test.ts`).

The implementation lives in `src/lib/recall.ts` (`buildLinkAdjacency()`, `LINK_DECAY = 0.3`) and is **OFF by default** (`enableLinkBoost: false` in `Bm25Options`). The live corpus has ~0 actual `[[wikilink]]` references, so enabling it would be a no-op. It activates via a single options flag and is fully unit-tested.

**Option B (embedding overlay) remains deferred** — no material change to the reasoning below.

See `knowledge/recall-engine-v2.md` for the full v2 architecture including the link-aware mechanism.

---


## Why This Exists

After BM25 keyword recall shipped (see `decision-mem0-vs-bm25-recall.md`), a session explored the next natural improvements to recall quality. Two options were compared:

- **Option A (link-aware BM25 boost)**: traverse `[[wikilink]]` edges in knowledge files and boost the BM25 score of docs linked from a high-scoring hit.
- **Option B (embedding overlay)**: add a second ranking layer using `@xenova/transformers` with a MiniLM model (~30 MB) to provide synonym/semantic recall alongside BM25.

Both were deferred. Neither is closed — they are the preferred sequence if the gold set reveals real recall gaps.

## The Two Options

### Option A — Link-aware BM25 boost via `[[wikilink]]` traversal

**Mechanism**: After BM25 scoring, parse `[[wikilink]]` references in top-K hits. Boost the BM25 score of each linked document by a decay factor (e.g., 0.3 × parent score per hop, capped at 2 hops).

**Why attractive**: Knowledge files in dreamcontext already use `[[wikilink]]` style cross-references. A link from a high-scoring file is a strong editorial signal that the linked file is topically related. BM25's term-frequency model has no way to capture this.

**Estimated effort**: ~2 hours. Parser for `[[...]]` patterns is trivial. Score propagation is a small graph walk over the adjacency map built during corpus load.

**Risk**: False-positive boosting if links are decorative rather than semantic. Requires link hygiene to be maintained. No additional npm deps; pure in-process logic.

### Option B — Embedding overlay via `@xenova/transformers` MiniLM

**Mechanism**: Run `@xenova/transformers` (WASM/ONNX) with a MiniLM sentence-embedding model in Node. For each query, compute cosine similarity across pre-built doc embeddings. Combine BM25 rank with cosine rank (e.g., RRF).

**Why attractive**: Captures synonym recall and paraphrased queries that BM25 misses entirely. Semantic recall is a natural ceiling-lifter beyond the ~95% BM25 top-3 performance already measured.

**Estimated effort**: ~1 day. Model download and first inference is ~100–200 ms cold (WASM); subsequent queries warm. Index build requires embedding all docs on startup or caching to disk (cache invalidation complexity). `@xenova/transformers` is a large npm dep (~15 MB unpacked, ONNX runtime).

**Risk**: Startup latency on first use. Disk cache adds state to manage. More complexity than Option A.

## The Decision: Defer Both — Gold Set First

**Heuristic adopted**: build a gold set of real BM25 misses before building anything.

The BM25 benchmark (20 queries on the dreamcontext corpus, 2026-05-23) showed 100% top-3 recall on queries that were tried. The benchmark was written by the same person who wrote the corpus — it may not surface the real-world failure modes. Before spending ~2h (Option A) or ~1 day (Option B) to fix a problem, the actual miss rate on real queries needs to be measured.

**Protocol**: over the next several sessions, record queries where BM25 returned the wrong top-1 or failed to surface the right doc in top-3. Once 5+ misses are recorded, classify them:

- **Term-mismatch misses** (synonym gaps, paraphrase) → prefer Option B.
- **Topical-adjacency misses** (correct doc linked from a hit, but not a direct keyword match) → prefer Option A.
- **Mixed** → implement Option A first (lower cost), measure residual misses, then decide on B.

If fewer than 5 misses accumulate after 10+ sessions of real use, neither option is worth building.

## Preferred Sequence

If the gold set justifies action:

1. **Option A first** (~2h, zero new deps, low risk). Implement link-aware boost; re-run benchmark on extended gold set.
2. **Option B only if** Option A doesn't close the gap, AND the embedding latency is acceptable on the target machine, AND the miss pattern is clearly semantic rather than structural.

Option B should be an **overlay** on BM25 + link-aware, not a replacement. This is consistent with the mem0 decision: the dreamcontext corpus is already curated atomic facts; BM25 is the right primary layer.

## Relation to the mem0 Decision

The mem0 review (`decision-mem0-vs-bm25-recall.md`) already flagged the embedding path: "A fundamentally cheaper local-embedding library emerges that doesn't require Python or Ollama (e.g., `@xenova/transformers` in Node with a 30MB MiniLM model). Even then: it should be an OVERLAY on the BM25 layer, not a replacement." This decision honors that constraint explicitly.

## Sources

- Session discussion: session `0459cdb8` (2026-05-23 — link-aware vs embedding overlay research).
- Related knowledge: `decision-mem0-vs-bm25-recall.md` — the BM25 adoption decision and its "conditions to revisit" section.
- Feature PRD: `_dream_context/core/features/memory-recall-bm25.md`.

## Last verified

2026-05-23.
