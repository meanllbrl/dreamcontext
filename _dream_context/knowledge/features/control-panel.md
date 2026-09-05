---
id: feat_ControlPanel_v06
status: in_review
created: '2026-05-31'
updated: '2026-09-05'
released_version: v0.8.7
tags:
  - control-panel
  - backend
  - frontend
  - 'topic:dashboard'
  - 'kind:design'
related_tasks:
  - settings-dort-gruba-toplanir-tekrarlayan-metin-teklenir-ve-save-dugmesi-kalkar
  - dashboard-settings-page-section-nav-menu
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
- [x] As a dashboard user, Settings reads as four groups (Project / Memory / Integrations / This machine) instead of nine flat sections, so I can find a setting without scanning the whole page.
- [x] As a dashboard user, every change I make is saved instantly and confirmed NEXT TO the control I touched — there is no global Save button to hunt for and no second, different saving model.
- [x] As a dashboard user, each setting is one row (name + one line on the left, control on the right) with the long explanation folded under "Details", so a section tells me what it does without a wall of paragraphs.
- [x] As a dashboard user, a control that cannot be used says WHY it is disabled instead of failing when I use it.

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

### Slice 6 — Settings information architecture redesign (settings-dort-gruba-toplanir-…, 2026-09-05)

- [x] A1. Left nav is four groups instead of nine flat rows: **PROJECT** (Platforms, Task Format, Agents, Sleepy, Linked repos) · **MEMORY** (Native memory, Learning, Recall) · **INTEGRATIONS** (GitHub, Team sync, ClickUp, Connections) · **THIS MACHINE** (Dependencies). Group headings are dividers, not clickable.
- [x] A2/A14. Scope, not just formatting: the old single GitHub section held three unrelated concepts. Split into **GitHub** (account + Issues mirroring, 1414 → 804 chars), **Team sync** (its own setting under INTEGRATIONS: cloud-sync switch + repo + auto-checkpoint) and **Linked repos** (its own setting under PROJECT — it has nothing to do with where the brain syncs).
- [x] A3. Nav rows carry no description; each section opens with ONE sentence. `settings.navdesc.*`, the long `settings.desc.*` and `brain.cloudSync.desc` deleted. "Cloud sync" appears once instead of seven times (verified).
- [x] A4. The System section stopped being a feature list: rows are per DEPENDENCY (git / Claude Code CLI / node-pty), each saying "Needed by: …". A missing dependency appears as a `FeatureDepsNotice` at the top of the section that needs it, with "Open This machine".
- [x] A5. The global Save button, the dirty state and `.settings-save-row` are gone. Platforms and native memory read straight from the server copy and PATCH on change; cloud-task text fields write on blur, selects and switches write immediately. The result is reported beside the control with `SaveMark`.
- [x] A6. Failure is never silent: `useInstantSave` shows the error next to the control and does not auto-clear it; config-backed switches hold no local mirror, so after a failed write they show what is actually on disk.
- [x] A9. One row grammar page-wide (`SettingRow` / `SettingGroup` / `Toggle` / `SettingChoice`): name + one line (62ch measure) left, control right, hairline between rows, grouped headers. The three previous layouts are gone — not one `.settings-checkbox-label` remains.
- [x] A10. Long copy was FOLDED, not deleted: a "Details" disclosure per row. The Agents section went 3,252 → 1,460 chars with the remainder in 8 folded blocks that open in place.
- [x] A11. A disabled control states its reason — on the Terminal screen "Answer rendering" is disabled and the row reads "Only the Chat screen can carry this" in a warning tone.
- [x] A12. No box-in-a-box: `OriginSetup` and `LinkedRepos` drop their own frame inside a row (CSS only — their logic was not touched); A17 added a `compact` prop so they stop repeating the section's own title and paragraph.
- [x] A15. A CORRECTNESS fix, not cosmetics: the cloud-sync switch is disabled with no repository and says "Pick a repository below first". It used to be flippable and the server rejected it with `400 no_origin` — a switch that could only fail.
- [x] A7/A16. The sidebar's cloud-sync CTA (`focus.id='brain'`, wire name unchanged) now opens the **Team sync** section it is named after, not the middle of GitHub.
- [x] A8/A13/A18. Verified in the REAL app three times as the redesign widened: isolated scratch vault + real dashboard server + Playwright — 15/15, then 5/5, then 7/7. A5 was proved against `GET /api/config` (on disk), not just the DOM. Full unit suite green (442 files / 8,090 tests).

## Constraints & Decisions

- **[2026-09-05]** CHOSEN: B + A (collapse into four groups + copy cleanup). The Save button is REMOVED entirely rather than moved down into each section — two saving models sitting side by side WAS the complaint. DEFERRED, not rejected: C (drop the nav for one long searchable list) can be layered on top of this structure later.
- **[2026-09-05]** Memory was deliberately NOT collapsed into a single section: Native memory / Learning / Recall stay separate. That separation is the reason the grouped nav exists at all, and Recall is a four-option radio group — a subject on its own.
- **[2026-09-05]** Planning board: `knowledge/settings-redesign/settings-redesign.excalidraw.md` (spec in the same folder). The diagnosis it captures: every section was forced to fill a navdesc+desc pair, on top of each switch's own label, paragraph and tooltip — which is how one screen came to say "Cloud sync" seven times.
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
- **Settings redesign (2026-09-05).** New: `components/settings/useInstantSave.tsx` (per-control save state + `SaveMark`), `components/settings/SettingRow.{tsx,css}` (`SettingRow`/`SettingGroup`/`Toggle`/`SettingChoice`), `components/settings/CloudTaskSync.tsx` (per-provider task-mirroring form, lifted out of `SettingsPage`). Changed: `pages/SettingsPage.tsx` (1,139 → ~640 lines; `SETTINGS_NAV` is now an array of groups, `SectionHead` helper, Save/dirty/`persistCloudConfig` removed), `pages/SettingsPage.css`, `components/settings/SystemDependencies.tsx` (dependency-first render + `FeatureDepsNotice` export), `components/settings/SettingsIcons.tsx` (Learning/Recall/ClickUp/TeamSync/LinkedRepos icons; `SETTINGS_ICONS` keys realigned to the new section ids), `context/I18nContext.tsx` (17 orphan keys deleted, group + one-sentence keys added). No server change was needed: `PATCH /api/config` already does allow-listed partial merge, so field-level writes ride the existing route. The task token writes on blur via `POST /tasks/token`, and Test/Provision call `flush()` first so the probe uses the value on screen. The deep-link contract is preserved — the sidebar still sends `focus.id='brain'` and the page resolves it (`Sidebar.tsx` untouched).

### Tests

- vitest under `tests/` (`vitest.config.ts` scopes to `tests/**/*.test.ts`); Playwright e2e under `e2e/` (`playwright.config.ts`, run via `npm run test:e2e`).
- `tests/unit/claude-settings.test.ts` (10 tests: apply enable/disable, missing file, merge safety, no-overwrite of other keys).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-05 - Slice 6: Settings information architecture redesign
- Nine flat sections → four groups; GitHub split into GitHub / Team sync / Linked repos; one row grammar with folded Details; the global Save button and dirty state deleted in favour of instant, per-control saves; System became dependency-first. Shipped in `7d8aac7`. Verified in the real app across three waves (15/15, 5/5, 7/7).

### 2026-06-04 - Slice 5: native memory disable + config CLI
- `src/lib/claude-settings.ts`: `applyClaudeAutoMemory()` writes `autoMemoryEnabled` to `.claude/settings.json` (server-safe).
- `SetupConfig.disableNativeMemory: true` (default); install applies on Claude Code targets; `--keep-native-memory` flag to opt out.
- `PATCH /api/config` extended to accept `disableNativeMemory`; SettingsPage Memory toggle wired.
- `src/cli/commands/config.ts`: `config show` + `config native-memory enable|disable` + interactive menu entry.
- 10 new claude-settings unit tests; 1085+ total green.

### 2026-05-31 - Created (Slices 1-4)
- Feature PRD created capturing backend control-plane (slice 1), frontend wiring (slice 2), --vault CLI (slice 3), vault management + polish (slice 4).
