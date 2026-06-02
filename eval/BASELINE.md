# Recall BASELINE (frozen)

- Commit baseline measured at: `1a2b567` (branch `memory-uplift`)
- Date: 2026-06-02
- Scorer: **UNMODIFIED `recall.ts`** — raw BM25 (k1=1.5, b=0.75), flat haystack (title+desc+tags+body concatenated), no field weighting, no recency/status, no stemming, no synonyms, no link-awareness.
- Corpus: committed worktree `_dream_context` (knowledge + feature + task + memory + changelog).
- Gold set: `eval/gold.jsonl` — 60 queries across 7 categories, authored blind to the improvement plan (separate sub-agent, corpus-only).
- Metric: recall@1 / recall@3 = % of queries whose top-1 / top-3 hits include an acceptable target (`expected ∪ alt`); MRR = mean reciprocal rank (0-1).

```
category          | recall@1% | recall@3% |    MRR |     n
------------------+-----------+-----------+--------+------
overall           |      68.3 |      81.7 |  0.768 |    60
exact-term        |      83.3 |     100.0 |  0.917 |    12
field-match       |      87.5 |      87.5 |  0.900 |     8
mixed             |      83.3 |      83.3 |  0.875 |     6
paraphrase        |      41.7 |      75.0 |  0.624 |    12
recency           |      75.0 |      87.5 |  0.833 |     8
topical-adjacency |      83.3 |     100.0 |  0.917 |     6
turkish           |      37.5 |      37.5 |  0.375 |     8
```

## Weak spots (improvement targets, ranked by headroom)
1. **turkish — 37.5% recall@1 / 37.5% recall@3** (worst). No Turkish morphology today; agglutinative inflections are distinct tokens. -> B4 TR suffix folding.
2. **paraphrase — 41.7% recall@1 / 75.0% recall@3**. Synonym/reword gap ("login" vs "authentication"). -> B4 EN stemming + synonym map.
3. **recency — 75.0% recall@1**. No recency/status weighting; completed docs tie active ones. -> B3.
4. Strong already: exact-term, field-match, topical-adjacency, mixed (83-88% recall@1) -- must NOT regress (B2 BM25F, B4 precision guard).

This is the frozen "before" number the user asked for. The 02:00 agent re-measures after each change and reports deltas in `eval/RESULTS.md`. **Do NOT edit the gold set to inflate after-scores** -- overfitting guard.
