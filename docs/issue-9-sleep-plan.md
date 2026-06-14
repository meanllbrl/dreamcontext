# Issue #9 — 360° Sleep/Consolidation Quality — Consolidated Implementation Plan

Validation method (user-chosen): **Tests + measurable eval** — every `it.todo` for shipped
behavior in `tests/unit/sleep-system-360.test.ts` becomes a real passing `it`; full `npm test`
green + clean build; a reproducible sleep-quality eval on a throwaway fixture project shows a
quantified BEFORE→AFTER improvement with no metric regressing.

User refinements captured in Phase 0:
- Consolidation **depth is dynamic on sleep debt** (more debt → deeper), with **agent
  discretion** (bump up with a stated reason) and **user override** (force deep). Destructive/
  expensive knowledge ops (merge / summarize-and-replace / delete-archive) run only at `deep`.
- **Optimize the debt tracker** (substance-weighted debt): sessions with *no file edits but lots
  of information shared* currently under-score. Add a bounded substance component.

---

## WS1 — Testability refactor (pure exported functions, no behavior change)

CREATE `src/lib/sleep-consolidation.ts` (leaf module, zero side-effect imports). Move the data
types from `sleep.ts:17-115` here and re-export them from `sleep.ts` so all existing importers
keep compiling. Add pure functions:

- `sleepinessLevel(debt) -> 'Alert'|'Drowsy'|'Sleepy'|'Must Sleep'` (verbatim from private
  `getSleepinessLevel`, sleep.ts:249-254).
- `sleepinessRange(debt) -> '0-3'|'4-6'|'7-9'|'10+'` (from sleep.ts:256-261).
- `recomputeDebt(sessions) -> number` (verbatim `sessions.reduce((s,x)=>s+(x.score??0),0)`, sleep.ts:438).
- `applyConsolidation(state, epoch) -> {state, sessionsProcessed, bookmarksProcessed, processedSessionIds}`
  — pure core of the epoch-clear block (sleep.ts:420-451). Operates on a CLONE (no input
  mutation). Epoch-truthy branch: survivors `= sessions.filter(s => s.stopped_at && s.stopped_at > epoch)`;
  bookmarks/dashboard_changes filtered `> epoch`; `debt = recomputeDebt(survivors)`. Epoch-null
  branch: clear all, debt 0. Always: expire triggers `fired_count < max_fires`. Does NOT write
  history / set last_sleep / call task backend / touch disk.
  **Deliberate behavior preserved (FIX: data-safety nit):** sessions with `stopped_at === null`
  (active/incomplete) are DROPPED on consolidation exactly as the current code does — documented as
  intentional so a maintainer doesn't "fix" it into a regression.
  **Single-write / no race (FIX: data-safety #2):** `sleep done` keeps the existing one read-modify-
  write pattern — capture `previousDebt = state.debt` BEFORE calling, run `applyConsolidation`,
  apply `finalizeSleepState`, then write the resulting state to `.sleep.json` exactly ONCE. No
  two-write pattern that could clobber a concurrent `hook stop`. `previousDebt` is captured by the
  caller (the function does not return it) and fed to `buildHistoryEntry`. (FIX: critic #3.)
- `upsertSessionOnStop(state, input) -> state` — pure re-stop dedupe (hook.ts:467-502): find by
  session_id; if found subtract old score (`max(0, debt-old)`), update fields, merge task_slugs;
  else unshift + `debt += score` + bump `sessions_since_last_sleep`. Returns clone.
- `appendCompactionRecord(state, record) -> state` — LIFO cap 20 (hook.ts:972-983).
- `validateSleepAdd(scoreStr, desc) -> {ok}|{error}` — sleep.ts:317-326.
- `markSleepStarted(state, nowISO) -> state`, `buildHistoryEntry(prevDebt, result, summary, today)`,
  `finalizeSleepState(state, summary, today) -> state` — small pure helpers so lifecycle
  invariants are assertable without disk.

EDIT `src/cli/commands/sleep.ts`: import + call the pure fns; delete the two private level fns;
swap the 3 `getSleepiness*` call sites (status:277-278, add:345); replace inline epoch block in
`sleep done` (420-451) with `applyConsolidation(...)`, keep history-write + reset + task-sync
(453-500) reading from the result.

EDIT `src/cli/commands/hook.ts`: `hook stop` builds `StopUpsertInput` and calls
`upsertSessionOnStop`; `pre-compact` calls `appendCompactionRecord`; export `getConsolidationDirective`
(hook.ts:288) and extract `userPromptReminder(state) -> string|null` (the debt/bookmark branch only,
hook.ts:714-726). No behavior change for these.
**WS2 test scoping (FIX: pragmatist #2):** the `user-prompt-submit` handler (hook.ts:693-908) is
deeply interleaved with recall injection, skill-gate, version-check, marketing nudge, etc. The WS2
todo "user-prompt-submit emits a one-line reminder when debt >= 4, silent below 4" is tested against
the EXTRACTED pure `userPromptReminder(state)` — NOT by invoking the full handler. The directive-
threshold todos likewise test the exported pure `getConsolidationDirective(state)` directly.

**Golden control:** capture `npm test` pass count before; refactor adds no test edits in this
step; after refactor `npm test` stays green = proof of no behavior change.

## WS2 — Lifecycle invariants locked

EDIT `tests/unit/sleep-system-360.test.ts`: convert every `it.todo` for shipped behavior into a
real passing `it`, calling the WS1 pure fns directly (epoch safety, debt recompute from survivors,
no-epoch backward compat, re-stop no-double-count, sleepinessLevel boundaries, directive
thresholds via exported `getConsolidationDirective`, the `user-prompt-submit >=4` reminder via the
extracted `userPromptReminder`, trigger expiry, compaction LIFO cap 20, >50MB transcript skip via a
sparse `truncate` file, multi-person attribution helper). The `trigger fired_count persisted across
snapshot generation` todo is a **disk round-trip** test (write state with a trigger carrying
`fired_count:2` via `writeSleepState` to a temp root, `readSleepState` back, assert preserved) — the
test file already uses `freshRoot()` temp dirs, so this is in-scope. The `attributes per person when
multiPerson` todo becomes real once WS4's `attributeByPerson` ships (same effort). Run:
`npx vitest run tests/unit/sleep-system-360.test.ts` → zero `it.todo` for shipped behavior.

## WS3 — Specialist architecture decision (evidence-based)

CREATE `scripts/feature-upkeep-evidence.ts`: load `_dream_context/core/features/*.md` frontmatter
+ task `related_feature`, run `analyzeFeatures()` (existing, src/lib/feature-freshness.ts), print
`{total, stale, orphaned, dangling, freshPct}`. Plus git churn ratio (feature-doc commits vs
src commits, 90d). Decision rule (pre-committed): add a dedicated `sleep-features` specialist ONLY
IF stale ratio > ~40% AND sleep-product cycles routinely skip feature writes; else KEEP 3 and add
a mandatory "feature upkeep considered: yes/no + why" self-report line to sleep-product.
Written decision → `_dream_context/knowledge/sleep-specialist-roster-decision.md` (3 measured
numbers + decision + rationale) and a one-paragraph `gh issue comment 9`. If roster changes, edit
canonical `agents/*.md` only + `npm run build` to mirror; register new agent in install catalog.

## WS4 — Consolidation quality

(a) **Per-person attribution** — CREATE `src/lib/attribution.ts` with
`attributeByPerson(commits, roster) -> Record<slug, change[]>` (pure, bot-filtered: drop
github-actions/dependabot). Orchestrator brief passes the detected `people` roster to each
specialist. Doc-only refs in agents/sleep-state.md (Pass B.5) + agents/sleep-tasks.md (step 2.5)
to the shared bot-filter list.

(b) **Capture→promote audit** — verification executed in the eval: are digests
(state/digests/) + auto-bookmarks (detectSalience) consumed by `sleep done` epoch-clear and
promoted into core/knowledge/feature/changelog? Metric = promotion rate. Add a mandatory closing
line to each of the 3 specialist "Return" sections: `Dropped-but-load-bearing self-check: <none|list>`.

(c) **Depth-gated knowledge ops** (user refinement 1) — see WS-DEPTH below.

## WS-DEPTH — Dynamic consolidation depth

Add to `src/lib/sleep-consolidation.ts`:
- `type ConsolidationDepth = 'light'|'standard'|'deep'`.
- `consolidationDepth(debt, {userRequestedDeep?, agentBump?}={}) -> {depth, reason, source}`.
  Base map aligned to existing thresholds: debt 0-3 → light; 4-9 → standard; 10+ → deep.
  Precedence (highest wins): `userRequestedDeep` → `agentBump` → debt base. **The function
  ITSELF clamps the bump** — `const bump = Math.max(0, Math.min(2, agentBump ?? 0))` inside the
  body — then steps `light→standard→deep` from the debt base. **Monotonic & bounded by
  construction:** a bump can only raise (never lower) and `userRequestedDeep` only forces UP to
  deep; depth never drops below the debt base, never exceeds deep. A negative/garbage bump is
  neutralized by the internal clamp, not by a caller contract. (FIX: reviewer data-safety #5.)
- `isDestructiveAllowed(depth: ConsolidationDepth | null | undefined) -> boolean` — true **iff**
  `depth === 'deep'`. Null/undefined/any-other-value → `false` (safe by default). (FIX: data-safety #4.)

Thread it:
- `SleepState` gains `consolidation_depth: ConsolidationDepth | null`. **Add `consolidation_depth:
  null` to BOTH `DEFAULT_SLEEP_STATE` (sleep.ts:117-131) and `freshDefaults()` (sleep.ts:144-160)**
  so old `.sleep.json` files back-fill safely via the existing `{...freshDefaults(), ...parsed}`
  spread in `readSleepState`. (FIX: data-safety #4.)
- `sleep start` gains a `--deep` flag and **ALWAYS** computes + persists depth:
  `state.consolidation_depth = consolidationDepth(state.debt, { userRequestedDeep: !!opts.deep }).depth`
  — i.e. with no flag it stores the debt-base depth, never leaving a stale prior value. `sleep done`
  (via `finalizeSleepState`) resets it to `null`. (FIX: pragmatist #1 — no stale-depth bleed.)
- `src/server/routes/launcher.ts` `buildSleepPrompt()`: **the desktop Sleep button bypasses
  `sleep start`**, so `buildSleepPrompt` must take a `depth: ConsolidationDepth` parameter and the
  desktop `mode==='sleep'` handler computes it at call time via
  `consolidationDepth(readSleepState(contextRoot).debt, { userRequestedDeep: true }).depth` (Sleep
  mode = user-requested deep) and passes it in. `buildSleepPrompt` injects the authorization line
  ONLY when `isDestructiveAllowed(depth)`; otherwise it injects an explicit "this is a
  light/standard consolidation — do NOT merge/summarize-replace/delete knowledge; flag candidates
  in your report instead." So both the CLI path and the high-frequency desktop path always carry a
  concrete depth directive — no silent hole. (FIX: data-safety #1.)
- Canonical SKILL.md (`.claude/skills/dreamcontext/SKILL.md` + `.agents` mirror): add a
  "Consolidation Depth" subsection (debt→depth table; destructive ops only at deep; orchestrator
  states `depth: <d> (source: ...) — reason: ...` in each specialist brief; agent MAY bump one
  tier with reason; user MAY force deep).
- `agents/sleep-product.md` Pass B: tag actions light/standard (non-destructive: create/extend/
  retag/tick) vs deep-only (merge-with-delete, summarize-and-replace still-valid detail, archive/
  delete stale). Guard text: at light/standard, flag in report instead of merging/deleting.
  **Archive-before-delete safety net (FIX: data-safety #3):** before ANY deep-tier merge-with-delete
  or summarize-and-replace, sleep-product MUST first copy the file to
  `_dream_context/knowledge/.archive/<slug>-<YYYYMMDD>.md` (create the dir if absent). The
  "Dropped-but-load-bearing self-check" report line is the audit signal; the dated archive copy is
  the recovery net. Both are required.

Tests (in `tests/unit/sleep-consolidation.test.ts`): boundary-exact level + depth maps, override,
agent bump (clamp on negative AND >2, never lowers), monotonicity, `isDestructiveAllowed` returns
false for `null`/`undefined`/`'light'`/`'standard'` and true only for `'deep'`.

## WS-DEBT — Substance-weighted debt (user refinement 2)

EXPORT `DECISION_RE`, `CORRECTION_RE` from `src/lib/salience.ts` (currently private :16-17).
EDIT `src/cli/commands/hook.ts`:
- Extend `TranscriptAnalysis` (:58) + `ZERO_ANALYSIS` (:64) with `userTurns`, `assistantChars`,
  `decisionMarkers`. **`analyzeTranscript` (:71) today regex-matches the flat `content` string and
  does NOT parse JSONL records** — so "sum the `text` block lengths" is not possible by raw regex
  (JSON-escaped multiline values). FIX (critic #1): tally the new signals by iterating the already-
  in-memory transcript **per line** with a guarded `JSON.parse(line)` (one pass, no extra file
  I/O; malformed lines skipped in try/catch): `userTurns` = records with `role==='user'` (or
  `message.role==='user'`); `assistantChars` = sum of `.length` of every assistant message
  `type:'text'` block's `text` (cap each block at e.g. 20000 chars so one giant block can't
  dominate); `decisionMarkers` = count of lines matching the imported `DECISION_RE`/`CORRECTION_RE`.
  This is a per-line parse of content already read into memory — negligible cost, and it is the
  honest implementation (the "no second parse" wording is dropped). Verify field shapes against a
  real transcript fixture before locking thresholds.
- ADD `scoreFromSubstance(signals) -> 0..3` (bounded ladder): +1 each for `userTurns>=6`,
  `assistantChars>=6000`, `decisionMarkers>=1`, `distinctTaskSlugs>=2`; `min(3, pts)`.
- Composition at both sites (:451 Stop, :542 SessionStart catch-up):
  `score = max(scoreFromChangeCount, scoreFromToolCount, scoreFromSubstance(...))`. `max` keeps it
  bounded at 3 and only raises the floor for edit-free-but-dense sessions; never lowers an
  edit-heavy score (regression guard test required).
- **Levels/limits: KEEP `<=3/<=6/<=9/10+`** — per-session ceiling unchanged (still 3), so accrual
  rate worst-case unchanged; only dense sessions reach a level a session or two sooner (intended).
  Document the decision in SKILL + a `// rationale:` comment.
Tests (`tests/unit/hook.test.ts`): substance scorer boundaries + clamp; before/after composition
(changeCount:0,toolCount:5 but dense → score>=2 vs old <=1); inverse regression (edit-heavy
unchanged); extended `analyzeTranscript` populates the 3 new fields. Thresholds are first-guess,
calibrate against real edit-free transcripts; `max`+clamp makes mis-calibration safe.

## WS-EVAL — Sleep-quality measurement (the crux, the user's "measurable improvement")

**Determinism split (FIX: pragmatist #3 + critic #2) — read this first.** The eval has TWO layers
with a hard boundary:
- **Layer 1 — automated, deterministic, no LLM (this is what the vitest test asserts and what
  proves "measurable improvement"):** metrics that are pure functions of OUR code over the fixture +
  gold. The genuine BEFORE→AFTER MOVERS are: **(8) substance-scoring** (old `max(change,tool)` vs
  new `max(change,tool,substance)` on the edit-free-dense fixture session: ≤1 → ≥2),
  **(9) depth-gating correctness** (`isDestructiveAllowed(consolidationDepth(debt,opts))` exists and
  gates correctly: 0 before / correct after), and **(5) attribution coverage** (`attributeByPerson`
  buckets multi-person changes: 0% before the helper exists → ~100% after; + 0 phantom on the
  single-person control). Metrics (1) epoch safety, (2) debt correctness, (3) no-double-count,
  (7) trigger expiry are **regression guards** (stay 100 before and after — they prove the WS1
  refactor changed nothing). The vitest test computes these purely from `(input, gold)` and the
  WS1/WS-DEBT/WS-DEPTH functions, and asserts `overall >= BASELINE`.
- **Layer 2 — manual, documented live-LLM run in RESULTS.md (NOT the asserted BASELINE):** the
  agent-driven quality metrics that CANNOT be computed without running the real specialist agents —
  **(4) dedup discipline** (did the agent actually merge the two near-duplicate knowledge files?),
  **(6) capture→promote rate** (did digests/bookmarks reach durable core/knowledge?), and PRD prose
  quality. These are tallied by hand from a real `sleep start → fan-out → sleep done` run on a
  fixture COPY, before vs after the prompt changes, and recorded as a Δ table in RESULTS.md. They
  are the human-facing demonstration, explicitly labeled "manual, not CI-asserted."

Acceptance is therefore split: (a) `npx vitest run tests/unit/sleep-quality-eval.test.ts` green with
Layer-1 overall ≥ BASELINE and movers 5/8/9 improved; (b) RESULTS.md populated with the Layer-2
manual run table. The scorer signature is `scoreConsolidation(input, output, gold)` where for the
automated test `output` is the deterministically-derived post-consolidation snapshot (applyConsolidation
result + the pure scorers), so every asserted number is reproducible by re-running the one command.

CREATE `eval/sleep-quality/` mirroring the existing `eval/harness.ts` + `recall-eval.test.ts`
conventions:
- `fixture/` — a committed, deterministic throwaway `_dream_context/`-shaped project mid-flight:
  `.sleep.json` (~6 sessions incl. post-epoch + a re-stopped dup + one edit-free-but-dense
  session; ~8 bookmarks incl. duplicates + one salience-3; 2 triggers one at max_fires), seeded
  `core/`, 3 feature PRDs (stale/orphaned/fresh), ~5 knowledge files (2 near-duplicates for merge),
  `.config.json` with `people:[mehmet, ada]` + git-author-tagged sessions. Plus a single-person
  control fixture for the phantom-attribution check.
- `scorer.ts` — pure `scoreConsolidation(input, output, gold) -> SleepQualityReport` with sub-scores
  (0-100 each + weighted overall): (1) epoch safety, (2) debt correctness, (3) no-double-count,
  (4) dedup discipline (near-duplicate knowledge → expected merged count), (5) attribution coverage
  (+ 0 phantom on single-person control), (6) capture→promote rate, (7) trigger expiry, plus the
  two refinement movers: (8) **depth-gating correctness** (destructive ops authorized iff
  `isDestructiveAllowed(consolidationDepth(...))`), (9) **substance-scoring** (edit-free-dense
  fixture session scores >=2 where baseline `max(change,tool)` scores <=1).
- `gold.json` — implementation-blind labels of expected post-consolidation state.
- `BASELINE.md` — frozen "before" numbers from a run on the pre-refinement code.
- `RESULTS.md` — BEFORE→AFTER Δ table (movers: dedup, attribution, promote-rate, depth-gating,
  substance) + a documented manual live-LLM run procedure (real `sleep start`→fan-out→`sleep done`
  on a fixture copy, tally the same metrics by hand) as the human-facing demonstration.
- `tests/unit/sleep-quality-eval.test.ts` — loads fixture+gold, runs scorer, logs the report,
  asserts `overall >= BASELINE`. Run: `npx vitest run tests/unit/sleep-quality-eval.test.ts`.

Eval acceptance: **Layer 1 (CI-asserted, the proof):** quantified improvement on substance-scoring
(8), depth-gating (9), and attribution coverage (5) with NO regression-guard metric (1,2,3,7)
dropping; `overall >= BASELINE`; reproducible via one `npx vitest run` command. **Layer 2
(documented):** dedup discipline (4) and capture→promote rate (6) shown improved in the RESULTS.md
manual live-LLM run table. Both frozen in `eval/sleep-quality/RESULTS.md`.

---

## DO NOT TOUCH (generated/install copies)
`.codex/agents/prompts/*`, `dist/**`, desktop bundle copies. Edit canonical `agents/*.md` and the
`.claude` + `.agents` SKILL copies; rebuild to mirror.

## Acceptance criteria (testable)
- WS1: pure fns exported + called from sleep.ts/hook.ts; pre-existing `npm test` stays green (golden).
- WS2: `npx vitest run tests/unit/sleep-system-360.test.ts` green, zero `it.todo` for shipped behavior.
- WS3: roster-decision knowledge file exists with 3 measured numbers + decision; issue #9 commented.
- WS4: `attributeByPerson` covered incl. single-person 0-phantom control; self-check line in all 3
  specialist reports.
- WS-DEPTH: depth map + override + bump + `isDestructiveAllowed` covered; sleep-product gates
  destructive ops to deep.
- WS-DEBT: substance scorer + composition covered; edit-free-dense session scores >=2; edit-heavy
  unchanged; thresholds-kept decision documented.
- WS-EVAL: sleep-quality eval green; RESULTS.md shows quantified BEFORE→AFTER, no regression.
- Global: full `npm test` green + clean `npm run build`.
