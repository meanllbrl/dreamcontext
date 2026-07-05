---
id: feat_43YmPwNg
status: active
created: '2026-06-12'
updated: '2026-06-21'
released_version: v0.8.7
tags:
  - architecture
  - backend
  - devops
related_tasks:
  - issue-23-migration-system
  - issue-20-excalidraw-knowledge
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

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-12]** First consumer shipped (#20): migration `0.7.2` (diagrams folder convention). Its code step is SAFE-DETECTION ONLY — it detects flat boards and records `detected` without moving anything (moves risk silent slug/wikilink/access-record breakage). The move + atomic wikilink rewrite live in the opt-in agentTask `diagrams-folder-convention`, executed via `dreamcontext migrations apply-diagrams`.
- **[2026-06-11]** `generateSnapshot` stays READ-ONLY: the snapshot note is driven by `.sleep.json` `pendingMigrationNotices` written by `update`/`sleep` and cleared by `sleep` — no ledger writes in the snapshot path (hook must never break or mutate).
- **[2026-06-11]** The ledger is a per-clone record, NOT the source of truth for content. Code steps must be independently filesystem-idempotent; the ledger gate is an optimization, not the safety net. This is what makes team clones and fresh projects safe (detected backfill).
- **[2026-06-11]** `sleep-migration` agent owns STRUCTURE only (paths/folders/frontmatter/fences), NEVER body prose. If it moves files it must update inbound `[[wikilinks]]` (or list broken links), and it writes the ledger ONLY on completion via `dreamcontext migrations record` (re-run safe).
- **[2026-06-11]** The old unconditional `migrateDataStructures()`/`fenceExistingDataStructures()` calls were fully REMOVED from `sleep.ts` (not duplicated) — the registry wraps the same functions; leaving both would double-execute. The migrations CLI is pared to `pending` + `record` (+ `apply-diagrams` from #20); no `status` subcommand (YAGNI). Out of scope: rollback/undo, content-semantic migration, dashboard migration-history UI, cross-project orchestration.

## Technical Details

**Registry** — `src/migrations/types.ts`: `Migration{version, steps: MigrationStep[], agentTask?: MigrationAgentTask{id, instruction}}`; `MigrationStep = (root) => {step, filesTouched, summary, detected}`. `src/migrations/index.ts`: `REGISTRY` + `pendingMigrations(from, to)` (filter by `compareVersions`, semver-sorted). Entries: `0.7.0.ts` (move-data-structures + fence-data-structures, no agentTask), `0.7.2.ts` (diagrams detection + `diagrams-folder-convention` agentTask).

**Ledger** — `src/lib/migration-ledger.ts`: `readLedger` (defensive), `writeLedger` (atomic tmp+rename), `appendLedger`, `isApplied(ledger, version, step)`. File: `_dream_context/state/.migrations.json`.

**Runner** — `src/lib/migration-runner.ts` `runMigrations(root, fromVersion, toVersion) → {applied, pendingAgentTasks}`: downgrade guard → pending → per-step ledger gate → run → `executor = detected ? 'detected' : 'code'` → append ledger → collect agentTasks lacking an `executor:'agent'` entry → CHANGELOG append (one entry per version with ≥1 code step, existsSync-guarded).

**Execution points** — `update.ts`: captures `fromVersion = readSetupConfig(...).setupVersion ?? '0.0.0'` BEFORE the #22 setupVersion bump, then (when `!packsOnly`) runs `runMigrations(ctxRoot, fromVersion, dreamcontextVersion())` and adds a summary line. `sleep.ts`: same call replacing the old unconditional migration calls; prints applied summaries; writes `pendingMigrationNotices` into `.sleep.json`.

**Snapshot note** — `generateSnapshot` reads `pendingMigrationNotices` read-only (after the #22 drift block, inside the never-evict flush); emits `## Migrations Applied` or nothing; try/catch → `''`.

**Agent path** — `agents/sleep-migration.md` (conditional sleep specialist, mirrors the other sleep-* agents); `src/cli/commands/migrations.ts`: `pending`, `record`, `apply-diagrams` (added by #20: organizes flat boards into `knowledge/diagrams/<title>/`, moves board + unambiguous same-basename generator/spec siblings, atomically rewrites inbound wikilinks via `src/lib/diagrams-migration.ts` + `wikilink-rewrite.ts`; never runs generators, never edits scene JSON). `skill/SKILL.md` sleep flow conditionally fires sleep-migration when `dreamcontext migrations pending` has output.

**Wikilink helper** — `src/lib/wikilink-rewrite.ts`: standalone (regex replicated from `recall.ts` with a cross-ref comment, not refactored); code-fence skip; atomic writes; slug = path-relative per `knowledge-index.ts`.

## Notes

- Adding a future migration is one new `src/migrations/<version>.ts` + one import/push in `src/migrations/index.ts`.
- `setup`/`init` "born migrated" stamping was deliberately dropped — the first `update`/`sleep` backfills `detected` entries naturally.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-12 - Created (retrospective consolidation of #23, PR #26)
- Versioned migration registry + per-clone atomic ledger + runner (detected backfill) + sleep-migration agent + migrations CLI + snapshot note + wikilink-rewrite helper + CONTRIBUTING docs. Merged to main fc3055d; all 9 ACs verified. First consumer: 0.7.2 diagrams migration (#20).
