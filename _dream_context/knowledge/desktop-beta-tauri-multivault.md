---
id: knowledge_desktop_beta_tauri_multivault
name: desktop-beta-tauri-multivault
description: >-
  How dreamcontext-beta (the Tauri 2 macOS app) wraps the existing React+Node
  dashboard for multi-vault / multi-window use: multi-window architecture, five
  non-obvious gotchas (CLI bundling, Tauri ACL, relative URLs, build/sign, v0.8.6
  DnD handler must be disabled via drag_drop_enabled(false) for HTML5 DnD to work),
  the in-app quiz-style project onboarding (scaffold endpoints, child-spawn
  pattern, auto-CLI-install, hasContext skip-quiz for pre-initialized folders),
  the Faz 1 GitHub Actions release pipeline (E2E verified v0.8.3+), the
  homebrew-vs-nvm CLI resolution gotcha, the Sleepy notch quick-capture companion
  (global hotkey; non-activating NSPanel via tauri-nspanel v2; hover-to-open via
  Rust CoreGraphics cursor poll; coded SleepyMascot.tsx replacing animated WebP;
  PanelEnabled opt-in default false; Learn/Ask/Sleep mode toggle; Sonnet enrichment
  with Markdown rendering; interactive-login-shell claude PATH fix; tracked
  enrichment status UI; dead-vault filtering; focus/blur UX), the in-app Agent
  terminal (xterm.js + @xterm/addon-webgl + node-pty WS bridge; session persistence
  via display:none hoist above App.tsx page switch; bypassPermissions opt-in;
  drag-to-split; desktop-only DREAMCONTEXT_DESKTOP gate; dev-workflow note: only
  Rust/lib.rs changes need tauri build, dashboard changes just need npm run build +
  app relaunch), find_global_cli -ilc fix SHIPPED v0.10.0 (empirical note: dev
  machine had both -lc and -ilc resolve nvm CLI because global is npm-linked to repo,
  so all three resolution paths pointed at same fresh dist), the Launcher per-project
  status indicator (green/yellow/red, upgrade-vs-update distinction), the
  content-scoped drift nag, the ensure-dashboard app-installed auto-open suppression,
  the interactive federation graph (react-force-graph-2d, read-only violet edges,
  drag-to-connect, active-edge particles), brain-settings server persistence
  (vault-scoped .brain-settings.json), and the Federation Settings panel redesign
  (plain-language explainers, direction labels).
type: knowledge
tags:
  - architecture
  - domain
  - onboarding
  - topic:federation
pinned: true
created: '2026-06-13'
updated: '2026-06-29'
released_version: v0.8.6
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

## Architecture (the "A path" — same React+Node, Tauri just wraps it)```
.app launch → Rust shell (desktop/src-tauri/src/lib.rs)
  → find_node() (login shell `command -v node`, else /opt/homebrew etc.)
  → spawn: node <bundled dist/index.js> dashboard --port N --no-open --launcher
  → poll GET /api/health, then open window "main" at http://127.0.0.1:N/
  → kill node child on RunEvent::ExitRequested (no orphan)```- **Launcher mode**: `dashboard --launcher` boots the server with `contextRoot = null`
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

> **v0.8.6 addition — gotcha #5:** Tauri's native OS-level drag-and-drop handler swallows `dragover`/`drop` events in the webview. If you ship HTML5 drag-and-drop features (Kanban task cards, Eisenhower matrix), you MUST disable the native handler in `lib.rs` via `.drag_drop_enabled(false)` on the `WebviewWindowBuilder`. Without this the webview never receives the HTML5 DnD events and cards cannot be dragged. File: `desktop/src-tauri/src/lib.rs`. Shipped v0.8.6.

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

CLI entry point is resolved as:```
process.env.DREAMCONTEXT_CLI ?? process.argv[1]```The env var override is the same hook the Rust shell uses (`lib.rs`), so test
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
   Resolution order: `DREAMCONTEXT_CLI` env → global → bundled resource →
   dev cwd. **v0.10.0 fix (SHIPPED)**: `find_global_cli` was changed from
   `$SHELL -lc 'command -v dreamcontext'` to `$SHELL -ilc 'command -v
   dreamcontext'` (interactive login shell, `lib.rs:215`). The `-i` flag sources
   `~/.zshrc` so nvm/mise/volta-managed CLIs are visible to the app even when
   launched from Finder or Spotlight. This fix shipped via `tauri build` +
   `dreamcontext app install` in v0.10.0.
   **Empirical nuance (v0.10.0 dev machine)**: On the development machine BOTH
   `-lc` and `-ilc` resolved the nvm `dreamcontext`, and the global CLI is
   `npm link`-ed directly to the repo (`<nvm>/bin/dreamcontext →
   ../lib/node_modules/dreamcontext/dist/index.js`). As a result all three CLI
   resolution paths — `DREAMCONTEXT_CLI` override (set via launchctl to
   `dist/index.js`), the global (npm-linked to the same `dist/`), and the
   freshly-rebuilt bundled fallback — pointed at the same fresh dist during
   testing. The stale-dist symptom was therefore NOT reproducible on the dev
   machine; it manifests on user machines where the global CLI is a separate
   installed copy that hasn't been updated yet.
   **Verified on dev**: a launched `.app` spawns
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

**`find_global_cli` (Rust, `lib.rs:215`) — UPDATED to `-ilc` in v0.10.0.** This is the primary resolution path for the app's server spawning. It now uses `$SHELL -ilc 'command -v dreamcontext'` (interactive login shell) so nvm/mise/volta-managed CLIs are visible.

**`ensureCliInstalled` (JS, `src/lib/ensure-cli.ts`) — still uses `-lc`.** This is the scaffold helper (run during project onboarding) that checks/installs the global CLI. It uses `$SHELL -lc 'command -v dreamcontext'` (login shell, non-interactive). On a machine with BOTH Homebrew and nvm, Homebrew appears earlier in the login-shell PATH — so the probe resolves the Homebrew global, and `npm install -g` targets Homebrew. If a developer updated a different (nvm-managed) global CLI, the scaffold check resolves the wrong one. This is a known residual gotcha (different from the `find_global_cli` issue which is now fixed).

**Fix / mitigation for `ensureCliInstalled`:** publishing the CLI to npm and having the user's global install sourced from one consistent toolchain (not a mix of brew + nvm) is the real fix. The thin-shell pivot (app prefers global CLI) amplifies this: it's a feature when the global stays fresh, a footgun when two globals diverge.

### App icon

Brand diamond logo (white squircle) fitted to the Tauri icon set via `tauri icon` from `desktop/public/image/dreamcontext.png`. Source kept at `desktop/src-tauri/icon-source.png`. Re-run `tauri icon <source>` to regenerate all platform sizes if the logo changes.

## Sleepy — notch quick-capture companion

A global-hotkey-summoned, transparent notch companion that captures thoughts/commands
into any registered vault. Desktop-only; ships via desktop release, not npm.

### Architecture```Global hotkey (tauri-plugin-global-shortcut, registered in launcher window JS)
  → toggleSleepyWindow() → WebviewWindow(label='sleepy', ?capture=1, transparent,
      alwaysOnTop, decorations=false, x=topCenter(420), y=0, 420×520 px)
      + win.setFocus() (grabs key focus immediately on open)
      → CaptureBar.tsx (mounts when ?capture=1)
          → onSleepyFocusChange(): close-on-blur dismiss (Spotlight-style)
          → mode toggle: Learn | Ask | Sleep
          → user types/clicks → POST /api/launcher/capture {vault, text, mode}
              Learn: (1) insertToJsonArray (in-process CHANGELOG write, guaranteed)
              Ask/Sleep: no CHANGELOG write
              → spawn: $SHELL -ilc 'exec claude --model sonnet -p "$0"' <prompt>
                   captureRuns Map { captureId → {state, stdout, stderr, startedAt} }
                   returns {ok, captureId}
          → poll GET /api/launcher/capture/status?id=<captureId> every 1.2s
              (Learn/Ask: 3-min ceiling; Sleep: ~15-min; unknown-streak guard)
              → renders Markdown response (marked + DOMPurify) in scrollable panel
              Sleep: mascot sleeps anim, toggle+input locked, no auto-dismiss```
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
- Mascot is an **animated WebP** rendered as `<img>`, not `<video>`. WKWebView
  hard-blocks `<video>` autoplay and Tauri 2.11/wry exposes no webview autoplay
  setting — even the React `muted`-attribute-vs-property fix could not override it.
  `<img>` with animated WebP autoplays unconditionally.
- `<img>` fills the panel edge-to-edge: `width:100%; height:100%; object-fit:cover`.

### Mascot mood

`GET /api/sleep` returns `{debt}`. Three modes: `idle` (debt < 8), `sleepy` (8–9),
`sleeps` (≥ 10). Threshold raised from 4 to 8 so the drowsy look only appears when
debt is genuinely high. Mode drives the image source: `/api/sleepy/anim?mode=<mode>`.

### Capture pipeline

1. **Instant / guaranteed**: the server writes the CHANGELOG entry **in-process** via
   `insertToJsonArray` (same logic as `memory remember`). No child CLI is spawned here.
   **Why**: in a packaged `.app`, the globally-resolvable `dreamcontext` can be a stale
   Homebrew copy or absent entirely (Finder/Spotlight don't inherit the user's
   interactive-shell PATH). A child `memory remember` call therefore surfaced as a bare
   "failed". Since the server IS dreamcontext, the write is direct and failure-proof.

2. **Tracked enrichment**: a headless `claude --model sonnet` spawn with piped stdio.
   The prompt is passed as login-shell positional `$0` (no injection). Prompts start
   with "Think hard" (medium extended thinking keyword). **Interactive login shell
   (`-ilc`)**: tools like `claude` are often added to PATH in `~/.zshrc` (e.g.
   `~/.local/bin`); a non-interactive login shell (`-lc`) does NOT source `.zshrc`,
   so a Finder-launched app got "command not found: claude". `-ilc` mirrors a real
   terminal's PATH and is verified to find claude in a clean Finder-like `env -i`
   simulation. Stdout (Claude's reply) and stderr (shell/init noise) are captured
   separately so rc-file chatter never pollutes the shown response. `captureRuns` Map
   tracks state (`running|done|error`) + output (tail-capped at 8 KB). Returns
   `{ok: true, captureId: <uuid>}`.

3. **Status route**: `GET /api/launcher/capture/status?id=<captureId>` →
   `{state: running|done|error|unknown, output}`. `unknown` = expired or never existed.
   The Map is pruned (TTL 10 min after completion, size cap 50) on each capture POST.

4. **Capture bar polling**: 1.2 s interval. Ceiling: 3 min for Learn/Ask, ~15 min
   for Sleep, or a streak of 5 consecutive `unknown` responses. Shows mode-appropriate
   spinner ("Sleepy is learning…" / "Sleepy is thinking…" / "Sleepy is sleeping…")
   while running, then Claude's response rendered as Markdown in a scrollable panel.

### Dead vault handling

`GET /api/vaults` now returns `exists: boolean` per vault (`existsSync(resolve(v.path))`).
The capture bar filters the picker to `exists=true` vaults only. Previously a deleted
vault (e.g. `/Users/.../Test`) would accept the selection and fail on POST with a
`missing_vault` error that showed only as bare "failed". Real error strings are now
surfaced in the UI.

### Asset bundling

- Source `.mp4` clips at `desktop/src-tauri/sleepy/{idle,sleepy,sleeps}.mp4`.
- **Animated WebP** clips at `desktop/src-tauri/sleepy/{idle,sleepy,sleeps}.webp`
  (15fps, ~2.5 MB each), generated with `img2webp` (libwebp) from ffmpeg-extracted
  frames (fps=15, scale=420px, q=72, loop=0). Both `.mp4` and `.webp` ship in the
  bundle; the capture bar uses `.webp`.
- Bundled as Tauri resources → `Resources/sleepy/` inside the `.app`.
- Rust shell sets `DREAMCONTEXT_SLEEPY_DIR=<resource_dir>/sleepy`; backend reads it.
- Served by `GET /api/sleepy/anim?mode=` (animated WebP, whole-file, 24h cache).
  Legacy `GET /api/sleepy/video?mode=` (Range-supporting mp4 stream) is kept.
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

**Disabling closes the whole notch (not just the hotkey).** The notch presence has
three Rust-owned entry points — the global hotkey, the always-on perch, and
hover-to-open — but `SleepyConfig.enabled` originally gated only the hotkey
(`applySleepyHotkey` unregisters). So a disabled Sleepy still showed the perch and
opened on hover. Fix: a `PanelEnabled` atomic in `lib.rs` (default **false** — Sleepy
is opt-in, so the notch never appears before it's enabled). The launcher mirrors the
persisted flag to Rust via a `sleepy:enabled` event emitted from `applySleepyHotkey`
(which already runs on mount, cross-window `storage` sync, and Settings change). Rust's
`apply_sleepy_enabled`: enabled → `show_perch`; disabled → hide any shown capture panel
+ `hide_perch`. Both `show_perch` and the hover watcher are gated on `is_enabled`, and
`build_perch_panel` now builds the perch hidden (no startup `order_front`).

### Modes: Learn / Ask / Sleep

A segmented toggle in the capture bar header selects the interaction mode:

- **Learn** (default): saves the note to project memory (in-process CHANGELOG write,
  guaranteed), then Sleepy enriches/learns it via `claude --model sonnet`. Shows
  "Sleepy is learning..." spinner, then the enrichment response in Markdown.
- **Ask**: one-shot Q&A about the project. **Nothing is saved.** Sleepy answers
  directly (no file changes, no follow-ups). Shows "Sleepy is thinking..." spinner.
  Answer rendered as GitHub-flavored Markdown (short, tight, no preamble).
- **Sleep**: triggers a full `dreamcontext sleep` consolidation for the selected vault.
  Mascot switches to the sleeping animation, the toggle and input lock, and the window
  does NOT auto-dismiss on blur so the user can step away and return for the summary.
  Poll ceiling ~15 min.

All three modes use `claude --model sonnet` with "Think hard" prompts for medium
extended thinking. Markdown responses rendered via `marked` (GFM) + `DOMPurify`.
A global `reset.css` reset had zeroed `list-style`; the `.cap-md` class re-enables
bullets and collapses loose-list `<p>` margins.

### Status

Functional and live-verified. Animated WebP mascot autoplays in WKWebView. Learn/Ask/Sleep
modes all functional. Visual design improved but **not yet formally user-accepted**.
Feature PRD: `_dream_context/core/features/sleepy-notch-capture.md`.

## Launcher per-project status & update (v0.8.3)

### Upgrade-vs-update distinction

Upgrading the global CLI (`npm install -g dreamcontext@latest`) refreshes the
binary but does NOT touch any project's installed skills, agents, or hooks. Each
project carries its own `setupVersion` in `_dream_context/state/.config.json`.
When `setupVersion` lags behind the running CLI version, the project's agent
tooling is stale until the user runs `dreamcontext update` INSIDE that project.

### Content-scoped drift nag (v0.8.4)

The SessionStart "stale project assets" directive fires on a cheap version
comparison (`setupVersion < cliVersion`). But a CLI release may only add or
change packs this project never installed — nagging then is a false positive;
`dreamcontext update` would be a content no-op for the user.

**Design**: `setup-drift.ts` still governs version-based detection
(`stale`/`bootstrap`/`current`/`downgrade`/`disabled`). A separate content-scope
layer reads a cached verdict and suppresses the nag only when the cache
confidently proves no used asset changed:

- **`src/cli/commands/asset-drift.ts` — `computeUsedAssetsChanged()`**: installs
  the current CLI's canonical assets for the project's exact platforms + packs into
  a throwaway temp dir using the REAL installers (zero mapping duplication of
  the intricate pack→disk logic). Then byte-compares each produced file against the
  project's on-disk copy. Comparison is temp→disk only (additions/modifications):
  unused/extra on-disk files never trigger the nag. Two files are excluded from
  comparison: `settings.json` (hooks are additively merged, never byte-identical)
  and any path under `_dream_context/` (machine-state; `emptyManifest()` is passed
  to the pack installer so no `.install-manifest.json` persists into the temp tree).

- **`src/lib/asset-drift-cache.ts` — `AssetDriftCache`**: verdict persisted at
  `_dream_context/state/.asset-drift.json` (machine-local, gitignored), keyed on
  `(cliVersion, setupVersion)`. `cacheConfidentlyClean()` returns true ONLY when
  the cache was computed for those exact versions AND `usedAssetsChanged === false`.
  Every other state — absent, version-mismatched, or `changed=true` — FAILS OPEN
  to the nag (better an extra nudge than a missed update).

- **Why detached**: `generateSnapshot()` is synchronous and stdout-sensitive; the
  installers are async and log to stdout. The verdict is therefore recomputed in a
  detached `hook refresh-asset-drift` child process (`spawnAssetDriftRefresh()` in
  `src/cli/commands/hook.ts`), piggybacking on the existing ≤once/24h version-check
  tick (alongside `maybeTriggerAppUpdate()`). The snapshot reads only the cached
  file. Convergence is bounded by the 24h cadence — the nag may show for at most
  one session before the cache arrives.

- **Suppression gate in snapshot**: `src/cli/commands/snapshot.ts` calls
  `resolveDriftState()` first; when state is `stale` or `bootstrap` it then reads
  the cache with `readAssetDriftCache()` and calls `cacheConfidentlyClean()`. Only
  a confident `false` suppresses the directive; any other outcome shows the nag.

### Status indicator

`GET /api/launcher/status` returns per-vault:```
{ name, path, exists, setupVersion, latestVersion, needsUpdate, shareable }```Color mapping displayed in the Launcher card:
- **green** — folder exists AND `setupVersion >= latestVersion`
- **yellow** — folder exists AND `setupVersion < latestVersion` (needs update)
- **red** — folder does not exist (removable)

A project that has never run `setup` shows `setupVersion: '0.0.0'` and therefore
always appears yellow — intentional, since `update` also acts as first-run `setup`.

### In-Launcher update flow

`POST /api/launcher/update { vault }` spawns `dreamcontext update` in the project
cwd using `defaultCliRunner` (no-shell, arg array, same pattern as scaffold). Returns
the updated `VaultStatus`. The user never opens a terminal.

`POST /api/launcher/unregister { vault }` removes the vault from the registry
(folder-agnostic; files are NOT deleted). Intended for red-status (deleted-folder)
cleanup. Idempotent.

## Interactive federation graph (v0.8.3)

### Purpose and location

A `react-force-graph-2d` canvas (`dashboard/src/pages/LauncherGraph.tsx`, CSS:
`LauncherGraph.css`) lives in the Launcher (not a per-project page) because
federation is a cross-project concern. Per-project Settings retains the text-form
`ConnectionsManager` for users who prefer a list.

### Node and edge semantics

- One node per registered vault, colored by STATUS (green `#34d399` / yellow
  `#fbbf24` / red `#f87171`). Canvas-safe hex constants (CSS vars not available
  on canvas).
- Directed edges come from `GET /api/launcher/federation-graph`, which aggregates
  `listVaults()` + each vault's `listConnections()` into
  `{ nodes: VaultStatus[], edges: FederationEdge[] }`.
- An edge `{ source, target, active }` is emitted iff the source's connection to
  target has `direction: 'out' | 'both'` AND the connection is not stale AND both
  vaults are registered. `active = target.shareable`.
- **Active edges** (target has `shareable: true`) animate `linkDirectionalParticles`
  in violet `#8b5cf6` — the "electric current" of live sync. Inactive edges are
  dimmed, signaling the link is stored but inert.

### Read model (critical mapping)

Per `src/lib/federation-recall.ts`:  
Vault A reads vault B iff A's connection to B has `direction: 'out' | 'both'`
AND B's `shareable` flag is `true`.

The graph surfaces BOTH: the edge (connection direction) and the shareable gate.

### Drag-to-connect

In **Connect mode** (toggle in graph toolbar), dragging from node A onto node B
calls `POST /api/launcher/connection { from: A.name, to: B.name }`. This stores an
`out` edge on A's side only. Two separate drags (A→B then B→A) create two
independent `out` edges — the graph renders them as a two-way arrow. There is no
`both` shortcut: two-way federation requires two explicit drags.

`POST /api/launcher/connection/remove { from, to }` removes the edge.  
`POST /api/launcher/shareable { vault, shareable }` toggles the shareable flag
directly from a node panel in the graph.

### Frontend hooks

`dashboard/src/hooks/useLauncher.ts` provides: `useFederationGraph`,
`useCreateConnection`, `useRemoveLauncherConnection`, `useToggleShareable`,
`useUpdateProject`.

## Brain-settings server persistence (v0.8.3)

### The problem

The desktop app assigns a new loopback port each launch, creating a new origin.
`localStorage` is empty on every launch, so brain graph settings (node size,
text-fade threshold, force parameters) reset every time.

### Solution

A new route file `src/server/routes/ui-settings.ts` provides:
- `GET /api/brain-settings` — returns the settings JSON (or `{}` if absent or corrupt)
- `PUT /api/brain-settings` — writes an opaque JSON blob; 256 KB size cap; validates
  only that the body is a JSON object, never inspects fields.

Settings persist at `_dream_context/state/.brain-settings.json` (vault-scoped, so
different projects can have independent graph configurations).

`dashboard/src/hooks/useGraphSettings.ts` hydrates from `GET /api/brain-settings`
on mount. Writes go to both localStorage (flash-free instant render) AND the server
(durable). This is the same write-through pattern used by Sleepy's `sleepy.json`.

## Federation Settings panel redesign (v0.8.3)

`dashboard/src/components/settings/ConnectionsManager.tsx` was rewritten with:
- A **plain-language explainer block** describing what federation is and what
  "A reads B" means before showing any controls.
- A **Sharing card** (enables/disables this project as a federation source).
- **Self-describing direction labels** replacing arrow-icon-only controls:
  - ⮜ Read from
  - ⮞ Share to
  - ⇄ Two-way
- Per-option **hints** explaining the effect of each direction choice.
- New `federation.*` i18n keys wired into the existing localization layer.

## `hook ensure-dashboard` auto-open suppression

`hook ensure-dashboard` normally opens the dashboard in a browser tab on
`SessionStart`. When the beta app is installed, the app owns the dashboard
surface — opening a browser tab would be redundant and confusing. The hook now
exits silently when `readAppManifest() !== null` (i.e. `~/.dreamcontext/app.json`
exists). The check is synchronous and cheap; no-op on non-app machines.

## In-app Agent Terminal (2026-06-28)

A full interactive Claude Code terminal embedded in the Sleepy page of the dashboard. Desktop-only; never ships in the npm package.

### Architecture

```
GET /api/agent/capabilities  →  { available: true }  (DREAMCONTEXT_DESKTOP gate)
GET /api/agent/capabilities  →  { available: false } (npm/browser build)

WS /api/agent/terminal?vault=<name>&bypass=<bool>
  ← loopback-only (strict remoteAddress check)
  → node-pty: $SHELL -ilc 'exec claude [--dangerously-skip-permissions]'
       cwd = vault project root
  ← AgentTerminal.tsx (xterm.js + @xterm/addon-webgl + @xterm/addon-fit)
```

### Key decisions

**Session persistence (display:none hoist):** `App.tsx` uses `switch (nav.page)` returning one mounted page, so navigating away unmounts `SleepyPage` → kills `AgentTerminal` → closes WebSocket + PTY. Fix: `AgentTerminal` is instantiated ABOVE the `switch` as a single long-lived owner, toggled via `display:none` (never unmounted) when Sleepy is not active. The xterm DOM node is re-shown and re-fit (`fitAddon.fit()`) on reveal. Tear-down only on explicit Close/Restart or app quit.

**WebGL renderer + Sometype Mono font metrics:** `@xterm/addon-webgl` gives GPU-composited, crisp-at-any-DPR text (comparable to Zed's terminal). Automatic fallback to the default canvas renderer on WebGL context-loss. The Sometype Mono font (regular + 600 weight) must be fully loaded and committed to `term.open()` before the WebGL addon is initialized — loading the font after `open()` results in thin/stretched glyphs because the glyph atlas is already committed to the wrong cell width. Fix: load via `FontFaceSet.load()`, await, then call `term.open()`, then attach the WebGL addon.

**bypassPermissions (default OFF):** The terminal runs real `claude` with full file-write capability. The bypass flag is opt-in; when armed, a standing orange warning chip is shown and the WS query param `bypass=true` passes `--dangerously-skip-permissions` to the claude spawn. Read-only Chat (Phase 3, `--permission-mode plan`) is always available and unaffected.

**Drag-to-split:** Dragging one agent tab onto another (or onto the terminal body) creates a side-by-side split layout. The drag-over handler gates `preventDefault()` on `dataTransfer.types` (available during dragover), not on React state (not settled on first hover). `⌘D` and the `⊟` button also split.

### Key files

- `src/server/routes/agent-terminal.ts` — `attachAgentTerminal(server)`: WS upgrade + node-pty spawn; `GET /api/agent/capabilities`; `POST /api/agent/open-terminal` (osascript fallback for external terminal).
- `src/server/index.ts` — `attachAgentTerminal(server)` wired at bottom.
- `dashboard/src/components/sleepy/AgentTerminal.tsx` — xterm.js + `@xterm/addon-webgl` + `@xterm/addon-fit`; `readXtermTheme()` maps design tokens to xterm theme; dynamic Sometype Mono font load before `term.open()`; drag-to-split logic.
- `dashboard/src/components/sleepy/AgentTerminal.css`.
- `dashboard/src/pages/SleepyPage.tsx` — `mode: 'search' | 'ask' | 'agent'` tabs; `<AgentTerminal />` rendered in agent mode. **AgentTerminal hoisted above `App.tsx` page switch.**

### Desktop dev workflow note

**Dashboard/CSS/React/server-route changes do NOT need a Tauri rebuild.** The app's Rust shell spawns the global CLI (`find_global_cli` → `$SHELL -ilc 'command -v dreamcontext'`, `-ilc` fix shipped v0.10.0) and serves this repo's `dist/` on a random loopback port. The fast loop:
1. `npm run build` (builds dashboard → dist/dashboard, then CLI → dist/index.js via tsup)
2. **⌘Q + reopen the desktop app** (new random port → new origin → empty WKWebView cache → serves the freshly built dist)

Do NOT use `⌘R` (refresh): WKWebView's document cache retains the OLD bundle at the same loopback port. A new launch picks a new port, bypassing the cache entirely.

**Only Rust/lib.rs changes require** a full `tauri build` + `dreamcontext app install` (rebuilds the native Rust binary). Examples: changes to `NSPanel` behaviour, `find_global_cli`, `apply_sleepy_enabled`, new Tauri commands.

**Last verified: 2026-06-29 (v0.10.0).** Version rename/delete dashboard feature was built (JS-only change), built via `npm run build`, and tested by ⌘Q + reopen — no Tauri rebuild required and the new routes were live immediately. The `-ilc` fix was baked in simultaneously via `tauri build` + `dreamcontext app install` as part of the v0.10.0 release.

**Dev-machine empirical note (2026-06-29):** On the development machine the `DREAMCONTEXT_CLI` launchctl override was set to the repo's `dist/index.js`, AND the global CLI was `npm link`-ed to the same repo. So all three resolution paths (`DREAMCONTEXT_CLI` override, global, bundled fallback) pointed at the same fresh dist. The stale-dist symptom (app serving an older dist than expected) manifests on user machines with a separately installed/stale global CLI — not reproducible in the linked-repo dev setup.

## Status / deferred

Working local beta. NOT Apple-signed/notarized (local install only; Gatekeeper
needs a right-click-open or the quarantine clear above). Pages reskin,
federation→nav promotion, Overview, and accessibility/quick-capture are still
deferred (see the unified-dashboard plan).

**Follow-up cleared this cycle:** the dead Rust `open_vault` command and `Port` state
were REMOVED from `lib.rs` (`cargo check` clean). That cleanup is no longer pending.
