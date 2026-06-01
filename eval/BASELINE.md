# Recall BASELINE (frozen)

- Commit: 3a1193d
- Date: 2026-06-02
- Scorer: UNMODIFIED recall.ts (raw BM25, k1=1.5 b=0.75, flat haystack, no field/recency/synonym weighting)
- Corpus: committed worktree `_dream_context` (knowledge+feature+task+memory+changelog)
- Gold set: eval/gold.jsonl (60 queries, 7 categories), authored blind to the improvement plan
- Metric: recall@1 / recall@3 are % of queries whose top-1 / top-3 hits include an acceptable target (expected ∪ alt); MRR is mean reciprocal rank (0-1)

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
```

## Weak spots (improvement targets)
- **paraphrase 41.7% recall@1** — synonym/reword gap (B4 stemming+synonyms target)
- **turkish** — no TR morphology today (B4 TR suffix folding target)
- **recency 75.0% recall@1** — no recency/status weighting (B3 target)

This is the frozen \"before\" number. The 02:00 agent re-measures after each change and reports deltas in eval/RESULTS.md. Do NOT edit the gold set to inflate after-scores.
