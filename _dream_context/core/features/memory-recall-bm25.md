---
id: feat_mem0Recall1
status: in_review
created: '2026-05-23'
updated: '2026-06-10'
released_version: null
tags:
  - memory
  - cli
  - topic:recall
  - decisions
related_tasks:
  - recall-context-uplift-v07
---

## Why

dreamcontext's existing snapshot pre-loads soul + user + memory + active tasks + knowledge index every session, but once the corpus grows past ~50 docs, users need a way to ask "where did we decide X?" or "what do we know about Y?" without scrolling through the snapshot or grepping by hand. The original exploration considered integrating mem0 (vector store + LLM-extracted facts), but three independent reviewers (critic, pragmatist, security) converged on rejecting it: mem0 adds a Python + Ollama runtime cliff, every `add()` is a 1.5–4s non-deterministic LLM call, and its native dedup is documented as unreliable. dreamcontext's content is *already* curated atomic facts (knowledge files, PRDs, closed tasks, LIFO memory entries) — the LLM extraction step mem0 provides is solving a problem dreamcontext has already solved. A deterministic BM25 ranker over the existing corpus gives ~80% of the value at 1% of the complexity, with zero new dependencies, full version-control compatibility, and instant recall.

## User Stories

- [x] As a developer using dreamcontext, I can run `dreamcontext memory recall "<query>"` and see the top-5 most relevant docs across knowledge files, feature PRDs, task files, memory entries, and CHANGELOG entries.
- [x] As a developer, I can filter recall to a specific type (`--types knowledge` or `--types task,feature,changelog`) when I know roughly where the answer lives.
- [x] As an agent calling recall from a script, I can pass `--json` and get a machine-readable response with score, snippet, and file path.
- [x] As a developer, I can run `dreamcontext memory status` to see how many docs are in the corpus broken down by type.
- [x] As a user typing queries in Turkish or mixed Turkish/English, I get sensible results because the tokenizer handles the diacritics.
- [x] As a developer, I can run `dreamcontext memory remember "<text>"` to log a quick decision/note — it writes a CHANGELOG entry (`type=note`, `scope=quick` by default) instead of appending to a LIFO section.
- [x] As a developer, my session snapshot shows recent CHANGELOG entries tiered (top 3 detailed with summary + body, next 10 titles-only) so I can scan history quickly without bloating context.
- [x] As a Turkish-speaking developer, my recall results are dramatically improved (37.5→75.0% recall@1) because the engine folds agglutinative suffix inflections before BM25 scoring.
- [x] As a developer, decisions captured automatically from my sessions (via salience detectors) are searchable by the next session before any sleep consolidation runs.
- [x] As a developer, auto-captured session content never crowds out curated knowledge files in recall results, thanks to the capture rank penalty.

- [x] As a Turkish-speaking developer using v3 of the engine, my recall is dramatically more accurate (recall@1 TR 75.0→90%, paraphrase 66.7→91.7%) because two-hop TR morphology, directed synonym bridges, and EN -e fold fix address structural gaps from v2.

## Acceptance Criteria

- [x] `dreamcontext memory recall <query...>` works without any setup (no `init` step, no external services, no API keys).
- [x] BM25 ranking with k1=1.5, b=0.75 over (title + description + tags + body) for each doc.
- [x] Corpus includes: `_dream_context/knowledge/*.md` + `_dream_context/core/features/*.md` + `_dream_context/state/*.md` + memory sections (Decisions, Known Issues) of `_dream_context/core/2.memory.md` + entries from `_dream_context/core/CHANGELOG.json`.
- [x] Snippet extraction: 3 lines around the line with the most query-term hits.
- [x] `--top <n>` (default 5, clamped to 1–50), `--json`, `--plain`, `--types <comma-list>` flags supported. `--types` accepts `knowledge`, `feature`, `task`, `memory`, `changelog`.
- [x] Cold start ≤ 100ms on a 40-doc corpus (measured on the dreamcontext repo itself).
- [x] Zero new npm dependencies; uses existing `fast-glob` + `gray-matter`.
- [x] Stopword filtering covers English + light Turkish.
- [x] Returns a clear "No hits" message when query matches nothing.
- [x] `DREAMCONTEXT_RECALL_MODE=haiku` (default): single `claude --model haiku -p` call with corpus index in system prompt; returns 0–3 doc keys as `type/slug`; falls back to raw BM25 when `claude` CLI unavailable.
- [x] `DREAMCONTEXT_RECALL_MODE=raw`: always use BM25 (no Haiku call, no external process).
- [x] `DREAMCONTEXT_RECALL_MODE=off`: disable recall injection entirely.
- [x] Haiku mode: corpus index capped at 8,000 chars with `[...truncated]` note to avoid unbounded `--system-prompt` length.
- [x] Haiku call uses `--setting-sources ""` `--tools ""` `--no-session-persistence` (bare, stateless invocation; no project context leakage into sub-process).
- [x] `stripCodeBlock` regex is case-insensitive (`/i`) to handle `\`\`\`JSON` and `\`\`\`json` both.
- [x] Haiku catch block logs to `console.error` when `DREAMCONTEXT_DEBUG=1`; otherwise silently falls back.
- [x] Empty-corpus case returns `null` immediately (BM25 fallback path) without calling the executor.
- [x] CHANGELOG schema supports optional `summary` (≤200 char soft cap), `references[]` (prefixed: `commit:|file:|knowledge:|feature:|task:|url:`), and `supersedes` (entry-id pointer for replaces-this-decision relationships). All three are optional and backwards-compatible.
- [x] CHANGELOG entries are indexed in the recall corpus as their own `changelog` type — searchable via `recall` and the UserPromptSubmit hook.
- [x] `memory remember "<text>"` writes a CHANGELOG entry (`type=note`, `scope=quick` by default; override via `--type`/`--scope`). The LIFO marker in `2.memory.md` is gone; quick captures land in CHANGELOG.json where they participate in recall.
- [x] SessionStart snapshot renders the recent CHANGELOG section as a tiered block: top 3 entries detailed (summary + ~300 char body), next 10 titles-only under an "Older" subheading. Tier sizes are configurable via constants at the top of `src/cli/commands/snapshot.ts`.
- [x] UserPromptSubmit memory-recall hook is **ON by default** on every non-trivial user prompt; opt out with `DREAMCONTEXT_MEMORY_HOOK=0`.
- [x] As a developer, I can set `DREAMCONTEXT_RECALL_MODE=haiku` (default) to use a single Haiku LLM call for semantic-intent-aware recall instead of raw keyword BM25, with automatic fallback to BM25 when the `claude` CLI is unavailable.

- [x] BM25F field weighting: title×3, tags×2, description×2, body×1 (feeds `rankScore` only; raw `score` stays flat-BM25 to preserve hook gate scale).
- [x] Conservative EN + TR morphological stemming applied symmetrically at index AND query time (`stemEn()` + `stemTr()` in `tokenize()`).
- [x] Query-time synonym expansion via hand-curated stemmed map (`recall-synonyms.ts`); synonyms are pre-stemmed through the same pipeline as the index.
- [x] Recency multiplier: exponential half-life 120 days, floor 0.85 (tie-breaker, not content override). `completed`/`archived` status gets 0.85× `rankScore` penalty.
- [x] `hit.score` = raw flat-BM25 (unchanged scale vs v1); `hit.rankScore` = derived sorting signal. All v2 signals feed `rankScore` only. Regression-locked by `recall-weighting.test.ts`.
- [x] Haiku corpus index is relevance-ranked (BM25 score against query) before slicing to 8K chars — no longer positional (which silently omitted ~half the corpus).
- [x] Link-aware 2-hop boost (`buildLinkAdjacency()`, `LINK_DECAY=0.3`) built and unit-tested; shipped OFF by default (`enableLinkBoost: false`) pending real wikilinks in corpus.
- [x] Auto transcript digest on SessionStart catch-up path (`session-digest.ts`); bounded ≤8KB; per-session try/catch.
- [x] Auto-salience detectors (`salience.ts`): user-correction (salience 2), error→fix (salience 1), decision-keyword (salience 2); EN+TR; max 5 moments per session. Auto-bookmarks written to `.sleep.json`.
- [x] Digests and bookmarks indexed into recall corpus (`capture: true` flag); decisions captured in session N are recallable in N+1 before sleep.
- [x] Recall hits call `bumpKnowledgeAccess(slug)` so recalled docs don't decay to stale.
- [x] `CAPTURE_RANK_PENALTY = 0.5`: capture docs' `rankScore` halved vs curated docs; raw `score` untouched.
- [x] K=50 digest cap: only 50 most-recent session digests indexed per corpus build.
- [x] Capture guard proof: `recall-capture-stress.test.ts` verifies zero gold-target displacement under worst-case capture flood (200 digests + 200 bookmarks).
- [x] Deterministic 60-query gold set (`eval/gold.jsonl`) + vitest harness (`eval/harness.ts`). Reproducible: `npx vitest run tests/unit/recall-eval.test.ts`.
- [x] Overall recall@1 68.3→85.0%, recall@3 81.7→95.0%, MRR 0.768→0.903. No category regressed. 1063 tests passing.

- [x] v3 held-out validation: 30-query blind gold set (`eval/gold-heldout.jsonl`, authored by a sub-agent that never saw the engine changes) achieves r@1 93.3%, r@3 96.7%, MRR 0.957, TR r@1 90%, TR r@3 100%. No category regressed on either train or held-out sets — no overfitting signature.
- [x] v3 engine changes: (1) two-hop TR morphology + possessive+case compound suffixes + TR question-word stopwords; (2) `DIRECTED_BRIDGES` — paraphrase→canonical is one-way only (bidirectional colloquials measurably regressed topical-adjacency); (3) EN `-e` fold fix so `database/databases` and `release/releases` merge correctly; (4) `CHANGELOG_RANK_FACTOR = 0.85` prevents short changelog entries from outranking the canonical docs they reference.
- [x] Link-aware boost tested and REJECTED with data: ~13 real wikilinks in corpus caused hub-doc hijacking (train r@1 cratered to 68.3%). `enableLinkBoost` permanently resolves to "stay off" on this corpus profile.
- [x] Snapshot token budget ladder (`src/lib/snapshot-budget.ts`): sections demote through progressively cheaper renders (full→summaries→one-line references) rather than raw-truncating. Measured: 20,253 → 10,386 tokens. `DREAMCONTEXT_SNAPSHOT_BUDGET` env var configures budget (default 10,000 tokens; "0"/"off" disables).
- [x] PreCompact partial digest: on PreCompact hook, a bounded summary of in-progress work is written before context resets, ensuring continuity across compactions.
- [x] Recall A/B harness (`scripts/recall-ab.ts`) runs engine comparisons on a frozen corpus (filters live captures + in-flight tasks) for deterministic measurement — required after discovering live corpus mutation caused false results.

## Constraints & Decisions


- **[2026-06-10]** **Decision (2026-06-10): directed synonym bridges only.** Bidirectional synonym bridges measurably regressed topical-adjacency recall — adding 'fold'↔'consolidation' as bidirectional caused unrelated queries to hit sleep/consolidation docs. DIRECTED_BRIDGES enforces one-way paraphrase→canonical mapping only.
- **Decision (2026-05-23): chose Path A over mem0 integration after 3-reviewer adversarial review.** Critic raised "premise not steel-manned" (mem0's LLM extraction solves a problem dreamcontext already solved). Pragmatist recommended cutting ~70% of the mem0 plan even in best case. Security flagged 5 critical hardening blockers (redaction order, embedding inversion, rebase data loss, finalizer crash, OpenAI exfil). Path A (BM25 over curated corpus) is deterministic, version-controllable, zero new deps. Full decision trace: see archived `/tmp/dreamcontext-mem0-{plan,decision}.md` + reviewer reports.
- **No persistent index file.** BM25 inverted index is rebuilt in-memory on every `recall` call. With ≤500 docs the rebuild is <100ms; storing an index file would add gitignore complications and cache-invalidation bugs for negligible speedup.
- **Stopword list is light, language-aware.** Includes Turkish particles (ve, ile, ki, için, gibi) since the user codes in Turkish; English stopwords are standard. Stemming is intentionally NOT applied — preserves slug-like terms (e.g., "manifest-bootstrap-safety-pattern") that exact-match in queries.
- **No semantic / synonym recall in raw BM25 mode.** Trade documented: "ML practitioner" will not match "data scientist." In Haiku mode this gap is mostly closed because Haiku understands intent across vocabulary variants and languages. If the `claude` CLI is unavailable the fallback is still raw BM25.
- **Decision (2026-05-26): Haiku single-call replaces multi-query BM25 as default recall strategy.** The original raw BM25 extracted keywords from the full prompt and ran multiple query variants. The Haiku approach sends the full prompt as-is to a single `claude --model haiku` call whose system prompt contains the full corpus index (slug + description + tags, ≤8K chars). Haiku understands intent in any language and returns exactly the relevant doc keys. The `recall-multi-query.ts` experiment (multi-query BM25 variant) was deleted in favour of this approach. Security note: `execFileSync` is used (not `exec`) and all args are positional (no shell injection). Corpus index is capped to prevent unbounded `--system-prompt` length. See `knowledge/haiku-recall-architecture.md` for full decision trace.
- **Snippet logic prefers high-density lines** (most query-term hits per line), with ±1 line of context. Good enough for eyeballing; not designed to be definitive.
- **Decision (2026-06-02): score/rankScore decoupling is inviolable.** All v2 ranking signals (BM25F, stemming, synonyms, recency, capture penalty) MUST feed `rankScore` only. `hit.score` must remain raw flat-BM25 at the original scale. The hook's `>= 2.0` / `>= 1.0` gates and the explore agent's `>= 5 / < 2` tiers depend on this scale remaining stable. Regression-locked by `recall-weighting.test.ts`.
- **Decision (2026-06-02): continuous capture ON by default, guarded by rank penalty + digest cap.** Auto-digest and auto-salience fire on every SessionStart. The CAPTURE_RANK_PENALTY (0.5×) and K=50 cap prevent corpus pollution while allowing genuine session-captured decisions to surface. These constants are exported and configurable but the guard proof test must remain green.
- **Decision (2026-06-02): stemming is applied symmetrically at index AND query time.** Both paths call `stemToken()`. This is required for correct BM25 term matching — asymmetric stemming would silently hurt precision. Do not stem only at query time or only at index time.
- **Link-aware boost deferred activation** pending real wikilinks. The `buildLinkAdjacency()` function and the LINK_DECAY logic are present; enabling requires `enableLinkBoost: true` in `Bm25Options`. Do not enable globally until the corpus has meaningful `[[slug]]` references — on a wikilink-free corpus it adds latency with zero benefit.

## Technical Details

**Key files (v2 engine):**

- `src/lib/recall.ts` — corpus loader (`buildCorpus`, `buildFields`), tokenizer with EN+TR stemming (`tokenize`, `stemToken`, `stemEn`, `stemTr`), BM25F field weighting (`FIELD_WEIGHTS`, `buildFields`), BM25 scorer (`bm25Search`), recency/status re-rank (`recencyMultiplier`, `STATUS_PENALTY`), link-aware adjacency (`buildLinkAdjacency`, off by default), capture rank penalty (`CAPTURE_RANK_PENALTY = 0.5`), snippet extractor.
- `src/lib/recall-synonyms.ts` — `expandQueryTerms()`: pre-stemmed synonym map, query-time expansion. Synonym families cover: recall/retrieval/search, embed/vector/semantic, bookmark/salience/ripple, consolidate/sleep, digest/distil/summary, capture/record/log, and more.
- `src/lib/salience.ts` — `detectSalience()`: structural auto-salience detectors (user-correction, error→fix, decision-keyword); EN+TR; capped at 5 moments/session.
- `src/lib/session-digest.ts` — `loadDigestDocs()`: auto transcript digest on SessionStart catch-up path; bounded ≤8KB; `capture: true` flag set on all digest+bookmark corpus docs.
- `src/lib/recall-query-extractor.ts` — `haikuRecall()`: builds BM25-relevance-ranked corpus index (B6 fix), caps at 8K chars, calls `claude --model haiku -p` via `execFileSync`, parses JSON, maps `type/slug` keys to `CorpusDoc[]`.
- `src/cli/commands/memory.ts` — `dreamcontext memory recall`, `status`, `remember`, `update`, `delete`, `list`.
- `eval/gold.jsonl` — 60-query gold set (deterministic benchmark; authored blind to improvements).
- `eval/harness.ts` — eval harness; `eval/BASELINE.md` + `eval/RESULTS.md` — before/after report.
- `tests/unit/recall-weighting.test.ts` — regression lock on `score` vs `rankScore` decoupling invariant.
- `tests/unit/recall-capture-stress.test.ts` — guard proof: zero gold displacement under worst-case capture flood.

**Corpus types (`CorpusType`):**

| Type | Source | Doc unit |
|---|---|---|
| `knowledge` | `_dream_context/knowledge/*.md` | 1 doc per file |
| `feature` | `_dream_context/core/features/*.md` | 1 doc per file |
| `task` | `_dream_context/state/*.md` | 1 doc per file |
| `memory` | `_dream_context/core/2.memory.md` | 1 doc per H2 section (Decisions, Known Issues — LIFO section removed 2026-05-23) |
| `changelog` | `_dream_context/core/CHANGELOG.json` | 1 doc per entry; body = `summary` + `description` + `references[]` joined |

soul.md, 1.user.md, the remaining core 3–6 files, RELEASES.json, and sleep state are intentionally NOT indexed. They are always-loaded via snapshot and belong to the deterministic tier — recall is a complement, not a replacement.

**BM25 formula:**```
score(D, Q) = Σ over q in Q: IDF(q) · TF(q,D)·(k1+1) / (TF(q,D) + k1·(1-b + b·|D|/avgdl))```with k1=1.5, b=0.75. IDF uses the `log(1 + (N - df + 0.5) / (df + 0.5))` form so it stays non-negative.

**Sleep-product specialist** (`agents/sleep-product.md`) does not need any changes — it already maintains knowledge files, feature PRDs, and the tag set. Recall reads what sleep-product already maintains.

**Verification (2026-05-23) on dreamcontext repo itself:**

10 representative queries scored against the live corpus (44 docs: 6 knowledge, 13 features, 22 tasks, 3 memory entries):

| Query | Top hit | Score |
|---|---|---|
| "sleep fan-out architecture" | sleep-fanout-architecture (task) | 9.06 |
| "council debate skill" | council-skill (task) | 7.99 |
| "ecc neuroscience inspired roadmap" | ecc-inspired-roadmap (task) | 12.20 |
| "bootstrap manifest safety" | manifest-bootstrap-safety-pattern (knowledge) | 9.78 |
| "iterative reviewer pattern" | sub-agent-iterative-reviewer-pattern (knowledge) | 9.49 |
| "meta marketing skill plan" | decision-meta-marketing-skill-adoption (knowledge) | 9.45 |
| "rice prioritization" | rice-prioritization (feature) | 9.28 |
| "quantum cryptography blockchain" | (no hits) | — |
| "sub-agent paralel reviewer" (mixed TR/EN) | sub-agent-iterative-reviewer-pattern (knowledge) | 5.83 |

Top hit was the right doc on every query that had a relevant doc. No-hit case returned a clean message. Mixed-language query still scored the right knowledge file highest.

## UserPromptSubmit Hook Integration (Default ON, Haiku Mode)

`src/cli/commands/hook.ts` user-prompt-submit handler injects recall hits into the agent's context for every non-trivial user prompt. **ON by default** — no opt-in step. Default mode is **Haiku** (single LLM call). To disable, set `DREAMCONTEXT_MEMORY_HOOK=0`. To force raw BM25, set `DREAMCONTEXT_RECALL_MODE=raw`.

Originally shipped opt-in with raw BM25 (2026-05-23). Flipped to default-on the same day. Upgraded to Haiku mode (2026-05-26) after the single-call approach proved more intent-aware, especially for multilingual (Turkish/English) and vague prompts where raw BM25 keyword extraction would miss the intent.

**Behavior (current — Haiku mode):**
- Reads the prompt from stdin (Claude Code hook payload).
- Skips if prompt < 8 chars.
- Calls `haikuRecall(prompt, root)` — single `claude --model haiku` call with corpus index in system prompt.
  - If Haiku returns `skip`: no injection (pure greeting/acknowledgment).
  - If Haiku returns 1–3 hits: inject as `— Memory recall (Haiku, top N) —` block.
  - If Haiku returns `null` (error / claude CLI unavailable): falls back to `bm25Search(prompt, corpus, 3)` and injects only if top BM25 score ≥ 2.0.
- Wrapped in try/catch — always best-effort, never breaks the prompt flow.

**Mode matrix (`DREAMCONTEXT_RECALL_MODE`):**

| Value | Behaviour |
|---|---|
| `haiku` (default) | Single Haiku call; BM25 fallback on failure |
| `raw` | BM25 only, no external process |
| `off` | No recall injection |

**Output format (`— Memory recall (Haiku, top N) —`):**```
— Memory recall (Haiku, top 2) —
  [feature] core/features/memory-recall-bm25.md
    Why dreamcontext chose BM25 over mem0 and ships Haiku-mode recall as default.
  [knowledge] knowledge/decision-mem0-vs-bm25-recall.md
    Decision trace for mem0 rejection and BM25/Haiku adoption.```## CHANGELOG Schema (2026-05-23)

CHANGELOG entries gained three optional fields, all backwards-compatible:

| Field | Type | Purpose |
|---|---|---|
| `summary` | string (≤200 char soft cap) | One-line headline rendered in the snapshot's tiered display and in recall snippets. |
| `references[]` | string[] | Prefixed tokens linking the entry to its evidence: `commit:<sha>`, `file:<path>`, `knowledge:<slug>`, `feature:<slug>`, `task:<slug>`, `url:<href>`. Searchable. |
| `supersedes` | string (entry id) | Points at a prior entry this decision replaces — surfaces "this decision was overridden" relationships during recall. |

`memory remember "<text>"` writes a CHANGELOG entry directly. Defaults: `type=note`, `scope=quick`. Override via `--type` (feat/fix/refactor/chore/docs/perf/test/note) and `--scope`. `--summary`, `--references`, `--supersedes` map onto the new schema fields.

## Tiered CHANGELOG Display (Snapshot)

The SessionStart snapshot used to render the last 5 (then 3) CHANGELOG entries with full bodies. As of 2026-05-23 the section is tiered:

- **Top 3 (detailed):** summary + first ~300 chars of `description`.
- **Next 10 (titles-only):** rendered as a compact list under an `### Older` subheading. Just `[type/scope]` + `summary` per line.

Both tier sizes (3 detailed, 10 titles-only, ~300 char body cap) are configurable via constants at the top of `src/cli/commands/snapshot.ts`. Older entries beyond the title tier are still indexed for recall — the snapshot is the always-loaded surface, recall is the on-demand surface.

## Open follow-ups (NOT v1)

- Add to dashboard: a search box on the Brain page that calls `dreamcontext memory recall --json` and renders hits.
- Consider exposing as a slash command (`/recall <query>`) for use inside Claude Code sessions.
- Optional: persist last-N queries to `_dream_context/state/.sleep.json` for analytics (would not affect ranking, just visibility into what users search for).
- If usage grows past ~500 docs, add a build-once-cache-in-memory pattern (`memory recall --watch`) to amortize tokenization cost.
- Add SessionStart hint: when corpus size grows past N docs, log a one-line "tip: `dreamcontext memory recall <query>` is available" reminder (off by default).
- Make hook toggle configurable via `_dream_context/state/.config.json` (`memoryHook: true|false`) so it's project-scoped rather than env-var-scoped.
- Make Haiku timeout configurable (currently hardcoded at 15s in `recall-query-extractor.ts`).
- ~~Tiered CHANGELOG display in snapshot (3 detailed + 10 titles)~~ — **shipped 2026-05-23.**
- ~~CHANGELOG entries as a recall corpus type~~ — **shipped 2026-05-23.**
- ~~`memory remember` writes to CHANGELOG instead of LIFO~~ — **shipped 2026-05-23.**
- ~~Haiku single-call semantic recall (default mode)~~ — **shipped 2026-05-26.**
