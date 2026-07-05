---
id: feat_ControlPanel_v06
status: in_review
created: '2026-05-31'
updated: '2026-06-18'
released_version: v0.8.7
tags:
  - control-panel
  - backend
  - frontend
related_tasks:
  - v06-control-plane-backend
  - v06-control-panel-frontend
  - v06-vault-management
  - v06-control-panel-polish
  - disable-claude-native-memory
type: feature
name: control-panel
description: ''
pinned: false
date: '2026-05-31'
---

## Why

The dashboard was a read-only task/knowledge/brain viewer with no way to configure dreamcontext itself — platforms, skill packs, vaults. Users had to fall back to the CLI for every change. The v0.6 control panel closes that loop **in the browser dashboard** (`dreamcontext dashboard`): a backend control-plane (REST API for config, packs, version-check, vaults), frontend pages wired to it (Settings, Packs, UpdateBadge, vault management), and UX polish (collapsible grouped sidebar, correct installed-packs display).

> **Standalone desktop (Tauri) app: DEFERRED.** A native macOS app was prototyped but parked — a true download-and-run app needs a bundled Node sidecar + Apple notarization (a separate epic). The full standalone effort is preserved on branch **`parked/desktop-app`**. The product ships via **npm + `dreamcontext dashboard`**. The `dashboard --vault` flag (below) stays on main as it's a useful CLI feature independent of the desktop shell.

## User Stories

- [x] As a dashboard user, I can view and edit my project's platforms and packs from a Settings page without using the CLI.
- [x] As a dashboard user, I can browse available skill packs and see which are actually installed (filesystem truth, not config).
- [x] As a dashboard user, I'm notified in-app when a newer dreamcontext version is available.
- [x] As a dashboard user, I can view, add, and remove vaults, and see which is currently active.
- [x] As a dashboard user, I can collapse the sidebar to an icon rail and the nav reads as sensible groups.
- [x] As a CLI user, I can run `dreamcontext vaults add/list/remove` and `dreamcontext dashboard --vault <name|path>`.
- [x] As a user, I can toggle Claude's native auto-memory on/off from the Settings page (Memory section) and from the CLI (`config native-memory enable|disable`) so dreamcontext is the single memory system by default.
- [x] As a user, dreamcontext disables Claude native auto-memory automatically on install/setup for Claude Code targets so I don't need to configure it manually.

## Acceptance Criteria

### Slice 1 — Backend control-plane (v06-control-plane-backend)

- [x] `src/lib/vaults.ts` global registry at `~/.dreamcontext/vaults.json`; `listVaults`/`addVault`/`removeVault`; missing/malformed → empty, never throws; `addVault` validates `_dream_context/` child + dedups (`VaultError`).
- [x] `vaults add <name> <path>` / `list` / `remove <name>` CLI with clean output (no stack on `VaultError`).
- [x] `GET /api/config` → `{ config: SetupConfig | null }` 200; `PATCH /api/config` strict allow-list `{platforms, packs}`, per-element validation, never spreads body (prototype-pollution-safe).
- [x] `GET /api/packs` → `{ packs, standalone }` from `src/lib/catalog.ts` (NOT `install-skill.ts`).
- [x] `GET /api/version-check` → nudge from disk cache only (no network/subprocess in the request path).
- [x] All 7 slug→path joins in `tasks.ts`/`knowledge.ts`/`features.ts` go through `safeChildPath(<dir>, \`${slug}.md\`)`.
- [x] `src/lib/catalog.ts` extracted so the server bundle never pulls `@inquirer/prompts`.

### Slice 2 — Frontend wiring (v06-control-panel-frontend)

- [x] Build green, no TS errors; `dashboard/tsconfig.json` has `noImplicitReturns: true`.
- [x] Settings page (config GET/PATCH, body `{platforms, packs}` only), Packs page, UpdateBadge (header nudge), read-only Vaults — tokens-only CSS, all strings i18n'd.

### Slice 3 — `--vault` CLI (from v06-tauri-shell; the desktop shell itself is parked)

- [x] `dashboard --vault <path|name>` re-roots the server to that vault's `_dream_context/`; without the flag, `ensureContextRoot()` walk-up is unchanged.
- [x] `resolveVaultContextRoot(arg, home?)` unit-tested (valid path / registered name / non-existent / missing `_dream_context/` / unknown name); `tests/integration/dashboard-vault.test.ts` spawns + polls `/api/health` + asserts `/api/vaults.current`.

### Slice 4 — Vault management + polish (v06-vault-management, v06-control-panel-polish)

- [x] `POST /api/vaults` (add) + `DELETE /api/vaults/:name` (remove) — CSRF-covered; Settings gains an "Open a vault" form (path-first, name auto-derived) + per-row remove.
- [x] Installed-packs FIX: `/api/packs` computes `installed` from the FILESYSTEM (`.claude/skills|.agents/skills/<name>/SKILL.md`), not `config.packs`. Packs page + Settings badge use it.
- [x] Collapsible/expandable sidebar (persisted) + grouped nav (Workspace / Control Panel).
- [x] Playwright e2e (`e2e/control-panel.spec.ts` + `playwright.config.ts`, `npm run test:e2e`) verifies drawer/tabs/packs/vault; full vitest suite green (978).

### Slice 5 — Native memory disable + config CLI (disable-claude-native-memory)

- [x] `SetupConfig.disableNativeMemory: boolean` (default `true`) added.
- [x] `src/lib/claude-settings.ts` — `applyClaudeAutoMemory(root, enable)` writes `{"autoMemoryEnabled": false}` to `.claude/settings.json` (server-safe, no inquirer dep).
- [x] Install/setup: `installCoreForPlatform` applies native-memory disable for Claude Code targets by default; `setup --keep-native-memory` flag skips it.
- [x] `PATCH /api/config` accepts `disableNativeMemory` (boolean, strict-pick); server applies to `.claude/settings.json`.
- [x] SettingsPage Memory toggle (ON/OFF, i18n'd, CSS) wired to `PATCH /api/config`.
- [x] CLI `dreamcontext config show` and `dreamcontext config native-memory enable|disable`; interactive menu System category.
- [x] `tests/unit/claude-settings.test.ts` (10 new tests); config-route disableNativeMemory cases; full unit suite green (1085+).

## Constraints & Decisions

- **[2026-06-04]** `autoMemoryEnabled: false` is the Claude Code official settings.json key (per Anthropic docs). dreamcontext defaults to disabling it on install. The key is `autoMemoryEnabled` (camelCase) — not `memory`, `nativeMemory`, or any other variant. `applyClaudeAutoMemory` reads the existing `.claude/settings.json`, merges the one key, writes back (no other keys disturbed). PATCH /api/config extends the strict-pick to include `disableNativeMemory` (one additional boolean).
- **[2026-06-01]** `PATCH /api/config` strict allow-list: body is NEVER spread; only `platforms`/`packs` extracted by name. Prototype-pollution is prevented by design — security invariant, do not relax.
- **[2026-06-01]** `GET /api/version-check` is cache-only (no network in the request path); networked `refreshVersionCache` stays out-of-band (UserPromptSubmit hook).
- **[2026-06-01]** `safeChildPath` passes the FULL `${slug}.md` so `slug='.'` → nonexistent dotfile (404) not the base dir (500 DoS).
- **[2026-06-01]** `src/lib/catalog.ts` extracted from `install-skill.ts` (which top-level-imports `@inquirer/prompts`) so server routes never pull interactive-prompt deps into the bundle. See knowledge `control-plane-api.md`.
- **[2026-06-01]** Installed-packs = filesystem truth, never `config.packs` (which only tracks `install-skill --packs` selections and drifts).
- **[2026-06-01]** `MarkdownPreview` now sanitizes `marked` output with DOMPurify (was a `dangerouslySetInnerHTML` XSS risk). `config.ts` route does NOT call `recordDashboardChange` (no `'config'` entity in the union).
- **[2026-06-01]** Standalone Tauri shell DEFERRED → `parked/desktop-app`. Reason: needs bundled Node sidecar + Apple notarize. Dashboard ships via npm.

## Technical Details

### Backend (src/)

- `src/lib/vaults.ts` — registry + `VaultError` + `resolveVaultContextRoot(arg, home?)` (name-or-path).
- `src/lib/catalog.ts` — moved from `install-skill.ts`: catalog types, `findPackageDir`, `loadCatalog`, `platformSkillRoot`, `isPackInstalledForPlatform`, `isSkillInstalled` (filesystem install detection). ESM `__dirname` shim.
- `src/lib/claude-settings.ts` — `applyClaudeAutoMemory(root, enable)`: reads `.claude/settings.json`, merges `{autoMemoryEnabled: boolean}`, writes back. No inquirer dep; safe for server bundle.
- `src/server/routes/{config,packs,version-check,vaults}.ts` — control-plane routes. `config` route: PATCH now also accepts `disableNativeMemory` (boolean) in strict-pick, calls `applyClaudeAutoMemory`. Registered in `src/server/index.ts`; CSRF/CORS pipeline unchanged.
- `src/cli/commands/vaults.ts` (`add/list/remove`); `src/cli/commands/dashboard.ts` (`--vault`).
- `src/cli/commands/config.ts` — `config show` + `config native-memory enable|disable`; interactive menu System category entry.

### Dashboard (dashboard/src/)

- Hooks (TanStack Query): `useConfig`, `usePacks`, `useVersionCheck`, `useVaults` (+ add/remove mutations).
- Pages: `SettingsPage` (platforms + packs + Memory toggle + Vaults), `PacksPage` (+ CSS); component `UpdateBadge` (mounted in `Header.tsx`).
- `Sidebar.tsx` — collapsible + grouped nav (persisted); `App.tsx`/`Shell.tsx` routing; `I18nContext.tsx` keys.

### Tests

- vitest under `tests/` (`vitest.config.ts` scopes to `tests/**/*.test.ts`); Playwright e2e under `e2e/` (`playwright.config.ts`, run via `npm run test:e2e`).
- `tests/unit/claude-settings.test.ts` (10 tests: apply enable/disable, missing file, merge safety, no-overwrite of other keys).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-04 - Slice 5: native memory disable + config CLI
- `src/lib/claude-settings.ts`: `applyClaudeAutoMemory()` writes `autoMemoryEnabled` to `.claude/settings.json` (server-safe).
- `SetupConfig.disableNativeMemory: true` (default); install applies on Claude Code targets; `--keep-native-memory` flag to opt out.
- `PATCH /api/config` extended to accept `disableNativeMemory`; SettingsPage Memory toggle wired.
- `src/cli/commands/config.ts`: `config show` + `config native-memory enable|disable` + interactive menu entry.
- 10 new claude-settings unit tests; 1085+ total green.

### 2026-05-31 - Created (Slices 1-4)
- Feature PRD created capturing backend control-plane (slice 1), frontend wiring (slice 2), --vault CLI (slice 3), vault management + polish (slice 4).
