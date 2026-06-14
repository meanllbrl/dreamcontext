---
id: knowledge_desktop_beta_tauri_multivault
name: desktop-beta-tauri-multivault
description: >-
  How dreamcontext-beta (the Tauri 2 macOS app) wraps the existing React+Node
  dashboard for multi-vault / multi-window use: multi-window architecture, the
  four non-obvious gotchas (CLI bundling, Tauri ACL, relative URLs, build/sign),
  the in-app quiz-style project onboarding (scaffold endpoints, child-spawn
  pattern, auto-CLI-install), the Faz 1 GitHub Actions release pipeline
  (E2E verified v0.8.1), the homebrew-vs-nvm CLI resolution gotcha, and the
  Sleepy notch quick-capture companion (global hotkey, transparent notch window,
  mascot mood, in-process capture pipeline, tracked enrichment status UI, dead-vault
  filtering, focus/blur UX, asset bundling).
type: knowledge
tags:
  - architecture
  - domain
  - onboarding
pinned: false
created: '2026-06-13'
updated: '2026-06-14'
---

## What this is

`dreamcontext-beta` is a **Tauri 2** macOS app that wraps the EXISTING React
dashboard + Node server (no rewrite). Built on branch `feat/unified-dashboard`
from the parked `parked/desktop-app` scaffold. Goal of the beta: a single
installable app that lists all registered vaults (Launcher), opens each project
in its OWN window (multi-window), and registers new projects via the native
macOS folder picker. Per-page reskin / federation-promotion / Overview /
accessibility were explicitly OUT of scope.

Task: `state/unified-dashboard-beta-multivault.md`. Deliverables produced:
installed `/Applications/dreamcontext-beta.app` (ad-hoc signed) + a `.dmg`.

## Architecture (the "A path" — same React+Node, Tauri just wraps it)

```
.app launch → Rust shell (desktop/src-tauri/src/lib.rs)
  → find_node() (login shell `command -v node`, else /opt/homebrew etc.)
  → spawn: node <bundled dist/index.js> dashboard --port N --no-open --launcher
  → poll GET /api/health, then open window "main" at http://127.0.0.1:N/
  → kill node child on RunEvent::ExitRequested (no orphan)
```

- **Launcher mode**: `dashboard --launcher` boots the server with `contextRoot = null`
  (no default vault). Vault-agnostic routes work (`/api/health`, `/api/vaults`,
  `/api/launcher/*`); every other `/api/*` route needs a vault.
- **Per-window vault pinning**: the Launcher (`/`) lists vaults; clicking one opens
  a NEW window at `http://127.0.0.1:N/?vault=<name>`. The SPA reads `?vault=` →
  `setActiveVault(name)` → injects header `X-Dreamcontext-Vault: <name>` on every
  API call. The server resolves a **per-request contextRoot** from that header via
  a STRICT name-only resolver (`src/server/index.ts` `resolveRequestVault`): rejects
  path-shaped / unknown values with 400, NEVER calls `resolve()` on the raw header
  (a confused-deputy guard — `resolveVaultContextRoot` would path-fall-back).
- So multi-vault == multi-window, one shared Node server. No in-window switcher,
  no React-Query cache thrash.

## The four gotchas (expensive to find; remember these)

1. **Self-contained CLI bundle.** tsup left deps external; the `.app` ships `dist/`
   but NOT `node_modules` → runtime `ERR_MODULE_NOT_FOUND: nanoid`. Fix in
   `tsup.config.ts`: `noExternal` for all 7 runtime deps **plus** a `createRequire`
   shim in the `banner` (bundled CJS deps like commander call `require()` for node
   builtins; ESM output has no `require`). Verify self-containment by running the
   built `dist/index.js` from a dir with no `node_modules`.

2. **Tauri v2 ACL blocks CUSTOM commands on remote-loaded pages.** The frontend is
   served from `http://127.0.0.1:PORT` — a REMOTE origin to Tauri. A custom Rust
   command (`invoke('open_vault')`) is rejected: **"Command open_vault not allowed
   by ACL"**. Two-part fix:
   - Add to the capability (`desktop/src-tauri/capabilities/default.json`):
     `"remote": { "urls": ["http://localhost:*", "http://127.0.0.1:*"] }` so the
     capability (and its permissions) apply to the loopback-served pages. This is
     ALSO what makes the dialog plugin (`+ Open Project` native picker) work.
   - Open windows with the **built-in `WebviewWindow` JS API** (governed by the
     core permission `core:webview:allow-create-webview-window`, which passes the
     ACL) instead of a custom command. Custom app commands stay ACL-blocked on
     remote pages even with `remote.urls`; core/plugin permissions pass.

3. **Relative URLs in `WebviewWindow` resolve to the bundled frontendDist, not the
   Node server.** A new window with `url: '/?vault=X'` loads Tauri's
   `frontend-placeholder/index.html` ("starting…"), NOT the dashboard. Fix: use an
   absolute same-origin URL: `${window.location.origin}/?vault=${enc}`.

4. **Build / sign / dmg.** `npm run build` (dashboard + CLI) → `cd desktop &&
   npm run tauri build`. Notes:
   - Updater DISABLED for beta (`createUpdaterArtifacts:false`, no signer keypair).
   - Ad-hoc codesign with `entitlements.plist`: `app-sandbox=false` (so the Node
     child has the user's FS rights) and NO hardened runtime (so node JIT runs):
     `codesign --deep --force --sign - --entitlements entitlements.plist <app>`.
   - macOS TCC: `Info.plist` carries `NS{Desktop,Documents,Downloads,RemovableVolumes}UsageDescription`
     so folder-access prompts are meaningful.
   - `bundle_dmg.sh` is Finder/AppleScript-flaky → build the dmg with
     `hdiutil create -volname dreamcontext-beta -srcfolder <stage> -ov -format UDZO`
     where `<stage>` holds the `.app` + an `/Applications` symlink.
   - Install: copy to `/Applications`, then `xattr -dr com.apple.quarantine`.
   - The computer-use MCP snapshots installed apps at session start → a freshly
     built app is "not_installed" to it; use `screencapture` (full screen) for
     visual checks instead.

## Verifying multi-window headlessly (no clicking)

A temporary self-test proved it without UI fumbling: a `useEffect` on launcher
mount called `openVaultWindow(firstVault)` and POSTed the outcome to a throwaway
`/api/_diag` sink (`/tmp/dc-diag.json`); read `{ok:true}` + `System Events →
count windows == 2`. The scaffolding (`/api/_diag`, the effect) was removed before
ship. Pattern worth reusing when GUI automation is blocked.

## In-app project onboarding (quiz-style scaffold)

Shipped in the same `feat/unified-dashboard` branch (task `launcher-quiz-onboarding`).
Lets a user create a brand-new project OR initialize an existing folder from inside
the Launcher, with no terminal. Deterministic, LLM-free; hands off to Claude Code for
the rich enrichment step.

### New server endpoints (vault-agnostic, behind existing cross-site CSRF guard)

All three live in `src/server/routes/launcher.ts` and are registered on the shared
Node server. They are vault-agnostic: they work in `--launcher` mode where
`contextRoot = null`.

- **`POST /api/launcher/scaffold`** — body fields `mode` (`new`|`existing`),
  `parentDir`/`projectPath` (absolute), `projectName`, description, target user,
  tech stack, priority. Strict-pick (no extra fields pass through). Path-traversal
  guards: name rejects `/` and `..`; parent/path must be absolute and exist; new
  dirs must not be non-empty. Runs `init --yes --name … --platforms claude` then
  `setup --defaults --platforms claude` (init is skipped on 2nd call because
  `_dream_context/` already exists — idempotent). Then `addVault`.
- **`GET /api/launcher/detect?path=<abs>`** — returns `{ stack, hasContext, basename }`.
  `hasContext: true` signals an already-initialized vault → Launcher skips the quiz
  and just registers + opens. Also used to pre-fill the tech-stack step for existing
  folders.
- **`GET /api/launcher/defaults`** — returns `{ home, projects: "~/projects" }` for
  pre-filling the parent-directory input without hard-coding paths in the frontend.

### Scaffold mechanism (the load-bearing decision)

The server spawns the **bundled CLI** in a **child process** via `execFile`
(`process.execPath` + `process.argv[1]`, no shell, arg array, configurable timeout).
`cwd` is set to the target directory. The long-lived launcher server NEVER mutates
its own `process.cwd()`.

CLI entry point is resolved as:
```
process.env.DREAMCONTEXT_CLI ?? process.argv[1]
```
The env var override is the same hook the Rust shell uses (`lib.rs`), so test
harnesses can inject a mock CLI without recompiling Tauri.

Execution sequence per scaffold:
1. `init --yes --name <name> --description <desc> --user <u> --stack <s> --priority <p> --platforms claude` (cwd=target)
2. `setup --defaults --platforms claude` (cwd=target; safe if `_dream_context/` absent)

On the second scaffold of the same directory `_dream_context/` already exists, so
`init` prints a warning and exits 0; `setup` runs normally; then `addVault` registers.
Result: idempotent by design.

### Deterministic, LLM-free — and the hand-off card

The standalone Tauri app ships no LLM. Quiz answers map 1:1 to `init`'s token flags
(`--name` / `--description` / `--user` / `--stack` / `--priority`). No scanning, no
inference. The success screen presents a **copyable prompt card** the user pastes into
Claude Code to trigger the rich enrichment flow (which DOES scan code and fill in
soul/tech-stack/knowledge with substance). Cross-reference: `initializer-improvements`
task covers the agent-side rich-fill path.

### Auto global-CLI install (`src/lib/ensure-cli.ts`)

Newly scaffolded projects' `.claude/` hooks call `npx dreamcontext hook …`. If
`dreamcontext` is absent from PATH, npx would hang or fail non-interactively. So
scaffold best-effort ensures a PATH-resolvable global `dreamcontext`:

1. Probe via `command -v dreamcontext` run through `$SHELL -lc` (login shell so a
   Finder-launched app sees nvm/brew/volta PATH — same reason `find_node()` in Rust
   uses `$SHELL -lc`).
2. If missing: `npm install -g dreamcontext@latest` (via the same login-shell path).
3. Never throws; returns `{ status: 'present' | 'installed' | 'failed' }`.
4. Result is included in the scaffold response JSON and surfaced on the success screen
   (shows "CLI installed" note or "failed — run manually" warning).

The `$SHELL -lc` approach is the critical detail: a `.app` launched from Finder or
Spotlight does NOT inherit the user's interactive-shell PATH. Without the login flag,
`command -v node` (and `command -v dreamcontext`) fails even if both are in `~/.zshrc`.

### Frontend shape

`dashboard/src/pages/LauncherPage.tsx` — `+ Add Project` tile triggers the wizard.
`OnboardingWizard` component — multi-step: choose new/existing → quiz (name, parentDir
w/ Browse picker, description, target user, tech stack, priority) → confirm → success.
`dashboard/src/hooks/useLauncher.ts` — `useScaffoldProject`, `useDetectStack`,
`useLauncherDefaults`.
`src/lib/tech-stack.ts` — `detectTechStack(dir)` extracted from `init` command,
shared by the detect endpoint and `init` itself.

### No new Rust needed

Scaffold is a server endpoint. The native folder picker (`dialog` plugin) and
`WebviewWindow` API were already wired for the multi-vault feature. No additional
Rust commands or Tauri ACL entries required.

## Continuous app update WITHOUT Apple notarization (the "CLI-carries-app" model)

The desktop app updates continuously **without** an Apple Developer ID / Tauri
updater, because the whole delivery path is CLI/curl-driven (which never sets the
macOS `com.apple.quarantine` bit, so Gatekeeper's notarization check never fires;
ad-hoc signing already satisfies Apple Silicon's must-be-signed rule). Two parts:

1. **Thin-shell pivot** (`lib.rs` `find_global_cli` + `resolve_cli`). The app
   PREFERS the globally-installed, auto-upgrading CLI over its bundled `dist/`.
   Resolution order: `DREAMCONTEXT_CLI` env → global (`$SHELL -lc 'command -v
   dreamcontext'`, same login-shell trick as `find_node`) → bundled resource →
   dev cwd. **Verified**: a launched `.app` spawns
   `node <nvm>/bin/dreamcontext dashboard …` (the GLOBAL CLI), so server /
   dashboard / route / all `dist/` logic stays fresh via the existing CLI
   auto-upgrade with NO app rebuild. ~95% of changes ride this; the bundled copy
   is only a first-run fallback.

2. **`dreamcontext app install|update|status`** (`src/cli/commands/app.ts`).
   Installs the `.app` to `~/Applications` (no admin) via `ditto` (preserves
   signature; sets no quarantine), atomic same-volume swap (staging→target with
   target→backup rollback), strips quarantine defensively, tracks the installed
   version in `~/.dreamcontext/app.json`. `--from <.app|.tar.gz|.zip>` for local;
   otherwise pulls the arch-matching `dreamcontext-beta_<ver>_<arch>.app.tar.gz`
   from GitHub Releases. `isAppRunning` matches `<bundle>/Contents/MacOS/` (NOT
   the bundle name — else the install command self-matches). Replacing a running
   bundle is safe (running process keeps its inode; relaunch picks up the new one).
   Auto-sync: `maybeTriggerAppUpdate` fires a detached background `app update`
   from the CLI's ≤once/24h hook tick when the app is installed (opt-out
   `DREAMCONTEXT_APP_AUTO_UPDATE=0`); only an already-installed app is updated,
   never auto-installed.

**Security posture (enforced):** a downloaded artifact is installed (often by the
silent background path), so `downloadLatestArtifact` REQUIRES a per-asset
`<asset>.sha256` and refuses to install if it's missing or mismatches. Ad-hoc
code-signing proves integrity-in-transit at best, never origin — it is NOT a
substitute. All external commands use arg arrays (no shell string); bsdtar
refuses `..`/absolute paths (no zip-slip).

**Faz 1 release CI — SHIPPED and E2E verified (v0.8.1).** `.github/workflows/desktop-release.yml`
fires on `v*` tags. Pipeline steps:
1. `npm ci` in repo root + `npm ci --prefix dashboard` (no workspace; separate installs).
2. `npm run build` (CLI + dashboard).
3. `npm run tauri build` under `desktop/`.
4. Ad-hoc deep-sign with `entitlements.plist`: `codesign --deep --force --sign - --entitlements entitlements.plist <app>`.
5. Package: `dreamcontext-beta_<ver>_<arch>.app.tar.gz` + `.sha256` checksum file.
6. Smoke-check: untar → verify codesign → verify checksum.
7. Upload both artifacts to a public GitHub Release (non-draft, tag-named).

`dreamcontext app install` then downloads the arch-matching tarball, verifies the `.sha256`, and installs to `~/Applications`. First E2E run: tag `v0.8.1` → CI green → `dreamcontext app install` confirmed download + checksum-verify + install. The `app install/update` and auto-sync paths are now fully operational end-to-end with no further code changes.

**Windows/Linux:** mechanism is macOS-only (no-quarantine property is macOS-specific); nice-to-have for later.

## Operational gotchas

### Homebrew-vs-nvm CLI resolution in the app

`ensureCliInstalled` probes `$SHELL -lc 'command -v dreamcontext'`. On a machine with BOTH Homebrew and nvm, Homebrew appears earlier in the login-shell PATH than nvm — so the probe resolves the Homebrew global, and `npm install -g` also targets Homebrew. If a developer updated a different (nvm-managed) global CLI, the app-spawned server runs the OLDER Homebrew copy. This explained a "stale dashboard" bug during development: the app was serving an older Node server build than expected.

**Fix / mitigation:** publishing the CLI to npm and having the user's global install sourced from one consistent toolchain (not a mix of brew + nvm) is the real fix. The thin-shell pivot (app prefers global CLI) amplifies this: it's a feature when the global stays fresh, a footgun when two globals diverge.

### App icon

Brand diamond logo (white squircle) fitted to the Tauri icon set via `tauri icon` from `desktop/public/image/dreamcontext.png`. Source kept at `desktop/src-tauri/icon-source.png`. Re-run `tauri icon <source>` to regenerate all platform sizes if the logo changes.

## Sleepy — notch quick-capture companion

A global-hotkey-summoned, transparent notch companion that captures thoughts/commands
into any registered vault. Desktop-only; ships via desktop release, not npm.

### Architecture

```
Global hotkey (tauri-plugin-global-shortcut, registered in launcher window JS)
  → toggleSleepyWindow() → WebviewWindow(label='sleepy', ?capture=1, transparent,
      alwaysOnTop, decorations=false, x=topCenter(420), y=0, 420×520 px)
      + win.setFocus() (grabs key focus immediately on open)
      → CaptureBar.tsx (mounts when ?capture=1)
          → onSleepyFocusChange(): close-on-blur dismiss (Spotlight-style)
          → user types → POST /api/launcher/capture
              → (1) insertToJsonArray (in-process CHANGELOG write, guaranteed)
              → (2) spawn: $SHELL -lc 'exec claude -p "$0"' <note>  (tracked)
                   captureRuns Map { captureId → {state, output, startedAt} }
                   returns {ok, captureId}
          → poll GET /api/launcher/capture/status?id=<captureId> every 1.2s
              → shows "Sleepy is learning…" spinner, then Claude's response
```

### Hotkey registration details

- Plugin: `tauri-plugin-global-shortcut`. Registered from the **dashboard JS** layer
  (not Rust), via a dynamic `import('@tauri-apps/plugin-global-shortcut')`.
- Capability scoped to the loopback origin (`http://127.0.0.1:*`) in
  `desktop/src-tauri/capabilities/default.json`.
- **Owned by the persistent launcher window** (not per-vault windows). When a user
  changes the hotkey in a vault's Settings page, that page writes to localStorage
  keyed `sleepy:config:v1`; the launcher window listens on the cross-window `storage`
  event and re-applies via `applySleepyHotkey()` — so the hotkey survives vault window
  closure.
- **Bare Fn keys not supported** — requires a native CGEventTap not available via the
  plugin. Combo keys only (e.g. `Alt+Cmd+S`).

### Transparent notch window

- `macOSPrivateApi: true` in `tauri.conf.json` enables true window transparency.
- Window: `decorations:false`, `transparent:true`, `alwaysOnTop:true`, `y:0`, size
  **420×520 px** (was 340, grown to fit the enrichment response panel).
- `win.setFocus()` is called after `tauri://created` so the panel immediately becomes
  the key window — the user can type or press Esc without a preliminary click.
- Enter submits; Shift+Enter newlines (chat-style `<textarea>`). Esc → `closeSelf()`.
- **Close-on-blur (Spotlight-style)**: `onSleepyFocusChange(cb)` in `sleepy.ts`
  subscribes to `getCurrentWebviewWindow().onFocusChanged(…)`. Armed after the first
  `focused=true` event; paused while the vault picker is open (`pickerActiveRef`). When
  the user clicks back to their editor the panel dismisses itself — focus returns to
  wherever they clicked, NOT to the dreamcontext main window.
- **Known gap**: dismissing with Esc (not click-away) may still surface the main window
  because the capture panel activates the app. Fully suppressing requires a native
  non-activating `NSPanel` — deferred.

### Mascot panel (notch layout)

- Black notch panel: **360×150 px** (matches the capture bar width below so both read
  as one cohesive column). Flat top, `border-radius: 0 0 22px 22px` bottom.
- Mascot `<video>` fills the panel **edge-to-edge**: `width:100%; height:100%;
  object-fit:cover` — the 16:9 H.264 clip is cropped top/bottom; the centered face
  fills the full banner width with no black side gutters.
- No alpha channel needed — black clips merge with the black panel.

### Mascot mood

`GET /api/sleep` returns `{debt}`. Three modes: `idle` (debt ≤3), `sleepy` (4–9),
`sleeps` (≥10). Mode drives the video source: `/api/sleepy/video?mode=<mode>`.

### Capture pipeline

1. **Instant / guaranteed**: the server writes the CHANGELOG entry **in-process** via
   `insertToJsonArray` (same logic as `memory remember`). No child CLI is spawned here.
   **Why**: in a packaged `.app`, the globally-resolvable `dreamcontext` can be a stale
   Homebrew copy or absent entirely (Finder/Spotlight don't inherit the user's
   interactive-shell PATH). A child `memory remember` call therefore surfaced as a bare
   "failed". Since the server IS dreamcontext, the write is direct and failure-proof.

2. **Tracked enrichment**: a headless `claude` spawn with piped stdio. The note is
   passed as login-shell positional `$0` (no shell string interpolation, no injection).
   `buildCapturePrompt` prepends: "do not ask follow-ups, take notes and learn".
   The spawn gets an `'error'` listener so async spawn failures (claude not on PATH)
   don't crash the server. The child is NOT detached — stdout/stderr are captured.
   `captureRuns` Map tracks state (`running|done|error`) + output (tail-capped at 8 KB).
   Returns `{ok: true, captureId: <uuid>}`.

3. **Status route**: `GET /api/launcher/capture/status?id=<captureId>` →
   `{state: running|done|error|unknown, output}`. `unknown` = expired or never existed.
   The Map is pruned (TTL 10 min after completion, size cap 50) on each capture POST.

4. **Capture bar polling**: 1.2 s interval, ceiling 3 minutes or a streak of 5
   consecutive `unknown` responses. Shows "Sleepy is learning…" spinner while running,
   then Claude's response in a scrollable panel below the textarea.

### Dead vault handling

`GET /api/vaults` now returns `exists: boolean` per vault (`existsSync(resolve(v.path))`).
The capture bar filters the picker to `exists=true` vaults only. Previously a deleted
vault (e.g. `/Users/.../Test`) would accept the selection and fail on POST with a
`missing_vault` error that showed only as bare "failed". Real error strings are now
surfaced in the UI.

### Asset bundling

- 3 clips downscaled to ~160 KB each from original 1920×1080 ~2 MB.
- Stored at `desktop/src-tauri/sleepy/{idle,sleepy,sleeps}.mp4` (renamed from `Dreamy`
  to `Sleepy` clips this cycle).
- Bundled as Tauri resources → `Resources/sleepy/` inside the `.app`.
- Rust shell sets `DREAMCONTEXT_SLEEPY_DIR=<resource_dir>/sleepy`; backend reads it.
- Served by `GET /api/sleepy/video?mode=` with Range support (WKWebView requires Range
  for `<video>`).
- **Nothing ships to the npm package.**

### Persistence gotcha

The app's per-launch loopback port creates a new origin each time → localStorage is
empty on every launch. Config (`{enabled, hotkey}`) persists server-side at
`~/.dreamcontext/sleepy.json`. The launcher seeds localStorage from this file on mount
(`initSleepyFromServer`); writes go to both localStorage AND the server.

### Settings

Sleepy section moved to the **bottom** of Settings (after Connections) and carries a
`BETA` badge (`<span class="settings-beta-badge">`) styled in the project's accent
colour (`--color-accent`, violet).

### Status

Functional and live-verified. Capture pipeline hardened (in-process write, tracked
enrichment, live status UI). Visual design improved but **not yet formally
user-accepted**. Feature PRD: `_dream_context/core/features/sleepy-notch-capture.md`.

## Status / deferred

Working local beta. NOT Apple-signed/notarized (local install only; Gatekeeper
needs a right-click-open or the quarantine clear above). Pages reskin,
federation→nav promotion, Overview, and accessibility/quick-capture are still
deferred (see the unified-dashboard plan).

**Follow-up cleared this cycle:** the dead Rust `open_vault` command and `Port` state
were REMOVED from `lib.rs` (`cargo check` clean). That cleanup is no longer pending.
