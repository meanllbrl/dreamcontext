---
id: feat_43YmPwNg
status: active
created: '2026-06-12'
updated: '2026-07-30'
released_version: v0.8.7
tags:
  - architecture
  - backend
  - devops
related_tasks:
  - issue-23-migration-system
  - >-
    migrations-pending-goes-blind-after-update-advances-setupversion-past-an-unfinished-agenttask
type: feature
name: migration-system
description: ''
pinned: false
date: '2026-06-12'
---

## Why

Each release that improves brain STRUCTURE (paths, folders, frontmatter, fences) leaves old consumer projects behind. Before this system, structural migrations were hand-baked unconditional calls inside `sleep start` (e.g., the data-structures move) — unversioned, unrecorded, and invisible to the user. The migration system replaces that with a versioned migration registry + per-clone ledger + a sleep-migration agent path + user-visible reporting, so structural changes migrate forward deterministically, are recorded once per clone, and surface to the user.

## User Stories

- [x] As a dreamcontext maintainer, I can ship brain-structure changes as versioned registry migrations with a per-clone ledger, agent task surfacing, and user-visible reporting, so that old consumer projects migrate forward instead of silently drifting.
- [x] As a dreamcontext maintainer, I can ship **two independent migrations under the same version** when one release changes two structures, and each one's code steps and agent task are gated separately.
- [x] As a user who ran `update`, `dreamcontext migrations pending` still tells me about the agent task I have not done — even though `update` already advanced my `setupVersion` past that version.
- [x] As a user with a legacy vault, an OPT-IN migration offer (e.g. organize-your-diagram-boards) never nags me as "unfinished" — it runs only through its own explicit command.
- [x] As a user with a 32K-char soul, the versioned migration splits it into a constitution plus pattern files so my snapshot fits, rather than the renderer hiding the problem.

## Acceptance Criteria

- [x] Registry (`src/migrations/`): `REGISTRY` array of `Migration{version, steps, agentTask?}`; `pendingMigrations(from, to)` returns `(from, to]` transitions in semver order (reuses `compareVersions` from `version-check.ts`); equal versions return empty.
- [x] Registry has real entries: `0.7.0.ts` retrofits the data-structures move+fence (wraps the EXISTING `migrateDataStructures` + `fenceExistingDataStructures` — not reimplemented); `0.7.2.ts` is the diagrams folder-convention migration (#20's consumer: safe-detection code step + opt-in agentTask).
- [x] Per-clone ledger at `state/.migrations.json` (`src/lib/migration-ledger.ts`): entries carry `{version, step, executor: 'code'|'agent'|'detected', timestamp, filesTouched, summary}`; reads are defensive (missing/malformed → `[]`, never throws); writes are atomic (tmp + rename).
- [x] Runner (`src/lib/migration-runner.ts`): code steps run on `update` and `sleep start`, gated by the ledger; second run is a no-op; downgrade guard returns empty.
- [x] Detected backfill: a clone whose content is already migrated but whose ledger is empty gets `executor: 'detected'` entries WITHOUT touching files (content/mtime unchanged).
- [x] Agent path: `dreamcontext migrations pending` surfaces pending agentTasks (no-content contract + ledger-write instruction); `dreamcontext migrations record --version --step --executor --files --summary` appends an `executor: 'agent'` ledger entry; `agents/sleep-migration.md` specialist + `skill/SKILL.md` sleep flow wire the surfacing.
- [x] Reporting: each applied `code` migration appends one entry to `core/CHANGELOG.json` (existsSync-guarded; never for detected-only runs); applied/pending summaries are written to `.sleep.json` `pendingMigrationNotices`, surfaced as a one-line SessionStart snapshot note, and cleared by `sleep start`; no pending → no snapshot noise.
- [x] Wikilink helper (`src/lib/wikilink-rewrite.ts`): `rewriteWikilinks(contextRoot, remaps)` rewrites `[[foo]]`, `[[foo|alias]]`, `[[foo#anchor]]` on slug moves (target token only, alias/anchor preserved), skips fenced code blocks, writes atomically, returns changed files.
- [x] Contributor docs: CONTRIBUTING.md "Shipping a migration" section — every PR changing brain structure adds `src/migrations/<version>.ts`, registers it in `src/migrations/index.ts`, includes an agentTask if judgment is needed; version key = the release the change ships in; `0.7.0.ts` is the worked example.
- [x] Validation: vitest per criterion (migration-registry, migration-runner, migration-ledger, migration-agent-task, migration-report, migration-sleep-regression, wikilink-rewrite, migration-docs) + full build green. Merged to main via PR #26 (fc3055d).
- [x] **Same-version multiplicity (0.23.0, 2026-07-30):** `REGISTRY` holds TWO `0.23.0` entries — `0.23.0.ts` (people-first) and `0.23.0-soul-split.ts`. The runner merges same-version CHANGELOG entries, gates every step by its own `step` id, and the pending-agentTask check matches on `e.step === migration.agentTask.id` (a version-only match let either recorded task hide the other). The people-first entry stays FIRST so its residue task prints first. Registry-uniqueness test reshaped from per-version to per-agentTask-id.
- [x] **`agentTask.optIn?: boolean` (2026-07-30):** marks a task that is an OFFER, not an obligation (0.7.2's diagram-folder organization). Opt-in tasks are never "unfinished", so a ledger-judged pending never nags an old vault about them; they run through their own command and record their ledger entry there.
- [x] **`unfinishedAgentTasks(contextRoot, toVersion)` (2026-07-30):** pending agent work is judged by the **LEDGER**, never by `setupVersion`. `update` advances `setupVersion` the moment code steps land, so a setupVersion-ranged `migrations pending` computed the empty range `(cliVersion, cliVersion]` and went blind to the very task it exists to print. A migration is unfinished iff its code/detected steps ARE in the ledger and its agent step is not — the "started" requirement is what keeps a freshly-initialized vault from being told to distribute residue that never existed.
- [x] **0.23.0-soul-split:** code step `detect-oversized-soul` is detection-only (compares `core/0.soul.md` length against `CORE_FILE_CHAR_CEILING`); the `split-soul-into-patterns` agentTask performs the judgment work with an explicit doctrine — constitution-only soul, verbatim moves, nothing discarded, 4,000-char target, `doctor` verification. 53 migration tests green including a same-version dual-task independence case.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-30]** **A version is not an identity — a step is.** Once two migrations could share `0.23.0`, every version-keyed check became a bug surface: the runner's agentTask gate, the ledger's applied test, the registry uniqueness test. All of them moved to step-id keying. The version stays the *ordering* key only.
- **[2026-07-30]** **The ledger is the only honest answer to "what is left to do".** `setupVersion` records what the CLI *installed*, not what the user *finished*; anything that asks "is there pending work?" must read the ledger. Found live on the first real 0.23.0 run: the residue file told the user to run `migrations pending`, and `migrations pending` said there was nothing to do.
- **[2026-07-30]** **Bloat is fixed by migration, not by the renderer.** The soul-split lives here rather than in the snapshot because an oversized constitution is a content problem in every existing vault; a render-time trim would hide it forever. Same split-of-labour as `distribute-user-md-residue`: deterministic detection in the code step, judgment in the agentTask.
- **[2026-07-30]** **Non-standard headings mean the migration must NOT guess.** Tilki used "User Preferences & Working Style" instead of the expected heading, so `split-user-file` scaffolded an EMPTY constitution and routed everything to `inbox/1.user-residue.md` — by design. The agent then placed it. Guessing would have silently mangled a person's constitution.

- **[2026-06-12]** First consumer shipped (#20): migration `0.7.2` (diagrams folder convention). Its code step is SAFE-DETECTION ONLY — it detects flat boards and records `detected` without moving anything (moves risk silent slug/wikilink/access-record breakage). The move + atomic wikilink rewrite live in the opt-in agentTask `diagrams-folder-convention`, executed via `dreamcontext migrations apply-diagrams`.
- **[2026-06-11]** `generateSnapshot` stays READ-ONLY: the snapshot note is driven by `.sleep.json` `pendingMigrationNotices` written by `update`/`sleep` and cleared by `sleep` — no ledger writes in the snapshot path (hook must never break or mutate).
- **[2026-06-11]** The ledger is a per-clone record, NOT the source of truth for content. Code steps must be independently filesystem-idempotent; the ledger gate is an optimization, not the safety net. This is what makes team clones and fresh projects safe (detected backfill).
- **[2026-06-11]** `sleep-migration` agent owns STRUCTURE only (paths/folders/frontmatter/fences), NEVER body prose. If it moves files it must update inbound `[[wikilinks]]` (or list broken links), and it writes the ledger ONLY on completion via `dreamcontext migrations record` (re-run safe).
- **[2026-06-11]** The old unconditional `migrateDataStructures()`/`fenceExistingDataStructures()` calls were fully REMOVED from `sleep.ts` (not duplicated) — the registry wraps the same functions; leaving both would double-execute. The migrations CLI is pared to `pending` + `record` (+ `apply-diagrams` from #20); no `status` subcommand (YAGNI). Out of scope: rollback/undo, content-semantic migration, dashboard migration-history UI, cross-project orchestration.

## Technical Details

**Registry** — `src/migrations/types.ts`: `Migration{version, steps: MigrationStep[], agentTask?: MigrationAgentTask{id, instruction, optIn?}}`; `MigrationStep = (root) => {step, filesTouched, summary, detected}`. `src/migrations/index.ts`: `REGISTRY` + `pendingMigrations(from, to)` (half-open `(from, to]`, semver-sorted) + `unfinishedAgentTasks(contextRoot, toVersion)` (ledger-judged; skips `optIn`; requires a `code`/`detected` entry to exist and no matching `agent` entry).

Entries, in registry order: `0.7.0.ts` (move + fence data-structures), `0.7.2.ts` (diagram detection + the `optIn` `diagrams-folder-convention` agentTask), `0.8.0.ts`, `0.10.7.ts`, `0.18.0.ts`, `0.23.0.ts` (people-first: `rescale-legacy-sleep-debt`, `seed-people-from-config`, `split-user-file`, `retire-config-roster` + the `distribute-user-md-residue` agentTask), `0.23.0-soul-split.ts` (`detect-oversized-soul` + the `split-soul-into-patterns` agentTask). **The last two deliberately share version `0.23.0`.**

**Ledger** — `src/lib/migration-ledger.ts`: `readLedger` (defensive), `writeLedger` (atomic tmp+rename), `appendLedger`, `isApplied(ledger, version, step)`. File: `_dream_context/state/.migrations.json`.

**Runner** — `src/lib/migration-runner.ts` `runMigrations(root, fromVersion, toVersion) → {applied, pendingAgentTasks}`: downgrade guard → pending → per-step ledger gate → run → `executor = detected ? 'detected' : 'code'` → append ledger → collect agentTasks lacking an `executor:'agent'` entry → CHANGELOG append (one entry per version with ≥1 code step, existsSync-guarded).

**Execution points** — `update.ts`: captures `fromVersion = readSetupConfig(...).setupVersion ?? '0.0.0'` BEFORE the #22 setupVersion bump, then (when `!packsOnly`) runs `runMigrations(ctxRoot, fromVersion, dreamcontextVersion())` and adds a summary line. `sleep.ts`: same call replacing the old unconditional migration calls; prints applied summaries; writes `pendingMigrationNotices` into `.sleep.json`.

**Snapshot note** — `generateSnapshot` reads `pendingMigrationNotices` read-only (after the #22 drift block, inside the never-evict flush); emits `## Migrations Applied` or nothing; try/catch → `''`.

**Agent path** — `agents/sleep-migration.md` (conditional sleep specialist, mirrors the other sleep-* agents); `src/cli/commands/migrations.ts`: `pending`, `record`, `apply-diagrams` (added by #20: organizes flat boards into `knowledge/diagrams/<title>/`, moves board + unambiguous same-basename generator/spec siblings, atomically rewrites inbound wikilinks via `src/lib/diagrams-migration.ts` + `wikilink-rewrite.ts`; never runs generators, never edits scene JSON). `skill/SKILL.md` sleep flow conditionally fires sleep-migration when `dreamcontext migrations pending` has output.

**Wikilink helper** — `src/lib/wikilink-rewrite.ts`: standalone (regex replicated from `recall.ts` with a cross-ref comment, not refactored); code-fence skip; atomic writes; slug = path-relative per `knowledge-index.ts`.

**Live 0.23.0 execution (Tilki, the mature peer vault, 2026-07-30)** — the first real-vault run, against a staged 0.23.0 CLI (dist copy + bumped `package.json`; the repo was left untouched):
- People-first code steps all green: sleep debt rescaled 14 → 42, `people/people.json` seeded from git identity, `1.user.md` split and retired, config roster already-retired (detected). The constitution scaffolded EMPTY because of the non-standard heading, so everything landed in `inbox/1.user-residue.md`; the agentTask was then executed by hand (constitution filled; 4 workflow blocks → `knowledge/patterns/`; an em-dash rule → soul; a brand-name rule → style guide; one duplicate dropped; residue deleted; ledger recorded, 5 steps).
- Soul-split agentTask: soul 32,912 → 3,983 chars. Kept identity/brand/philosophy + 16 unconditional rules; moved 37 conditional rules into 10 clustered pattern files, with the originals byte-exact in `knowledge/archive/0.soul-2026-07-pre-split.md`. Ledger 6/6, `migrations pending` silent, idempotent re-run clean, `doctor` soul OK, and recall surfaces the moved rules by content.
- Snapshot effect: 53,668 → 48,964 (people-first) → 19,284 (soul-split), under the harness limit with no banner for the first time.
- **Release gate:** migration `0.23.0` cannot fire until `package.json` bumps to `0.23.0` (half-open range) — whoever cuts the release must bump the version WITH this feature. Side effect to watch: Tilki's `setupVersion` is now `0.23.0`, which soft-warns as drift against the published CLI until that release ships.

## Notes

- Adding a future migration is one new `src/migrations/<version>.ts` + one import/push in `src/migrations/index.ts`. Two entries may share a version when one release changes two structures; keep the one whose agentTask should print first earlier in the array.
- The 0.23.0 work was driven by the task `soul-becomes-constitution-only-and-always-loads-verbatim-while-conditionals-move-to-keyword-prioritized-patterns-across-the-whole-system` (not listed in `related_tasks` — `related_feature` is single-valued and that task's primary home is `context-snapshot`).
- `setup`/`init` "born migrated" stamping was deliberately dropped — the first `update`/`sleep` backfills `detected` entries naturally.
- The 0.23.0 work is **uncommitted in the working tree** as of 2026-07-30 (`src/migrations/0.23.0-soul-split.ts` is untracked; `index.ts`, `types.ts`, `migration-runner.ts`, `0.7.2.ts` and `migration-agent-task.test.ts` are modified).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-30 - 0.23.0 ships TWO same-version migrations, and pending goes ledger-judged (UNCOMMITTED)
- `0.23.0-soul-split.ts` registered as a second `0.23.0` entry; the runner merges same-version changelog entries and gates each step and agentTask by its own id.
- `agentTask.optIn` added so offer-shaped tasks (diagram folders) never register as unfinished work.
- `unfinishedAgentTasks()` replaces the setupVersion-ranged pending computation — the bug that made the residue instruction unreachable on the first live run.
- Executed live on Tilki: soul 32,912 → 3,983 chars, snapshot 53,668 → 19,284, ledger 6/6, doctor clean. 53 migration tests green.

### 2026-06-12 - Created (retrospective consolidation of #23, PR #26)
- Versioned migration registry + per-clone atomic ledger + runner (detected backfill) + sleep-migration agent + migrations CLI + snapshot note + wikilink-rewrite helper + CONTRIBUTING docs. Merged to main fc3055d; all 9 ACs verified. First consumer: 0.7.2 diagrams migration (#20).
