---
id: "feat_mBa5T4nU"
status: "in_review"
created: "2026-05-22"
updated: "2026-05-22"
released_version: null
tags: ["devops", "onboarding", "architecture"]
related_tasks: []
---

## Why

When dreamcontext ships a new version, stale files from previous installs linger silently in user projects — old agent prompts, deprecated skill files, removed hook configs. The old `install-skill` and `update` commands updated and added files but never removed files that the new version dropped. Stale files cause confused behavior (old agents shadowing new ones, removed commands still visible) and make each upgrade an imperfect overlay instead of a clean replacement.

A manifest-based install/update solves this by tracking every file dreamcontext owns at write time (`_dream_context/state/.install-manifest.json`). On the next `update`, a diff against the newly-computed manifest identifies stale entries; safe-path stale files are offered for deletion (or auto-deleted with `--yes`). First-run safety: if no manifest exists yet, bootstrap from a scan and flag candidates rather than delete.

## User Stories

- [x] As a developer, I want `dreamcontext update` to delete stale agent/skill/hook files from `.claude/`, `.agents/`, and `.codex/` when the new version no longer ships them, so I don't accumulate ghost files.
- [x] As a developer, I want the first `update` after upgrading to only flag stale files (not delete) so I can review before anything is removed.
- [x] As a developer, I want `dreamcontext setup` to run init + install-skill in one command so I don't have to run two separate commands on a new project.
- [x] As a developer, I want setup to support `--platforms`, `--packs`, and `--multi-product` flags so it can be scripted non-interactively.
- [x] As a developer, I want manifest writes to be cancel-safe so a Ctrl+C mid-install doesn't leave a corrupted manifest.
- [x] As a developer, I want filter persistence across update: installed packs and platform flags are preserved in `.config.json` and re-applied so an update doesn't forget my configuration.
- [ ] As a developer, I want `dreamcontext update --dry-run` to show what would change without writing anything, so I can audit before committing.

## Acceptance Criteria

- [x] `src/lib/manifest.ts` exists with `readManifest`, `writeManifest`, `diffManifests`, `bootstrapManifestFromScan`, `recordPlatform`, `dreamcontextVersion`, `isSafeDeletePath`.
- [x] `SAFE_DELETE_PREFIXES` covers `.claude/`, `.agents/`, `.codex/`. Files outside these prefixes are never deleted automatically.
- [x] `_dream_context/state/.install-manifest.json` is written after every successful `install-skill` or `update` run.
- [x] Manifest records `{ version, createdAt, updatedAt, platforms, files: { [relPath]: { version, kind } }, packs }`.
- [x] `update.ts` reads old manifest before running install; diffs with new manifest; offers or auto-deletes safe stale files.
- [x] First migration run (no manifest found): bootstrap from file scan, flag candidates, do not delete.
- [x] `src/lib/setup-config.ts` persists platforms + packs + multiProduct + setupVersion in `.config.json`. Updates merge (patch), never overwrite unrelated fields.
- [x] `dreamcontext setup` (`src/cli/commands/setup.ts`) runs init + install-skill in one orchestrated flow, supporting `--defaults`, `--yes`, `--platforms`, `--packs`, `--multi-product` flags.
- [x] `setup` threads manifest through every copy so the resulting manifest is complete after a single command.
- [x] Partial-flag partition preservation: when platforms/packs are passed as flags, the partitions not covered by the flags remain in the manifest (existing files not clobbered).
- [ ] `dreamcontext update --dry-run` lists changes without writing.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-05-22]** Manifest is written atomically via temp-file + rename pattern to prevent corruption on cancellation. If the write is interrupted, the old manifest remains intact.
- **[2026-05-22]** `isSafeDeletePath` only returns true for paths under `.claude/`, `.agents/`, `.codex/`. Files outside these prefixes (including `_dream_context/` itself) are never candidates for auto-deletion — user-owned data is protected by design.
- **[2026-05-22]** `setup` and `install-skill` share the same internal install logic; `setup` is a thin orchestrator that calls `init` then `install-skill`. The `SETUP_INTERNAL_ENV` env var suppresses deprecation hints from child commands when invoked via `setup`.
- **[2026-05-22]** Old `install-skill` and `install-claude-md` commands are deprecated but not removed until v0.5. They print a deprecation hint directing users to `setup` unless invoked via `setup` itself.
- **[2026-05-22]** Bootstrap scan on first migration: scans `.claude/`, `.agents/`, `.codex/` for files matching known dreamcontext-owned path patterns. This heuristic is best-effort; the first post-upgrade `update` only flags, never deletes.

## Technical Details

**Key new files**:
- `src/lib/manifest.ts` — manifest type definitions, read/write/diff/bootstrap/record helpers.
- `src/lib/setup-config.ts` — typed `.config.json` read/write/merge. Adds `setupVersion` field.
- `src/cli/commands/setup.ts` — `dreamcontext setup` one-shot command.

**Manifest diff logic** (`diffManifests(old, new)`):
- `added`: in new but not old.
- `removed`: in old but not new (candidates for deletion after `isSafeDeletePath` check).
- `changed`: in both but with different `version` field.

**Stale-file deletion flow** (`pruneStaleFiles` in `update.ts`):
1. Filter `diff.removed` by `isSafeDeletePath`.
2. Unsafe paths: warn, skip.
3. If `isFirstRun` (bootstrapped manifest): flag all candidates, return early without deleting.
4. Else: prompt user (or auto-confirm if `--yes`); delete confirmed files; handle per-file errors gracefully.

**`update.ts` flow**:
1. Detect installed platforms from disk.
2. `getOrCreateManifest` reads or bootstraps old manifest.
3. Run `installCoreForPlatform` for each platform (builds new manifest in memory).
4. Diff old vs new to find stale files; prune before persisting.
5. Write final manifest.

**`setup.ts` flow**:
1. Resolve platforms (flag > defaults > interactive).
2. Run `dreamcontext init` (skipped if `_dream_context/` already exists).
3. Run `dreamcontext install-skill` for selected platforms + packs.
4. Write `.config.json` with full setup state.
5. Write platform defaults file.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-05-22 - Created
- Feature PRD created from v0.4 session.
