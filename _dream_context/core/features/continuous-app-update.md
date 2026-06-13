---
id: feat_T2UDusWh
status: in_progress
created: '2026-06-13'
updated: '2026-06-14'
released_version: null
tags:
  - devops
  - architecture
  - desktop
related_tasks:
  - continuous-app-update
  - unified-dashboard-beta-multivault
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
- [ ] As a CI engineer, the release pipeline builds, ad-hoc deep-signs, and publishes `.tar.gz` + `.sha256` to GitHub Releases so the install/update commands have a live source (Faz 1 — not yet built).

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
- [ ] CI builds `.app`, ad-hoc deep-signs with `entitlements.plist` (tauri build output is linker-signed only; published artifact must pass `codesign --verify --deep`), packages as `dreamcontext-beta_<ver>_<arch>.app.tar.gz`, publishes artifact + `.sha256` to GitHub Release (Faz 1 prerequisite — unbuilt).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

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

**Auto-sync wiring** (`src/lib/hook.ts` or equivalent):
- 24h tick calls `maybeTriggerAppUpdate`; gated on `DREAMCONTEXT_APP_AUTO_UPDATE !== '0'` and `appManifest` existing.

**Key constraint (Faz 1 gate)**: the GitHub Releases source does not exist yet. `app install` / `app update` work end-to-end from `--from <local>` today. The network path (`downloadLatestArtifact`) is code-complete + unit-tested but will return 404 until CI publishes actual releases.

## Notes

- The `$SHELL -lc` login-shell pattern is used in three places: `find_global_cli` (Rust), `find_node` (Rust), and `ensure-cli.ts` (Node). Any future PATH probe must use this pattern for Finder-launched apps.
- Windows/Linux: the no-quarantine property is macOS-specific. For other platforms, a code-signed Tauri updater or platform-native package manager would be the right approach — no work started.
- Faz 1 CI shape: `tauri build` → ad-hoc deep-sign (`codesign --deep --force --sign - --entitlements entitlements.plist`) → `tar czf dreamcontext-beta_<ver>_<arch>.app.tar.gz` → `shasum -a 256 > <artifact>.sha256` → `gh release upload`.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-13 - Implemented (thin-shell pivot + app command)
- `lib.rs` resolve_cli prefers global CLI; verified locally (spawns global nvm CLI, not bundled).
- `src/cli/commands/app.ts`: install/update/status, atomic swap, rollback, SHA256 enforcement, isAppRunning fix, maybeTriggerAppUpdate on 24h hook tick.
- 26 app-command tests + full suite (1843) green; 2-round reviewer PASS.
- GitHub Releases delivery path code-complete but gated on Faz 1 (no CI pipeline yet).

### 2026-06-13 - Created
- Feature PRD created.
