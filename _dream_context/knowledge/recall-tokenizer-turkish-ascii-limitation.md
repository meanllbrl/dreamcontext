---
id: know_HtQQQKr9
name: recall-tokenizer-turkish-ascii-limitation
description: >-
  The shared BM25 tokenizer in src/lib/recall.ts cannot bridge Turkish prose to
  ascii filenames: inconsistent suffix stripping plus no ascii folding. Still
  open for ordinary recall — the patterns layer routed around it rather than
  fixing it, because tokenize() is pinned to a tuned eval baseline.
tags:
  - 'topic:recall'
  - 'domain:recall'
  - architecture
  - decisions
pinned: false
date: '2026-09-10'
---

# Recall tokenizer: the Turkish/ascii limitation (still open)

## Why this exists

This documents a **still-open defect in the shared BM25 tokenizer** (`tokenize()` in `src/lib/recall.ts`), discovered while building patterns auto-injection. It is deliberately NOT a property of the patterns feature: the patterns layer *routed around* this limitation with its own folder, so the defect remains fully in force for every ordinary recall path. Anyone reading `knowledge/features/patterns-auto-injection.md` and concluding "the Turkish problem was fixed" would be wrong — the feature works precisely because it does not use this tokenizer.

## The defect

One Turkish word, three different stems, no meeting point:

| Input | Where it comes from | `tokenize()` output |
|---|---|---|
| `özetle` | the user's prompt ("özetle" = "summarize it") | `özetl` |
| `ozeti` | the ascii filename `plan-ozeti.md` | `ozeti` |
| `özeti` | the diacritic title inside the file | `özeti` |

Three stems for one concept. Nothing links them, so a user typing `özetle` can never retrieve `plan-ozeti.md` by name — the retrieval that ought to be the *easiest* one in the corpus.

### Two compounding defects, not one

1. **Inconsistent suffix stripping.** The Turkish stemmer strips `-le` from `özetle` (→ `özetl`) but leaves `-i` on `özeti`. Query and index therefore land on different stems even when both sides carry diacritics. This is a stemmer-consistency bug independent of any encoding question.
2. **No ascii folding at all.** `tokenize()` keeps Turkish characters in its character class (`[^a-z0-9çğıöşü_\-\s]`) and never folds them. So `özeti` and `ozeti` are unrelated tokens. This is not a missing capability in the repo — **`foldAscii()` already exists** in `src/lib/fold-ascii.ts` and is used by six other subsystems (`doctor`, `tasks`, both task backends, `member-match`, `patterns`). The recall tokenizer is the one place that does not call it.

Either defect alone would break the retrieval. Both together mean there is no single-line fix.

## Why it was NOT fixed

`tokenize()` is **pinned to a tuned eval baseline.** It is the shared entry point for every BM25 path in the product — knowledge, features, tasks, memory, changelog, objectives, insights, theses, automations, plus federated peers. Changing the stem function changes every document's token set and therefore every score in the corpus, so "fixing one caller" is not available: the only way to change it is to change all of recall at once and re-establish the baseline.

Against that risk, the patterns feature needed the bridge for exactly one narrow purpose (identity keys derived from a pattern's filename + H1). So `src/lib/patterns.ts` got its own `foldKey()` — ascii-first, with aggressive Turkish suffix stripping and 1-character prefix tolerance — and the global tokenizer was left untouched. That was the right call for that feature. It is not a fix for this defect.

## This STILL EXISTS today

For ordinary recall — `dreamcontext memory recall`, the UserPromptSubmit recall hook, the snapshot's warm-knowledge selection, federated peer search — a Turkish query still cannot reach an ascii-named file, and a diacritic query still stems inconsistently against a diacritic document. No mitigation is in place on that path. Assume any Turkish-language recall of an ascii-slugged document fails.

## What a future fix must carry

A fix is a **recall-wide change**, budgeted as such:

1. **Fold BOTH sides.** Query-side folding alone makes it worse: the index would still hold `özeti` while queries produce `ozeti`. Query and index must be folded by the same function, and the index must be rebuilt so no stale token sets survive the change.
2. **Republish the eval baseline.** The current tuned numbers are invalidated by definition. Re-run the eval, accept the new operating point explicitly, and publish it the way the patterns layer published its 14/14-hits / 13-of-15-silent measurement — a number in the repo, not a "no regressions" claim.
3. **Fix the stemmer inconsistency separately from the folding.** They are independent bugs; fixing folding alone still leaves `özetl` vs `özeti`. Land them as distinguishable changes so a regression can be attributed.
4. **Decide the fate of `patterns.ts`'s folder.** Once `tokenize()` folds ascii, `foldKey()` is partially redundant — but only partially: it is deliberately *more* aggressive (heavier suffix stripping, prefix tolerance) than a general-purpose recall tokenizer can safely be, because a false-positive identity key costs one wrong pattern injection while a false-positive recall token costs corpus-wide precision. The decision is whether it collapses back in, stays as a stricter sibling, or keeps only its prefix-tolerance layer. Do not assume it collapses.

## Sources

- `src/lib/recall.ts` — `tokenize()` (L342), `stemToken()` (L333)
- `src/lib/fold-ascii.ts` — `foldAscii()`, the folder that already exists and is not called here
- `src/lib/patterns.ts` — `foldKey()` (L152), the feature-local workaround
- `knowledge/features/patterns-auto-injection.md` — Constraints & Decisions, "The global BM25 tokenizer was deliberately NOT touched"

**Last verified:** 2026-09-11 (defect confirmed present in `src/lib/recall.ts` at this date).
