---
id: feat_ControlPanel_v06
status: in_review
created: '2026-05-31'
updated: '2026-06-01'
released_version: null
tags:
  - control-panel
  - backend
  - frontend
  - desktop
related_tasks:
  - v06-control-plane-backend
  - v06-control-panel-frontend
  - v06-tauri-shell
---

## Why

The existing dashboard is a read-heavy task/knowledge/brain viewer, but provides no way to configure dreamcontext itself: platforms, skill packs, vault selection. Users must fall back to CLI commands for every configuration change, and there is no path to running the dashboard as a native desktop app.

The v0.6 control panel adds: (1) a backend control-plane (REST API for config, packs, version-check, vaults), (2) frontend pages wired to those routes (Settings, Packs, UpdateBadge), and (3) a Tauri 2.x native shell that spawns the Node dashboard on a free loopback port and loads it via an External webview. Together these complete the loop: the dashboard can now inspect and mutate project configuration and runs natively on macOS without a separate browser window.

## User Stories

- [x] As a dashboard user, I can view and edit my project's platforms and packs from a Settings page without using the CLI.
- [x] As a dashboard user, I can browse available skill packs and see which are installed.
- [x] As a dashboard user, I'm notified in-app when a newer dreamcontext version is available.
- [x] As a dashboard user, I can see which vaults are registered (read-only) and which is currently active.
- [x] As a CLI user, I can run `dreamcontext vaults add/list/remove` to manage a global registry of project vaults.
- [x] As a CLI user, I can run `dreamcontext dashboard --vault <name|path>` to open any registered or ad-hoc vault.
- [ ] As a user, I can run the dreamcontext desktop app in a native window (macOS) — requires manual sign/notarize/launch handoff.

## Acceptance Criteria

### Slice 1 — Backend control-plane (v06-control-plane-backend)

- [x] `src/lib/vaults.ts` global registry at `~/.dreamcontext/vaults.json`; exports `listVaults`/`addVault`/`removeVault`; missing file → empty registry; malformed JSON → empty (logged), never throws.
- [x] `addVault` rejects non-existent path or path lacking `_dream_context/` child (`VaultError`); rejects duplicate name and duplicate resolved path.
- [x] `vaults add <name> <path>` / `vaults list` / `vaults remove <name>` CLI subcommands with human-readable output; `VaultError` rendered as clean message (no stack).
- [x] `GET /api/config` returns `{ config: SetupConfig | null }`, 200 always.
- [x] `PATCH /api/config` explicit allow-list `{platforms, packs}`; per-element validation; never spreads body (prototype-pollution-safe); valid → returns `{ config }` 200.
- [x] `GET /api/packs` returns `{ packs, standalone }` from `src/lib/catalog.ts` (NOT `install-skill.ts`).
- [x] `GET /api/version-check` returns nudge payload from disk cache only — no network/subprocess in the request path.
- [x] All 7 slug→path joins in `tasks.ts` (4), `knowledge.ts` (2), `features.ts` (1) go through `safeChildPath(<dir>, \`${slug}.md\`)`.
- [x] `src/lib/catalog.ts` extracted so server bundle never pulls `@inquirer/prompts`.
- [x] Build clean; full vitest suite green (949 baseline).

### Slice 2 — Frontend (v06-control-panel-frontend)

- [x] Build green with zero TypeScript errors; new client types fully typed (no `any`); `dashboard/tsconfig.json` has `noImplicitReturns: true`.
- [x] Backend suite stays green + new `tests/unit/vaults-route.test.ts` asserts `{vaults, current}` shape.
- [x] Settings page: loads `GET /api/config`, shows platforms checkboxes + packs toggles, Save issues `PATCH /api/config` with body `{platforms, packs}` only; read-only Vaults subsection from `GET /api/vaults`.
- [x] Packs page: lists catalog packs + standalone; packs in `config.packs` show "Installed" indicator.
- [x] UpdateBadge: header banner surfaces nudge from `GET /api/version-check` when non-null; renders nothing when null.
- [x] Zero hardcoded hex/rgb/raw-px in new CSS (all `var(--…)` tokens); zero inline strings (all via `useI18n().t(...)`).
- [x] Smoke: Settings + Packs render; all 4 routes resolve 200; no console errors.

### Slice 3 — Tauri shell + `--vault` (v06-tauri-shell)

- [x] `dashboard --vault <path|name>` re-roots the server to that vault's `_dream_context/`; without flag, existing `ensureContextRoot()` walk-up is byte-for-byte unchanged.
- [x] Invalid `--vault` → non-zero exit, clean message, no stack frames.
- [x] `resolveVaultContextRoot(arg, home?)` unit-tested (5 cases: valid path, registered name, non-existent, missing `_dream_context/`, unknown name).
- [x] Build + full vitest suite green; `tests/integration/dashboard-vault.test.ts` spawns + polls `/api/health` + asserts `/api/vaults.current`.
- [x] `desktop/` Tauri 2.x project scaffolded (Cargo.toml, tauri.conf.json, main.rs/lib.rs, build.rs, capabilities, package.json, frontend-placeholder, icons).
- [x] `cd desktop/src-tauri && cargo check` compiles with all three plugins wired.
- [ ] `tauri dev` launches a native window loading the spawned dashboard (manual — requires user's machine + signing material).
- [ ] Code-sign + Apple-notarize; branded icons; updater `latest.json` endpoint configured (manual handoff).

## Constraints & Decisions

- **[2026-06-01]** `PATCH /api/config` strict allow-list: body is NEVER spread; only `platforms` and `packs` are extracted by name. Prototype-pollution via `__proto__`/`constructor` etc. is prevented by design. This is a security invariant; do not relax.
- **[2026-06-01]** `GET /api/version-check` is cache-only (no network in the request path). The networked `refreshVersionCache` remains out-of-band (UserPromptSubmit hook). Any future refactor must preserve this.
- **[2026-06-01]** `safeChildPath` passes the FULL `${slug}.md` filename (not the slug alone) so `slug='.'` resolves to a nonexistent dotfile (404) rather than the base directory (500 DoS). Pattern from `core.ts:62-66`.
- **[2026-06-01]** `src/lib/catalog.ts` was extracted from `install-skill.ts` specifically because `install-skill.ts:7` has a top-level `import { checkbox, confirm } from '@inquirer/prompts'`; any server route importing from it would pull interactive-prompt deps into the tsup bundle. Server routes import only from `src/lib/catalog.ts`. See knowledge file `control-plane-api.md`.
- **[2026-06-01]** Tauri architecture: spawn existing Node CLI via `tauri-plugin-shell`, pick free port via `TcpListener::bind('127.0.0.1:0')`, poll `/api/health`, open `WebviewUrl::External`. Reimplementing routes in Rust was rejected (not a static SPA); a packaged-Node sidecar is deferred (follow-up). See knowledge file `tauri-desktop-hosting.md`.
- **[2026-06-01]** Vault selection in the Tauri shell reads `DREAMCONTEXT_VAULT` env var (+ dev default). A native vault-picker UI (reading `~/.dreamcontext/vaults.json`) is a follow-up, not this slice.
- **[2026-06-01]** `dashboard/tsconfig.json` now has `"noImplicitReturns": true` — added after plan review found that a missing `App.tsx` switch case would silently render blank with no TS error (no `default`, no `noImplicitReturns`).
- **[2026-06-01]** `MarkdownPreview` uses `dangerouslySetInnerHTML` over unsanitized `marked` — a pre-existing XSS risk for user-authored content. Out of scope for slice 2; recorded as follow-up (`v06-markdownpreview-sanitize`: add DOMPurify).
- **[2026-06-01]** Tauri capability scoped to `shell:allow-spawn` for `node` only — least-privilege grant. CSP is null for first cut (own loopback content) — flagged as a hardening TODO.
- **[2026-06-01]** `config.ts` route does NOT call `recordDashboardChange` — the `change-tracker.ts` entity union has no `'config'` member; adding it would be a TS compile error. Union NOT widened in this slice.
- **[2026-06-01]** `vaults.json` is last-write-wins (no file lock) — acceptable for single-user local CLI. `safeChildPath` does not resolve symlinks — threat model is browser CSRF / URL-encoded traversal, not local symlink planter.

## Technical Details

### Backend (src/)

- `src/lib/vaults.ts` — global vault registry; `VaultError`; `listVaults(home?)`/`addVault(name, dirPath, home?)`/`removeVault(name, home?)`/`resolveVaultContextRoot(arg, home?)`. Injectable `home` param for testability. Registry at `~/.dreamcontext/vaults.json`.
- `src/lib/catalog.ts` — moved from `install-skill.ts`: catalog types (`CatalogSubSkill`, `CatalogPack`, `CatalogStandalone`, `CatalogAgent`, `Catalog`), `findPackageDir`, `loadCatalog`. No interactive-prompt imports. Includes `fileURLToPath`-based `__dirname` shim for ESM.
- `src/server/routes/config.ts` — `GET /api/config` (returns `SetupConfig | null`), `PATCH /api/config` (strict-pick `{platforms, packs}`; per-element validation; returns `{ config }`).
- `src/server/routes/packs.ts` — `GET /api/packs`; imports from `lib/catalog.ts`; catalog unreadable → `{packs:[], standalone:[]}`.
- `src/server/routes/version-check.ts` — `GET /api/version-check`; imports from `lib/version-check.ts`; cache-only; read failure → benign payload.
- `src/server/routes/vaults.ts` — `GET /api/vaults`; read-only; returns `{vaults, current: dirname(contextRoot)}`.
- `src/server/index.ts` — extended with 4 new routes; CSRF/CORS pipeline unchanged.
- `src/cli/commands/vaults.ts` — `vaults add/list/remove` subcommands.
- `src/cli/commands/dashboard.ts` — `--vault <path|name>` option; `resolveVaultContextRoot` on flag present; `VaultError` → clean exit.

### Dashboard (dashboard/src/)

- Hooks: `useConfig.ts`, `usePacks.ts`, `useVersionCheck.ts`, `useVaults.ts` (TanStack Query; mirror `useKnowledge.ts` pattern).
- Pages: `pages/SettingsPage.tsx` + `.css`, `pages/PacksPage.tsx` + `.css`.
- Components: `components/layout/UpdateBadge.tsx` + `.css` (mounts in `Header.tsx`).
- Nav: `Sidebar.tsx` extended with `settings` + `packs` nav items; `Shell.tsx` `VALID_PAGES` updated; `App.tsx` switch gets `case 'settings'` + `case 'packs'`; `I18nContext.tsx` extended with 20+ new i18n keys.

### Tauri shell (desktop/)

- `desktop/src-tauri/src/lib.rs` — `host_dashboard()`: free-port via `TcpListener::bind('127.0.0.1:0')` + drop; spawn `node dist/index.js dashboard --port <free> --no-open --vault <vault>` via `tauri-plugin-shell`; poll `/api/health` ~10s; `WebviewWindowBuilder::new(... WebviewUrl::External(...))`.
- Capability: `capabilities/default.json` — `shell:allow-spawn` scoped to `node`.
- Not in root build — `desktop/` is a standalone Tauri project with its own `package.json`.
