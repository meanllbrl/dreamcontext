---
id: handoff_memuplift
name: memory-uplift-handoff
description: >-
  RESUME HANDOFF for the memory/recall uplift goal-skill run. Paused by the user
  due to session limits; scheduled to resume at 02:00 on 2026-06-02. Read this
  file FIRST when resuming, then continue the goal-skill orchestration from
  Phase 2.
status: in_progress
updated_at: '2026-06-01'
tags:
  - handoff
  - resume
  - memory
  - recall
  - goal-skill
---

# RESUME HANDOFF — memory/recall uplift

## How to resume (do this first)
1. You are continuing a `goal-skill` orchestration. You are the ORCHESTRATOR (dispatch sub-agents; do not write production code yourself).
2. ALL work happens in the git worktree on branch **`memory-uplift`** at `/Users/mehmetnuraydin/projects/dreamcontext-memory-uplift`. If that path is gone, recreate it: `git -C /Users/mehmetnuraydin/projects/dreamcontext worktree add /Users/mehmetnuraydin/projects/dreamcontext-memory-uplift memory-uplift`, then symlink node_modules from main (`ln -s …/dreamcontext/node_modules …/dreamcontext-memory-uplift/node_modules` and the same for `dashboard/node_modules`). DO NOT `npm install` (it would mutate main's shared node_modules via the symlink). Main repo is in active use by the user — never edit main.
3. Tests run via **vitest against worktree `src/`**, never the global `dreamcontext` binary (it points at MAIN's dist).
4. The full roadmap (context) is at `_dream_context/state/memory-engine-360-roadmap.md` (committed to this branch).

## Goal (one sentence)
Implement ALL high-uplift memory/recall + continuous-capture improvements (roadmap Wave 0+1+2 and memory-relevant 3/4), prove the recall uplift with a deterministic before/after percentage benchmark (recall@1/@3/MRR), make the full `npm test` + `npm run build` green, and deliver a clear "X% → Y%" report. Thoroughness over speed (10h acceptable). Iterate until recall is dramatically better.

## Validation method (the "done" contract)
(a) Deterministic recall eval harness reporting recall@1 / recall@3 / MRR as a percentage, baseline measured on unmodified code then re-measured after each change, must show a material jump with no category regressing >3 points; (b) full `npm test` green; (c) `npm run build` succeeds.

## ✅ STATUS: COMPLETE (2026-06-02, all in one session — the 02:00 resume is NOT needed for implementation)
**All batches implemented, tested, reviewed, committed and pushed to `memory-uplift`. See `eval/RESULTS.md` for the before/after report.**
- **Phase 0–1**: DONE.
- **Phase 2 (plan review)**: the OPEN FINDING below was resolved (option iii — multipliers feed a derived `rankScore`; raw `hit.score` is untouched so the hook gates stay calibrated).
- **Phase 3 (task)**: this handoff + roadmap serve as the task record.
- **Phase 4 (implement)**: Batch 0 `f560fd8`, Batch 1 `a56f9d4` (+tests `125e029`), Batch 2 `a5edce7`, Batch 3 `1451ab5`.
- **Phase 5 (review)**: clean-context `reviewer` ran; 2 fixes applied in `e31b2e3` (BM25-fallback gate `.some()`; sanitize digest `session_id`).
- **Phase 6 (validate)**: `npm test` 1038/1038 green; `npm run build` clean; recall benchmark **overall recall@1 68.3→85.0%, recall@3 81.7→95.0%** (turkish 37.5→75.0, paraphrase 41.7→66.7), no category regressed.

**If you are the 02:00 (or any) resume agent: implementation is already done.** Do NOT re-implement. Optionally: independent fresh-clone verification (`npm install && npm test && npm run build && npx vitest run tests/unit/recall-eval.test.ts`) and confirm the RESULTS.md numbers reproduce; do not change code unless a check fails.

## OPEN FINDING — RESOLVED (kept for the record)
**Score-scale coupling.** B2/B3/B4 change scoring, but the hook uses hard thresholds on `hits[].score` (BM25 fallback `>= 2.0`, skill gate `1.0`, explore `5/2`). **Resolution shipped (option iii):** all new signals (field weighting, recency, status, synonyms, link-aware) feed a derived `rankScore` used only for ordering; `hit.score` stays raw flat-BM25 so the gates are unaffected. Regression-locked by `tests/unit/recall-weighting.test.ts`. Phase-5 review additionally fixed the BM25-fallback gate to use `hits.some(h=>h.score>=2.0)` (a strong raw match could otherwise sit below a rank-reordered doc).

## Implementation order (re-measure where noted)
Batch 0 (harness + gold set + freeze BASELINE) → B1 → B2 (re-measure) → B3 (re-measure) → B4 (re-measure, watch precision) → B6 (unit) → B5 (synthetic fixture, off by default) → Batch 2 continuous-capture (re-measure no-regression) → Batch 3 supporting. Each batch = its own commit on `memory-uplift`. WAVE-1/Batch-2 should get a short feature PRD before implementation.

## THE VALIDATED PLAN (verbatim)

### BATCH 0 — Measurement instrument (build + freeze baseline FIRST)
- CREATE `eval/gold.jsonl`: 60 queries, schema `{id,query,expected:[type/slug],alt:[...],category,lang}`. Categories: exact-term(12)/paraphrase(12)/turkish(8)/mixed(6)/recency(8)/field-match(8)/topical-adjacency(6). **Authored by a SEPARATE sub-agent that reads ONLY the corpus (not the Batch-1 design) to avoid overfit.** `expected[0]` must resolve to a real stable docKey (prefer knowledge/feature/task/memory slugs; changelog only as `alt`).
- CREATE `eval/BASELINE.md`: frozen pre-change recall@1/@3/MRR aggregate + per-category table + git SHA. Regenerated only by an explicit reviewed step.
- CREATE `tests/unit/recall-eval.test.ts`: pure vitest, no network/Haiku. Loads gold, `buildCorpus(<worktree _dream_context>)` resolved via `import.meta.url`, runs `bm25Search(query,corpus,10)` per query, computes recall@1/@3/MRR overall+per-category, prints % table via console.log, asserts threshold floors set at BASELINE (floors-not-snapshots so corpus growth doesn't break it). Self-check assertion: every gold `expected[0]` resolves to a real docKey.
- ADD `export function docKey(doc): string` = `` `${doc.type}/${doc.slug}` `` to `recall.ts` (shared key format).
- CREATE `eval/harness.ts`: `loadGold/evaluate/formatReport` shared by the test and an optional `scripts/recall-bench.ts` (the script is YAGNI-guarded — skip if the test already prints clearly).

### BATCH 1 — Recall engine (no new deps)
- **B1 recursive glob + product**: `recall.ts:60` `'*.md'`→`'**/*.md'`; add `product?:string` to `CorpusDoc`, derived from `knowledge/products/<name>/…` path. Test: nested doc indexed with correct product.
- **B2 BM25F**: add `FIELD_WEIGHTS={title:3,tags:2,description:2,body:1}`; replace the flat `haystack` (recall.ts:70) with per-field weighted `termFreq` via a shared `buildFields()` used by all 4 loaders (loadMarkdownDocs/loadChangelogEntries/loadMemoryFile/loadSkillDocs); `dl` = unweighted union length (document the choice). `bm25Search` shape unchanged (reads `termFreq`).
- **B3 recency/status**: add `status?`,`updatedAt?` to `CorpusDoc`; `STATUS_PENALTY={completed:0.6}`; `recencyMultiplier(updatedAt,now,halfLifeDays=120)`→`[0.75,1]`; apply as a post-BM25 multiplier (see OPEN FINDING — decide whether it mutates `score` or a separate rank field). Add optional `bm25Search(query,corpus,topK,opts?:{now?:Date})` for deterministic tests; the 4 existing callers keep working via the optional param. Test: completed down-weighted; recent tie-break; but an extra exact term still beats a recency-only edge.
- **B4 stemming + synonyms**: `tokenize()` adds conservative EN suffix strip (`-s/-es/-ing/-ed`, len>4) + TR suffix folding (`-ler/-lar/-de/-da/-den/-dan/-nin/-nın/-nun/-nün/-yi/-yı`, len>4). CREATE `src/lib/recall-synonyms.ts` (`SYNONYMS` map: auth↔authentication, db↔database, recall↔search/retrieval, sleep↔consolidation, bookmark↔ripple/salience, …). Query-time expansion in `bm25Search` with `SYNONYM_WEIGHT=0.5`; index untouched so BASELINE stays comparable. **Highest precision risk — if exact-term/field-match drop >3pts, dial back.**
- **B6 Haiku relevance-rank**: `recall-query-extractor.ts:70-74` replace the 8000-char positional slice with a `bm25Search` pre-pass top-100, then `buildCorpusIndex(subset)`; keep `MAX_INDEX_CHARS` as a safety clamp. Test: on a >100-doc fixture the gold slug appears in the index string handed to the MOCKED executor (no `claude` CLI call).
- **B5 link-aware** (corpus has ~0 real wikilinks → no live-metric effect): add `links:string[]` (parse `[[slug]]`), `buildLinkAdjacency()`, bounded 2-hop 0.3-decay boost gated `opts.linkAware` DEFAULT OFF. Unit-test on a synthetic fixture only; ship off (honors the decision-doc deferral discipline).

### BATCH 2 — Continuous capture
- **C1**: CREATE `src/lib/session-digest.ts` (`buildDigest(distilled,maxBytes=8000)` pure+bounded; `writeDigest/digestExists/loadDigestDocs`). Run on the **SessionStart catch-up loop** (hook.ts:454-471), NOT synchronous Stop; try/catch so it can never break the hook. Digests → `state/.session-digests/<id>.md` frontmatter `type:session-digest`.
- **C2**: CREATE `src/lib/salience.ts` `detectSalience(distilled)` — structural detectors over the already-parsed `DistilledSection`: user-correction (`no/actually/wrong/instead/hayır/yanlış/değil`) → salience 2; error→fix → salience 1; decision keyword (`decided/chose/switched to/karar/seçtik`) → salience 2. Dedup + cap 5. Append auto-bookmarks in SessionStart. Test: each detector + zero false positives on a clean session.
- **C3**: `buildCorpus` += `loadDigestDocs` (type task) + `loadBookmarkDocs` (from `.sleep.json` bookmarks, type memory, slug `bookmark#<id>`) so salient moments are recallable BEFORE sleep. **NOTE for eval integrity:** the eval harness must measure a STABLE committed corpus — ensure no generated digests/bookmarks leak into the eval run (the worktree `_dream_context` has none committed; keep it that way, or point the eval at a fixed snapshot).
- **C4**: recall hit → bump `knowledge_access` for `type==='knowledge'` hits using the exact `knowledge touch` write; extract `bumpKnowledgeAccess(state,slug)` into `sleep.ts`, used by both `knowledge.ts touch` and the hook. Persist state once.

### BATCH 3 — Supporting correctness
- **D1**: add `dreamcontext memory recall` + `dreamcontext transcript distill` to the explore Bash allowlist in `agents/dreamcontext-explore.md:124`, `.codex/agents/prompts/dreamcontext-explore.md:101`, and the `.codex` `.toml` `developer_instructions`.
- **D2**: register a 2nd PreToolUse hook `matcher: 'Edit|Write|MultiEdit'` at `install-skill.ts:183` (keep the `Agent` entry for the explore gate); confirm whether pipe-alternation is supported or 3 separate entries are needed. Test: install manifest includes the entry; `.env` write yields `permissionDecision:'deny'`.

### ACCEPTANCE CRITERIA
`npm run build` exit 0; `npm test` exit 0; `recall-eval` prints the % table; `eval/BASELINE.md` committed; gold 50–80 lines all parse and every `expected[0]` resolves; CLAIM thresholds: overall recall@3 ≥ BASELINE+5pts (reported, not hard-asserted), recall@1 ≥ BASELINE (hard floor), no category drops >3pts; all per-feature unit tests green; D1 grep; D2 manifest+deny test.

### RISKS (carry forward)
R1 overfit (independent gold author; floors-not-snapshots; tune on aggregate only — a +5 on 60 queries is suggestive not proof, report honestly). R2 stemming precision. R3 recency burying decisions. R4 global binary→MAIN dist (tests use worktree src only). R5 link-aware no-op (fixture + off). R6 Stop latency (moved to SessionStart catch-up). R7 symlinked node_modules (no npm install). R8 optional-param caller compat. **R9 (new, see OPEN FINDING): score-threshold coupling in the hook.**

### OUT OF SCOPE
Embeddings/vector overlay; WAVE 3 (sub-agent write-back / recall-in-briefing / sleep harvesting) and most of WAVE 4 (PreCompact content summary, corpus-index caching, substance-weighted debt, security secret-scan hook); real wikilink authoring; dashboard; auto-sleep.

## Changelog

### 2026-06-01 - Session Update
- Batch 2 (continuous capture C1-C4) implemented: session-digest.ts (buildDigest/writeDigest/digestExists/loadDigestDocs), salience.ts (detectSalience), recall.ts buildCorpus now folds digests (task) + .sleep.json bookmarks (memory), SessionStart catch-up loop mines digests+auto-bookmarks (off Stop path), bumpKnowledgeAccess extracted to sleep.ts and called by knowledge touch + hook recall block. recall-eval unchanged at 85.0/95.0/0.903; full suite 1038 green.
- 2026-06-02: Paused at Phase 2 (plan review re-run needed) due to session limit. Handoff written; resume scheduled for 02:00.
