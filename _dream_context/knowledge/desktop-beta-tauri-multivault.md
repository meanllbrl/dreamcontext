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
  terminal — AgentSurface.tsx/agentSession.ts (xterm.js DOM renderer — the WebGL
  addon was REMOVED 2026-07-01 for native macOS anti-aliasing — + node-pty WS bridge;
  session persistence via display:none hoist; bypassPermissions opt-in; drag-to-split;
  2026-07-01 readability polish: minimumContrastRatio 4.5→3 + softened foreground,
  JetBrains Mono as the actually-loaded --font-mono primary with real 400/500/700
  weights (the intended Sometype Mono was NEVER loaded), 14.5px/1.65 line-height,
  encoding-safe beep-free copy/cut, always-visible selection, no inactive-pane
  dimming, cursor-targeted any-file drag-drop; in-app prereq
  installer: GET /api/agent/capabilities + POST /api/agent/install; dev-workflow: only
  Rust/lib.rs changes need tauri build, dashboard changes just need npm run build +
  app relaunch), find_global_cli -ilc fix SHIPPED v0.10.0 (note: global was a
  separate installed copy until this session re-ran npm link; see dev footgun note),
  the Launcher per-project
  status indicator (green/yellow/red, upgrade-vs-update distinction), the
  content-scoped drift nag, the ensure-dashboard app-installed auto-open suppression,
  the interactive federation graph (react-force-graph-2d, read-only violet edges,
  drag-to-connect, active-edge particles), brain-settings server persistence
  (vault-scoped .brain-settings.json), the Federation Settings panel redesign
  (plain-language explainers, direction labels), and the 2026-06-30 agent-surface
  UX redesign: global FAB+overlay replacing SleepyPage, per-pane tab bars,
  minimize-to-corner AgentDock (MUST be DOM sibling of .agent-surface — contain:layout
  paint creates a new containing block for fixed children; .agent-surface > * forces
  width:100%; sibling + z-index 25 is the fix), WKWebView DnD dragend-not-drop rule
  (drop event NOT delivered to mid-drag-mounted targets even though dragover fires;
  custom-MIME getData() empty on drop; carry session id in React ref on dragstart;
  record hovered target on dragover; execute on source dragend), auto-resume transcript
  check (--resume errors if JSONL absent; fall back to --session-id), ⌘K command
  palette (BM25 + Haiku toggle; recallNav + useFocusTarget wired PageRouter→pages),
  and the 2026-06-30 orphaned-dashboard-server root-cause fix (server-side
  parent-death watchdog in src/server/lifecycle.ts — the Rust RunEvent::ExitRequested
  handler alone missed force-quit/crash/dev-rebuild teardown paths, leaking ~25
  launcher servers reparented to PID 1; fixed via a parent-liveness poll inside
  the Node server itself, a PTY child-reaping registry, and Rust SIGTERM->SIGKILL
  process-group hardening).
type: knowledge
tags:
  - architecture
  - domain
  - onboarding
  - topic:federation
pinned: true
created: '2026-06-13'
updated: '2026-07-05'
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
  → graceful SIGTERM→1.5s→SIGKILL on the whole process group on ExitRequested/Exit
    (was: bare kill() on RunEvent::ExitRequested only — see "Orphaned dashboard-server
    fix" below, this line was the STALE claim; that path alone leaked ~25 servers)```- **Launcher mode**: `dashboard --launcher` boots the server with `contextRoot = null`
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
   **Empirical nuance (v0.10.0 dev machine — corrected 2026-06-29)**: At the time
   of the v0.10.0 release the dev machine's global CLI was a **separate installed
   copy** (`<nvm>/lib/node_modules/dreamcontext` — a real directory, not a symlink),
   not `npm link`-ed to the repo. `npm link` was re-run in this session to restore
   the linked-repo dev setup. Once re-linked, all three resolution paths —
   `DREAMCONTEXT_CLI` override (set via launchctl to `dist/index.js`), the global
   (npm-linked to the same `dist/`), and the freshly-rebuilt bundled fallback —
   point at the same fresh dist. The stale-dist symptom (app serving an older dist)
   manifests on user machines with a separately installed, stale global CLI.
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

### Orphaned dashboard-server processes — root-cause fix (v0.10.5, session `96d934d7`)

**The bug the earlier architecture line was wrong about:** the Rust shell spawns exactly ONE `node dist/index.js dashboard --launcher` per app launch and (previously) only killed it from `RunEvent::ExitRequested`. That handler does **not** run on every way the app can die — force-quit, a crash, a `tauri dev` Ctrl+C, or a dev rebuild swapping the binary all terminate the app without it firing. Confirmed empirically: **11 orphaned `--launcher` servers**, all reparented to `PPID 1` (launchd), spanning ~2 days of launches — not grandchildren, the launcher servers *themselves*, each still holding its loopback port. A secondary leak: even when the handler DID fire, `child.kill()` sent SIGKILL (uncatchable), so the server never got to reap its own `claude` PTY grandchildren (the agent-terminal spawns) either.

**The fix is layered, and the primary layer lives in the SERVER, not the Rust shell:**

1. **Server-side parent-death watchdog (the real fix)** — `src/server/lifecycle.ts`, `startParentDeathWatch()`. When desktop-spawned (`DREAMCONTEXT_DESKTOP=1`), the server records its parent PID (`DREAMCONTEXT_PARENT_PID` env var from the shell, falling back to `process.ppid` for an older app bundle that doesn't set it) and probes liveness every 2s via `process.kill(pid, 0)` (existence probe, no signal sent — throws `ESRCH` once the parent is gone, for ANY reason). The moment the parent is gone, the server self-shuts-down. This runs inside Node, so it covers every parent-death path Tauri's Rust exit events miss — and it ships via the normal CLI/`dist` bundle, **no Tauri rebuild required** for this half of the fix.
2. **Child reaping on shutdown** — a small `trackChild()`/`killTrackedChildren()` registry in `lifecycle.ts`; the agent-terminal's `claude` PTY processes register on spawn and get killed when the server shuts down (either via the watchdog or a normal signal), closing the secondary grandchild-leak.
3. **Rust shell hardening** (`lib.rs`) — passes `DREAMCONTEXT_PARENT_PID` explicitly to the spawned child; on BOTH `RunEvent::ExitRequested` AND `RunEvent::Exit`, does graceful **SIGTERM → wait 1.5s → SIGKILL on the whole process group** (`reap_server` helper, needs `libc` as a direct dep) instead of a bare uncatchable `kill()` — this lets the server run its own cleanup (including the child registry) instead of being hard-killed before it can reap anything.

**Verification:** `tests/unit/lifecycle.test.ts` (8/8, including a REAL-process integration test — spawns an actual child, SIGKILLs the parent, asserts the watchdog fires in ~2s); reaped the 11 live orphans found on the investigating machine (preserved the running app's own server + an unrelated manually-started dashboard). `cargo check` / `tsc --noEmit` clean.

**Load-bearing takeaway for any future desktop process-lifecycle work:** don't trust the Rust exit-event handler alone to be the single point of cleanup — Tauri's `RunEvent` variants don't cover every OS-level way a process tree can be torn down. A server-side watchdog that verifies its OWN parent is alive is the only mechanism that's correct regardless of how the parent died.

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

## Interactive federation board (v0.8.3, modeless redesign 2026-07-05)

### Purpose and location

A `react-force-graph-2d` canvas (`dashboard/src/components/federation/FederationBoard.tsx`, CSS:
`FederationBoard.css`) — a reusable widget with two variants: `<FederationBoard variant="full" />` 
(Launcher window) and `variant="embedded"` (Settings → Connections). Lives in the Launcher because
federation is a cross-project concern. Per-project Settings retains the text-form
`ConnectionsManager` for users who prefer a list.

### Modeless direct-manipulation model (2026-07-05 redesign)

**One interaction model, no mode toggle.** The old Connect/View switch is gone. Everything is direct:
- **Drag from one card onto another** to wire a read — animated dashed preview + drop-target highlight, success/warn feedback notes.
- **Click a card** to inspect it (detail panel with Connect-to… arming click-to-connect, Readable toggle, version/update controls).
- **Click a wire** to edit it (in-place popover showing both directions with per-direction Remove + one-click "Make Readable" for inert wires).
- **Drag empty canvas** to pan, wheel/buttons to zoom — card press is claimed at capture phase so the library only sees empty-canvas presses.

**Feedback is designed, not silent.** Wiring shows a success banner ("A now reads B — live") or warning banner with inline action ("Turn on Readable") when target isn't shareable. Hovering a card rings it violet, hovering a wire thickens it. Auto-fit viewport happens only on first layout (not after every mutation) to keep the viewport stable.

**Clarity extras:** always-visible on-canvas legend (wire meanings + card statuses), designed empty state, rewritten 3-step "How it works" guide, ~50 i18n keys added (`federation.map.*`).

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

### Wire creation and removal

Dragging from card A onto card B calls `POST /api/launcher/connection { from: A.name, to: B.name }`. This stores an
`out` edge on A's side only. Two separate drags (A→B then B→A) create two
independent `out` edges — the graph renders them as a two-way arrow. There is no
`both` shortcut: two-way federation requires two explicit drags.

`POST /api/launcher/connection/remove { from, to }` removes the edge (via in-place wire popover).
`POST /api/launcher/shareable { vault, shareable }` toggles the shareable flag
directly from the card detail panel or wire popover "Make Readable" action.

### Layout tuning (2026-07-05 fix)

With no wires between cards, strong repulsion pushed unlinked cards to corners (specks). Fixed:
- Softened charge repulsion (`-350`), added gentle center pull (`forceX/forceY`), collision radius sized to card footprint (`forceCollide(85)`).
- Auto-fit zoom clamped `[0.9, 1.4]` — never zooms below 0.9, so cards stay readable even when sparse.

### Load-bearing technical gotchas (2026-07-05)

1. **d3-zoom pans on `mousedown`, not `pointerdown`** — a custom card-drag gesture must cancel the compatibility mouse event (`preventDefault` on pointerdown + swallow mousedown at capture), else the library pans through the wire gesture.
2. **d3-force-3d ships untyped** — minimal `.d.ts` added at `dashboard/src/types/d3-force-3d.d.ts` (any-typed node callbacks to stay compatible with BrainCanvas3D/BrainPage).

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

## In-app Agent Terminal (2026-06-28, latest readability polish 2026-07-01)

A full interactive Claude Code terminal embedded in the Sleepy page of the dashboard. Desktop-only; never ships in the npm package.

### Architecture

```
GET /api/agent/capabilities  →  { desktop, embeddedTerminal, openTerminal, nodePty, claudeCli, npm }
  (DREAMCONTEXT_DESKTOP gate; nodePty/claudeCli/npm probed via $SHELL -ilc for PATH parity with PTY)

POST /api/agent/install { target: 'claude'|'pty' }  →  { ok, runId }
GET  /api/agent/install/status?id=<runId>           →  { state, output }

WS /api/agent/terminal?vault=<name>&bypass=<bool>
  ← loopback-only (strict remoteAddress check)
  → node-pty: $SHELL -ilc 'exec claude [--dangerously-skip-permissions]'
       cwd = vault project root
  ← agentSession.ts createSession() (xterm.js DOM renderer + @xterm/addon-fit)
```

### Key decisions

**Session persistence (display:none hoist):** `App.tsx` uses `switch (nav.page)` returning one mounted page, so navigating away unmounts `SleepyPage` → kills `AgentTerminal` → closes WebSocket + PTY. Fix: `AgentTerminal` is instantiated ABOVE the `switch` as a single long-lived owner, toggled via `display:none` (never unmounted) when Sleepy is not active. The xterm DOM node is re-shown and re-fit (`fitAddon.fit()`) on reveal. Tear-down only on explicit Close/Restart or app quit.

**DOM renderer + real mono font (updated 2026-07-01 — supersedes the original WebGL design):** `@xterm/addon-webgl` was REMOVED. It gave GPU-composited, crisp-at-any-DPR text, but the atlas's rasterisation produced hard "sharp" glyph edges users found eye-tiring over long sessions. The DOM renderer's real text nodes pick up native macOS anti-aliasing instead — `.xterm { -webkit-font-smoothing: auto; -moz-osx-font-smoothing: auto; text-rendering: optimizeLegibility }` overrides the app-wide CSS reset's forced `-webkit-font-smoothing: antialiased` (the thinnest grayscale AA), which was otherwise thinning the DOM-rendered glyphs. Separately, the originally-intended **Sometype Mono font was never actually loaded** — no `@font-face`/Google-Fonts link ever pulled it in, so `--font-mono`'s first-listed family silently fell through to JetBrains Mono @400 with a faux-synthesized bold the whole time. Fix: `index.html` now loads JetBrains Mono weights 400/500/700 from Google Fonts, `--font-mono` lists JetBrains Mono FIRST (the actually-loaded family), and the font-load-before-open gate reads the primary family off `--font-mono` dynamically (`fontFamily.split(',')[0]`) instead of a hardcoded font name — so `FontFaceSet.load()` awaits the REAL webfont (both regular + `fontWeightBold: '700'`) before `term.open()` measures cell width. The DOM renderer needs no separate glyph-atlas-attach step.

**bypassPermissions (default OFF):** The terminal runs real `claude` with full file-write capability. The bypass flag is opt-in; when armed, a standing orange warning chip is shown and the WS query param `bypass=true` passes `--dangerously-skip-permissions` to the claude spawn. Read-only Chat (Phase 3, `--permission-mode plan`) is always available and unaffected.

**Readability fix — per-theme ANSI ramp, then calmed to minimumContrastRatio 3 (2026-07-01):** `readXtermTheme()` originally mapped the 16 ANSI slots straight to design tokens, which inverted luminance in light mode (ANSI black→light background colour, ANSI white→dark foreground colour) and made dim grays too light in dark mode. Combined with `minimumContrastRatio: 1` (contrast net deliberately OFF "to keep the palette exact"), Claude's TUI blocks that pair a default foreground with an ANSI 7/8 background fill collapsed to same-luminance-on-same-luminance → unreadable in both themes. First fix (2026-06-29): `minimumContrastRatio: 4.5` (xterm auto-lifts any too-low-contrast foreground) + the conventional per-theme grayscale ANSI ramp (slot 0=darkest…slot 15=lightest). **Follow-up (2026-07-01):** 4.5 flattened hierarchy — it force-brightened dim/secondary text along with the raw near-white default foreground (`#f5f6fa` on `#14171f`, ~17:1), which read as harsh over long sessions. Fix: softened the default foreground to a calmer off-white (`#cdd3de` dark / `#33383f` light) instead of the raw `--color-text` token, and lowered `minimumContrastRatio` to `3` — still high enough to rescue the ANSI-on-ANSI block-fill case, low enough that dim/secondary text stays visibly dim. Lesson: in an embedded TUI, readability > exact brand-colour fidelity, but the contrast floor is itself a hierarchy control — tune it, don't max it.

**Readability polish — clipboard, selection, pane dimming (2026-07-01, task `agent-terminal-rendering-readability-polish`):**
- **WKWebView mangles UTF-8 on clipboard write.** `navigator.clipboard.writeText()` in this WKWebView re-decodes UTF-8 bytes as Mac Roman (ç→"√ß", ğ→"ƒü", —→"‚Äî"). Fix: `copyPreservingUnicode()` copies via a hidden `<textarea>` + `document.execCommand('copy')` (routes through the OS's native text-copy pipeline, round-trips UTF-8 correctly); `navigator.clipboard` is kept only as a last-resort fallback. `⌘C`/`⌘X` call this and `preventDefault()` so WKWebView never rings the macOS system beep on an otherwise-unhandled ⌘-key (the terminal is read-only, so `⌘X` just copies, same as `⌘C`); `⌘A` selects all and is swallowed the same way. `⌘V` is deliberately left untouched so xterm's native bracketed paste stays intact (else a multi-line paste would auto-submit each line).
- **`selectionInactiveBackground` fires whenever the terminal isn't the focused element** — a much fainter xterm default than `selectionBackground`, and the actual value rendered while unfocused (e.g. right after clicking elsewhere). It was invisible on a white light-mode background. Fix: pin BOTH `selectionBackground` and `selectionInactiveBackground` to a solid `#6a57d6` with white `selectionForeground` — visible in light and dark, focused or not.
- **Inactive split-pane dimming removed.** The non-active pane previously got `opacity: 0.82` + a `--color-bg` overlay to signal focus; users read this as "blurring out" a pane they were still reading. Both panes now stay fully legible; only the active pane's accent ring + top bar mark focus.
- Comfort defaults also tuned: font size 13.5→14.5, line-height 1.4→1.65.

**In-app prerequisite installer:** `GET /api/agent/capabilities` now reports `claudeCli`, `nodePty`, and `npm`, each probed via `$SHELL -ilc` matching the PTY spawn's PATH (`claude` commonly lives in `~/.local/bin` sourced only by `~/.zshrc`; a non-interactive `-lc` shell won't source it). `POST /api/agent/install { target: 'claude'|'pty' }` + `GET /api/agent/install/status?id=` mirror the Sleepy capture-run pattern: in-memory `installRuns` Map, 10-min TTL prune, 5-min watchdog, login-shell spawn. Targets: `claude` → `npm install -g @anthropic-ai/claude-code`; `pty` → `npm install node-pty@^1.1.0 --no-save` into the CLI's own package root (nearest ancestor `package.json` walking up from `process.argv[1]`, so node-pty resolves from the bundled dist exactly as `import('node-pty')` does), then `ensurePtyHelperExecutable()` (`chmod +x` all prebuilt spawn-helpers) and bust the memoized `ptyAvailable` cache so the next capabilities check reports ready without a relaunch. `AgentSurface.tsx` `Prereqs` component lists missing prerequisites with one-click Install + live log tail + auto re-check; Start-agent gated on BOTH `embeddedTerminal` AND `claudeCli`. Routes in `src/server/routes/agent-terminal.ts`, registered in `src/server/index.ts` and added to `VAULT_AGNOSTIC_PREFIXES`. Desktop-gated, loopback-only, closed target whitelist (bad target → 400).

**Drag-to-split (WKWebView DnD — CRITICAL for all future WKWebView drag-and-drop):** In WKWebView (Tauri webview), the HTML5 `drop` event is **NOT delivered** to drop targets that are mounted mid-drag (e.g., split drop-zones that are conditionally rendered only while a drag is active). `dragover` fires on those targets normally — the hover highlight works — but `drop` never fires. WKWebView also **strips custom-MIME `getData()` on `drop`**: the MIME type IS listed in `dataTransfer.types` during `dragover` but `getData()` returns an empty string on `drop`. Standard `text/plain` on always-mounted targets (as used by the Kanban/Eisenhower boards) is unaffected by either restriction. **Fix pattern:** (1) carry the dragged session id in a React **ref** set on `dragstart`; (2) gate `preventDefault()` via `dataTransfer.types.includes(...)` on `dragover` (not React state, which is not settled on the first hover tick); (3) record the currently-hovered target on every `dragover`; (4) **execute the split/combine/reorder on the source tab's `dragend`** — which fires reliably on the always-present source element — **NEVER on `drop`**. `⌘D` and the `⊟` button also split (keyboard/click path unaffected by WKWebView restrictions).

### Multi-session pane redesign (2026-06-30, feat/sleepy-agent-surface-ux-redesign)

The agent surface was redesigned: the Sleepy page (`SleepyPage.tsx`, `SleepyPage.css`) is **deleted**; the embedded terminal is now a global bottom-right FAB (`AgentFab.tsx`) that expands to a fullscreen overlay (`AgentSurface.tsx`) accessible from any page. Sessions persist across collapse/expand/navigation (the existing `display:none` hoist above `App.tsx` page switch remains the mechanism). Key new behaviours:

**Per-pane tab bars:** Each pane renders its own tab strip at z-index 7 (above the split drop overlay at z-index 6), so it is unambiguous which tab controls which pane. The single shared header strip was removed.

**Active-pane accent ring + click-to-activate:** Clicking anywhere in a pane makes it active (blue accent ring). The overlay auto-collapses on page navigation via a `dreamcontext-navigate` custom window event (cross-tree signalling pattern — the same event the ⌘K palette uses to confirm a navigation completed).

**Per-tab actions:** Each tab carries minimize + close only. Restart was removed.

**Search relocated to ⌘K:** The in-app search/Ask modes were removed from the agent surface; a persistent top-bar pill + ⌘K command palette (see §"⌘K command palette") replaces them.

**New component files:**
- `dashboard/src/components/sleepy/AgentTabs.tsx` — per-pane tab bars
- `dashboard/src/components/sleepy/AgentFab.tsx` + `AgentFab.css` — global floating action button
- `dashboard/src/components/sleepy/SessionRail.tsx` — session rail
- `dashboard/src/components/sleepy/agentStatus.ts` — status computation
- `dashboard/src/components/search/CommandPalette.tsx` + `CommandPalette.css` — ⌘K palette
- `dashboard/src/hooks/useFocusTarget.ts` — focus-target wiring (recall→page open)
- `dashboard/src/lib/recallNav.ts` — navigate-and-open from recall hits
- `src/server/routes/agent-sessions.ts` — session listing/management
- `src/server/routes/agent-drop.ts` — file DnD drop endpoint (any file type since 2026-07-01, was image-only)

**Deleted:** `DockBubble.tsx`, `agentSlots.tsx`, `SleepyPage.tsx`, `SleepyPage.css`.

### Minimize-to-corner (AgentDock) — contain:layout paint gotcha

A session can be minimized out of the side-by-side panes into a live progress chip in a corner `AgentDock` that floats ABOVE the expanded overlay. Clicking the chip restores the session as a new pane without losing state.

**Critical gotcha (load-bearing):** The floating dock MUST be rendered as a **sibling** of `.agent-surface` in the DOM tree, NOT as a child. Two independent reasons:

1. `.agent-surface` has `contain: layout paint`. This creates a new **containing block** for `position: fixed` descendants — so a child `AgentDock` with `position: fixed` is anchored to the surface element, not the viewport.
2. A `.agent-surface > *` CSS rule forces `width: 100%` on every direct child — a child dock is stretched to full surface width regardless of its own sizing.

Fix: render `<AgentDock />` as a sibling in `App.tsx` with a modifier class setting `z-index: 25` (above the overlay's `z-index: 20`). File: `dashboard/src/components/sleepy/AgentDock.tsx`.

### Auto-resume reliability

`claude --resume <uuid>` throws "No conversation found" when a tab was created but the user never sent a message — Claude only writes the JSONL transcript file after the first turn completes.

**Fix:** Before spawning, the server checks whether the transcript file exists:
- **Exists** → `--resume <uuid>` (restores the prior conversation)
- **Absent** → `--session-id <uuid>` (starts fresh but pins the id, making the session resumable after the first turn is recorded)

**Transcript path format (confirmed empirically):**
`~/.claude/projects/<working-directory-with-/-replaced-by-->/<session-uuid>.jsonl`

### ⌘P "Go to Project" switcher + shared overlayStack (2026-07-04)

A second global overlay, `⌘P`, sits alongside `⌘K`: a fast tab-like project
switcher available in every window (Launcher or vault) with `⌘1`-`⌘9` quick-jumps
to the Nth open-able project. Full feature detail (user stories, ACs, files) lives
in `core/features/launcher-project-switcher.md` — this entry captures the reusable
architectural pattern it introduced:

- **`lib/overlayStack.ts`** — a shared LIFO stack (`pushOverlay(id)` /
  `popOverlay(id)` / `isTopOverlay(id)`) that both `CommandPalette` (⌘K) and
  `ProjectSwitcher` (⌘P) push/pop on open/close. A window-level capture-phase
  `Escape` listener closes only the topmost overlay. **This is now the standing
  pattern for any future in-app overlay** — adopt the same push/pop pair rather
  than hand-rolling Esc/focus logic per-component; it gets correct behavior for
  free regardless of what other overlay is open underneath it.
- **`isTerminalTarget(el)`** (`.xterm`, `.agent-surface`) — the pattern for
  "this hotkey must not fire while the embedded PTY has focus", since xterm
  actively forwards unhandled chords (like `⌘P`) into the running Claude Code
  session. Narrower than the existing `isEditableTarget` (which also excludes
  plain inputs/textareas/selects) — reuse whichever matches the actual risk.
- **`<VaultDot>`** (`components/layout/VaultDot.tsx`) — the canonical status-dot
  component (exists / needs-update / missing); both the Launcher vault list and
  the switcher consume it now instead of three inline copies.
- Status-poll gating: an always-mounted overlay component must gate its data
  fetch on its own `open` state (`useLauncherStatus(open)`), or it silently
  inherits the app-wide background refetch interval forever — the same gotcha
  `⌘K`'s `useRecall(open?…)` already solved; a code-review pass caught a real
  regression of this in the ⌘P build (comment claimed the gate existed; it didn't).

### One-click full-machine upgrade — relaunch escapes the app's own teardown (2026-07-04)

The header `UpdateBadge` runs `dreamcontext upgrade --yes` as a singleton
background job (`POST /api/launcher/upgrade`, polled via `/upgrade/status`) and,
on completion, offers to relaunch the app. Relaunching is the hard part: closing
the app's last window quits the whole process, which tears down the very Node
server handling the relaunch request. `POST /api/launcher/relaunch` solves this
the same way sibling desktop gotchas do — **detach a process that survives the
parent's death**: `spawn('/bin/sh', ['-c', 'sleep 2; open "$0"', appPath], {
detached: true, stdio: 'ignore' })` + `child.unref()` puts the relauncher in its
own process group, which escapes the parent-death watchdog / Rust
`RunEvent::ExitRequested` reap described above (§"orphaned-dashboard-server root
cause fix") instead of being caught by it. The frontend calls `/relaunch` FIRST,
then closes its own window — never the reverse. Full feature detail:
`core/features/web-dashboard.md` § One-Click Full-Machine Upgrade.

### ⌘K command palette (BM25 + Haiku intelligent toggle)

A unified search palette (⌘K, also reachable via a persistent top-bar "Search the brain" pill) backed by `/api/recall` (BM25). An optional "intelligent" Haiku model toggle sends the same query through a Claude-ranked recall path. Clicking a result navigates to its page AND opens the document in-app via:
- `recallNav.ts` — maps a recall hit's `type`+`slug` to the correct page + focus signal
- `useFocusTarget.ts` — a hook wired into each page component, consumed by the target page to open the correct document when it receives a focus signal
- `PageRouter → pages` — the two ends of the wiring chain

Cross-tree collapse uses the `dreamcontext-navigate` custom window event so the overlay folds away as the page transitions. Files: `dashboard/src/components/search/CommandPalette.tsx`, `CommandPalette.css`, `dashboard/src/hooks/useFocusTarget.ts`, `dashboard/src/lib/recallNav.ts`.

### Key files

- `src/server/routes/agent-terminal.ts` — `attachAgentTerminal(server)`: WS upgrade + node-pty spawn; `GET /api/agent/capabilities`; `POST /api/agent/install` / `GET /api/agent/install/status` (prereq installer); `POST /api/agent/open-terminal` (osascript fallback).
- `src/server/routes/agent-sessions.ts` — session listing and management (added 2026-06-30).
- `src/server/routes/agent-drop.ts` — any-file DnD drop endpoint (added 2026-06-30; opened to any file type + cursor-targeted pane routing 2026-07-01, was image-only + last-focused-pane).
- `src/server/index.ts` — `attachAgentTerminal(server)` wired at bottom; install + session routes in `VAULT_AGNOSTIC_PREFIXES`.
- `dashboard/src/components/sleepy/AgentSurface.tsx` — `Prereqs` component; multi-pane layout; drag-to-split via `dragend` pattern; cursor-targeted any-file drop routing (`onTermDrop` → `elementFromPoint` → `.agent-pane-slot[data-pane]`, 2026-07-01); `kind` (`'agent'|'shell'`) threaded through spawn/split/resume/hydration for basic-terminal mode, and the auto-title effect (2026-07-04, see feature PRD for detail).
- `dashboard/src/components/sleepy/agentSession.ts` — `createSession()`: xterm Terminal + DOM renderer + `@xterm/addon-fit` (WebGL removed 2026-07-01); `readXtermTheme()` (`minimumContrastRatio: 3`, softened foreground, solid selection); JetBrains-Mono-aware font-load-before-open; `copyPreservingUnicode()` + beep-free ⌘C/⌘X/⌘A key handler.
- `dashboard/src/components/sleepy/AgentTerminal.css` — stylesheet (filename retained); inactive-pane dimming removed, `.xterm` font-smoothing override (2026-07-01).
- `dashboard/src/components/sleepy/AgentDock.tsx` — minimize-to-corner dock chip; sibling of `.agent-surface` (see §"Minimize-to-corner" gotcha above).
- `dashboard/src/components/sleepy/AgentTabs.tsx` — per-pane tab bars.
- `dashboard/src/components/sleepy/AgentFab.tsx` + `AgentFab.css` — global floating action button.
- `dashboard/src/components/sleepy/SessionRail.tsx` — session rail.
- `dashboard/src/components/search/CommandPalette.tsx` + `CommandPalette.css` — ⌘K palette.
- `dashboard/src/hooks/useFocusTarget.ts` — focus-target wiring hook.
- `dashboard/src/lib/recallNav.ts` — navigation from recall hits.
- `dashboard/src/styles/tokens.css` — `--font-mono` primary is JetBrains Mono (the actually-loaded webfont; Sometype Mono was removed, was never loaded); `dashboard/index.html` loads JetBrains Mono 400/500/700 (2026-07-01).
- `App.tsx` — hosts the `<AgentSurface />` hoist (display:none) and sibling `<AgentDock />`; `<AgentFab />` wired to open the overlay.
- ~~`dashboard/src/pages/SleepyPage.tsx`~~ — **deleted** 2026-06-30 (agent surface is now FAB-driven from any page).

### Desktop dev workflow note

**Dashboard/CSS/React/server-route changes do NOT need a Tauri rebuild.** The app's Rust shell spawns the global CLI (`find_global_cli` → `$SHELL -ilc 'command -v dreamcontext'`, `-ilc` fix shipped v0.10.0) and serves this repo's `dist/` on a random loopback port. The fast loop:
1. `npm run build` (builds dashboard → dist/dashboard, then CLI → dist/index.js via tsup)
2. **⌘Q + reopen the desktop app** (new random port → new origin → empty WKWebView cache → serves the freshly built dist)

Do NOT use `⌘R` (refresh): WKWebView's document cache retains the OLD bundle at the same loopback port. A new launch picks a new port, bypassing the cache entirely.

**Only Rust/lib.rs changes require** a full `tauri build` + `dreamcontext app install` (rebuilds the native Rust binary). Examples: changes to `NSPanel` behaviour, `find_global_cli`, `apply_sleepy_enabled`, new Tauri commands.

**Last verified: 2026-06-29 (v0.10.0).** Version rename/delete dashboard feature was built (JS-only change), built via `npm run build`, and tested by ⌘Q + reopen — no Tauri rebuild required and the new routes were live immediately. The `-ilc` fix was baked in simultaneously via `tauri build` + `dreamcontext app install` as part of the v0.10.0 release.

**Dev-machine empirical note (corrected 2026-06-29):** At the start of this session the dev machine's global CLI was a **separate installed copy** (`<nvm>/lib/node_modules/dreamcontext` — a real directory, not a symlink), NOT `npm link`-ed to the repo. `npm link` was re-run in this session to restore the linked-repo dev setup. **npm-linked dev footgun:** even when the global IS npm-linked to the repo, the embedded terminal silently downgrades to "Open in Terminal" unless (a) `node-pty` is installed in the repo's `node_modules` (it is an optional dep — a plain `npm install` can skip it) AND (b) its prebuilt spawn-helper has `+x` (the tarball ships `-rw-r--r--` → `posix_spawnp failed` at runtime). `ensurePtyHelperExecutable()` restores `+x` at runtime; the in-app installer's `pty` target handles the missing-module case from the UI. The stale-dist symptom (app serving an older dist) is a separate concern — manifests on user machines with a separately installed, stale global CLI.

Feature PRD: `_dream_context/core/features/in-app-agent-terminal.md`.

## Status / deferred

Working local beta. NOT Apple-signed/notarized (local install only; Gatekeeper
needs a right-click-open or the quarantine clear above). Pages reskin,
federation→nav promotion, Overview, and accessibility/quick-capture are still
deferred (see the unified-dashboard plan).

**Follow-up cleared this cycle:** the dead Rust `open_vault` command and `Port` state
were REMOVED from `lib.rs` (`cargo check` clean). That cleanup is no longer pending.
