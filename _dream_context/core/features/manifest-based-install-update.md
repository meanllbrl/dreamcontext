---
id: "feat_mBa5T4nU"
status: "in_review"
created: "2026-05-22"
updated: "2026-06-06"
released_version: null
tags: ["devops", "onboarding", "architecture"]
related_tasks: ["v04-ws1-install-update-overhaul", "v06-control-plane-backend", "v06-control-panel-frontend"]
---

## Why

When dreamcontext ships a new version, stale files from previous installs linger silently in user projects — old agent prompts, deprecated skill files, removed hook configs. The old `install-skill` and `update` commands updated and added files but never removed files that the new version dropped. Stale files cause confused behavior (old agents shadowing new ones, removed commands still visible) and make each upgrade an imperfect overlay instead of a clean replacement.

A manifest-based install/update solves this by tracking every file dreamcontext owns at write time (`_dream_context/state/.install-manifest.json`). On the next `update`, a diff against the newly-computed manifest identifies stale entries; safe-path stale files are offered for deletion (or auto-deleted with `--yes`). First-run safety: if no manifest exists yet, bootstrap from a scan and flag candidates rather than delete.

v0.5.0 extended this with: (1) a one-command `install.sh` curl script, (2) a `dreamcontext upgrade` command that refreshes the globally-installed CLI, and (3) a non-blocking in-session update nudge (`## Update Available` injected into the SessionStart snapshot when a newer version is available, sourced from a disk cache populated by the UserPromptSubmit hook at most once per 24h).

## User Stories

- [x] As a developer, I want `dreamcontext update` to delete stale agent/skill/hook files from `.claude/`, `.agents/`, and `.codex/` when the new version no longer ships them, so I don't accumulate ghost files.
- [x] As a developer, I want the first `update` after upgrading to only flag stale files (not delete) so I can review before anything is removed.
- [x] As a developer, I want `dreamcontext setup` to run init + install-skill in one command so I don't have to run two separate commands on a new project.
- [x] As a developer, I want setup to support `--platforms`, `--packs`, and `--multi-product` flags so it can be scripted non-interactively.
- [x] As a developer, I want the interactive menu and README Quick Start to lead with `dreamcontext setup` so I can't accidentally end up with a half-install by running bare `init`.
- [x] As a developer, I want `dreamcontext init` (run interactively without an existing integration) to offer to finish the install or print a clear warning, so I am never silently left without `.claude/`, skills, agents, or hooks.
- [x] As a developer, I want manifest writes to be cancel-safe so a Ctrl+C mid-install doesn't leave a corrupted manifest.
- [x] As a developer, I want filter persistence across update: installed packs and platform flags are preserved in `.config.json` and re-applied so an update doesn't forget my configuration.
- [ ] As a developer, I want `dreamcontext update --dry-run` to show what would change without writing anything, so I can audit before committing.
- [x] As a developer, I want a single `curl | sh` install script so I can install dreamcontext without running npm manually.
- [x] As a developer, I want `dreamcontext upgrade` to update the globally-installed CLI binary and then refresh project files in one command.
- [x] As an agent, I want the SessionStart snapshot to tell me when a newer dreamcontext is available so I can inform the user to run `dreamcontext upgrade`.

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
- [x] `interactive.ts` menu leads with "Set up dreamcontext (recommended)" as the first Setup entry (runs full `setup`); bare `init` is relabelled "advanced".
- [x] `setup.ts` extracts install logic into `installPlatformIntegration()` helper shared between `setup` and `init` so they cannot drift.
- [x] `init.ts`: when run interactively and the integration is absent, offers to finish the install (default yes) or prints "⚠ Not done yet → run `dreamcontext setup`" warning; offer is gated on `SETUP_INTERNAL_ENV` absent + TTY present + `integrationPresent` false (uses `.every()` over selected platforms so multi-platform partial installs are not suppressed).
- [x] README Quick Start leads with `dreamcontext setup`; two-step flow moved under an "advanced" details block.
- [x] Partial-flag partition preservation: when platforms/packs are passed as flags, the partitions not covered by the flags remain in the manifest (existing files not clobbered).
- [ ] `dreamcontext update --dry-run` lists changes without writing.
- [x] `install.sh` at repo root: POSIX sh, `set -e`, checks Node ≥18, runs `npm install -g dreamcontext`, calls `dreamcontext update` if `_dream_context/` exists or prompts `setup` otherwise, prints a success banner with the positioning one-liner. No `sudo`, no `eval`, no nested remote fetch.
- [x] `dreamcontext upgrade` command (`src/cli/commands/upgrade.ts`): runs `npm install -g dreamcontext@latest` then instructs the user to run `dreamcontext update` in each project. `--check` flag prints current vs available version without installing.
- [x] `src/lib/version-check.ts`: `readVersionCache`, `isCacheFresh` (TTL 24h), `compareVersions` (semver-lite), `buildNudge` (pure, returns string or null), `refreshVersionCache` (only networked function, runs from UserPromptSubmit hook). Cache stored at `_dream_context/state/.version-check.json`.
- [x] `generateSnapshot()` in `snapshot.ts` injects `## Update Available` block when a fresh cache indicates installed < latest. Never makes a network call — reads only the cache file.
- [x] UserPromptSubmit hook lazy-refreshes the version cache (at most once per 24h TTL, wrapped in try/catch, failure writes `latestCli: null` silently).
- [x] `GET /api/version-check` dashboard route exposes the nudge payload to the browser via disk cache (no network); `UpdateBadge` component surfaces it in the header.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-05-22]** Manifest is written atomically via temp-file + rename pattern to prevent corruption on cancellation. If the write is interrupted, the old manifest remains intact.
- **[2026-05-22]** `isSafeDeletePath` only returns true for paths under `.claude/`, `.agents/`, `.codex/`. Files outside these prefixes (including `_dream_context/` itself) are never candidates for auto-deletion — user-owned data is protected by design.
- **[2026-05-22]** `setup` and `install-skill` share the same internal install logic; `setup` is a thin orchestrator that calls `init` then `install-skill`. The `SETUP_INTERNAL_ENV` env var suppresses deprecation hints from child commands when invoked via `setup`.
- **[2026-05-31]** `refreshVersionCache` is the ONLY function allowed to make a network call (npm view). `generateSnapshot()` is on the SessionStart hot path and must never call it. The UserPromptSubmit hook calls it lazily, gated by `isCacheFresh`. Any future refactor must preserve this separation.
- **[2026-06-06]** `integrationPresent` in `init.ts` uses `.every()` over selected platforms (not `.some()`). Using `.some()` would suppress the finish-setup offer when only one of several selected platforms is installed, leaving a partial install. See commit 486d418.
- **[2026-06-06]** The `installPlatformIntegration()` helper in `setup.ts` is the single canonical install path. Both `setup` and `init` (when the user accepts the finish-offer) call it. This ensures future changes to install logic are applied consistently to both entry points.
- **[2026-05-31]** `dreamcontext upgrade` does NOT auto-exec `dreamcontext update` after installing the new binary — the freshly-replaced binary cannot reliably re-exec the old process. It prints the instruction and exits. This is intentional; do not change.
- **[2026-05-22]** Old `install-skill` and `install-claude-md` commands are deprecated but not removed until v0.5. They print a deprecation hint directing users to `setup` unless invoked via `setup` itself.
- **[2026-05-22]** Bootstrap scan on first migration: scans `.claude/`, `.agents/`, `.codex/` for files matching known dreamcontext-owned path patterns. This heuristic is best-effort; the first post-upgrade `update` only flags, never deletes.

## Technical Details

**Key files** (v0.4 manifest foundation):
- `src/lib/manifest.ts` — manifest type definitions, read/write/diff/bootstrap/record helpers.
- `src/lib/setup-config.ts` — typed `.config.json` read/write/merge. Adds `setupVersion` field.
- `src/cli/commands/setup.ts` — `dreamcontext setup` one-shot command.

**Key files** (v0.5.0 install/update/nudge additions):
- `install.sh` (repo root) — POSIX sh one-command install script. Checks Node ≥18, runs `npm install -g dreamcontext`, calls `dreamcontext update` or `setup` as appropriate.
- `src/cli/commands/upgrade.ts` — `dreamcontext upgrade [--check] [-y]`. Uses `execFileSync('npm', ['install','-g','dreamcontext@latest'])`, no shell string interpolation.
- `src/lib/version-check.ts` — `VersionCache` type + pure functions: `readVersionCache`, `isCacheFresh`, `compareVersions` (semver-lite, handles `0.0.0` sentinel), `buildNudge`, `writeVersionCache`, `refreshVersionCache`.
- Cache file: `_dream_context/state/.version-check.json` (machine-local, gitignored).
- `snapshot.ts` → `getVersionNudge(root)` reads cache, calls `buildNudge`, emits `## Update Available` section or nothing.
- `hook.ts` UserPromptSubmit → lazy `refreshVersionCache` behind `isCacheFresh` check, wrapped in try/catch.

**v0.6 dashboard surface** (added in `v06-control-plane-backend`/`v06-control-panel-frontend`):
- `src/server/routes/version-check.ts` — `GET /api/version-check`; imports `readVersionCache`, `isCacheFresh`, `buildNudge` from `src/lib/version-check.ts` (NOT from any CLI command file); cache-only, no network. Returns `{cache, fresh, nudge}`.
- `dashboard/src/hooks/useVersionCheck.ts` — TanStack Query hook polling the route.
- `dashboard/src/components/layout/UpdateBadge.tsx` — header banner; renders when `nudge !== null`; hidden when null (no layout change).

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

**`setup.ts` flow** (v0.6.0):
1. Resolve platforms (flag > defaults > interactive).
2. Run `dreamcontext init` (skipped if `_dream_context/` already exists).
3. Call `installPlatformIntegration(platforms, packs, opts)` — shared helper extracted from the old inline logic.
4. Write `.config.json` with full setup state.
5. Write platform defaults file.

**`init.ts` discoverability / finish-offer** (v0.6.0 addition):
- When `init` completes and `_dream_context/` is fresh: checks `SETUP_INTERNAL_ENV` (if set, invoked via setup — skip), TTY (if non-TTY — skip), and `integrationPresent` (checks `.every()` selected platform has a skill installed).
- If all conditions met for the offer: prompts "Finish setup now?" (default yes); on yes calls `installPlatformIntegration()`.
- If TTY present but integration already installed: silent (normal agent-invoked-init path).
- If TTY present, no integration, user declines: prints loud warning banner "⚠ Not done yet → run `dreamcontext setup`".

**`interactive.ts` menu change**:
- "Set up dreamcontext (recommended)" → calls `setup` command (first item).
- "Initialize project context only (advanced)" → calls `init` (demoted, labelled advanced).

Also see: `project-initialization.md` for `init` scaffolding semantics.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-06 - Onboarding front-door fix
- Added 2 user stories (discoverability, init finish-offer).
- Added 6 acceptance criteria (menu lead, shared helper, init offer gating, .every() check, README change).
- Added 2 constraints (`.every()` reasoning, shared-helper canonical path).
- Updated Technical Details: setup.ts flow, init.ts discoverability/finish-offer, interactive.ts menu change.
- Commits: ecfe365, 486d418.

### 2026-05-22 - Created
- Feature PRD created from v0.4 session.
