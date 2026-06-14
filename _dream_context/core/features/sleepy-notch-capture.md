---
id: feat_UF2kRQGT
status: in_review
created: '2026-06-14'
updated: '2026-06-14'
released_version: null
tags:
  - frontend
  - backend
  - domain
related_tasks:
  - sleepy-notch-capture
---

## Why

Developers lose quick thoughts, commands, and notes between coding sessions. The terminal is too slow; a native notch-companion that appears on a global hotkey — anywhere, instantly — closes that gap. The Sleepy mascot doubles as a mood indicator (sleep debt) so the user always knows how stale their project context is.

## User Stories

- [x] As a user, I want to summon a capture bar with a global hotkey from any app so that I can record a thought without switching to a terminal.
- [x] As a user, I want the mascot's mood to reflect the selected project's sleep debt so that I know when consolidation is needed at a glance.
- [x] As a user, I want my capture to be saved instantly (guaranteed) to the project's memory so that I never lose a note even if the AI enrichment step fails.
- [x] As a user, I want the capture to be enriched by a headless Claude run so that it integrates with the project's existing context rather than just being raw text.
- [x] As a user, I want to see live status while Claude is learning from my capture so that I know it is working and can read the response when done.
- [x] As a user, I want the dropdown to only show vaults with existing folders so that I cannot accidentally capture into a deleted project.
- [x] As a user, I want to select which project receives the capture from a dropdown so that captures go to the right vault.
- [x] As a user, I want to configure the hotkey and toggle the feature on/off from Settings so that I have control without editing config files.
- [ ] As a user, I want the visual design of the notch bar to feel polished and native so that it is a pleasant, non-jarring part of my workflow. (Visual design currently iterating — not yet user-accepted.)

- [x] As a user, I want to ask a one-shot question about a project from the notch (Ask mode) and get Claude's answer without anything being saved to memory.

- [x] As a user, I want to trigger a full dreamcontext consolidation from the notch (Sleep mode) and see the result inline so that I do not need a terminal.

- [x] As a user, I want Claude's answers rendered as formatted Markdown so that code, lists, and headings are readable in the small panel.

## Acceptance Criteria

- [x] Global hotkey registered via `tauri-plugin-global-shortcut`; configured in Settings (default `Alt+Cmd+S`, toggleable off).
- [x] Hotkey ownership lives in the persistent launcher window; re-registered on cross-window `storage` event when the hotkey changes from a vault Settings page.
- [x] Pressing the hotkey toggles a transparent, always-on-top, decorations-free window at top-center y=0 (black panel merges with macOS notch).
- [x] Window loads `?capture=1` route (absolute same-origin URL, not a relative Tauri URL).
- [x] `macOSPrivateApi` enabled in `tauri.conf.json`; capability grants `global-shortcut:allow-register`, `global-shortcut:allow-unregister-all`, `core:window:allow-create`, `core:webview:allow-create-webview-window`.
- [x] CaptureBar mounts in `?capture=1` mode with transparent page background; Esc closes the window via `closeSelf()`.
- [x] Mascot is an animated WebP (`<img>`) driven by `GET /api/sleepy/anim?mode=idle|sleepy|sleeps`; mood from `GET /api/sleep` debt (debt<8 → idle, 8-9 → sleepy, ≥10 → sleeps). Legacy video route kept but unused.
- [x] Mascot panel is 360×150 px (same width as capture bar below), clip fills edge-to-edge with `object-fit:cover` — no black gutters.
- [x] Textarea auto-grows up to ~5 lines; Enter submits, Shift+Enter inserts newline.
- [x] `POST /api/launcher/capture` (Learn mode): (1) instant in-process CHANGELOG append via `insertToJsonArray`; (2) starts tracked `claude --model sonnet` run with Think hard prompt, returns `{ok, captureId}`. Ask/Sleep modes skip the CHANGELOG write.
- [x] `GET /api/launcher/capture/status?id=` returns `{state: running|done|error|unknown, output}`; capture bar polls at 1.2s (3-min ceiling for Learn/Ask, ~15-min for Sleep; unknown-streak guard) and shows mode-appropriate spinner then response in a scrollable panel.
- [x] Window grabs key focus on open (`win.setFocus()`); dismisses on blur (Spotlight-style, armed after first focus, paused while native vault picker is open); Esc still closes.
- [x] `GET /api/vaults` returns `exists` flag per vault; capture picker filters out vaults whose folder is gone.
- [x] Capture bar surfaces the server's real error message when a capture fails (not a bare "failed").
- [x] Config persists server-side at `~/.dreamcontext/sleepy.json` (survives per-launch port/localStorage reset); launcher seeds localStorage from server on mount.
- [x] Mascot animated WebP clips (15fps, ~2.5 MB each, 3 clips) + `.mp4` sources bundled as Tauri resources (`desktop/src-tauri/sleepy → Resources/sleepy`); served by `GET /api/sleepy/anim?mode=`; `DREAMCONTEXT_SLEEPY_DIR` env var injected by Rust shell.
- [x] Assets do NOT ship in the npm CLI package.
- [x] Settings "Sleepy" section moved to the bottom (after Connections) with a BETA badge.
- [ ] Visual design accepted by user. (Mascot layout and notch panel improved this cycle — still not formally accepted.)

## Constraints & Decisions

- **[2026-06-14]** Ask mode has no side effects -- no CHANGELOG write, no file changes. One-shot Q&A only. Sleep mode triggers real consolidation -- full dreamcontext sleep flow, takes minutes, uses tokens, modifies _dream_context files.
- **[2026-06-14]** Claude runs on Sonnet + medium thinking -- enrichment, Ask, and Sleep spawns use claude --model sonnet; prompts lead with 'Think hard' (Claude Code's medium-thinking keyword).
- **[2026-06-14]** Enrichment uses interactive login shell (-ilc) -- claude is commonly added to PATH in ~/.zshrc (e.g. ~/.local/bin) which a non-interactive login shell (-lc) does NOT source. Stdout and stderr captured separately so rc-file chatter never pollutes Claude's reply.
- **[2026-06-14]** Mascot sleepy mood threshold is debt >= 8 (was >= 4). Idle covers debt 0-7; sleepy 8-9; sleeps >= 10.
- **[2026-06-14]** Mascot uses animated WebP, not video -- WKWebView hard-blocks video autoplay and Tauri 2.11/wry exposes no webview autoplay setting. img with animated WebP autoplays unconditionally. Assets: idle.webp, sleepy.webp, sleeps.webp at 15fps alongside source .mp4 clips in desktop/src-tauri/sleepy/.
- **Bare Fn key hotkeys NOT supported** — requires a native event tap not available through Tauri's shortcut plugin. Combo keys only (modifier + key).
- **No alpha channel on mascot videos** — H.264, sRGB, black background. The black panel merges with the notch; `object-fit: cover` fills the panel edge-to-edge (full-bleed), cropping 16:9 letterbox top/bottom.
- **Config persisted server-side** — the app's per-launch loopback port resets localStorage on every launch (new origin). So `~/.dreamcontext/sleepy.json` is the source of truth; localStorage is a per-launch cache seeded from it.
- **Guaranteed capture is in-process, not a child CLI** — in a packaged desktop app, the globally-resolvable `dreamcontext` CLI can be stale (Homebrew vs nvm) or absent (login-shell PATH not injected from Finder). Spawning a child `memory remember` surfaced as "failed" captures. The server IS dreamcontext, so the CHANGELOG write now uses `insertToJsonArray` directly — same code path, zero child-process failure class.
- **Claude enrichment spawn hardened** — the `claude` child gets an `'error'` listener so an unhandled spawn rejection cannot crash the server; spawn failures are swallowed silently (the note is already saved in-process).
- **Tracked enrichment runs (ephemeral)** — captureRuns Map, keyed by UUID, holds running/done/error state + piped stdout/stderr (tail-capped at 8 KB). TTL 10 min after end, size cap 50 entries, pruned on each new capture POST.
- **Esc dismiss activates the app on macOS** — fully suppressing activation on Esc requires a native non-activating `NSPanel`, which Tauri does not expose. The blur/click-away dismiss path is clean; Esc is a documented partial.
- **Claude injection via login-shell `$0`** — the note text is passed as the positional `$0` argument to a `exec claude -p "$0"` login shell, so the user's `~/.zshrc` PATH (nvm, brew) resolves `claude`; no shell string interpolation → no injection.
- **Desktop-only feature** — no npm package ships; reaches users only via a desktop release.

## Technical Details

**Rust shell (`desktop/src-tauri/src/lib.rs`):** adds `tauri-plugin-global-shortcut` plugin; sets `DREAMCONTEXT_SLEEPY_DIR` env to `<resource_dir>/sleepy` (where bundled `.webp` and `.mp4` clips live).

**Capability (`desktop/src-tauri/capabilities/default.json`):** `global-shortcut:allow-register`, `global-shortcut:allow-unregister-all`, core window/webview permissions — scoped to the `http://127.0.0.1:*` loopback origin.

**`sleepy.ts` (`dashboard/src/lib/sleepy.ts`):** config (read/write localStorage + server), `applySleepyHotkey(cfg)` (unregister all → register new), `toggleSleepyWindow()` (open/close `WebviewWindow` label `sleepy`), `closeSelf()` (closes the current webview window from inside), `onSleepyFocusChange(cb)` (subscribes to `onFocusChanged` on the current webview; returns unsubscribe fn). Window size: 420×520 px (was 340, grown to fit response panel), y=0, decorations=false, transparent=true, alwaysOnTop=true. `win.setFocus()` called after `tauri://created` so the panel is the key window immediately on open.

**`CaptureBar.tsx/.css`:** mounts when `?capture=1`; sets `html`/`body` background to transparent. Notch panel: **360×150 px** (was 200×92), flat top, rounded bottom, solid `#000`. Mascot: `<img className="cap-char" src="/api/sleepy/anim?mode=<displayMode>">` — animated WebP fills panel edge-to-edge. Mode toggle: Learn | Ask | Sleep segmented switch; toggle and input locked during sleep. `sleeping` = `capMode === 'sleep' && enrich?.state === 'running'`; `sleepingRef` guards close-on-blur. Enrich panel renders via `marked` (GFM) + `DOMPurify`; errors plain text. `.cap-md` CSS: explicit bullets (overrides global `reset.css` `list-style:none`), collapsed loose-list `<p>` margins, dim headings, violet links, monospace code.

**`App.tsx`:** launcher window effect reads config from server (`initSleepyFromServer`), registers hotkey, re-registers on `storage` event keyed to `SLEEPY_CONFIG_KEY`. `?capture=1` → renders only `<CaptureBar />`.

**Backend routes (`src/server/routes/launcher.ts`):**
- `GET /api/launcher/sleepy-config` / `POST /api/launcher/sleepy-config` — reads/writes `~/.dreamcontext/sleepy.json`.
- `GET /api/sleepy/video?mode=` — streams bundled `.mp4` clip with Range support (legacy; kept but unused by capture bar).
- `GET /api/sleepy/anim?mode=` — serves animated WebP as `image/webp`, whole-file, 24h cache. 404 when `DREAMCONTEXT_SLEEPY_DIR` absent.
- `POST /api/launcher/capture` — body: `{vault, text, mode}`. Learn: in-process CHANGELOG write then `$SHELL -ilc 'exec claude --model sonnet -p "$0"' <prompt>`. Ask/Sleep: skip write. Returns `{ok, captureId}`.
- `GET /api/launcher/capture/status?id=` — returns `{state: running|done|error|unknown, output}` from `captureRuns` Map; `unknown` means the id expired or never existed.

**`src/server/routes/vaults.ts`:** `GET /api/vaults` now maps each vault through `existsSync(resolve(v.path))` and adds an `exists: boolean` field; the capture bar filters to `exists=true` vaults only.

**Assets:** `desktop/src-tauri/sleepy/{idle,sleepy,sleeps}.webp` (animated WebP, 15fps, ~2.5 MB each) + `.mp4` source clips. Generated with `img2webp` (libwebp) from ffmpeg-extracted frames (fps=15, scale=420px, q=72, loop=0). Bundled via `tauri.conf.json` `"sleepy": "sleepy"` resources entry. Nothing ships to npm.

**Mood thresholds:** `modeForDebt(debt)` — `idle` (debt < 8), `sleepy` (8–9), `sleeps` (>= 10).

## Notes

- Visual design is the main open item: the notch panel improved significantly this cycle (edge-to-edge mascot, cohesive width with capture bar), but the user has not formally accepted the look yet. Next focus: tighter notch-companion aesthetics.
- Esc-dismissing still activates the dreamcontext main window on macOS because the capture window must first activate the app. Fully suppressing this requires a native non-activating `NSPanel` — deferred. The blur/click-away path (the common case) dismisses cleanly without surfacing the main window.
- Bare Fn hotkeys (e.g. F12 alone) cannot be registered via `tauri-plugin-global-shortcut`; requires a native `CGEventTap` — deferred.
- Future: Windows/Linux global hotkey would need a different approach (no macOS notch equivalent).
- The `?capture=1` routing means the capture bar is also accessible in a plain browser build (no Tauri), though the hotkey and transparent window features won't function.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-14 - Update
- 2026-06-14 - Animated WebP mascot; Learn/Ask/Sleep toggle; Sonnet+thinking; Markdown rendering; list fix; claude PATH fix; debt threshold raised to 8. Mascot switched from video to animated WebP img via new GET /api/sleepy/anim?mode= route. Three-mode toggle: Learn (save+enrich), Ask (one-shot Q&A, no memory write), Sleep (full consolidation, input locked). Enrichment uses claude --model sonnet with Think hard prompt. Ask answers rendered via marked+DOMPurify. List rendering fix: .cap-md sets explicit bullets over global reset. Spawn changed from -lc to -ilc for Finder-app PATH. Stdout/stderr captured separately. Poll ceiling widened to ~15 min for Sleep mode. sleepingRef guards close-on-blur during consolidation.
### 2026-06-14 - Capture pipeline hardened; enrichment status UI; layout + UX polish
- Capture guaranteed write changed from child `memory remember` CLI to in-process `insertToJsonArray` — eliminates whole class of packaged-app CLI resolution failures.
- `claude` enrichment spawn hardened with `'error'` listener to prevent unhandled rejection crashing the server.
- Tracked enrichment runs: `POST /api/launcher/capture` now starts a tracked claude run (stdout/stderr piped, captureRuns Map, TTL 10min, cap 50), returns `{ok, captureId}`.
- New route `GET /api/launcher/capture/status?id=` exposes run state + output; capture bar polls at 1.2s with 3-min/unknown-streak ceiling.
- Capture bar shows spinner "Sleepy is learning…" then Claude's response in a scrollable panel.
- Mascot panel widened 200×92 → 360×150 (matches capture bar width); clip fills edge-to-edge with `object-fit:cover`.
- Window height 340→520 px to accommodate response panel.
- Window grabs key focus on open (`setFocus`); close-on-blur armed after first focus, paused while vault picker is open.
- `GET /api/vaults` returns `exists` flag per vault; capture picker filters out deleted vaults.
- Capture bar surfaces real error from server instead of bare "failed".
- Settings: Sleepy section moved to bottom (after Connections) + BETA badge.
- Mascot clips renamed to Sleepy IDLE/SLEEPY/SLEEPS (replacing Dreamy clips).

### 2026-06-14 - Initial implementation shipped (desktop-only, visual design iterating)
- Full feature built and live-verified: hotkey, notch window, mascot with mood modes, capture pipeline, persistence, bundled assets.
- Visual design not yet accepted by user — marked as iterating.

### 2026-06-14 - Created
- Feature PRD created.
