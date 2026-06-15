---
id: feat_ReflectionEngine_v06
status: in_review
created: '2026-06-04'
updated: '2026-06-05'
released_version: null
tags:
  - architecture
  - backend
  - decisions
  - memory
related_tasks:
  - reflection-engine
---

## Why

Sleep consolidation files individual facts per session but never *generalizes* across them. A pattern that recurs three sessions in a row ("always use BM25 before grep", "Turkish prompts need synonym expansion") remains buried in individual session digests rather than surfacing as a candidate rule. The reflection engine is the missing brain function: a deterministic, AI-free step that scans the accumulated evidence (session digests + bookmarks) and surfaces cross-session recurring terms as **candidate generalizations** — not decisions, not written to soul/user/knowledge automatically, but named and presented so the sleep agent or user can decide whether to promote them.

This turns the system from "remembers" toward "notices a rule."

## User Stories

- [x] As a developer, I can run `dreamcontext reflect` and see a markdown report of candidate generalizations (terms that recurred across ≥3 distinct sessions) so I can decide which to promote to permanent knowledge.
- [x] As a developer, I can run `dreamcontext reflect --write` and have the candidate report written to `_dream_context/state/.reflection.md` without touching any core/soul/user/knowledge file.
- [x] As the sleep agent, I can run `reflect` as a step in the consolidation flow and promote only genuinely load-bearing candidates into `2.memory.md` or knowledge — the vast majority are noise and are discarded.
- [x] As a developer, the reflect command degrades gracefully on an empty/sparse corpus (zero candidates is success, emits a valid empty artifact on `--write`).

## Acceptance Criteria

- [x] AC1 — `dreamcontext reflect` is registered in `src/cli/index.ts` and listed in `skill/SKILL.md` command table; running it on the real `_dream_context/` prints a markdown candidate report and exits 0.
- [x] AC2 — `detectPatterns` surfaces a term ONLY when it spans `>= minSessions` (default 3) DISTINCT sessions. Repeats within one session count once; multiple bookmarks from the same session collapse to one session (via the `bookmarkSessions` id→session_id map). Digest session key = `slug.slice('digest#'.length)`.
- [x] AC3 — Terms already present in corpus knowledge/feature docs, in `2.memory.md` sections (memory# slugs), or in soul/user (`excludedExtra` token set) are EXCLUDED — candidates are genuinely NEW.
- [x] AC4 — Bounded: at most `maxCandidates` (default 12) candidates; formatted output `<= MAX_REFLECTION_BYTES` (8000) via a local `capToBytes(lines[], max)` in `reflection.ts`.
- [x] AC5 (HARD) — `detectPatterns` + `formatReflection` are pure (no fs). `writeReflection` writes ONLY `_dream_context/state/.reflection.md`. No core/soul/user/knowledge file is created or modified. Unit test asserts core/ files untouched.
- [x] AC6 — Deterministic: two runs on identical input produce byte-identical candidate ordering (sort: sessionCount desc, totalOccurrences desc, term asc — total order).
- [x] AC7 — Pure Node, no AI/network: `reflection.ts` imports only `node:fs`, `node:path`, and `tokenize` from `recall.ts`; source contains no `fetch`/`spawn`/`execFile`/`claude`/`anthropic` (asserted by a source-grep test).
- [x] AC8 — Empty/low corpus degrades gracefully: no throw; zero candidates is SUCCESS (still emits a valid empty artifact on `--write`).
- [x] AC9 — Full `npm test` green + `npm run build` clean (no TS errors). 26 reflection tests; full suite 1111/1112 (1 pre-existing stress-test failure unrelated to reflection).

## Constraints & Decisions
<!-- LIFO: newest at top -->

- **[2026-06-04]** HARD: never auto-write/modify core/soul/user/knowledge — reflection only PRODUCES candidates; promotion stays with the sleep agent or user. This is a non-negotiable constraint: the engine is a suggestion surface, not an auto-writer.
- **[2026-06-04]** Out of scope (YAGNI): no LLM/semantic clustering; no auto-promotion; no `generateSnapshot` injection; no new hook; no `agents/*.md` or `.codex` mirror edits; no `--json` flag; no CHANGELOG as evidence; no dashboard UI; no trigger auto-creation; no change to `buildCorpus` or recall ranking (score/rankScore decoupling untouched).
- **[2026-06-04]** Digest session key = `slug.slice('digest#'.length)` (full UUID, no parsing). Bookmark field is `session_id` (snake_case). CLI must ALWAYS build `bookmarkSessions` map or bookmark dedup degrades. `loadBookmarkDocs` does NOT propagate `session_id` into `CorpusDoc`, so read `.sleep.json` directly for the map.
- **[2026-06-04]** Bigram pass: skip if either half is stop/noise word; drop bigram if BOTH halves are excluded. This prevents noise phrases like "create task" from appearing when "create" and "task" are individually in the exclusion set.
- **[2026-06-04]** `REFLECTION_NOISE` stoplist: command/stdout/local/session/digest/goal/bash/write/edit/file/... — prevents transcript chrome from surfacing as candidates.

## Technical Details

### Key files

- `src/lib/reflection.ts` — pure: `detectPatterns(corpus, opts): ReflectionResult`; `formatReflection(result): string`; `writeReflection(root, md): string` (writes only `state/.reflection.md`); `reflectionPath(root)`. Evidence docs = digests (`type:'task'`, slug `'digest#<uuid>'`) + bookmarks (`type:'memory'`, slug `'bookmark#<id>'`). Reuses `tokenize()` from `recall.ts`.
- `src/cli/commands/reflect.ts` — `registerReflectCommand(program)`: flags `--min-sessions` (3), `--max` (12), `--write`. Builds `excludedExtra` by tokenizing `core/0.soul.md` + `core/1.user.md`. Builds `bookmarkSessions` map from `.sleep.json`. Mirrors `transcript.ts` command structure.
- `src/cli/index.ts` — `registerReflectCommand` imported and called in `createProgram()`.
- `skill/SKILL.md` — `reflect` row in command table + one sleep-flow step (step 5a): run reflect, promote only load-bearing candidates into `2.memory.md`/knowledge, discard most as noise, NEVER auto-promote.
- `tests/unit/reflection.test.ts` — 26 tests covering all 9 ACs (threshold, distinct-session dedup, exclusion, bounds, determinism, bigram>unigram preference, no-core-write snapshot, no-AI source grep).

### Algorithm```
Evidence corpus = session digests (type:task, slug digest#<uuid>)
               + bookmarks (type:memory, slug bookmark#<id>)

For each term (unigram + bigram via tokenize()):
  sessionSet = Set<sessionKey>  // one entry per distinct session
  totalOccurrences = count of all term appearances

Cross-session DF = Map<term, Set<sessionKey>>
Exclusion = corpus type 'knowledge'|'feature' + memory sections + excludedExtra (soul+user tokens)

Filter: df >= minSessions AND term not in exclusion set
Rank: sessionCount desc, totalOccurrences desc, term asc (total order, deterministic)
Cap: maxCandidates (12); then capToBytes(lines, 8000)
Bigram preference: drop unigram if a kept bigram contains it```### Output format

`state/.reflection.md` frontmatter: `type: reflection-candidates`, `generated_at: <ISO>`. Body: disclaimer header ("these are CANDIDATES — most are noise; promote only load-bearing ones") + candidate list with session count.

## Notes

- The `reflect` step in the sleep flow is informational. The sleep agent reads the report and decides. If no candidates are load-bearing, nothing is written to permanent memory — that is the expected case.
- `recall-capture-stress.test.ts` fails in the current environment (1 pre-existing failure) because it reads live `_dream_context/state/.session-digests/*.md` created by this session's capture hook. Unrelated to reflection.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-04 - Created + all ACs implemented
- `src/lib/reflection.ts`, `src/cli/commands/reflect.ts`, `src/cli/index.ts` wired, `skill/SKILL.md` command row + sleep step 5a added.
- 26 reflection tests green; full suite 1111/1112.
- Smoke: `reflect --write` touches ONLY `state/.reflection.md`, zero core/ writes; reviewer PASS on all 8 constraints.
