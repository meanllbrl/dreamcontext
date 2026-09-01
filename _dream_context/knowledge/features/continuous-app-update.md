---
id: feat_T2UDusWh
status: active
created: '2026-06-13'
updated: '2026-08-29'
released_version: v0.8.1
tags:
  - devops
  - architecture
  - 'topic:desktop'
related_tasks: []
type: feature
name: continuous-app-update
description: ''
pinned: false
date: '2026-06-13'
---

## Why

The dreamcontext Tauri desktop app cannot ship through the Mac App Store or notarize via Apple Developer ID today. Traditional auto-updaters (Tauri's built-in updater) require a signed Developer ID, which triggers notarization gating. This blocks fast iteration on the desktop app.

The "CLI-carries-app" model sidesteps notarization entirely: the Tauri shell is thin (Rust only manages process launch and window lifecycle); ~95% of app logic (server, dashboard, routes) lives in the CLI `dist/` and is delivered by `dreamcontext upgrade` — which never sets the macOS `com.apple.quarantine` bit, so Gatekeeper's notarization check never fires. Ad-hoc signing satisfies Apple Silicon's requirement that every executable be signed. The remaining ~5% (actual Rust changes) ships as a `.tar.gz` artifact delivered by `dreamcontext app update`, also curl/ditto-based with no quarantine.

## User Stories

- [x] As a user, installing the app via `dreamcontext app install` gives me a working `.app` in `~/Applications` without needing to be an admin, notarize, or purchase an Apple Developer ID.
- [x] As a user, when I run `dreamcontext upgrade`, my desktop app's server, dashboard, and routes are all updated without rebuilding or reinstalling the `.app`.
- [x] As a user, `dreamcontext app update` fetches and installs the latest `.app` binary atomically, rolling back automatically if something goes wrong.
- [x] As a user, `dreamcontext app status` tells me the installed version vs. available version so I know if I'm up to date.
- [x] As a user, the app auto-checks for updates in the background (once per 24h) and installs them silently via the CLI hook tick, with opt-out.
- [x] As a CI engineer, the release pipeline builds, ad-hoc deep-signs, and publishes `.tar.gz` + `.sha256` to GitHub Releases so the install/update commands have a live source (Faz 1 — shipped as `.github/workflows/desktop-release.yml`).

## Acceptance Criteria

- [x] `lib.rs` `find_global_cli()` probes the global CLI via `$SHELL -lc 'command -v dreamcontext'` (login-shell trick so Finder-launched apps see nvm/brew PATH); `resolve_cli()` prefers global → bundled resource → dev cwd. `DREAMCONTEXT_CLI` env overrides all.
- [x] Verified: a launched `.app` spawns `node <nvm_path>/bin/dreamcontext dashboard …` (global CLI), NOT the bundled copy.
- [x] `dreamcontext app install [--from <path|url>]`: installs to `~/Applications` via `ditto` (preserves signature, no quarantine); atomic staging-dir swap with rollback to backup; strips quarantine defensively; records version + installDate in `~/.dreamcontext/app.json`.
- [x] `dreamcontext app update`: pulls arch-matching `dreamcontext-beta_<ver>_<arch>.app.tar.gz` from GitHub Releases + mandatory `.sha256` (refuses install if missing or mismatch); same atomic swap + rollback path.
- [x] `dreamcontext app status`: reports installed version (from `~/.dreamcontext/app.json`) and available version (from GitHub Releases API); no install action.
- [x] `isAppRunning` matches `<bundle>/Contents/MacOS/` path prefix (NOT bundle name, which would self-match the install command). Replacing a running bundle is safe: running process keeps its inode; next launch picks up new bundle.
- [x] `maybeTriggerAppUpdate`: fires a detached background `app update` from the CLI 24h hook tick when the app is installed; never auto-installs if not already present; opt-out via `DREAMCONTEXT_APP_AUTO_UPDATE=0`.
- [x] Security: all external commands use arg arrays (no shell string); bsdtar extraction refuses `..`/absolute paths (zip-slip prevention); `downloadLatestArtifact` REQUIRES a `.sha256` per asset and aborts on mismatch.
- [x] 26 unit tests for app command logic pass; full suite (1843 tests) green.
- [x] CI builds `.app`, ad-hoc deep-signs with `entitlements.plist` (tauri build output is linker-signed only; published artifact must pass `codesign --verify --deep`), packages as `dreamcontext-beta_<ver>_<arch>.app.tar.gz`, publishes artifact + `.sha256` to GitHub Release. Shipped: `.github/workflows/desktop-release.yml` (macos-14/aarch64 on `v*` tag push, non-draft Release).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-08-27]** **Nothing this repo publishes may name a real project or person** — a durable privacy posture enforced by tests, not convention. The announcement leak (a screenshot showed private project names) revealed the same defect everywhere the codebase reached for a worked example: ~300 references to private projects and ~130 to the owner's identity (full name, slug, emails, GitHub login, absolute `/Users/<name>/` import paths) in code comments, CLI `--help` strings, test fixtures, skill docs and agent prompts. `src/` and `dashboard/src/` build into `dist/`, so a comment naming a client shipped to every npm install; the rest is public on GitHub. Everything now names the demo vault cast — the same fictional projects the announcement screenshots show — so an author reaching for "a project name" finds one already there and a reviewer meeting an unfamiliar name knows it is a leak. Provenance stays provenance, measurements stay measurements, and `meanllbrl/dreamcontext` as the APP_RELEASE_REPO is kept (this project's own public repo, a functional constant). Two test assertions broke by renaming fixtures (roster sort order, a shared-surname count); the replacement is deliberately not `ada` (`ada` was already the second example person, and reusing it would have collapsed two people into one while leaving every multi-person test green). Evidence: full unit suite 7617 passed / 0 failed, root and dashboard tsc clean, rebuilt `dist/` greps zero for every private token. (a6e35bf)
- **[2026-08-27]** **The announcement feed carries nothing personal and skips no release** — a tighter gate and a looser one. (1) The feed's announcement screenshots must show only the demo vault cast (the privacy rule above, applied to the feed specifically); leak = retract. (2) Announcements are hand-authored product news, not a CHANGELOG mirror — so a shipped release with zero announcements is valid and gets no placeholder. The dashboard "What's New" page renders an empty state when there are none, instead of synthesizing one from the changelog. (c020c2a)
- **[2026-06-13]** Only already-installed apps are auto-updated (hook tick). Never auto-installs from scratch — that requires explicit user intent via `dreamcontext app install`. This avoids surprising the user with a hidden app in `~/Applications`.
- **[2026-06-13]** `.sha256` is mandatory for every downloaded artifact. Ad-hoc code signing proves integrity-in-transit at best, never origin; the checksum is the actual tamper guard. Artifacts without a `.sha256` sidecar are refused.
- **[2026-06-13]** `DREAMCONTEXT_CLI` env var is the test-harness override hook: test suites inject a mock CLI without recompiling Tauri. The Rust shell uses the same env var as the scaffold `execFile` path in `src/lib/ensure-cli.ts`.
- **[2026-06-13]** Mechanism is macOS-only today. The no-quarantine property (delivery via npm/curl never sets the bit) is macOS-specific. Windows/Linux delivery is documented as a nice-to-have; no code written.
- **[2026-06-13]** This PRD has a sharp boundary from `manifest-based-install-update`: that PRD covers updating dreamcontext's CLI and project files (`_dream_context/`, `.claude/`). This PRD covers the Tauri desktop `.app` binary lifecycle (install, update, auto-sync). They share `src/lib/version-check.ts` for version comparisons but are otherwise independent.

## Technical Details

**Thin-shell pivot** (`desktop/src-tauri/src/lib.rs`):
- `find_global_cli() -> Option<String>`: runs `$SHELL -lc 'command -v dreamcontext'` via `Command::new(&shell).args(["-lc", "command -v dreamcontext"])`. Returns trimmed stdout. The login-shell flag (`-lc`) is critical: `.app` launched from Finder/Spotlight has no interactive-shell PATH (no nvm/brew), so `command -v` would fail without it.
- `resolve_cli(app: &AppHandle) -> Result<String, String>`: resolution order is `DREAMCONTEXT_CLI` env → `find_global_cli()` → bundled resource (`app.path().resource_dir()` / `dist/index.js`) → dev cwd. Returns the first that exists.
- Dead Rust commands (`open_vault`, Port state) removed this cycle; `cargo check` clean.

**App command** (`src/cli/commands/app.ts`):
- `APP_BUNDLE_NAME = 'dreamcontext-beta.app'`, `APP_RELEASE_REPO = 'meanllbrl/dreamcontext'`.
- `detectPlatform()`: maps Node's `process.platform` / `process.arch` to Tauri arch tokens (`aarch64`, `x86_64`).
- `appArtifactName(version, arch)`: returns `dreamcontext-beta_<ver>_<arch>.app.tar.gz`.
- `pickAssetForArch(assetNames, arch)`: filters `.app.tar.gz` assets, prefers exact arch match.
- `readAppManifest()` / `writeAppManifest()`: `~/.dreamcontext/app.json` — `{ version, installDate, bundlePath }`.
- `downloadLatestArtifact(repo, arch)`: GitHub Releases API → pick matching asset + `.sha256`; download both; SHA256 verify; return temp path.
- `installFromPath(srcPath, targetDir)`: extracts via `bsdtar` into staging dir, `ditto` to target, atomic rename, quarantine strip, backup + rollback.
- `isAppRunning(bundlePath)`: compares each `/proc/`-style entry's executable path prefix to `<bundle>/Contents/MacOS/` — avoids self-match.
- `maybeTriggerAppUpdate(appManifest)`: detached `spawn('dreamcontext', ['app', 'update'])` — does not await.

**Auto-sync wiring** (`src/cli/commands/hook.ts`):
- 24h tick calls `maybeTriggerAppUpdate`; gated on `DREAMCONTEXT_APP_AUTO_UPDATE !== '0'` and `appManifest` existing. Version comparison shared with `src/lib/version-check.ts`.

## Notes

- The `$SHELL -lc` login-shell pattern is used in three places: `find_global_cli` (Rust), `find_node` (Rust), and `ensure-cli.ts` (Node). Any future PATH probe must use this pattern for Finder-launched apps.
- Windows/Linux: the no-quarantine property is macOS-specific. For other platforms, a code-signed Tauri updater or platform-native package manager would be the right approach — no work started.
- Faz 1 CI shape (as shipped): `tauri build` → ad-hoc deep-sign (`codesign --deep --force --sign - --entitlements entitlements.plist`) → `tar czf dreamcontext-beta_<ver>_<arch>.app.tar.gz` → `shasum -a 256 > <artifact>.sha256` → `gh release upload`.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-08-27 - Privacy posture and announcement gate
- **Nothing this repo publishes may name a real project or person** (a6e35bf): ~300 project references and ~130 identity references scrubbed from code comments, CLI help, test fixtures, skill docs, agent prompts. Everything now names the demo vault cast. Two test assertions fixed (roster sort order, shared-surname count). Test suite 7617 passed, rebuilt `dist/` greps zero for private tokens.
- **Announcement feed carries nothing personal and skips no release** (c020c2a): screenshots must show only the demo vault cast (leak = retract); a shipped release with zero announcements is valid (empty state, not synthesized placeholder).

### 2026-08-01 - Recovered onto main
- PRD recovered from the abandoned `feat/unified-dashboard` branch (commit 6a4af92, 2026-06-14), which never merged; the file had been stranded there since. Relocated `core/features/` → `knowledge/features/` per the folder migration, and given current feature frontmatter (`type`/`name`/`description`/`pinned`/`date`).
- Reconciled to reality rather than ported verbatim: Faz 1 shipped as `.github/workflows/desktop-release.yml`, so both remaining `[ ]` boxes are now met; `status` in_progress → active; `released_version` null → v0.8.1.
- Dropped `related_tasks: [continuous-app-update, unified-dashboard-beta-multivault]` — neither task exists on main; they died with the branch.
- Corrected the auto-sync wiring path (`src/lib/hook.ts` → `src/cli/commands/hook.ts`) and dropped the stale "GitHub Releases source does not exist yet" gate. Note `src/lib/auto-upgrade.ts` and `src/lib/app-manifest.ts` no longer exist — that logic now lives in `src/cli/commands/app.ts`, `src/cli/commands/hook.ts`, and `src/lib/version-check.ts`.

### 2026-06-13 - Implemented (thin-shell pivot + app command)
- `lib.rs` resolve_cli prefers global CLI; verified locally (spawns global nvm CLI, not bundled).
- `src/cli/commands/app.ts`: install/update/status, atomic swap, rollback, SHA256 enforcement, isAppRunning fix, maybeTriggerAppUpdate on 24h hook tick.
- 26 app-command tests + full suite (1843) green; 2-round reviewer PASS.
- GitHub Releases delivery path code-complete but gated on Faz 1 (no CI pipeline yet).

### 2026-06-13 - Created
- Feature PRD created.
