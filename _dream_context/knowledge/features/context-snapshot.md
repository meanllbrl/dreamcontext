---
id: feat_4NB3SlrK
status: active
created: '2026-02-25'
updated: '2026-07-30'
released_version: 0.1.0
tags:
  - architecture
  - backend
  - onboarding
related_tasks:
  - >-
    the-sessionstart-snapshot-busts-the-harness-limit-even-fully-demoted-so-the-brain-arrives-as-a-2kb-blind-preview
  - >-
    soul-becomes-constitution-only-and-always-loads-verbatim-while-conditionals-move-to-keyword-prioritized-patterns-across-the-whole-system
type: feature
name: context-snapshot
description: ''
pinned: false
date: '2026-02-25'
---

## Why

Every AI session starts blind — no memory of previous work, no knowledge of project identity or rules. The snapshot solves this by auto-injecting the full project brain into context at session start via a hook, requiring zero tool calls from the agent. It is the core value proposition of the entire system.

## User Stories

- [x] As an AI agent, I want my project identity (soul), user preferences, and memory injected at session start so I don't have to read core files manually.
- [x] As an AI agent, I want active tasks surfaced automatically so I can immediately see what work is in progress without grepping the state directory.
- [x] As an AI agent, I want the knowledge index loaded every session so I know what deep research exists and can load it on demand.
- [x] As an AI agent, I want pinned knowledge files surfaced prominently at the top of the Knowledge Index with a warning, so I know which files to load — without inlining their bodies into the snapshot (kept body inlining out as of 2026-05-23 to keep snapshot under budget).
- [ ] ~~As an AI agent, I want sleep state shown at startup so I know whether to consolidate before doing more work.~~ — Sleep State block was **removed from the snapshot** on 2026-05-23. Debt and consolidation prompts still surface via the SessionStart consolidation directive prepend and the UserPromptSubmit hook reminders; the standalone Sleep State block was duplicative.
- [x] As an AI agent, I want recent CHANGELOG entries surfaced **tiered**: top 3 detailed (summary + ~300 char body), next 10 titles-only under an "Older" subheading — so I get the most recent signal without the section eating context budget.
- [x] As an AI agent, I want the features summary shown (with Why, related tasks, latest changelog) so I understand the product surface without reading every PRD.
- [x] As an AI agent, I want the extended core files index shown so I know what additional files exist and can read them on demand.
- [x] As a sub-agent, I want a lightweight context briefing injected at launch so I know the project structure and can check existing knowledge without any tool calls.

- [x] As an AI agent working on a large project, my session snapshot stays within a token budget (default 10,000 tokens) because sections demote through progressively cheaper renders rather than being raw-truncated — so I never silently lose the knowledge index or warnings.

- [x] As an AI agent, my project's constitution (soul + the active person's file) arrives FULL and VERBATIM in every snapshot at any budget pressure, so the rules I am bound by are never summarized, compressed, or evicted out from under me.
- [x] As an AI agent, the project's patterns arrive in their own block with a hard warning at every rung — never folded into anonymous folder inventory — because the patterns hold the conditional rules that used to live in the soul.
- [x] As an AI agent, each inventory section (tasks, changelog, bookmarks, features, knowledge) ends with a standing line that teaches me how to SEARCH and BROWSE it, so a section head is never a dead end even at its floor.
- [x] As an AI agent, every active task is ACCOUNTED FOR at any budget: detailed, named on the needs-attention line, or inside a per-status count whose sum equals the true total — so a demoted board never silently drops work.
- [x] As an AI agent, tasks are displayed by their frontmatter NAME (Turkish and other non-ASCII intact) with the slug carried as a `->` path subline, so a mangled legacy slug is never shown to me as a title.
- [x] As an AI agent, `core/2.memory.md` renders in FULL whenever it is within the 4,000-char core ceiling — sleep is memory's compressor, so render-time rungs would be double taxation.
- [x] As a user, I can ask a metric question from the snapshot at any budget because the Lab section has no demotion rungs at all (Operational Rule 13 is the section's whole purpose).

## Acceptance Criteria

- Running `dreamcontext snapshot` outputs a plain-text, no-color document to stdout.
- Soul (0.soul.md), user (1.user.md), and memory (2.memory.md) are always included in full when they exist.
- Active tasks (status != completed) are listed with name, status, priority, and last-updated date.
- ~~Sleep state section appears only when debt > 0 or sessions exist; shows debt level (Alert/Drowsy/Sleepy/Must Sleep).~~ **Removed 2026-05-23** — Sleep State block is no longer emitted as a dedicated section. Consolidation pressure is communicated via the SessionStart consolidation directive (prepended before the snapshot when debt is high or critical bookmarks exist) and via the UserPromptSubmit hook one-liner.
- Recent CHANGELOG is tiered: top 3 entries detailed (summary + first ~300 chars of description), next 10 entries as titles-only under an `### Older` subheading. Tier sizes are configurable via constants at the top of `src/cli/commands/snapshot.ts`.
- ~~Features section includes each feature's status, tags, `Why:`, related tasks, and latest changelog entry.~~ **Superseded 2026-07-30 (level-0 density redesign):** the Features section is `name + status + -> path` lines only, active-first, single rung packing into `FEATURES_ROSTER_CHARS` with a named tail. The PRD is one `Read` away; the snapshot's job is to say the feature EXISTS and where it lives.
- Active-task surfacing caps the task's `why:` excerpt at **250 chars**, with HTML template comments stripped. Tasks display the frontmatter **name** (non-ASCII preserved) and carry `-> _dream_context/state/<slug>.md` as the address subline.
- ~~Knowledge index lists all knowledge files with slug, path, description, and tags.~~ **Superseded 2026-07-30:** only **pinned** entries carry descriptions (at any level) and **patterns** carry a title + path + one-clause brief; all other knowledge is a single accurate count + search-commands line (`(+N more knowledge file(s), not listed — search: … · full index with descriptions: dreamcontext knowledge index)`), at level 0 AND at the floor. The Warm Knowledge section was deleted entirely.
- Extended core index lists all core files numbered 3+ (not soul/user/memory) with their name and summary; the demoted rung keeps a short word-safe per-file summary (`EXTENDED_CORE_SUMMARY_CHARS = 90`) instead of collapsing to bare name+path.
- [x] **Constitution renders verbatim:** `core/0.soul.md` and the active person's constitution are never-evict AND have no compression rungs — full text at every budget. An oversized soul is a CONTENT problem (fixed by the 0.23.0 soul-split migration + `doctor`), never a render-time trim.
- [x] **Patterns block with hard banner at every rung:** patterns render under their own `### Patterns (reusable playbooks)` heading preceded by `PATTERNS_BANNER` (same register as the pinned banner: "Bu pattern'lar projenin KURALLARIDIR … MUTLAKA OKU!"). Level 0 = title + path + brief (`PATTERN_BRIEF_CHARS = 80`); rung 1 drops briefs; rung 2/floor = slugs only packed into `PATTERNS_FLOOR_CHARS = 1_000` with a named tail. Patterns are never folded into folder grouping and are deliberately NOT `pinned: true` per file (the pin block is unbounded at level 0; pinning stays the user-curation channel).
- [x] **Every active task is accounted for:** at any rung, `detailed + named-on-the-needs-attention-line + counted` sums to the true active total. Asserted on the 60-task acceptance fixture and a 200-task variant.
- [x] **Standing search/browse footers at every rung including floors:** changelog (`memory recall --types changelog` + `changelog list --page 1`), tasks (`memory recall --types task` + the full `tasks list` filter surface), bookmarks (`bookmark list`), features (`memory recall --types feature` + the PRD path). Objectives, lab, memory and knowledge already carried theirs.
- [x] **Memory conditional full render:** `core/2.memory.md` at or under `CORE_FILE_CHAR_CEILING` (4,000 raw chars, the same measurement `doctor` uses) renders in full with no rungs, plus one pointer line. Over-ceiling files keep the 3-rung ladder and earn a `doctor` error.
- [x] **Lab has no rungs at all:** the section is name + latest value + staleness plus a `Detail: dreamcontext lab show <slug> · sync: …` pointer, at every budget. No cheaper render exists that still serves Operational Rule 13.
- [x] **No raw truncation anywhere:** every capped line goes through `capAtWordBoundary`; a global tripwire test fails if an ASCII `...` mid-word cut is reintroduced on the mature fixture.
- If `_dream_context/` does not exist, the command exits silently with no output and no error.
- Output is designed for `SessionStart` hook consumption — no chalk, no interactivity.
- `hook subagent-start` outputs valid JSON `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}` per Claude Code's SubagentStart hook spec. The briefing inside is ~25 lines: project summary, directory structure, active tasks, knowledge index, pinned knowledge, usage instructions.

- [x] Snapshot token budget ladder: `src/lib/snapshot-budget.ts` enforces demotion waves (full→summaries→one-line references); never-evict tier (soul, user, warnings, reminders) is untouchable; stops demoting the moment the snapshot fits. Measured on this repo: 20,253→10,386 tokens. `DREAMCONTEXT_SNAPSHOT_BUDGET` env var configures budget; "0"/"off" disables (legacy unbounded).

## Constraints & Decisions

> **Implementation status (2026-07-30): the entire level-0 density redesign below is UNCOMMITTED in the working tree.** `src/cli/commands/snapshot.ts`, `snapshot-caps.ts`, `snapshot-budget.ts`, `snapshot-compress.ts`, `task-query.ts`, `tasks.ts`, `id.ts`, `federation-peer-summary.ts`, both golden fixtures, `src/lib/changelog-list.ts` + `src/cli/commands/changelog.ts` (untracked) and the test suites are all modified-but-uncommitted on `main`. Suites are green (5,494 unit) and the live results below are real measurements, but nothing here is in a commit or a release yet.

- **[2026-07-30] The default render is itself compact — level 0 is no longer "everything, in full".** The old model treated level 0 as maximal and relied on the ladder to shrink under pressure; on a mature vault that made the ladder do all the work and made the *default* the worst case. Now every inventory section is authored dense at level 0 and demotes from there. Owner voice directive + two AskUserQuestion picks.
- **[2026-07-30] Inventory sections TEACH SEARCH instead of listing.** Non-pinned, non-pattern knowledge is not listed at all — one accurate count plus the exact `memory recall` / `knowledge index` commands. Features are name + status + path with a search footer. The routine task queue is a per-status count plus a footer teaching the whole `tasks list` filter surface. Rationale (Fable judge verdict D, owner-approved): a name with **no session-start consumer** is not context, it is inventory — the recall hook and a taught command both recover it on demand, and the same name was triple-covered (roster + recall + list). This is the counterweight to `budget-demotion-floor-prevents-blinding`: a bare count is blinding **only when the name is the routing key** (Lab metric slugs, objective titles, exceptional task states); when it is not, the count plus a taught command is strictly better than the names.
- **[2026-07-30] Exceptions are the signal, not the queue.** The demoted Active Tasks render is: activity-sorted detailed head (`TASKS_DETAIL_CHARS = 1_100`, max `TASKS_DETAIL_MAX = 3`; floor 400 / max 1, whole blocks only, in_progress only past rung 1) → a **needs-attention** line naming every not-detailed task whose status is outside `todo|planned` or whose priority is critical (overflow in_progress included, marked `[in_progress]` — the concurrent-thread "continue X" case; `TASKS_EXCEPTIONS_CHARS = 450` / floor 250) → per-status counts → the filter-teaching footer. `TASKS_L1_CHARS`, `TASKS_L2_CHARS` and `TASKS_ROSTER_CHARS` are retired. **Level 0 is unchanged** — small vaults keep the whole board and both goldens stayed byte-identical without regeneration.
- **[2026-07-30] The soul is a constitution and renders verbatim; conditionals become patterns.** Soul and the active person's file are never-evict AND rung-less. Consequently the patterns surface must carry rule weight: its own block, its own hard banner, at every rung, never folded into folder grouping. Patterns were deliberately NOT marked `pinned: true` — the pin block is unbounded at level 0 (12+ pins with long descriptions would push a live vault back over 20K) and pinning is the *user's* curation channel; the banner block is the structural equivalent for rules. Enforcement is systemic: a char ceiling, a `doctor` check, and the 0.23.0 soul-split migration — not a render-time trim.
- **[2026-07-30] Names, not slugs.** Tasks display the frontmatter `name` everywhere (Turkish intact); the slug stays the ADDRESS on a `-> _dream_context/state/<slug>.md` subline. Triggered by a live screenshot of mangled legacy slugs (`retmen-fte-yeniden-tasar-m`) rendering as titles. Paired fix: `foldToAscii` in `id.ts` (NFD + strip combining marks + dotless-i map) so new slugs are `ogretmen-fiyati`, not `retmen-fiyat`; existing files are never renamed.
- **[2026-07-30] Every section head must be recoverable.** A floor that names nothing and teaches nothing is a dead end — the changelog floor had zero recovery pointer. Standing one-line search+browse footers now ride at EVERY rung including floors (changelog, tasks, bookmarks, features; theses keeps its board pointer). Owner generalized it mid-turn: "bu yapıyı tasks, bookmarks ve diğer kısımlar için de yap".
- **[2026-07-29] Memory is sleep's job, not the ladder's.** `core/2.memory.md` within `CORE_FILE_CHAR_CEILING` renders in full with no rungs plus one pointer line; sleep already distills it to the ceiling and archives the rest, so render-time rungs were double taxation. Over-ceiling files (unslept vaults) keep the 3-rung ladder and a `doctor` error. Side effect fixed in the same change: the exhausted-footer's section list was doubled (~250 bytes) and pushed an otherwise-fitting snapshot into the banner.
- **[2026-07-29] Banner doctrine: give ALL valuable info; if the snapshot busts the harness limit, the banner ORDERS the agent to read the persisted file.** The proposed "emergency harness-fit band" (floors yield only at the 20K cliff) was retired. Consequence accepted: a maxed vault sits in banner-read state rather than blinding itself to fit.
- **[2026-07-29] Lab has no rungs; the Rule-13 floor became a floor of one.** Owner picked "keep name+value" — the section is rungless because no cheaper render still serves the read-path rule.
- **[2026-07-29] Named-with-identity beats a bare roster, everywhere.** The Connected Projects floor was a bare "Readable peers: names" line, which reproduced the original soul-review complaint (the agent sees "Tilki" and learns nothing); it now renders name + first-sentence identity (`CONNECTED_PEER_ID_CHARS = 90`). Same reasoning drove `EXTENDED_CORE_SUMMARY_CHARS = 90` and the bookmarks floor keeping the ★★ tier with first-sentence lines behind an accurate quieter tail.
- **[2026-07-29] Latest Release is chosen by semver, not array position,** after `RELEASES.json` put a superseded 0.20.2 on top and the snapshot crowned it. Planning and superseded entries are filtered out; empty date/summary fields disappear instead of rendering `- 0.20.2 ():`; the demoted rung caps the latest summary at `RELEASES_LATEST_SUMMARY_CHARS = 300` (0.21.0's narrative was 1.6K unbounded at the floor).
- **[2026-07-29] No raw cuts survive.** Every remaining `slice() + '...'` (changelog headline/body/older, task Why, feature Why/Latest, `extractFirstParagraph`, briefing project summary, peer `whatItIs`/activity headline) moved to `capAtWordBoundary`, with a global no-`...` tripwire on the mature fixture so a reintroduced raw cut fails the suite. Excalidraw boards are excluded from BOTH feature enumerators — a board is knowledge, never a PRD.

**Measured, live (Tilki, the mature peer vault):** 53,668 → 48,964 (0.23.0 people-first migration) → 19,284 (soul-split: soul 32,912 → 3,983) → 19,920 (patterns block added) → 21,098/21,470 (names + footers + transient Migrations Applied report) → 17,575 (knowledge search-only + tasks footer) → **16,320, no banner, fully inline** (tasks roster compression; Active Tasks 2,731 → ~900).

- **[2026-07-28]** Snapshot-budget rework (wave 2 in flight, decisions durable even if code uncommitted): On mature vaults the snapshot's never-evict tier alone (~20.9KB on dreamcontext vault, measured) exceeds the 20,000-char harness persist limit, so `applyBudget` demotes every section and still returns overBudget, then the harness performs exactly the raw 2KB positional cut the budget module exists to prevent. No demotion ladder can win when the floor already busts the ceiling.
- **[2026-07-28]** Two-tier architecture chosen: rank-ordered demotion decoupled from render order via `demotionRank` (explicit rank wins over array index for demotion, render order unchanged); byte-aware lazily-resolved rungs (thunks: `BudgetRung = string | (() => string)`; zero resolve under budget, zero thunks in the output); per-section `maxDemotionLevel` floors prevent blinding collapses (see Lab floor below); lossy-but-structure-preserving core-file compressor (`snapshot-compress.ts`: headings + rule titles + first sentences kept verbatim, paths kept, full text recoverable via `Read`/recall); two-band footer (fitted vs exhausted) and `⚠️ CONTEXT IS INCOMPLETE` over-budget banner naming the oversized files.
- **[2026-07-28]** The ceiling is 4,000 chars per core file, and characters bind — not the ~150-line rule. The line-count heuristic (SKILL.md rule 12, `agents/sleep-state.md` §C1) remains as an authoring guide, but the snapshot budget pays in UTF-16 units (`String.length`), so a 69-line file with 13,573 chars still exceeds the ceiling. `dreamcontext doctor` reports both. Propagated across SKILL.md, cli-reference, troubleshooting, knowledge-and-recall, sleep.md.
- **[2026-07-28]** Byte-identity golden testing: a date-free 19-file fixture vault rendering 8,504 chars, generated in a detached-HEAD worktree at the base SHA (7effb381) so the golden proves "no drift on an under-budget vault". Determinism pins: `vi.setSystemTime`, fresh `HOME`, `process.chdir` to fixture root (because `buildMarketingSnapshot()` resolves from CWD, not `rootOverride`, and would otherwise splice the real repo's Marketing block into the fixture), `DREAMCONTEXT_DRIFT_CHECK=0`, `triggers: []` (a matching trigger mutates `.sleep.json`), `sleep_history` omitted (migrated + rewritten on first read).
- **[2026-07-28]** Lab insight snapshot section gains `maxDemotionLevel: 1` floor (shipped commit a562d1d). A level-2 rung collapsing to "N insight(s) — lab list for details" is blinding, not a cheaper render: on both live vaults the budget ladder took it, so metric questions bypassed Lab's synced series and went to external APIs/MCPs — violating Operational Rule 13 (insights before external fetch). The floor keeps metric names + latest values in context under any budget pressure. Paired with UserPromptSubmit hook directive: insight recall hits now carry the exact `lab show` call and an explicit do-NOT-fetch line, so the rule fires on every prompt regardless of skill loading or snapshot survival.
- **[2026-06-10]** Snapshot token budget: sections demote in waves (cheapest-loss first) using `BudgetSection.demotions[]`. Never-evict sections (soul, user, warnings, reminders) are untouchable regardless of budget pressure. The budget gate is enforced in `src/lib/snapshot-budget.ts` by `applyBudget()`. Design principle: nothing is ever raw-truncated — demoted content stays reachable via file path + recall corpus.
- **[2026-02-25]** Plain text only — no ANSI colors or interactive elements. The snapshot is piped into the Claude Code context window, not displayed to a human in a terminal.
- **[2026-02-25]** Completed tasks are excluded from the snapshot to avoid cluttering context with resolved work.
- **[2026-05-23]** Feature `Why:` and active-task `why:` excerpt cap raised from 100 → 250 chars. HTML template comments stripped from excerpts so scaffold boilerplate doesn't leak into the snapshot.
- **[2026-05-23]** Sleep State section removed from the snapshot output. Consolidation pressure communicated via the SessionStart consolidation directive prepend (when debt is high or critical bookmarks exist) and the UserPromptSubmit hook reminder. The standalone block was duplicative.
- **[2026-05-23]** Pinned Knowledge body inlining removed. Pinned files surface at the top of the Knowledge Index with a prominent warning; the agent loads the bodies on demand via the surfaced path. Keeps snapshot size bounded as projects accumulate pinned docs.
- **[2026-05-23]** Recent CHANGELOG section is now tiered (top 3 detailed + next 10 titles-only). Tier sizes and body-snippet length configurable via constants at the top of `src/cli/commands/snapshot.ts`. Older entries remain searchable through `memory recall --types changelog`.
- **[2026-02-25]** Feature Why text was originally truncated to 120 chars; feature changelog entries still 120 chars.
- **[2026-02-25]** Non-pinned knowledge shows only the index line. This keeps snapshot size bounded.
- **[2026-02-25]** SubagentStart briefing is intentionally lighter than the full snapshot. Sub-agents are task-focused and short-lived; they need enough to check existing knowledge, not the full project state. Soul/user/memory content excluded to avoid leaking internal rules into sub-agent contexts.

## Technical Details

**Entry point**: `src/cli/commands/snapshot.ts` — `generateSnapshot()` function.

**Hook integration**: Three hooks are registered by `install-skill`:
- `hook session-start`: Analyzes previous session transcript for debt scoring, then calls `generateSnapshot()` and outputs plain text. Used by SessionStart hook.
- `hook stop`: Records session_id + transcript_path for the next session's debt analysis. Used by Stop hook.
- `hook subagent-start`: Calls `generateSubagentBriefing()` and outputs JSON per Claude Code's SubagentStart spec. Used by SubagentStart hook (no matcher, fires for all sub-agents). Includes Task Awareness section with plan-to-task workflow instructions.
- `hook pre-tool-use`: PreToolUse hook handler. Reads stdin JSON `{ tool_name, tool_input }`. If `tool_name === "Agent"` and `subagent_type === "Explore"` and `_dream_context/` exists, returns deny response redirecting to `dreamcontext-explore`. Otherwise outputs nothing (allow).

**Section generation order** (all sections are conditional — only emitted if data exists):
1. Soul (`core/0.soul.md`) — full file content, **never-evict and rung-less**
2. Person (`people/<slug>.md`, active person) — full constitution, never-evict and rung-less; other people render one role-only line each (demotable rank 110). `core/1.user.md` is the retired legacy layout, migrated by 0.23.0.
3. Memory (`core/2.memory.md`) — **full content when ≤ `CORE_FILE_CHAR_CEILING`**, plus a "Working set only — full history … `memory recall`" pointer; only an over-ceiling file walks the 3 rungs.
4. Extended Core Files index — `buildCoreIndex()` in `src/lib/core-index.ts`; scans `core/[3-9]*`, reads frontmatter `name`/`type`/`summary`. Demoted rung keeps a 90-char word-safe summary per file. **These files are read ON DEMAND, not billed per session** — measured on this vault, `4.tech_stack.md` + `6.system_flow.md` are 27,005 chars on disk and **297 chars in the rendered snapshot**. `CoreFileSizeAudit` carries `alwaysLoaded` (`core/[0-2]` and `people/*.md` true, `core/[3-9]` false) so `doctor` phrases its remedy off the real tier (2026-08-01, `e50935c`): the old warning claimed the snapshot pays for every core file every session, overstating the extended tier's cost by two orders of magnitude and driving a plan to gut two files that were never the problem. The ceiling and the warn status are UNCHANGED on both tiers — a 16K file is still expensive when the agent opens it — only the stated reason changed, because it was wrong. `tests/unit/core-index.test.ts` pins the split per path.
5. Active Tasks — fast-glob `state/*.md`, frontmatter, skips `status: completed`. Renders the **name**, with `-> _dream_context/state/<slug>.md` beneath. Demoted: detailed head → needs-attention line → per-status counts → filter-teaching footer.
6. ~~Sleep State~~ — **removed 2026-05-23.** Consolidation pressure surfaces via the SessionStart consolidation directive prepend + UserPromptSubmit hook one-liner.
7. Recent CHANGELOG — tiered: top 3 detailed (summary + word-safe ~300-char body), next 10 titles-only under `### Older`, then the standing search+browse footer.
7a. Latest Release — highest **semver** entry in `core/RELEASES.json` excluding `planning` and `superseded`; empty date/summary omitted; demoted summary capped at 300 chars.
8. Features — `knowledge/features/*.md` (typed knowledge, `type: feature`; excalidraw boards excluded). `name + status + -> path` only, active-first, then the features footer.
9. Knowledge Index — `buildKnowledgeIndex()` in `src/lib/knowledge-index.ts` (globs `**/*.md`, so subfolders are recall-safe). Order: pinned block (descriptions kept) → **patterns block behind `PATTERNS_BANNER`** → one count + search-commands line for everything else. No folder inventory, no Warm Knowledge section.
10. Objectives / Lab / Theses / Automations / Bookmarks / Connected projects — each with its own floor doctrine (Lab rung-less; theses = summary + top 2 open + board pointer; automations collapse routine ok runs to one aggregate line while failures/blocked/orphan keep per-item detail and render first).

**Budget architecture (two-tier model)**:

1. **Never-evict tier**: soul, the active person's constitution, warnings, constraints, reminders — full text at any pressure, and (soul/person) with no compression rungs at all. Consequence: an oversized constitution is a *content* problem that `doctor` errors on and the 0.23.0 soul-split migration fixes, never something the renderer trims.
2. **Demotable tier**: memory (only when over-ceiling), tasks, changelog, objectives, lab (floor of one), features, knowledge, bookmarks, connected projects, people roster — progressive demotion through curated rungs, ordered by `DEMOTION_RANKS`.

Demotion mechanics (`src/lib/snapshot-budget.ts`):
- `BudgetRung = string | (() => string)` — lazily-resolved thunks; zero resolve under budget, zero thunks in the output.
- `demotionRank?: number` — explicit rank decouples demotion order from render order (cheapest-loss-first demotes, render order unchanged).
- `maxDemotionLevel?: number` — per-section floor prevents blinding collapses. A floor is warranted when the item NAME is the routing key; where it is not, the section instead teaches its search/browse command (see the 2026-07-30 decision above).
- Rungs memoized per `${id}:${level}`; two-band footer (fitted vs exhausted, de-duplicated section list).

Core-file compression (`src/lib/snapshot-compress.ts`, `src/lib/snapshot-caps.ts`):
- Lossy-but-structure-preserving: headings + rule titles + first sentences kept verbatim, paths kept, full text recoverable via `Read`/recall. Applies to extended core files and over-ceiling memory — **not** to soul or the person constitution.
- `packToCharBudget` fits whole items to a char budget, never mid-item cuts; `capAtWordBoundary` (exported from `snapshot-compress`) is the only sanctioned way to shorten a line.
- `CORE_FILE_CHAR_CEILING = 4_000` (binding); `CORE_FILE_LINE_CEILING = 150` (authoring heuristic).

Level-0 density constants (`src/lib/snapshot-caps.ts`, 2026-07-30):
`TASKS_DETAIL_CHARS = 1_100` / `TASKS_DETAIL_MAX = 3` / `TASKS_DETAIL_FLOOR_CHARS = 400`; `TASKS_EXCEPTIONS_CHARS = 450` / `TASKS_EXCEPTIONS_FLOOR_CHARS = 250`; `PATTERN_BRIEF_CHARS = 80`; `PATTERNS_FLOOR_CHARS = 1_000`; `EXTENDED_CORE_SUMMARY_CHARS = 90`; `CONNECTED_PEER_ID_CHARS = 90`; `RELEASES_LATEST_SUMMARY_CHARS = 300`; `FEATURES_ROSTER_CHARS = 450`; `PINNED_KNOWLEDGE_CHARS = 1_300`. **Retired:** `TASKS_L1_CHARS`, `TASKS_L2_CHARS`, `TASKS_ROSTER_CHARS`, `KNOWLEDGE_L2_CHARS`, `FEATURES_L1_CHARS` (unused).

Signaling (`src/cli/commands/snapshot.ts`, wave 2):
- Over-budget banner: `⚠️ CONTEXT IS INCOMPLETE` appears in the snapshot header when `overBudget` is true, naming the oversized never-evict files and instructing `dreamcontext doctor`.
- Two-band footer: fitted (demotions listed, recovery instructions) vs exhausted (floor-reached sections listed, doctor command).
- `overBudget` computed PRE-footer so the banner decision precedes footer text in the render.

Doctor integration (`src/lib/core-index.ts`, `src/cli/commands/doctor.ts`, wave 2+):
- `auditCoreFileSizes()` measures both chars (`String.length`, UTF-16 units) and lines (`split('\n').length`).
- Error iff never-evict tier alone >20,000; warn over 20,000; warn past 18,000 ladder target; ok otherwise.
- `BUDGET=off` special-cased: names the disabled ladder instead of blaming core files.

**Library dependencies**:
- `src/lib/core-index.ts` — `buildCoreIndex()`, `auditCoreFileSizes()`
- `src/lib/snapshot-budget.ts` — `applyBudget()`, `BudgetSection`, `BudgetRung`, demotion ladder
- `src/lib/snapshot-compress.ts` — `compressMarkdownBlock()`, `packToCharBudget()`, `compressedCoreFile()`
- `src/lib/snapshot-caps.ts` — all budget constants + `DemotableSectionId` + `NeverEvictSectionId` + `DEMOTION_RANKS`
- `src/lib/knowledge-index.ts` — `buildKnowledgeIndex()`
- `src/lib/frontmatter.ts` — `readFrontmatter()`
- `src/lib/markdown.ts` — `readSection()`
- `src/lib/json-file.ts` — `readJsonArray()`
- `src/cli/commands/sleep.ts` — `readSleepState()`

## Notes

- The snapshot is append-only by design — each section independently guarded by existence checks. A missing file never crashes the snapshot.
- The `hook session-start` command prepends a consolidation directive before the snapshot output: `>>> CONSOLIDATION REQUIRED <<<` at debt >= `DEBT_MUST_SLEEP` (60), with softer notes at >= `DEBT_SLEEPY` (40) and >= `DEBT_DROWSY` (24). Cite the constants, not the numbers — this scale has rescaled twice. This appears before snapshot content so the agent reads it first.
- The `snapshot` command is also registered as a standalone CLI command for testing/debugging purposes.
- Snapshot size can grow large on projects with many pinned knowledge files. The recommendation is to pin sparingly — only files that are needed in nearly every session.

## Changelog

### 2026-08-01 - `doctor` stops billing the extended core tier every session (`e50935c`)
- `checkCoreFileSizes` warned on every `core/[0-9]*.md` with ONE remedy — *"The SessionStart snapshot pays this every session; extract detail to knowledge/"* — but that is true only of the VERBATIM tier (core 0-2 + the active `people/*.md`). Everything from 3 up renders as the Extended Core Files INDEX: name, path, truncated first-sentence summary.
- `auditCoreFileSizes`' own docstring carried the contradiction: it opened with "every always-loaded file" and then listed "the extended files (3+)" among them.
- `CoreFileSizeAudit.alwaysLoaded` now carries the tier and `doctor` phrases the remedy off it. Ceiling and warn status unchanged on both tiers; moving the threshold for read-on-demand files is a separate product call. Pinned per path by `tests/unit/core-index.test.ts`, since this is exactly the kind of claim that drifts unnoticed.
<!-- LIFO: newest entry at top -->

### 2026-07-30 - Level-0 density redesign + constitution-verbatim doctrine (UNCOMMITTED in the working tree)
- The default render is now itself compact: features to `name + status + path`, knowledge to pinned-descriptions + a hard-warned patterns block + one count/search line, Warm Knowledge deleted, theses to summary + top 2 + pointer, lab rung-less, automations' routine ok runs to one aggregate line.
- Soul and the active person's constitution render full and verbatim with no rungs; the patterns block carries `PATTERNS_BANNER` at every rung and is never folded into folder grouping.
- Active Tasks: render by name with a `->` path subline; demoted = detailed head + needs-attention exceptions line + per-status counts + filter-teaching footer; every active task accounted for. `TASKS_L1/L2/ROSTER` retired.
- `core/2.memory.md` within the 4,000-char ceiling renders in full with no rungs.
- Standing search+browse footers at every rung including floors (changelog, tasks, bookmarks, features); `dreamcontext changelog list` and `tasks list --since/--until` exist so those footers point at something real.
- Word-safe sweep completed (`capAtWordBoundary` everywhere + a no-`...` tripwire); Latest Release picked by semver; Connected Projects floor keeps peer identity; Turkish-safe `foldToAscii` slugify.
- Live Tilki: 53,668 → 16,320 chars, no banner, fully inline. Suites green (5,494 unit); both goldens regenerated with reviewed, fixture-identical diffs.

### 2026-05-23 - Snapshot leanness pass
- Sleep State block removed from snapshot output; consolidation pressure now lives in the SessionStart prepend + UserPromptSubmit hook only.
- Pinned Knowledge body inlining removed. Pinned entries now surface at the top of the Knowledge Index with a prominent warning; agent loads bodies on demand via the surfaced path.
- Recent CHANGELOG section made tiered: top 3 detailed (summary + ~300 char body), next 10 titles-only under `### Older`. Configurable via constants at the top of `snapshot.ts`.
- Feature `Why:` and active-task `why:` excerpt cap raised 100 → 250 chars. HTML template comments stripped from excerpts.

### 2026-03-01 - Context-Aware Sub-Agent Optimization (PreToolUse + Task Awareness)
- Added `hook pre-tool-use` subcommand. Blocks default Explorer (`subagent_type: "Explore"`) via JSON deny response when `_dream_context/` exists. Non-dreamcontext projects unaffected.
- Added Task Awareness section to SubagentStart briefing for all sub-agents: plan-to-task workflow, task creation commands, "All work should be linked to a task" directive.
- `install-skill` now registers 4 hooks: SessionStart, Stop, SubagentStart, PreToolUse (matcher: "Agent").
- `agents/dreamcontext-explore.md` created: context-first Explorer. Checks _dream_context/ files first, returns immediately if context answers the query, falls back to full codebase search. Same tools as default Explorer.
- 9 new integration tests; 403 total passing.

### 2026-02-26 - Latest Release Section + Changelog Limit
- Added Latest Release section to snapshot (reads most recent entry from RELEASES.json, shows version/date/summary).
- Recent Changelog reduced from 5 to 3 entries to balance token budget.
- `src/lib/release-discovery.ts` drives both the snapshot section and the `releases add` auto-discovery.

### 2026-02-25 - SubagentStart Hook Support
- Added `hook subagent-start` subcommand outputting JSON with lightweight context briefing for all sub-agents.
- Added `generateSubagentBriefing()` to snapshot.ts; extracted `getActiveTaskLines()` helper shared with `generateSnapshot()`.
- `install-skill` now registers three hooks: SessionStart, Stop, SubagentStart.
- 10 new integration tests; 246 total passing.

### 2026-02-25 - Created
- Feature PRD created.
