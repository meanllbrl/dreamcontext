---
id: decision-mem0-vs-bm25-recall
name: "Decision: mem0 (rejected) vs BM25 (adopted) for memory recall"
description: "Why dreamcontext chose deterministic BM25 over the curated corpus instead of integrating mem0. Captures the 3-reviewer adversarial process, the 5 reviewer-converged issue categories, the 20-query benchmark results, and the Path A architecture summary."
tags: ["decisions", "architecture", "memory", "topic:recall"]
pinned: false
date: "2026-05-23"
---

## Why This Exists

In May 2026 the user proposed integrating [mem0](https://github.com/mem0ai/mem0) (a vector-store memory layer with LLM-extracted facts) into dreamcontext, with a CLI surface of remember/recall/update/delete. After a full adversarial review the proposal was rejected and a deterministic BM25 alternative ("Path A") was shipped. This file traces the decision so future sessions don't relitigate it.

**There is no fallback to mem0; this decision is canonical.** If the question comes up again, read this file before re-running the analysis.

## The Process

1. Edge case enumeration agent: 150 ECs across 21 categories.
2. Planning agent: 830-line plan with 15 architectural decisions (D1–D15), 26 implementation tasks (T1–T26), 10-item risk register.
3. Three reviewer agents dispatched in parallel with **different mandates**:
   - **critic** — find holes, unsupported claims, hidden assumptions, missed edge cases.
   - **pragmatist** — challenge scope, recommend cuts, estimate MVP boundaries.
   - **security** — find data loss, secret leakage, corruption, concurrency hazards.
4. All three reviewers REJECTED the plan independently.
5. User chose Path A (BM25 over curated corpus); reviewers' pragmatist explicitly endorsed this.

## The 5 reviewer-converged issue categories

These are the issues all three reviewers surfaced (from different angles), which made them load-bearing:

### 1. Python + Ollama runtime cliff fatal for npm distribution
- dreamcontext is `npm install -g dreamcontext` → works. mem0 stack requires Python 3.10+ (macOS default is 3.9), PEP 668 externally-managed Python issue on Homebrew, Ollama install (5GB), Ollama daemon running, ~150MB per project.
- Critic estimate: kills ~40% of macOS dev environments without troubleshooting. For 95% of dreamcontext users, the v1 outcome is "install, never run `memory init`, ship dies on the vine."

### 2. Determinism tier (soul/user/memory) would leak into vector store
- Original plan's D6 said "don't index determinism tier" but D13 (init protocol) explicitly indexed soul/user/memory. The plan tried to "dedup at recall time" — worst of both worlds.
- Also depended on a `pinned: true` frontmatter field dreamcontext doesn't have.
- Consequence: secrets in soul.md (api keys, paths, hostnames) would end up in Qdrant vectors despite redaction.

### 3. Sleep-finalizer agent would reverse the just-shipped 5→3 specialist collapse
- v0.3.0 collapsed sleep from 5 specialists to 3 (sleep-tasks + sleep-state + sleep-product) because parallel agents help wall-clock time only to the slowest lane.
- mem0 plan invented a 4th `sleep-finalizer.md` agent to handle diff-driven mem0 sync, undoing the collapse without acknowledging it. Should have been one CLI line in the SKILL.md Sleep flow, not a new agent.

### 4. Every mem0 add() is 1.5–4s non-deterministic LLM call with unreliable dedup
- mem0's native add() does LLM-driven fact extraction + similarity search + ADD/UPDATE/NOOP decision. Per mem0's own README and reference: 1.5–4s with local Ollama, 0.6–1.5s with OpenAI.
- mem0's dedup is documented (gotcha #4 in mem0 docs) as **unreliable** at high relevance — produces near-duplicates that have to be reconciled manually. Plan secretly bypassed this with delete-then-add (D7), abandoning history.db audit trail.
- Translation: the "auto-dedup" value-prop dreamcontext could have claimed is a fiction.

### 5. Five critical security blockers (security reviewer's CRIT-1 through CRIT-5)
- **CRIT-1**: redaction runs BEFORE mem0.add() but mem0's LLM paraphrases input — secret survives in the extracted text. Must redact extracted output too.
- **CRIT-2**: vectors with public `nomic-embed-text` weights are partially invertible (Pan et al. 2020) — 30–60% token-level reconstruction feasible. `_dream_context/.mem0/` is credential-class, not config-class. "Gitignored therefore safe" is wrong.
- **CRIT-3**: `git rebase` past `last_sync_commit` orphans facts in mem0 with no recovery path. Plan's "fall back to full re-extract" doesn't recover the orphaned facts.
- **CRIT-4**: sleep-finalizer crash mid-batch produces state.json + audit.jsonl + Qdrant divergence; plan contradicts itself on audit-write ordering.
- **CRIT-5**: `provider: "openai"` key in state.json + `OPENAI_API_KEY` env = silent cloud upload of all knowledge files on next sleep cycle. No consent UX.

## Why Path A wins for dreamcontext specifically

dreamcontext's content is **already curated atomic facts**: knowledge files written by sleep-product, feature PRDs with structured sections, closed task files, LIFO 2.memory.md entries written by sleep-state. The whole pipeline is designed to keep facts atomic and discoverable.

mem0's central value is LLM-extracted facts from unstructured conversational input. **It is solving a problem dreamcontext has already solved.** With curated atomic facts, semantic search adds little; the failure mode of BM25 (no synonym matching) is rare because knowledge file slugs and tags already canonicalize vocabulary.

Pragmatist reviewer summarized it: "BM25 keyword search may be a stronger move than mem0 for v0.5 — consider this honestly before committing."

## What was shipped (Path A summary)

- **CLI**: `dreamcontext memory recall <query>` (BM25 top-K), `remember`, `update`, `delete`, `list`, `status`. Zero new npm dependencies (uses existing `fast-glob` + `gray-matter`).
- **Library**: `src/lib/recall.ts` — corpus loader (knowledge + features + tasks + 2.memory.md LIFO sections), light TR/EN tokenizer, BM25 scorer (k1=1.5, b=0.75), snippet extractor.
- **Hook integration (default ON, Haiku mode as of 2026-05-26)**: UserPromptSubmit hook auto-injects top-3 hits per non-trivial prompt. Originally raw BM25 (default-on since 2026-05-23). Upgraded to Haiku single-call mode: a single `claude --model haiku -p` call receives the full prompt + corpus index (slug/desc/tags, ≤8K chars), returns 0–3 relevant doc keys. Falls back to raw BM25 if `claude` CLI unavailable. Opt-out: `DREAMCONTEXT_MEMORY_HOOK=0`. Mode selection: `DREAMCONTEXT_RECALL_MODE=haiku|raw|off` (default: `haiku`).
- **Storage**: NONE. The corpus is the live `_dream_context/` files; the inverted index is rebuilt in-memory per query. No cache invalidation bugs possible.

## Haiku Mode — Evolution, Not Reversal

The 2026-05-26 Haiku upgrade does NOT change the Path A decision. BM25 remains the fallback and is still used for direct `dreamcontext memory recall` CLI calls. Haiku mode is an intent-extraction layer on top of BM25: instead of tokenizing the raw prompt into BM25 queries, Haiku understands intent across languages and vocabulary variants, then resolves to the same BM25 corpus. The `recall.ts` library is unchanged; only the hook's query strategy changed. The Path A architecture (curated corpus, deterministic ranking, zero new persistent deps) is unchanged. See `knowledge/haiku-recall-architecture.md` for the full Haiku design.

## Benchmark (2026-05-23)

20-query benchmark on dreamcontext repo's 44-doc corpus (6 knowledge, 13 features, 22 tasks, 3 memory entries). Mix of specific, oblique, vague, mixed-language (TR/EN), and one negative-control query.

| Metric | Result |
|---|---|
| Top-1 (correct doc is rank 1) | 18/19 = **94.7%** |
| Top-3 (correct doc in top 3) | 19/19 = **100%** |
| Top-5 (correct doc in top 5) | 19/19 = **100%** |
| Negative control (should return no/weak hits) | 0/1 passed — false positive on "quantum cryptography blockchain" matching the new PRD due to "embedding inversion" content; fix: raise score threshold from 2.0 to ~3.0 |
| Cold start latency | <100ms on M-series Mac |

## Conditions under which to revisit

This decision should be re-opened ONLY if:
1. The corpus grows past ~500 docs AND benchmark recall@5 drops below ~85% on a hand-built 30-query eval set.
2. A measurable user complaint emerges that synonym recall ("ML practitioner" vs "data scientist") is missing, on at least 5 distinct cases, AND BM25 + a small synonym dictionary can't close the gap.
3. A fundamentally cheaper local-embedding library emerges that doesn't require Python or Ollama (e.g., `@xenova/transformers` in Node with a 30MB MiniLM model). Even then: it should be an OVERLAY on the BM25 layer, not a replacement.

## Sources

- Original plan: `/tmp/dreamcontext-mem0-plan.md` (session-scoped, may not persist).
- Three reviewer reports: `/tmp/review-{critic,pragmatist,security}.md` (session-scoped).
- mem0 technical reference: `/tmp/mem0-reference.md` (session-scoped).
- Decision synthesis: `/tmp/dreamcontext-mem0-decision.md` (session-scoped).
- Feature PRD (canonical, persistent): `_dream_context/core/features/memory-recall-bm25.md`.
- Related pattern knowledge: `three-reviewer-parallel-mandates-pattern.md`.

## Last verified

2026-05-26.
