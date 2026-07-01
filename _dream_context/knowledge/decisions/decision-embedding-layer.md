---
id: know_HS7cx_QA
name: "Decision: Local Embedding Layer (experimental hybrid recall + semantic dedup)"
description: >-
  Decision + design for an experimental LOCAL embedding layer: hybrid BM25+dense
  recall (RRF) and semantic sleep-time dedup, via transformers.js
  multilingual-e5-small, content-hash chunk cache, brute-force cosine.
  Supersedes the 'embedding overlay deferred' decision. Cited prior art
  (BEIR/RRF/Chroma/Continue.dev) + experimental rollout plan, flag-gated and
  A/B-gated.
tags:
  - 'kind:decisions'
  - 'kind:architecture'
  - 'domain:knowledge'
  - 'topic:recall'
  - 'topic:embeddings'
pinned: false
date: '2026-06-29'
updated: '2026-06-29'
---

## Status

**EXPERIMENTAL / BETA — flag-gated, off by default, A/B-gated before any default-on.**

This supersedes the deferral in [[decisions/decision-link-aware-vs-embedding-recall]] ("Option B — embedding overlay — remains deferred"). The precondition that deferral set ("build a gold set of real BM25 misses first") is **satisfied**: the 60-query `eval/gold.jsonl` + 30-query `eval/gold-heldout.jsonl` exist. We now **build the embedding overlay as an experiment**, behind a flag, measured against BM25 on those gold sets. We do **not** make it default until the A/B proves a win with no exact-term regression.

It does **not** reverse [[decisions/decision-mem0-vs-bm25-recall]]. That decision rejected *mem0* (Python + Ollama + cloud upload + non-deterministic LLM fact-extraction). This is the opposite: a **pure-Node, local, offline, deterministic** embedding overlay — exactly the "OVERLAY on the BM25 layer, not a replacement … `@xenova/transformers` in Node with a small model" escape hatch that the mem0 decision explicitly named as the condition to revisit.

## Why This Exists

The user's goal: take memory "one level higher" so a *really big* knowledge base stays sharp. The strategic discussion (2026-06-29) converged on a single insight that ties several proposed options into one project:

> The embedding index has **two consumers**, not one: (1) hybrid recall, and (2) sleep-time semantic dedup. Build it once, get both.

The conflated options unify as:
- **Hybrid recall** (semantic "meaning space" the user wanted) — dense vectors fused with the existing BM25F.
- **"Embed on file change"** — the user's open question. This *is* the "persistent incremental index": embedding is CPU-expensive, so you cannot re-embed per query — you must persist vectors and update only changed chunks. The freshness mechanism and the index are the same feature.
- **Section-level chunking** — not a separate "thousands of docs" nicety; it is a *prerequisite* for embeddings to be sharp (whole-doc vectors average into mush).
- **Sleep dedup** — the same index lets sleep sub-agents check "does a doc about X already exist?" by nearest-neighbor instead of keyword-guessing → merge instead of duplicate.

What we explicitly drop from the broader discussion: the demotion-ladder/budget work (already planned separately, see [[diagrams/memory-science/memory-upgrade-plan/memory-upgrade-plan]]) and "agentic just-in-time retrieval" (an emergent property of good recall, not a build).

## The Decision

1. **Keep BM25 as the backbone. Add dense as an OVERLAY, fused with Reciprocal Rank Fusion (RRF).** Never replace BM25. Pure-vector is *worse* on exact tokens — error codes, SKUs, function/identifier names, slugs, rare entities — which is exactly what this corpus is full of. Hybrid beats either alone by **+5 to +18% nDCG** on BEIR.
2. **Local, in-process, zero-daemon, offline.** `@xenova/transformers` (transformers.js, ONNX/WASM). No Python, no Ollama, no server — honoring the constraint that killed mem0.
3. **Multilingual model so dense retrieval matches TR↔EN natively.** This can let the hybrid mode **retire the per-prompt Haiku CLI call** for routine cross-lingual recall (the Haiku call exists *only* to bridge TR→EN intent). Keep an optional LLM-expansion fallback for hard/tail queries.
4. **Content-hash chunk cache, refreshed incrementally** (lazy at recall, eager at sleep). The cache key is the chunk content hash, not mtime.
5. **Preserve the decoupling invariant.** Dense/RRF feeds `rankScore` only, never `score`. The hook gate thresholds (`>= 2.0` etc.) stay frozen, so nothing downstream needs retuning. (See [[recall-engine-v2]] "Decoupling Invariant".)
6. **Prove it before shipping it.** Default stays BM25. A frozen-corpus A/B on the gold sets must show the dense layer raises recall@5 / MRR / nDCG **without regressing the 100% exact-term recall**. No proof → it stays off.

## Design (grounded in prior art)

### Model
- **Primary: `multilingual-e5-small`** — 384-dim, ~120 MB quantized. Best Turkish/English quality-per-MB; the E5 family leads TR-MTEB (Turkish enterprise eval: multilingual-e5 most stable, F1≈0.80).
- **Lighter alt: `paraphrase-multilingual-MiniLM-L12-v2`** — 384-dim, ~120 MB, 50 langs, faster.
- **Reject as default: `bge-m3`** — 1024-dim, GB-scale; too heavy for `npm install -g` on a laptop (revisit later: it emits dense+sparse natively).
- **De-risk first:** `Xenova/multilingual-e5-*` ONNX exports have historically thrown `Missing the following inputs: token_type_ids` in the transformers.js `feature-extraction` pipeline. **Verify the exact model+version offline before committing**; bge-small / MiniLM family avoid this. This is the #1 risk and the first thing the spike validates.

### Fusion
- **RRF**, rank-based, no score normalization, no labels: `RRF(d) = Σ 1/(k + rank_i(d))` over the BM25 rank list and the dense rank list. (Cormack et al., SIGIR 2009.)
- **k = 60** default — the original tuned value; RRF is forgiving (best/worst configs ≈ 5% apart).
- Given a code-identifier-heavy corpus, a convex weight favoring BM25 (α≈0.3) can add more *only if* we label ~40 queries; otherwise plain RRF. Start with plain RRF.

### Chunking
- Embed at **section / passage level (~200–512 tokens)**, split on markdown heading boundaries. **Never embed whole documents.** Chroma's controlled study: 200-token chunks gave ~5× precision for ~3 pts recall vs 800-token chunks — the long-passage vector "dilutes the similarity."

### Cache / "embed on change" (the user's open question — answered)
- **Content-hash-addressed chunk cache** on disk: `_dream_context/.embeddings/` (flat file or small SQLite), rows `{ chunkId, path, contentHash, vector }`.
- On corpus build / file change: re-chunk the file → hash each chunk → embed only chunks whose hash is **new/changed** → **delete** vectors for chunks that disappeared. (LlamaIndex IngestionPipeline + LangChain CacheBackedEmbeddings + Continue.dev `getComputeDeleteAddRemove` pattern.)
- **Triggers, no daemon:** lazy at recall (hash check is near-instant when nothing changed) + eager during **sleep** (sleep already rewrites the corpus). mtime is a cheap pre-filter; the hash is the source of truth (survives `git checkout`).
- **Security/storage:** vectors are partially invertible → `.embeddings/` is credential-class → **gitignore it**, never upload. Local model means the two worst mem0 findings (CRIT-2 invertible-vector upload, CRIT-5 silent cloud upload) are structurally impossible.

### Vector store
- **No vector database.** At our scale (a few k → ~50k chunk-vectors), plain **in-memory brute-force cosine** (a `Float32Array` + dot product, or `vectra` for zero native deps) is sub-millisecond and exact.
- ANN crossover is ~50–100k vectors. **Upgrade path if/when we cross it: LanceDB** (embedded, no server, Continue.dev-proven) or HNSW — *not* Qdrant (daemon).

### Cross-lingual / Haiku
- Multilingual embeddings retrieve TR↔EN natively, so hybrid mode can drop the per-prompt Haiku translation for the common case. Caveat: multilingual-LLM query expansion still helps on *hard* CLIR cases — keep it as an optional fallback, not the default path.

## Experimental Rollout

- New mode under the existing switch: `DREAMCONTEXT_RECALL_MODE=hybrid` (or `embed`), **default stays `haiku`/`raw`**. Off unless explicitly enabled, so it can be tested on specific machines only.
- `dreamcontext doctor` check for the embedding cache + model presence.
- A/B harness extends the frozen-corpus eval (`eval/`): same queries, BM25-only vs hybrid vs embed-only, across categories (exact-term, field-match, paraphrase, turkish, recency, topical-adjacency), reporting recall@1/3/5, MRR, nDCG@10, latency, and per-category deltas — so we can say *which is better and by how much*.

## Conditions to Make It Default (graduate from beta)

All must hold on the frozen gold sets:
1. Hybrid recall@5 and MRR **strictly beat** BM25-only.
2. **Exact-term and field-match recall@1 do NOT regress** below the current 100%.
3. Cold-start + warm latency acceptable on a CPU laptop (target: warm recall stays interactive).
4. No category regresses (same discipline that gated v2/v3).

## Prior Art (cited)

- **Hybrid > either alone:** Elastic BEIR — RRF +18% nDCG@10 over BM25, +1.4% over learned-sparse alone (`elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid`). BigData Boutique: "5–15% nDCG on BEIR" (`bigdataboutique.com/blog/hybrid-search-explained`).
- **RRF origin/formula/k:** Cormack, Clarke & Büttcher, SIGIR 2009; k=60 canonical (`paradedb.com/learn/search-concepts/reciprocal-rank-fusion`).
- **Dense fails on exact tokens:** BEIR (Thakur et al., NeurIPS 2021, `arxiv.org/pdf/2104.08663`); production failure-mode list — error codes, SKUs, identifiers, rare entities (`tianpan.co/blog/2026-04-12-hybrid-search-production-bm25-dense-embeddings`).
- **transformers.js / models:** HF transformers.js docs; `Xenova/all-MiniLM-L6-v2` (384-dim, ~22 MB, Continue.dev default); `intfloat/multilingual-e5-small`; TR-MTEB (`arxiv.org/html/2511.08376v1`); MDP Group Turkish embedder eval.
- **token_type_ids gotcha:** `github.com/huggingface/transformers.js/issues/267`.
- **Incremental cache:** LlamaIndex IngestionPipeline (doc_id + content-hash upsert/skip); LangChain CacheBackedEmbeddings (hash-as-key); Continue.dev `getComputeDeleteAddRemove` + SQLite `cachekey` + LanceDB (DeepWiki `continuedev/continue/3.4-codebase-indexing`). Counterpoint: Sourcegraph Cody **deprecated** embeddings because keeping them fresh was the costly part — our incremental cache is precisely what makes the dense layer worth it.
- **Embedded vector stores / crossover:** LanceDB ("SQLite for vectors"); sqlite-vec brute-force-only; vectorlite HNSW 3–30× faster; brute-force fine <50k, HNSW past 100k (Qdrant HNSW docs).
- **Chunking:** Chroma "Evaluating Chunking" (`trychroma.com/research/evaluating-chunking`); "Searching for Best Practices in RAG" (`arxiv.org/pdf/2407.01219`).
- **Cross-lingual dense vs LLM rewrite:** multilingual-e5 cross-lingual recall; "Generative Query Expansion with Multilingual LLMs" (`arxiv.org/html/2511.19325v1`) — LLM expansion still helps hard CLIR.
- **Eval:** Weaviate retrieval-eval-metrics; Elastic Bayesian-opt of RRF-k vs nDCG@10.

Full synthesized brief: session research agent `af52656747ba1e939` (2026-06-29).

## Related

- [[decisions/decision-link-aware-vs-embedding-recall]] — the deferral this supersedes.
- [[decisions/decision-mem0-vs-bm25-recall]] — the mem0 rejection this honors (local overlay, not a replacement).
- [[recall-engine-v2]] — BM25F backbone, decoupling invariant, eval harness this extends.
- [[haiku-recall-architecture]] — the per-prompt Haiku call hybrid mode may retire.

## Tasks (this knowledge file IS the umbrella — there is no epic task)

The "epic" is **this document**. The umbrella/organizing view lives in knowledge; only the buildable units live in `state/` as tasks. Implementation is tracked as six tasks under planning version **v0.11.0**, each of which references back here.

**Children — execution order:**
1. `feat-embedding-spike-pick-multilingual-model-validate-latency-and-token-type-ids` — de-risk the model (gates everything).
2. `feat-embedding-cache-engine-content-hash-chunk-cache-and-incremental-refresh` — the embed-on-change engine.
3. `feat-hybrid-recall-fusion-bm25-plus-dense-via-rrf-behind-flag` — RRF fusion behind the flag (needs 2).
4. `feat-embedding-ab-eval-harness-bm25-vs-hybrid-vs-dense-on-frozen-gold-set` — prove-it-or-kill-it A/B (needs 3).
5. `feat-sleep-semantic-dedup-nearest-neighbor-merge-instead-of-duplicate` — second consumer (needs 2).
6. `feat-embedding-beta-rollout-opt-in-flag-doctor-gitignore-docs` — safe on/off + docs (needs 3, 4).

**Dependency graph:** `1 → 2 → {3 → 4, 5}`; `6` needs `{3, 4}`.

**Umbrella acceptance — the whole layer is "done" when:**
- All six tasks complete and the A/B shows hybrid beats BM25-only on recall@5 + MRR with **zero exact-term regression**.
- Ships **OFF by default**; a single documented env flag enables it; opt-out users see no change.
- The embedding cache is gitignored and out of the npm files list; no vectors leave the machine.

(Graduation-to-default gates are in "Conditions to Make It Default" above.)

## Last Verified

2026-06-29 (decision + design authored; implementation not yet started).
