---
id: recall-maintenance-2026-10-plan
name: "Recall maintenance plan (2026-10): Haiku out, hybrid default, quality + latency"
description: "Validated goal-skill plan (plan-review SOLID: pragmatist r3, critic r5) for removing the Haiku recall mode, making hybrid the default, repairing eval gold sets, ranking fixes, latency cuts and model screening, measured on the dc and h-f brains."
tags: ["plans", "topic:recall", "domain:knowledge"]
date: "2026-10-07"
---

# Recall maintenance plan, revision 4: remove Haiku, make hybrid the default, raise quality and cut latency

Read-only throughout. All [DECIDED] items from round 3 are applied as stated, and the fold-ins are applied too.

The main change is the hook latency gate. The critic measured the recall-free hook at ~0.42 s, against ~1.8 s for raw recall, so the old 400 ms target can't be reached. The new gate measures the recall overhead above that floor.

## 1. Diagnosis confirmation (verified in code)

**Haiku surface:**
- `RECALL_MODES` at `src/cli/commands/sleep.ts:1247`; `'haiku'` defaults at `:115`, `:151`, `:1260`, `:1274`; `recall on` writes haiku at `:1291`.
- Mirrors: `src/server/routes/sleep.ts:19` and `:104`, `src/lib/sleep-consolidation.ts:167`, `useSleep.ts:40` and `:115`, `SettingsPage.tsx:61` and `:195`.
- Hook: the Haiku branch is `hook.ts:2488-2501`; the gate at `:2522` lets `mode==='Haiku'` skip the `score>=2.0` check.
- `GET /api/recall/haiku` (`server/index.ts:210`, `:376`; `routes/recall.ts:150`) has one consumer, `haikuRecallOnce` (`useRecall.ts:97`), used by `BrainSearch.tsx` and `CommandPalette.tsx`.
- `recallEnvFor` at `agent-chat.ts:346`.
- Comments: `install-skill.ts:266`, `tests/integration/cli-commands.test.ts:902`, `tests/unit/auto-sleep-runner.test.ts:296`.
- Fixtures: `auto-sleep-runner.test.ts:325` and the others listed under T3.
- `jev-verify` assertions: `skill-packs/jev-verify/SKILL.md:102`, `examples/settings-recall.json:14`.
- Extractive Ask uses `recallOnce` with no LLM call, so it is unaffected.
- `agents/dreamcontext-explore.md:9` and `skill-packs/council/SKILL.md:187` mention `haiku` as a model choice, not recall, so they stay.

**Hybrid still labelled experimental:** `embed.ts:53` and `:62`, `sleep.ts:1278`, `:1320`, `:1326`, `hook.ts:2503`, `SettingsPage.tsx:63` and `:608`, `I18nContext.tsx:933`, plus the "opt-in" header comments in `hybrid.ts:6-19` and `store.ts`.

**Latency:**
- **BM25 search** (`embed-ab` times it on a corpus that's already built):
  - `extractSnippet` runs for every scored doc (`recall.ts:1233`).
  - Document frequencies, `avgdl` and `avgFieldLen` are recomputed per query (`:1133-1143`).
  - Synonym stems are recomputed per query (`recall-synonyms.ts:163`). `recall.ts:7` imports `recall-synonyms`, so the reverse import would be circular.
- **Hook, as measured by the critic** (dist CLI, live dc vault):
  - raw recall ≈ 1.8 s
  - with `DREAMCONTEXT_MEMORY_HOOK=0` ≈ 0.42 s (the recall-free floor)
  - `--version` ≈ 0.16 s
  - So recall costs ≈ 1.4 s per prompt: `buildCorpus` + `bm25Search` + the cross-vault read inside the recall block.
- **Hybrid in the hook** adds two full `cache.json` parses (`store.ts:169` and inside `refreshEmbeddings`) plus the ~1 s model load. `refreshEmbeddings` mutates the loaded cache in place (`store.ts:484-485`).

**Model swap:**
- The cache key is the model id only (`store.ts:85`).
- Hard-wired to e5: `isEmbedModelDownloaded` checks the q8 onnx file only, `EMBED_DIMS=384` is fixed, and the e5 prefixes are hardcoded.
- The models directory comes from `homedir()` (`embedder.ts:25`), so an empty `HOME` simulates a machine with no model.

**Eval gaps:**
- The root is hardcoded (`embed-ab.ts:21`).
- No clock is pinned (recency affects `rankScore`), and no warm-up query is discarded.
- The integrity test checks only `expected[0]` of `gold.jsonl`.
- The Turkish categories are tiny: n=8 on train, n=10 on held-out.

**Provisioning gaps:**
- The sleep refresh needs a cache to already exist (`sleep.ts:949`).
- `ensureIndexBuilt` runs only for the Assistant (`agent-chat.ts:1272`).
- `doctor`, `update` and `init` don't know embeddings exist.

**Infrastructure to reuse:**
- `dreamcontext builder heavy` (`builder.ts:159`).
- `acquireFileLockWithin`/`releaseFileLock` (`src/lib/file-lock.ts`).
- `tests/setup/isolate-spawn-env.ts`, already the vitest `setupFiles` entry.

**Not re-verified:** the Turkish-task and board hijack examples come from your brief. T7 re-confirms them on train.

## 2. File-by-file plan

### Execution rules (apply to every task)

**Checkout and build discipline:**
- No git worktrees.
- Builders run only their lane's tests and the type-check, via `dreamcontext builder heavy -- npx vitest run <files>` and `dreamcontext builder heavy -- npx tsc --noEmit -p .`. They never run the build, the full suite, integration tests or generators.
- The orchestrator runs every gate, every build, the generators (`gen:cli-manifest` at the W1 and W3 gates) and `dreamcontext update`.

**Timing discipline:**
- Every timing-sensitive command runs under `dreamcontext builder heavy`: G1/G2 latency runs, the T4 profiles, `hook-latency` and the T6 index builds.
- Search latency = the **mean after discarding one warm-up query per mode**, computed the same way in G1, G2 and T6.

**Held-out isolation:**
- New held-out gold sets and all per-query output live under `~/.dreamcontext/eval-frozen/{gold,runs}`. Repo `eval/runs/*.json` files hold aggregates only.
- The old `eval/gold-heldout.jsonl` stays in the repo.
- To be honest about it: any builder with filesystem access *could* read these paths. Isolation rests on the orchestrator never passing them and the tuner prompts (T7, T10) forbidding them. Tuners pass only train paths.

**Shared files:** another session has uncommitted work in some of these files (`recall.ts`, `embed.ts`, `agent-chat.ts`, `useRecall.ts`, `README.md`, `memory-recall-bm25.md`, `recall-engine-v2.md`). Those get surgical edits only, never reverts or reformatting. No commits.

**Exit paths [DECIDED]:**
- **G2 fails for a non-model reason:** never retune against held-out. The orchestrator either reverts the offending change set wholesale (resuming that task's implementer with "revert X") and reruns G2, or escalates to you with the per-query flips. Real rework afterwards needs a fresh blind held-out from T2.
- **G2 fails after a model switch:** revert to e5 and rerun G2.
- **The hook raw gate is unreachable** according to the G1 and T4 Step 0 profiles: escalate right after T4 Step 0.
- **T4 misses its BM25 target after Step 3:** escalate. No silent growth in scope, e.g. no persisted inverted index without approval.
- **The search-hybrid 3× gate or the hook-hybrid gate isn't met within T10's 3 rounds:** escalate.

### G0 · Freeze the corpora and pin the clock (orchestrator)

- `rsync -a --exclude .embeddings --exclude .recall-cache --exclude .git` both brains to `~/.dreamcontext/eval-frozen/{dc,hf}-20261007/_dream_context`. `-a` keeps mtimes, which whiteboard `updatedAt` depends on.
- Write `~/.dreamcontext/eval-frozen/now.txt`, one ISO timestamp.
- **Index-build cost estimates:**
  - e5 index: about 4 minutes for dc (1385 docs) and 6–8 minutes for h-f (~2200 docs).
  - Each T6 candidate needs its own frozen copy. EmbeddingGemma q8 runs about 3× e5's time (roughly 12–25 minutes per corpus); granite is about the same as e5.

### T1 · Eval infrastructure + gold repair

**`eval/harness.ts`:**
- `stableCorpus(root)` and `loadNow(arg?)`.
- `evaluateSearch` gains `warmup = 1`: one untimed query per mode before the timed loop. Latency reports the post-warm-up mean/p50/p90.

**`scripts/embed-ab.ts`:**
- Flags:
  - `--root`, `--gold` (repeatable), `--modes`, `--now` (forwarded as `opts.now` to `bm25Search` and `hybridSearch`).
  - `--json` (aggregates and ranks only).
  - `--per-query <path>`, which refuses any path not under `~/.dreamcontext/eval-frozen/runs/`.
  - `--dump-topk <path>`: top-10 keys, rankScore and snippet per query, written only under `eval-frozen/runs/`.
  - `--build-timing`: `buildCorpus` p50 over 10 runs.
  - `--checksum <out>`: sha256 of every frozen corpus file, excluding `.embeddings` and `.recall-cache`.
- Fix the false "git-tracked" comment.

**`scripts/recall-ab.ts`:** add `--root` and `--now`, and use the shared `stableCorpus`.

**`scripts/hook-latency.ts`** (new). Flags: `--root`, `--prompts`, `--mode hybrid|raw|floor`, `--n 30`, `--no-model`.
- One-line guard: the root must sit under the frozen directory.
- One scratch copy of the frozen project per **invocation**, at `~/.dreamcontext/eval-frozen/scratch/<invocation-id>/`. Knowledge-access bumps and capture vectors land there, never in the frozen root.
- Warm-up: `node dist/index.js embed refresh` with cwd set to the scratch project.
- Each run spawns `node dist/index.js hook user-prompt-submit` with stdin `{prompt}` and env `DREAMCONTEXT_RECALL_MODE`, `DREAMCONTEXT_AUTO_UPGRADE=0`, `DREAMCONTEXT_EMBED_AUTO=0`. `floor` mode adds `DREAMCONTEXT_MEMORY_HOOK=0`.
- The first run is discarded; p50/p90 are reported.
- In hybrid mode, any recall header other than `— Memory recall (Hybrid` fails, and so does a set of runs with no Hybrid header at all.
- `--no-model` sets `HOME` to an empty temp directory, expects the `(BM25` header, and asserts no `HOME/.dreamcontext/models` and no `.embeddings/cache.json` are created.
- `--cpu-prof <dir>` forwards `--cpu-prof` to the spawned hook process.

**`scripts/model-ab.ts`** is T6's, but it uses the same harness warm-up.

**Gold repair** (`eval/gold.jsonl`, `eval/gold-heldout.jsonl`):
- Query text never changes. Stale targets (h009, h019, h021, and anything else the check finds) are repointed to the live successor doc, verified by reading it. If none exists, the query is dropped.
- Every edit is logged in `eval/REPAIRS-2026-10.md` (new).

**`tests/unit/recall-eval.test.ts`:** checks every `expected` and `alt` in every repo gold file, plus the frozen held-out files when `RECALL_EVAL_ROOT` is set.
- With `RECALL_EVAL_ROOT` set: any missing target fails.
- On the live corpus: missing targets get a `console.warn`, not a failure. Ids in `eval/gold-quarantine.json` (new) are skipped.

### T2 · Blind gold authoring (separate agent)

- **What it sees:** only the frozen corpus, the schema, the categories, and the docKey rules:
  - `knowledge/**/<s>.md` → `knowledge/<s>`
  - `knowledge/features/**` → `feature/`
  - `state/<s>.md` → `task/<s>`
  - `core/objectives` → `objective/`; `lab/insights` → `insight/`; `theses` → `thesis/`; `automations/<s>.md` → `automation/`; `whiteboards/<s>/` → `whiteboard/<s>`
  - Memory and changelog entries are never targets.
- **What it never sees:** `src/`, `eval/`, `scripts/`, this plan, or any recall output.
- **Outputs:**
  - dc train, ≥60 queries: `eval/gold-2026-10.train.jsonl` (in the repo).
  - dc held-out, ≥40 queries: `~/.dreamcontext/eval-frozen/gold/dc-2026-10.heldout.jsonl`.
  - h-f train, ≥60 queries: `h-f_dreamcontext/eval/recall-gold.train.jsonl`.
  - h-f held-out, ≥40 queries: `~/.dreamcontext/eval-frozen/gold/hf.heldout.jsonl`.
- **Split:** stratified by category, with at least 8 queries per category per split where the corpus allows. Shortfalls go in `provenance.md`.

### T3 · Remove Haiku, default hybrid (CLI and server)

- **`src/lib/recall-mode.ts`** (new): `RECALL_MODES`, `RecallMode`, `DEFAULT_RECALL_MODE` and `normalizeRecallMode`.
- **`src/lib/sleep-consolidation.ts`:** `recall_mode: RecallMode`.
- **`src/cli/commands/sleep.ts`:**
  - Re-exports; both defaults become hybrid; `readSleepState` normalizes on read; `resolveRecallMode` maps env `haiku` → `hybrid`.
  - `recall on` is an alias for hybrid.
  - The status label and `recall hybrid` text drop "EXPERIMENTAL" (`:1278`, `:1320`, `:1326`).
- **`src/server/routes/sleep.ts`:** use the shared list and accept the legacy value, storing `hybrid`.
- **`src/cli/commands/hook.ts`:** remove the import (`:54`), the branch and the gate bypass, the "EXPERIMENTAL" comment at `:2503`, and the Haiku comments at `:2474-2477` and `:2547`.
- **`src/server/routes/recall.ts` and `src/server/index.ts`:** remove the handler and the route.
- **`src/server/routes/agent-chat.ts`:** `recallEnvFor` simplified, and its caller at `:1264` updated.
- **`src/cli/interactive.ts:328`:** text.
- **Comments:** `install-skill.ts:266`, `cli-commands.test.ts:902`, `auto-sleep-runner.test.ts:296`.
- **Delete last**, after a zero-reference grep: `recall-query-extractor.ts` and its test.
- **Tests:**
  - `sleep-route.test.ts` (legacy case) and `assistant-latency.test.ts:382`.
  - New `recall-mode-legacy.test.ts`.
  - Fixture `'haiku'` → `'hybrid'` in: `sleep-system-360`, `auto-sleep-decision`, `auto-sleep-runner:325`, `automation-threads-runner`, `sleep-state`, `automations-runner`, `sleep-effective-debt`, `sleep-consolidation`, `auto-sleep-end-to-end`.
  - `scripts/verify/assistant.mjs`.
- `eval/sleep-quality/fixture` stays as it is: it deliberately exercises the legacy read path.
- **W1 ownership:** T3 owns `dashboard/src/generated/cli-manifest.json`. The orchestrator regenerates it at the W1 gate.

### G1 · Baseline (orchestrator; after W1, before any ranking change; under the heavy lock)

1. One full `npm test -- run`. Record any tests that are already red (from the other session's uncommitted work) in `eval/runs/2026-10-07-preexisting-red.txt`.
2. `build:cli` and `gen:cli-manifest`.
3. Build the e5 indexes on the frozen roots.
4. `RECALL_EVAL_ROOT` integrity test.
5. `--checksum`, written to `~/.dreamcontext/eval-frozen/g1.sha256`.
6. `embed-ab --now --modes bm25,hybrid,dense` over all six sets (dc v1 train and held-out, dc 2026-10 train and held-out, h-f train and held-out), with post-warm-up mean/p50/p90.
7. `--build-timing` on both roots.
8. `hook-latency` in `floor`, `raw` and `hybrid` modes, on both roots.

Output: `eval/runs/2026-10-07-baseline.json` (aggregates and ranks only). Per-query output goes to `~/.dreamcontext/eval-frozen/runs/g1/`.

### T4 · BM25 and hook latency, no ranking change (`recall.ts` lane)

- **Step −1, before any edit:** dump the pre-edit train results with `embed-ab --dump-topk ~/.dreamcontext/eval-frozen/runs/t4/pre.json` (train sets only).
- **Step 0, profile** under the heavy lock:
  - `node --cpu-prof` on `embed-ab --modes bm25` over dc train.
  - `hook-latency --mode raw --cpu-prof` on the dc scratch copy.
  - Break the recall overhead into: walk/stat, frontmatter parse and tokenize (`buildCorpus`), `bm25Search` (and within it, snippets), and the cross-vault read.
  - **Escalation check:** set the reachable budget to `B = min((G1 raw p50 − G1 floor p50) / 3, 600 ms − G1 floor p50)`. Even with a perfect corpus cache, the hook still has to walk and stat every file, so `walk/stat + post-fix search + cross-vault` is the smallest the recall overhead can get. If that minimum is above B, escalate now.
- **Step 1, the smallest fix:**
  - `recall.ts`: `bm25Search` builds snippets only for the final `topK`, after the sort and the link boost. Also fix the stale `haikuRecall` comments at `:22` and `:860`.
  - `recall-synonyms.ts`: `expandQueryTerms` memoizes its stemmed tables in a `WeakMap` keyed on the stem function it's given (no circular import).
- **Step 2:** re-profile. Only if BM25 search is still less than 3× below its G1 mean, add a `WeakMap` memo of `N`, `avgdl`, `avgFieldLen` and document frequencies per corpus array. This helps the server and eval only; a one-shot hook process never benefits.
- **Step 3, conditional disk corpus cache.** Build it if the measured hook recall overhead after Steps 1–2 is still greater than B (the trigger comes from the measured floor, not a fixed margin).
  - Module: `src/lib/recall-corpus-cache.ts` with `buildCorpusCached`.
  - Cache file: `<root>/.recall-cache/corpus.json`, self-gitignored, written via atomic rename.
  - Invalidation is per *source* file, by path + mtimeMs + size. That includes the sources of derived docs: the changelog JSON, `2.memory.md` sections, bookmarks inside `state/.sleep.json`, automation output, and whiteboard folders.
  - Files added or removed are detected on every walk.
  - The header carries a version plus a hash of the tokenizer constants (STOPWORDS, TR_SUFFIXES, FIELD_WEIGHTS, stemmer version).
  - Tests: deep-equal to `buildCorpus` on a scratch copy of the real frozen dc vault, plus touch, add and delete tests.
- **Equivalence proof:**
  - `tests/unit/recall-latency-equivalence.test.ts` on a synthetic corpus.
  - After the edits, dump post-edit train results to `runs/t4/post.json` and diff against `pre.json`: the full top-10 keys, rankScore and snippet must be identical. Only pass/fail is reported.
  - The held-out comparison happens only under `runs/t4/`, also pass/fail only.
- **After Step 3:** if the hook raw gate (criterion 3) still isn't met, escalate.

### T5 · Remove Haiku from the dashboard and skill packs (after T3)

- `useSleep.ts`.
- `SettingsPage.tsx`: options, default hybrid, recommended. Remove the `experimental` property from the hybrid entry and remove the `MaturityTag` wiring if nothing else uses it.
- `I18nContext.tsx`: remove `settings.recall.haiku.*` and `settings.recall.experimental`.
- `useRecall.ts`: delete `haikuRecallOnce` and `HaikuRecallResponse`.
- `BrainSearch.tsx`, `CommandPalette.tsx`, `CommandPalette.css:81`: remove the toggle and the `intelliMode` state.
- About pages: `features.data.ts`, `RecallFlowSection.tsx`, `flow-specs.ts`.
- `scripts/verify/jev-spike-recall-settings.mjs`.
- `skill-packs/jev-verify/SKILL.md:102` and `examples/settings-recall.json:14`: the expected selection becomes Hybrid, the "experimental" assertion goes, and "at least four modes" becomes three.
- New `tests/unit/recall-mode-mirror.test.ts`: a drift test between `SettingsPage` and `RECALL_MODES`.

### T6 · Model experiment (scripts only; 6-hour wall-clock budget including index builds)

- **Ownership:** `scripts/model-ab.ts` (self-contained: prefix, pooling, dtype, onnx file and dimensions per candidate; same warm-up and `--now` as the harness) and `eval/runs/2026-10-07-models.json` (aggregates).
- **Pre-check:** confirm an ONNX export exists and works with transformers.js v4 for every candidate. Drop it otherwise.
- **Order:**
  1. Dense-only screening on train, which doesn't depend on fusion settings: e5-small (control), EmbeddingGemma-300m q8 and q4 (also check the prompt format and the Gemma license), granite-97m-multilingual-r2.
  2. Fusion is re-swept only for a model that wins dense-only.
  3. Reranker: screen a small multilingual cross-encoder (e.g. mMiniLMv2-L12) offline on the top 20. bge-reranker-v2-m3 runs only if the small one shows promise. Jina v2 is excluded for its non-commercial license.
- **Timing:** each index build is its own `builder heavy` invocation. The orchestrator may pre-build the candidate indexes right after G1.
- **Per candidate it reports:** dense-only and hybrid `ExtendedMetrics`, per-language numbers, index time, cold model-load time and post-warm-up query time.
- **If it runs out of budget:** report "no winner" and keep e5.

### T7 · Ranking fixes (`recall.ts` lane, after T4)

- Tuned on train only (dc v1 train, dc 2026-10 train, h-f train), at most 3 rounds.
- **Board fix:** `BOARD_RANK_FACTOR` (rankScore only) for `*.excalidraw` knowledge docs and whiteboards that contain only labels.
- **Turkish→English bridges:** add TR→EN `DIRECTED_BRIDGES`, derived from corpus term frequency, never from gold queries.
- **Tests:**
  - `tests/unit/recall-board-rank.test.ts` (new, synthetic corpus): a label-only board must not outrank a prose doc on a shared term, and `hit.score` is unchanged.
  - `tests/unit/recall-tr-bridge.test.ts` (new): a Turkish query term reaches the English canonical doc through rankScore, with raw score unchanged.
  - `recall-weighting.test.ts` and `recall-capture-stress.test.ts` stay green.
- **Report:** every train `--misses` entry it targeted, marked resolved or explained.

### T8 · Provisioning (hook/sleep lane, after T3 and T4)

- **`src/lib/embeddings/provision.ts`** (new): `ensureHybridReady` and `spawnEmbedEnsure`.
  - Opt-out: `DREAMCONTEXT_EMBED_AUTO=0` means skip.
  - Model download: `embeddingsAvailable()` held under `acquireFileLockWithin` on `~/.dreamcontext/models/.download.lock`.
  - Index: built with `refreshEmbeddings(..., { waitForLock: true })`.
  - Throttle marker: `<root>/.embeddings/ensure.json`, 24 hours between failed attempts.
  - The spawn is detached, `stdio: 'ignore'`, and `unref()`'d.
- **`embed.ts`:** new `embed ensure [--no-download] [--quiet]`; drop the "EXPERIMENTAL" description and comments (`:53`, `:62`).
- **`hook.ts`, SessionStart:** spawn ensure when the mode is hybrid and `hybridReady` is false, with a one-line notice. If T4 built `buildCorpusCached`, use it in UserPromptSubmit.
- **`sleep.ts:949`:** refresh when the mode is hybrid **and** the model is on disk **and** `process.env.DREAMCONTEXT_EMBED_AUTO !== '0'`. It never downloads.
- **`update.ts` and `init.ts`:** call `spawnEmbedEnsure` for each vault.
- **`doctor.ts`:** report package, model and index status; `--fix` runs `ensure`.
- **No test can download or embed:**
  - `tests/setup/isolate-spawn-env.ts` sets `DREAMCONTEXT_EMBED_AUTO='0'`.
  - Repo-wide audit: grep `tests/` for every place that spawns the CLI (`spawn`, `spawnSync`, `execFile`, `execa`, `runCli`-style helpers that call `dist/index.js` or `src/cli`). Any call that builds its env without inheriting `process.env` gets `DREAMCONTEXT_EMBED_AUTO=0` added. Each result is listed in the task log.
- **Tests:**
  - `tests/unit/embed-provision.test.ts`: clears the opt-out where needed; the spawn is injected and asserted detached, `stdio: 'ignore'` and `unref()`'d; the opt-out suppresses the spawn.
  - `tests/integration/hook-hybrid-fallback.test.ts`, which also covers sleep:
    1. A temp vault in hybrid mode with `HOME` set to an empty directory. UserPromptSubmit shows the `(BM25` header, no models directory or `cache.json` is created, and it finishes within 5 s.
    2. SessionStart under the opt-out: no spawn and no marker file.
    3. `sleep done` under the opt-out, with the model present (a fake models directory under the temp `HOME` holding the three files `isEmbedModelDownloaded` checks): no `.embeddings/` created.
- **W3 ownership:** T8 owns `dashboard/src/generated/cli-manifest.json` again. The orchestrator regenerates it at the W3 gate.

### T9 · Hybrid's own cache cost (`store.ts` lane)

- `store.ts`: an in-process memo of the parsed cache, keyed by path + mtimeMs. `embeddingCacheUsable` and the read-only paths share it.
- `refreshEmbeddings` deletes the memo entry before mutating anything and repopulates it after `saveCache` with the new mtime, so a refresh that throws can't leave dirty state.
- `meta.json` is added only if the measured parse cost justifies it. If added:
  - It is written after the `cache.json` rename.
  - `usable` requires `meta.chunks` to match whenever the cache is parsed anyway.
  - Old caches without meta fall back to a full parse.
- Rewrite the header comments so they no longer say "experimental" or "opt-in".
- Tests in `tests/unit/embeddings.test.ts`: memo hit, invalidation on mtime change, and no dirty state after a refresh that throws.

### T10 · Final hybrid (embeddings lane, after T6, T7 and T9)

- **Tuning:** at most 3 rounds, on train only.
- **`hybrid.ts`:**
  - Retune `ADAPTIVE_*` and the pin margin; add boards to `DENSE_EXCLUDED_TYPES` if that helps.
  - Rewrite the header comment (`:6-19`) without "experimental" or "opt-in".
  - `denseGate` and `bm25Confident` are the named lever for **three** gates: quality, the search-hybrid 3× gate, and the hook-hybrid 2× gate. On a BM25-confident query it returns BM25's order without loading the model or parsing the cache. Build it if G1 or T10 measurements show it is needed for any of those gates, or if the fallback below is used.
- **Model winner only:**
  - Port the profile abstraction into `embedder.ts`, keeping e5 in the registry.
  - In `store.ts`, add `embedCacheModelKey()`. For e5 it stays exactly `'Xenova/multilingual-e5-small'`, so existing users don't rebuild.
- **Reranker:** `reranker.ts` only if it wins on quality and stays within both hybrid latency gates.
- **Exit:**
  - If the quality gate fails after 3 rounds: ship hybrid as the default with `denseGate: 'auto'`, provided it meets 2b and 2c. Otherwise escalate with the per-query flips.
  - If the hybrid latency gates fail after 3 rounds: escalate.
- Freeze the config and hand off.

### G2 · Validation gate (fresh agent; after T10, T8 and T5; under the heavy lock)

- **Runs:**
  - `npm test -- run`, compared against `preexisting-red.txt`. Only new reds count as regressions.
  - `npm run build`.
  - The `RECALL_EVAL_ROOT` integrity tests.
  - The checksum against `g1.sha256`.
  - Every held-out run on the frozen T10 config.
  - Every latency run, with the same warm-up and modes as G1, including `floor`.
  - `hook-latency --no-model`.
  - The code-path checks for criteria 4 and 8.
- **Writes:**
  - `eval/runs/2026-10-07-final.json` (aggregates and ranks) and a pass/fail table.
  - Per-query output to `~/.dreamcontext/eval-frozen/runs/g2/`.
- **On failure:** follow the exit paths.

### T11 · Docs (after G2)

- **Skill and README:**
  - `skill/SKILL.md` `:90` and `:365`.
  - `skill/references/cli-reference.md`: `:354`, the env table at `:548` (remove haiku; add `DREAMCONTEXT_EMBED_AUTO`), `embed ensure`, the doctor embedding report, and hybrid as the default.
  - `knowledge-and-recall.md` `:79`, `:142` and `:152`: the background-download and index behaviour, and the BM25 fallback.
  - `integrations.md:229`.
  - `README.md:523`.
- **Diagram:** `scripts/diagrams` source, then `public/image/diagram-recall.png` (orchestrator regenerates).
- **Results:** `eval/RESULTS.md`, aggregates only.
- **Brain docs:**
  - `haiku-recall-architecture.md`: retirement note.
  - `decision-embedding-layer.md`: graduated, plus the model verdicts.
  - `recall-engine-v2.md`: an update section.
  - `features/memory-recall-bm25.md` and `features/sleepy-search-ask.md`.
- **Changelog:** a CLI changelog entry plus a release-notes line for the retired `haiku` mode.
- **Feature-integration scan:** record each item as done or "considered / not applicable" with a reason:
  - the SKILL.md Entity Router row
  - the sleep docs
  - `agents/*.md`
  - the marker test

### G3 · Docs gate (orchestrator)

- Docs-path checks for criteria 4 and 8.
- `build`, then `dreamcontext update` (propagation to `.claude/skills`), then verify the skill copy matches.

## 3. Dependency map

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| G0 freeze | `~/.dreamcontext/eval-frozen/{dc,hf}-20261007/`, `now.txt` | — | 0 | Frozen roots (excluding `.embeddings`, `.recall-cache`, `.git`) plus the pinned ISO time |
| T1 eval infra + repair | `eval/harness.ts`, `scripts/embed-ab.ts`, `scripts/recall-ab.ts`, `scripts/hook-latency.ts`(new), `eval/gold.jsonl`, `eval/gold-heldout.jsonl`, `eval/REPAIRS-2026-10.md`(new), `eval/gold-quarantine.json`(new), `tests/unit/recall-eval.test.ts` | G0 | 1 | `stableCorpus(root: string): CorpusDoc[]`; `loadNow(arg?: string): Date`; `evaluateSearch(search, gold, warmup = 1)`, where latency = post-warm-up mean/p50/p90; `embed-ab --root --gold… --modes --now --json [--per-query <p>] [--dump-topk <p>] [--build-timing] [--checksum <out>]` (`<p>` must be under `eval-frozen/runs/`); `hook-latency --root --prompts --mode hybrid\|raw\|floor --n [--no-model] [--cpu-prof <dir>]` returns `{p50Ms, p90Ms, n, headerOk}` (needs **build:cli**); env `RECALL_EVAL_ROOT` |
| T2 blind gold | `eval/gold-2026-10.train.jsonl`(new), `~/.dreamcontext/eval-frozen/gold/{dc-2026-10,hf}.heldout.jsonl`(new), `h-f_dreamcontext/eval/recall-gold.train.jsonl`(new), `provenance.md` | G0 | 1 | Each line is a `GoldQuery {id, query, expected[], alt?, category, lang}`; docKey = `${type}/${slug}`; split stratified by category, ≥8 per category per split where possible |
| T3 Haiku out (core) | `src/lib/recall-mode.ts`(new), `src/lib/sleep-consolidation.ts`, `src/cli/commands/{sleep,hook,install-skill}.ts`, `src/cli/interactive.ts`, `src/server/routes/{sleep,recall,agent-chat}.ts`, `src/server/index.ts`, `recall-query-extractor.ts` + its test (deleted), the fixtures and comments listed in §2, `tests/unit/recall-mode-legacy.test.ts`(new), `scripts/verify/assistant.mjs`, `dashboard/src/generated/cli-manifest.json` (W1; regenerated by the orchestrator) | — | 1 | `RECALL_MODES = ['hybrid','raw','off'] as const`; `DEFAULT_RECALL_MODE: RecallMode = 'hybrid'`; `normalizeRecallMode(v: unknown): RecallMode` (`'haiku'`, invalid or missing → `'hybrid'`); `resolveRecallMode(root): RecallMode`; `recallEnvFor(o: {isAssistant: boolean; modelOnDisk: boolean}): Record<string,string>`; `/api/recall/haiku` → 404; `PATCH {recall_mode:'haiku'}` → 200, stored as hybrid |
| G1 baseline | `eval/runs/2026-10-07-baseline.json`(new, aggregates and ranks), `eval/runs/2026-10-07-preexisting-red.txt`(new), `~/.dreamcontext/eval-frozen/{runs/g1/, g1.sha256}` | T1, T2, T3 + **build:cli** + `gen:cli-manifest` | gate 1→2 | Per set and mode: `ExtendedMetrics` + post-warm-up mean/p50/p90; `buildCorpus` p50; hook p50/p90 in floor, raw and hybrid |
| T4 latency | `src/lib/recall.ts`, `src/lib/recall-synonyms.ts`, `src/lib/recall-corpus-cache.ts`(new, conditional), `tests/unit/recall-latency-equivalence.test.ts`(new), `tests/unit/recall-corpus-cache.test.ts`(new, conditional), `eval-frozen/runs/t4/{pre,post}.json` | G1 | 2 | `bm25Search` and `expandQueryTerms` signatures unchanged; train top-10 keys/rankScore/snippet identical before vs after; optional `buildCorpusCached(root: string, opts?: BuildCorpusOptions): CorpusDoc[]`, deep-equal to `buildCorpus`; budget `B = min((G1 raw − G1 floor) / 3, 600 − G1 floor)`, escalate after Step 0 if B is unreachable |
| T5 dashboard + packs | `dashboard/src/hooks/{useSleep,useRecall}.ts`, `pages/SettingsPage.tsx`, `context/I18nContext.tsx`, `components/search/{BrainSearch.tsx,CommandPalette.tsx,CommandPalette.css}`, `components/about/{features.data.ts,RecallFlowSection.tsx,flow-specs.ts}`, `scripts/verify/jev-spike-recall-settings.mjs`, `skill-packs/jev-verify/{SKILL.md,examples/settings-recall.json}`, `tests/unit/recall-mode-mirror.test.ts`(new) | T3 (+ **build:dashboard** at the W2 gate) | 2 | Dashboard `RecallMode = 'hybrid'\|'raw'\|'off'`, default `'hybrid'`; no callers of `/recall/haiku`; hybrid entry has no `experimental`; `settings.recall.experimental` removed |
| T6 model experiment | `scripts/model-ab.ts`(new), `eval/runs/2026-10-07-models.json`(new, aggregates) | G1 | 2 | `model-ab --root --gold(train) --now --candidate <id> [--dense-only]` returns `{dense, hybrid?: ExtendedMetrics, byLang, indexMs, coldLoadMs, warmMeanMs}`; 6 h budget |
| T7 ranking | `src/lib/recall.ts`, `src/lib/recall-synonyms.ts`, `tests/unit/recall-board-rank.test.ts`(new), `tests/unit/recall-tr-bridge.test.ts`(new) (same lane as T4) | T4, T2 | 3 | `export const BOARD_RANK_FACTOR: number` (rankScore only); `hit.score` unchanged; a misses ledger in the task log |
| T8 provisioning | `src/lib/embeddings/provision.ts`(new), `src/cli/commands/{embed,hook,sleep,update,init,doctor}.ts`, `tests/setup/isolate-spawn-env.ts`, `tests/unit/embed-provision.test.ts`(new), `tests/integration/hook-hybrid-fallback.test.ts`(new), env-only edits to CLI-spawning tests found by the repo-wide audit, `dashboard/src/generated/cli-manifest.json` (W3; regenerated by the orchestrator) (same lane as T3) | T3, T4 | 3 | `ensureHybridReady(root: string, opts?: {allowDownload?: boolean}): Promise<'ready'\|'downloaded'\|'indexed'\|'skipped:mode'\|'skipped:package'\|'skipped:optout'\|'failed'>`; `spawnEmbedEnsure(root: string, deps?: {spawn?: typeof import('node:child_process').spawn; now?: () => number}): boolean`; CLI `embed ensure [--no-download] [--quiet]`; env `DREAMCONTEXT_EMBED_AUTO=0` gates ensure, spawn **and** the sleep refresh; lock `~/.dreamcontext/models/.download.lock` |
| T9 cache cost | `src/lib/embeddings/store.ts`, `tests/unit/embeddings.test.ts` | G1 | 3 | `embeddingCacheUsable` and `refreshEmbeddings` signatures unchanged; at most one parse per mtime per process; memo invalidated around mutation; optional `meta.json {version, model, chunks}` written after the rename |
| T10 final hybrid | `src/lib/embeddings/hybrid.ts`, `src/lib/embeddings/reranker.ts`(new, only if it wins), `src/lib/embeddings/embedder.ts` (only if a model wins), the `store.ts` cache-key line (only if a model wins) | T6, T7, T9 | 4 | `hybridSearch(query, corpus, root, topK, opts)` signature unchanged; optional `HybridOptions.denseGate?: 'auto'\|'always'` and `bm25Confident(hits: RecallHit[]): boolean`; optional `embedCacheModelKey(): string` (e5 = `'Xenova/multilingual-e5-small'`); optional `rerank(q: string, docs: {key: string; text: string}[]): Promise<Map<string, number> \| null>` |
| G2 validation | `eval/runs/2026-10-07-final.json`(new, aggregates and ranks), `~/.dreamcontext/eval-frozen/runs/g2/` | T10, T8, T5 + **build** | gate 4→5 | The pass/fail table for §4 (code paths); exit paths applied |
| T11 docs | `skill/SKILL.md`, `skill/references/{cli-reference,knowledge-and-recall,integrations}.md`, `README.md`, `scripts/diagrams/*`, `public/image/diagram-recall.png`, `eval/RESULTS.md`, the brain docs listed in §2, the changelog entry | G2 | 5 | Numbers from `final.json`; a scan-decision list for the feature-integration items |
| G3 docs gate | — (orchestrator) | T11 + **build** + `dreamcontext update` | gate 5 | Criteria 4/8 on docs paths; skill copy propagated |

## 4. Proposed acceptance criteria

All comparisons are against G1, on the frozen corpus with the pinned clock and the production default config.

1. **Build and tests.**
   - `npm test -- run` shows no reds beyond `preexisting-red.txt`, and `npm run build` passes.
   - `RECALL_EVAL_ROOT` integrity tests pass, and the frozen checksum matches `g1.sha256`.
   - No models directory is created on a machine without the model. The proof is `hook-hybrid-fallback.test.ts` (empty `HOME`).
   - `sleep done` under the opt-out creates no `.embeddings/` (same test).
2. **Quality.**
   - **(a) MRR beats G1 BM25 in each split**, pooled across all of that split's sets (dc v1, dc 2026-10 and h-f).
   - **(b) No worse than G1 BM25 and G1 hybrid on r@1, r@3 and r@5, per set.**
     - At most one net query flip is tolerated per set per metric.
     - That flip is allowed only if the pooled split metric still improves.
     - Each such flip is listed with a one-line reason.
   - **(c) Category gate.**
     - **Gated:** categories with n ≥ 8, on the pooled dc sets for each split and on each h-f split. Their r@1 and r@3 must be at least G1 BM25.
     - **n < 8:** each flipped query is listed with a reason.
     - **Exact-term or field-match:** any regression flip fails; improvements are fine.
   - **(d) Turkish.** Turkish r@1 and r@3, pooled per split, must be at least G1 BM25 (gated).
3. **Latency** (under the heavy lock; same procedure in G1 and G2).
   - **Search:** the `embed-ab` mean after one warm-up query, on frozen dc, is at least 3× below its own G1 mean, for BM25 and for hybrid. Dense is informational only. Any model or reranker winner must keep hybrid within this gate.
   - **Hook, raw:** both of these must hold:
     - recall overhead = (hook raw p50 − hook floor p50) at least 3× below the G1 overhead
     - absolute hook raw p50 ≤ 600 ms
   - **Hook, hybrid:** p50 at least 2× below the G1 hybrid hook p50. p90 is recorded. A reranker must stay within this gate.
   - **Hook-latency checks:** hybrid mode passes its header assertion, and `--no-model` passes.
4. **Haiku removed.**
   - Command: `grep -rnE "haikuRecall|HaikuRecall|recall-query-extractor|recall/haiku|intelliMode|recall_mode.{0,6}haiku|settings\.recall\.haiku|Haiku option|recall.{0,30}Haiku|Haiku.{0,30}recall"`.
   - Paths: `src dashboard/src tests skill-packs agents scripts` at G2, then `skill README.md` at G3.
   - Allowed matches, and only these files: `src/lib/recall-mode.ts`, `tests/unit/recall-mode-legacy.test.ts`, the legacy case in `tests/unit/sleep-route.test.ts`, and `eval/sleep-quality/fixture/state/.sleep.json`.
5. **Legacy compatibility.**
   - On-disk `"haiku"`, env `haiku`, missing values and garbage values all resolve to `hybrid`, never `off`.
   - `PATCH 'haiku'` → 200, stored as hybrid.
   - `recall on` → hybrid.
6. **Fresh-machine fallback** (verified by `hook-hybrid-fallback.test.ts` and `hook-latency --no-model`).
   - With no package, no model, a busy lock or a stale cache key, the BM25 header appears and no download or index build happens in-line.
   - SessionStart's ensure is detached, or suppressed by the opt-out.
   - `doctor` reports status, and `embed ensure` provisions.
7. **Models.**
   - Every candidate tried, or dropped for having no ONNX export, is recorded with its aggregates.
   - A switched model invalidates old caches through the key, and e5 caches are reused.
   - A held-out regression after a switch → reverted to e5.
8. **Labels and docs** (explicit checks, not a single grep).
   - **(a)** The hybrid entry of `RECALL_MODE_OPTIONS` in `SettingsPage.tsx` has no `experimental` property.
   - **(b)** `settings.recall.experimental` does not exist in `I18nContext.tsx` and is referenced nowhere under `dashboard/src`.
   - **(c)** The header comments of `hybrid.ts` and `store.ts`, and the `embed` command description in `embed.ts`, contain neither "experimental" nor "opt-in".
   - **(d)** `sleep.ts`'s `recall status` and `recall hybrid` text contain no "EXPERIMENTAL".
   - **(e)** At G3, `cli-reference.md` documents `embed ensure`, the doctor embedding report and `DREAMCONTEXT_EMBED_AUTO`, and its env table no longer lists haiku.
   - **(f)** The retirement note, the changelog entry and the feature-integration scan list exist.
   - **(g)** `RESULTS.md` holds aggregates only, and the skill copy is propagated.

## 5. Assumptions and open questions

1. **Directory access.** This session can't read `h-f_dreamcontext` or `~/.dreamcontext/eval-frozen`. The orchestrator has to grant both to T2, T6, G1 and G2.
2. **h-f privacy.** The h-f gold sets, per-query output and frozen copies never enter this repo (assumed public). Please confirm that `h-f_dreamcontext/eval/` is the right place for the h-f train set.
3. **Sleepy "Intelligent" search.** Recommend removing it entirely: with hybrid as the default it's dead UI. Extractive Ask uses `recallOnce` with no LLM call and is unaffected. The chat's Normal/Intelligent choice (Sonnet/Opus) is unrelated and stays.
4. **Background download consent.** The plan has SessionStart, `init` and `update` trigger a detached 113 MB download, with a notice and the `DREAMCONTEXT_EMBED_AUTO=0` opt-out. Please confirm; the alternative is downloads only from `doctor --fix`, the Settings card or `embed ensure`.
5. **The 600 ms raw gate will most likely force the corpus cache.** The critic's numbers (floor ≈ 0.42 s, raw ≈ 1.8 s) leave roughly 180 ms for recall. That probably means T4 Step 3 has to be built. If the remaining walk/stat and cross-vault cost alone exceeds that budget, the plan escalates right after T4 Step 0.
6. **The hybrid hook gate will probably need `denseGate`.** If the ~1 s model load dominates the G1 hybrid hook time, halving its p50 is only reachable by skipping the load on BM25-confident prompts. T10 decides from data. Routing hook queries through a running dashboard server stays out of scope (no new services).
7. **Heavy-lock contention.** T6 index builds hold the lock for up to about 25 minutes each, and other builders' checks queue behind them. The orchestrator can pre-build the candidate indexes right after G1.
8. **Pooling interpretation.** I read 2a/2d as pooling dc and h-f together within a split; 2b and 2c still guard each corpus. Tell me if you meant per-corpus pooling.
9. **Not in scope:** the `npx` overhead in the installed hook command, and the 120 s UserPromptSubmit timeout (it was sized for Haiku; I'd leave it).
10. **Knowledge Base.** It wasn't consulted: the `kb_guide` call was refused in round 1. This plan rests on the repo alone, with no company standards checked.

---

# Plan revision 4 — amendments (orchestrator, from plan review round 4)

These amend `plan-r4.md` and take precedence over it where they conflict.

## A1 — T4 owns the hook call-site swap (blocking r4-1)
- T4's owned files gain `src/cli/commands/hook.ts`, limited to the UserPromptSubmit corpus call site (`hook.ts` ~2504-2514, currently `buildCorpus(root)`): if T4 Step 3 builds `buildCorpusCached`, T4 swaps that call to `buildCorpusCached(root, …)` in both the raw and the hybrid branches. No other hook.ts edits in T4.
- T3 (W1) is finished before T4 (W2) starts; T8 (W3) depends on T4 and MUST NOT redo the swap (T8's hook.ts edits are SessionStart provisioning only).
- T4's Step 3 gate and its "after Step 3 → escalate" rule are therefore measured on a real end-to-end hook (`hook-latency --mode raw` against a `build:cli` the orchestrator runs at T4's request before the measurement).
- Dependency map row T4: files owned += `src/cli/commands/hook.ts (UserPromptSubmit corpus call only)`; depends on: G1, T3.

## A2 — Pre-existing red is taken at G0, not G1 (blocking r4-2)
- G0 (before ANY W1 edit) runs one full `npm test -- run` and writes `~/.dreamcontext/eval-frozen/preexisting-red.txt` (failing test ids) plus `git status --porcelain | shasum` and `git rev-parse HEAD` next to it.
- G1 step 1 runs the full suite again and diffs against G0: any red that is new since G0 is a W1 regression and is routed to its owning implementer and fixed BEFORE the baseline is frozen. Criterion 1 excuses only G0 reds (and only if their files belong to the other session's uncommitted work).

## A3 — Non-blocking fold-ins
- Criterion 6: `tests/integration/hook-hybrid-fallback.test.ts` (T8) also covers stale cache key and busy lock via cheap unit assertions on `hybridReady` / `waitForLock: false` (`hybrid.ts:22`, `:245`); "no package" covered by mocking `isEmbedPackageInstalled` → false. Otherwise narrow the criterion text to what is tested.
- T1: `hook-latency --prompts` must use strong-match prompts (gold queries whose target scores raw `score >= 2.0` on the frozen corpus — the hook prints a recall header only then, `hook.ts:2522`); the script filters to those and reports how many it kept.
- `hook-latency` scratch copy: ONE copy per invocation via `rsync -a` INCLUDING `.embeddings` (mtimes preserved), so no index rebuild per invocation.
- T1 gold repair resolves successors against the FROZEN root (`RECALL_EVAL_ROOT=<frozen dc>`), not the live brain.
- T10 note: hybrid runs `bm25Search` with `POOL=50` (`hybrid.ts:237`), so snippet work still covers 50 docs unless hybrid only snippets its final topK; T4/T10 should make hybrid snippet only the returned topK. `denseGate` is the expected lever for the hybrid search 3× gate.

## A4 — Fold-ins from review round 5 (non-blocking)
- `preexisting-red.txt` lives ONLY at `~/.dreamcontext/eval-frozen/preexisting-red.txt` (A2); every reference to `eval/runs/2026-10-07-preexisting-red.txt` in the G1 section, the G1 dep-map row, G2 and criterion 1 means this file. G2 diffs against it.
- A G0→G1 red whose file is in the other session's uncommitted set (compare the recorded `git status` shasum / porcelain list) is NOT routed to a W1 implementer; it is noted and excluded.
- If T4 builds `buildCorpusCached`, its cache header hash includes the synonym/bridge tables too (or T7 changes only query-side expansion — T7 must state which).
- hook-latency's discarded first run warms `.recall-cache` in the scratch copy; raw p50 is the warm steady state, compared to the cacheless G1 baseline by design.
- Frozen roots are not read-only after G1 (they gain `.embeddings`); the checksum excludes `.embeddings` and `.recall-cache`.

## A5 — Validation amendments (2026-10-07, after G2)
- Criterion 4 allow-list gains `tests/unit/recall-mode-mirror.test.ts`: its only matches are negative guard assertions (`expect(...).not.toContain('settings.recall.haiku' | 'haikuRecallOnce' | '/recall/haiku' | 'intelliMode')`) that keep the Haiku surface from coming back — the criterion's intent (no Haiku surface) is satisfied.
- Criterion 2c: OWNER DECISION — accepted with five held-out single-query category flips recorded (dc paraphrase r@3 14→13 h018; hf paraphrase r@1 6→5 hfh-022; hf recency r@1 5→4 hfh-042 and r@3 7→6 hfh-048; dc-26 exact-term h26-008 1→2 with the category count unchanged 9→9). Every pooled and per-set metric improved on both splits; no retuning against held-out was done. These queries are the first targets of the next recall round.
