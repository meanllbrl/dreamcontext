---
id: "feat_SmXNyMxN"
type: "feature"
name: "patterns-auto-injection"
description: "Patterns in knowledge/patterns/ fire by themselves: triggers are DERIVED from each pattern's own filename + H1 (nobody authors them), a deterministic gate in the UserPromptSubmit hook injects matched patterns' full prose into the turn, and per-pattern '/' entries self-maintain via a SessionStart fingerprint."
pinned: false
date: "2026-09-10"
status: "in_review"
created: "2026-09-10"
updated: "2026-09-10"
released_version: null
tags:
  - "domain:knowledge"
  - "topic:agents"
  - "topic:skills"
  - "topic:recall"
  - "architecture"
related_tasks:
  - patterns-first-class
  - knowledge-workflows
  - patterns-tetiklenir-hale-gelir-otomatik-tetik-turetme-deterministik-kapi-ve-slash-girisleri
---

## Why

A pattern was, until this shipped, only a knowledge file. A pattern could say "this is mandatory on every plan presentation" and nothing read it: it competed for a top-3 recall slot against everything else in the corpus and usually lost.

Three measurements made the gap concrete:
- **Zero of 71 patterns had a `triggers:` field.** Nothing declared when it should fire, and asking authors to write triggers by hand fixes one vault, not every user's.
- **The `/` menu had one entry — `/patterns`** — a browser you had to think to open, in a surface built for things you discover by typing `/`.
- **The shared recall tokenizer cannot bridge Turkish prose to an ascii filename.** `özetle → özetl`, ascii slug `ozeti → ozeti`, diacritic title `özeti → özeti`: one word, three stems, no meeting point, and `tokenize()` does not ascii-fold at all. So a user typing "özetle" could never reach `plan-ozeti.md`.

The user-visible failure: the owner typed "özetle", the vault's own `plan-ozeti` pattern existed, and it was never loaded. Writing triggers by hand would have been symptom-fixing. The fix had to work for every user, on every pattern, with zero authoring.

## User Stories

- [x] As a developer, I type a normal sentence and any pattern my sentence is about is loaded into the turn automatically, so I never have to remember a pattern exists or name its file.
- [x] As a developer writing a pattern, I write nothing but the pattern — no `triggers:`, no `aliases:` — and it still fires, because its triggers come from its own filename and H1.
- [x] As a Turkish-speaking (or any non-English) user, a prompt in my language reaches an ascii-named pattern file, because the pattern layer folds identity keys itself instead of relying on the BM25 tokenizer.
- [x] As a developer, the agent gets the pattern's FULL PROSE, not a pointer to go read it, so it can actually follow it in the same turn.
- [x] As a developer, I see a `/pattern-<name>` entry per pattern in the `/` menu, and it appears/disappears as I add or retire patterns without me ever running a command.
- [x] As a developer, when a pattern is injected and I then contradict, narrow, or extend it, the agent is told to fix that pattern file before finishing the task — so the vault's patterns stay true instead of silently rotting.
- [x] As a developer, if a pattern file fails to load, I am told on stderr unconditionally, so a pattern the project believes governs behaviour cannot vanish silently.
- [x] As a team using a synced brain repo, a pattern file cannot be used as an instruction channel against the agent, because injected prose is fenced as a project document and scoped to engineering guidance only.

## Acceptance Criteria

- [x] `src/lib/patterns.ts` derives identity keys from each pattern's filename + H1 with its own ascii-first folder (aggressive Turkish suffix stripping, 1-character prefix tolerance) — the global BM25 tokenizer is untouched.
- [x] Match rule is deterministic and df-aware: `firesAlone(key, df)` requires ≥4 chars at df=1, ≥5 at df=2, ≥7 at df=3; otherwise two pieces of evidence, at least one an identity key (description prose alone can never fire a pattern).
- [x] `evidenceNeeded(promptKeyCount)` scales required evidence to prompt length (≤10 keys → 1, ≤30 → 2, else 3) — the fix for the first production misfire.
- [x] The UserPromptSubmit hook injects the full frontmatter-stripped body of every matched pattern into the turn, on its own budget (`DEFAULT_INJECTION_BUDGET = 12000`, `DREAMCONTEXT_PATTERN_BUDGET` overrides; `0` reverts to pointer-only behaviour).
- [x] The single most relevant match is injected in full even when it alone exceeds the budget; the tail degrades to a MUST-READ pointer list rather than being dropped silently. `MAX_PATTERN_MATCHES = 6` is a backstop, not the real limit.
- [x] Per-pattern `/` entries are generated as `.claude/commands/pattern-*.md` (commands, not skills — 40 skills would load 40 descriptions into every session's catalog).
- [x] `syncPatternShimsIfStale()` regenerates those entries from a sha256 fingerprint (pattern filenames + mtimes + the generated shim list) stored in `state/.patterns-shims.json`; steady state is one `stat()` per pattern and zero writes. `dreamcontext patterns sync` exists to force, not to remember.
- [x] Slash names are derived from a slug hash, not a counter — adding an unrelated pattern can rename an existing `/pattern-x` once but can never repoint it at another file's content (locked by test).
- [x] The injection block carries the keep-them-true directive: a contradicted/narrowed/extended pattern is edited **before the task finishes**, in place (not appended to), with the change named in the reply; judging a correction one-off must also be said out loud.
- [x] `isReadablePatternFile()` rejects symlinks via `lstat` + realpath containment (catches a symlinked *directory*, which a leaf-only lstat missed) and enforces a 256KB per-file ceiling.
- [x] Injected prose is wrapped in `BEGIN/END PROJECT DOCUMENT` delimiters with an explicit scope warning: it is engineering guidance to follow, never a source of operational orders about the agent's own conduct.
- [x] `loadPatternsReporting()` returns `skipped[]`; the hook prints skips to stderr unconditionally (not DEBUG-gated) and `dreamcontext patterns list` surfaces them.
- [x] `dreamcontext patterns match "<phrase>"` lets a human verify what a given prompt fires.
- [x] Shared-JSON writes go through `acquireFileLock` + re-read-inside-lock + write-then-rename (the repo's own `pid-lockfile-concurrent-json` pattern).
- [x] Measured operating point published in code comments, not a "zero false positives" claim: 14/14 golden hits, 13/15 noise queries silent, the 2 remaining firings named and accepted.
- [x] Full suite green: 9299 passing, 0 failing (commit `3b66ef1`).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-09-10 — Injected prose is engineering guidance, never operational orders
Pasting vault prose into an agent turn is a prompt-injection surface the moment the vault is a team-synced brain repo: a pattern file arrives from anyone with commit access, and pattern prose gets far less review scrutiny than code. The resolution was **not** "trust it less" — obeying patterns IS the feature. The line was drawn by *category*: a pattern is documentation about **how to build things**, followed as such; it is **not** a source of instructions about the agent's own conduct (exfiltrating secrets or file contents, contacting the network, running commands). Enforced with `BEGIN/END PROJECT DOCUMENT` delimiters plus an explicit scope warning in the injected block. Full reasoning: `knowledge/injected-vault-prose-trust-boundary.md`.

### 2026-09-10 — The keep-them-true rule lives in the hook, and sleep no longer folds corrections in
A pattern the user has just contradicted is worse than no pattern: it keeps being injected and keeps being obeyed. Placement was decided by the repo's own `hook-delivered-must-not-miss-rules` pattern — the load-bearing half of a must-not-miss rule goes in the unconditional hook (a skill may not load, a snapshot may be trimmed), with the text pinned in code so it cannot drift. Correspondingly `sleep-product` was narrowed: it keeps pattern creation, condensation, retirement and shim sync, but folding a user correction into a pattern is now forbidden — by the time a cycle runs, the argument that produced the correction is gone and only its conclusion remains. A cycle that sees a contradicted-but-unupdated pattern **reports it as a missed awake rule** instead of silently rewriting it.

### 2026-09-10 — Evidence scales with prompt length; rarity in a small corpus is not specificity
The first shipped version misfired on its very first real prompt: a routine background notification triggered three patterns off the words "test", "code", "file" — each *unique* among 42 filenames but utterly ordinary in language. Suppressing by measuring word frequency across pattern bodies over-corrected (8 of 14 golden hits lost — patterns share a domain vocabulary by nature). The valid fix scales required evidence to prompt length: a three-word "özetle" message is *entirely* about that pattern; "test" inside a 400-word dump is a coincidence of length. Needs no language knowledge and works in every language. Also fixed two over-stemmings: prefix tolerance 2→1 chars, and single-vowel suffix stripping limited to words ≥6 chars (`state` and `status` were both folding to `stat`).

### 2026-09-10 — Cross-language bridging from description prose was tried and REJECTED
Deriving extra keys from description prose bought 1 extra hit and produced 1 false positive ("öğretmen kaydı nasıl siliniyor" → `lesson-conflict`), and could not do context-df discrimination (in a 27-pattern vault every description key is df-1). A MUST-READ directive that fires wrongly is a directive the agent learns to ignore. Trade refused.

### 2026-09-10 — The global BM25 tokenizer was deliberately NOT touched
`tokenize()` is pinned to a tuned eval baseline; changing it would put every recall path at risk to fix one. The pattern layer is purely **additive**: its own folder, its own keys, its own gate. The tokenizer's Turkish/ascii limitation therefore still exists for ordinary recall — documented in `knowledge/recall-tokenizer-turkish-ascii-limitation.md`.

### 2026-09-10 — Slash entries are commands, not skills
A 40-pattern vault rendered as skills would load 40 descriptions into the skill catalog every session; the soul's 4,000-character ceiling exists for exactly this reason. Commands are the cheaper surface. **Correction of an earlier claim in this task:** commands are *not* free either — this session confirmed all 42 pattern entries listed with their descriptions in the catalog. The choice stands (skills would cost that *and* leave firing to model discretion), but the cost is nonzero and was misreported once.

### 2026-09-10 — Injection replaced pointing, on owner instruction
The first design pointed the agent at matched pattern files. The owner's requirement was that ALL relevant patterns be injected. A half-injected pattern is worse than a pointer to the whole one, so the top match is always emitted in full, and only the tail degrades to MUST-READ pointers.

### 2026-09-10 — Shim maintenance is fingerprint-gated, never per-project setup
"Do I have to run this per project, over and over?" — no. `syncPatternShimsIfStale()` on SessionStart makes the `/` entries a property of the vault's current pattern set. Verified on an empty vault: session 1 generated entries, adding a pattern added one, deleting one cleaned it up.

## Technical Details

**`src/lib/patterns.ts`** — the whole matching layer, independent of BM25 recall.
- `foldKey()` / `foldKeys()` — ascii-first identity folding with Turkish suffix stripping; 1-char prefix tolerance; single-vowel stripping gated at ≥6 chars.
- `loadPatterns()` / `loadPatternsReporting()` — the latter returns `{patterns, skipped[]}` so load failures are reportable.
- `isReadablePatternFile()` — `lstat` symlink rejection + realpath containment + 256KB ceiling.
- `keyFrequency()` → `firesAlone(key, df)` (4/5/7-char rungs at df 1/2/3) and `evidenceNeeded(promptKeyCount)` (1/2/3 at ≤10/≤30/more).
- `matchPatterns()` — two firing routes: one decisive identity key, or two pieces of evidence with at least one identity key. `MAX_PATTERN_MATCHES = 6`.
- `selectForInjection()` + `injectionBudget()` — `DEFAULT_INJECTION_BUDGET = 12000`, env-overridable; top match always full; tail becomes pointers.
- `displayName()` (frontmatter prose > H1 > slug), `slashNameFor()` (slug hash), `syncPatternShims()`, `patternsFingerprint()`, `syncPatternShimsIfStale()`.

**`src/cli/commands/hook.ts`**
- `SessionStart` → `syncPatternShimsIfStale(projectRoot, contextRoot)`, errors DEBUG-logged only (shim sync must never break a session).
- `UserPromptSubmit` → the deterministic gate with its own budget, outside the top-3 recall competition: skipped-pattern stderr lines (unconditional), the `— Project patterns (N triggered) —` header, the keep-them-true directive, then each match fenced in `BEGIN/END PROJECT DOCUMENT` with the scope warning, then any MUST-READ pointer tail.

**`src/cli/commands/patterns.ts`** — `patterns list` (incl. skipped), `patterns match "<phrase>"`, `patterns sync` (force). `cli-manifest` regenerated for the new command.

**State:** `_dream_context/state/.patterns-shims.json` (fingerprint + generated shim list). **Generated:** `.claude/commands/pattern-*.md`.

**Tests:** `tests/unit/pattern-triggers.test.ts` and siblings — 30→38→42 tests across rounds, with regression locks for both production misfires (long technical dump stays silent; `foldKey('state') != foldKey('status')`), the slash-name stability property, the symlink exploit, and the post-sync fingerprint recompute.

## Notes

- **Known, accepted false-firing:** "build alıp deploy edelim" pulls in two build patterns; "componentin state yapısı" pulls the session-state pattern. Both are topic-adjacent, not absurd; every attempt to suppress them cost real hits, so the trade is written into the code.
- **Not fixed, deliberately:** shim-deletion protection is still a marker substring search. Two reviewers disagreed (security "weak", edge-cases "fine"); downgraded to Minor because it can only hit a file that quotes the marker verbatim, and on a symlink `rmSync` removes only the link.
- **Partially solved:** slash-name collision. A colliding existing pattern's `/` name can change once; it can never point at another file's content. The test locks exactly that boundary.
- The first fix round introduced its own bug (the M6 fingerprint was written *before* sync, so every session would re-sync once forever) — caught by the M6 regression test, not by review.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-10 - Created
- Feature PRD created retrospectively during sleep, from task `patterns-tetiklenir-hale-gelir-otomatik-tetik-turetme-deterministik-kapi-ve-slash-girisleri` (4 changelog rounds) plus the prior `patterns-first-class` and `knowledge-workflows` tasks. Commits f03c001 + 3b66ef1.
