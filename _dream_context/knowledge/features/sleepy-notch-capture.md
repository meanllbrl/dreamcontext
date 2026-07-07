---
id: feat_UF2kRQGT
status: in_review
created: '2026-06-14'
updated: '2026-07-06T19:30:00.000Z'
released_version: v0.8.7
tags:
  - frontend
  - backend
  - domain
related_tasks:
  - sleepy-notch-capture
  - sleepy-notch-panel-redesign
type: feature
name: sleepy-notch-capture
description: ''
pinned: false
date: '2026-06-14'
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
- [x] As a user, I want the visual design of the notch bar to feel polished and native so that it is a pleasant, non-jarring part of my workflow. (NSPanel redesign shipped; in_review for final acceptance.)

- [x] As a user, I want to ask a one-shot question about a project from the notch (Ask mode) and get Claude's answer without anything being saved to memory.

- [x] As a user, I want Sleepy to summon from any app without dreamcontext gaining focus, so that my workflow is not interrupted.
- [x] As a user, I want Sleepy to open via a hover over the MacBook notch (in addition to the hotkey) so I can access it without memorizing a key combination.
- [x] As a user, I want Sleepy to be disabled by default (opt-in via Settings) so that it never surprises me on first launch.
- [x] As a user, I want the mascot to be a coded animated character (not a video/WebP file) so that it renders crisply at any size and mood transitions are instant.

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
- [x] Visual design in_review: NSPanel non-activating notch-native redesign shipped; pending final user sign-off.

### Notch Panel Redesign (2026-06-28)
- [x] Sleepy runs as a non-activating `NSPanel` via `tauri-nspanel` v2: floats over the focused app, receives keystrokes, without activating dreamcontext — verified opening over TextEdit while TextEdit stayed active.
- [x] Global hotkey reliably fires from any app: JS registers the OS-wide shortcut (`sleepy:toggle`), Rust owns the panel. Stored `Cmd+H` combo (reserved key) auto-falls-back to `Alt+Cmd+S`.
- [x] Hover-to-open: Rust CoreGraphics cursor poll triggers panel show when cursor enters the notch area; auto-closes on leave unless the user has engaged (committed); no key-steal required.
- [x] Open-from-notch animation: cap-drop `clip-path` reveal replayed on each `sleepy:shown` event.
- [x] Notch-emergence CSS: pure `#000` neck+body+concave shoulders so the panel reads as the MacBook notch growing a tongue.
- [x] `SleepyMascot.tsx/.css` — coded animated mascot (violet dream-gem, blinks/breathes/Zzz) replaces the WebP animated clips; mood driven by sleep debt (`idle`/`sleepy`/`sleeps`).
- [x] `PanelEnabled` atomic state in Rust (default `false` — opt-in): `sleepy:enabled` event from launcher JS mirrors the persisted enabled flag; `apply_sleepy_enabled` shows/hides the perch accordingly. Disabling closes the notch entirely (not just the hotkey).
- [x] `build_perch_panel` builds hidden; `show_perch` and hover-to-open watcher are both gated on `is_enabled`.

## Constraints & Decisions

- **[2026-07-06]** **Never type into a spawned TUI's readline after a timing guess — pass the message positionally at spawn.** The original Sleep-agent auto-submit (2026-07-04) used client-side readline injection triggered by a busy→idle edge, guessing when Claude Code's prompt was ready. When an MCP server auth pause delayed the boot, the send fired before the readline was mounted, dropping the consolidation message and leaving the agent stalled on an empty prompt. The fix: pass the prompt to `claude` as a positional CLI arg (`claude … "$0"`) at spawn — the TUI starts with the message already submitted, eliminating the race. Client-side readline injection survives only for the "write-but-don't-send" composer skill-add case (where the user finishes the prompt). This constraint is load-bearing for any future auto-submit feature — a spawned interactive TUI's readline timing is never reliably detectable from outside.
- **[2026-06-28]** **Non-activating NSPanel via `tauri-nspanel` v2.** The original `WebviewWindow` (decorations-free, always-on-top) activates dreamcontext when summoned from another app — the MacBook notch companion pattern requires the capture panel to steal keystrokes without stealing app focus. `tauri-nspanel` wraps `NSPanel` with `.isFloatingPanel = true` and `.becomesKeyOnlyIfNeeded = true`, giving non-activating floating panel behaviour not exposed by the Tauri window API.
- **[2026-06-28]** **Hover-to-open via Rust CoreGraphics cursor poll.** Registering a `CGEventTap` for cursor movement from JS/Tauri would require elevated permissions. The Rust shell polls cursor position against the static notch rect (hard-coded at top-center for MacBook) on a background thread; the notch rect is device-specific but safe to hard-code for the target hardware family. Auto-closes on cursor leave unless `sleepy:committed` is set (user is typing).
- **[2026-06-28]** **PanelEnabled state: opt-in, default false.** Showing the Sleepy perch on first launch would confuse users who haven't set it up. `PanelEnabled` is an atomic Rust state (default false); the launcher JS mirrors it from the persisted `~/.dreamcontext/sleepy.json` `enabled` flag on mount and on `storage` events. This means the notch is visually absent until the user enables it in Settings — consistent with the existing hotkey-toggle model.
- **[2026-06-28]** **Coded mascot replaces animated WebP.** The WebP clips are large (~2.5 MB each) and mood transitions require swapping the `src` attribute (flicker). `SleepyMascot.tsx` is a pure CSS animation (blink keyframe, breath scale, Zzz float) with instant mood-class switching and zero asset bundle cost. Trade-off: less photorealistic than the WebP clips; acceptable given the mascot's role is contextual indicator, not hero asset.
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

### Agent session map (2026-07-06) — tab tracking for auto-title + resume

**The problem:** Claude Code rotates conversation IDs underneath a running tab (verified on v2.1.201). `/clear` starts a brand-new session file (the stub sits at the top of the fresh transcript), and the in-TUI resume picker switches to another conversation entirely. The dashboard roster pins a tab to its **birth** conversation UUID forever, but that pinned ID becomes stale the moment a rotation happens — auto-title read frozen transcripts and renamed the wrong tab, resume reopened snapshots from before the rotation, and session stats/model-picker hit the wrong session.

**The fix (architectural):** `src/lib/agent-session-map.ts` — a per-tab sidecar file (`state/.agent-session-map/<tab-uuid>.json`) that records `tab id → live conversation id` on every rotation. The PTY exports `DREAMCONTEXT_TAB_SESSION=<roster id>` into the spawned `claude` process (the env var is inherited by the hook), the SessionStart hook (and Stop hook, belt-and-suspenders) calls `recordAgentSession(contextRoot, tabId, sessionId)` on every startup/resume/compact/clear, and server routes resolve through `resolveAgentSession(contextRoot, tabId)` (mtime-cached read) for `--resume`, auto-title, session stats, and the model picker. Returns `''` for unmapped (identity) tabs or when the file is absent/corrupt. `liveTranscriptPath()` helper in `agent-session-map.ts` wraps the fallback chain (map-resolved → pinned → session-id UUID validation) so every route uses one tested path.

**Hardening (multi-review findings, all fixed):**
- `isNestedClaudeHook()` guard (ps-ancestry walk via `ps -p <ppid> -o comm=`, skips recording when a second `claude` process sits above the hook's own — i.e., a `claude -p` child run from inside the tab; fails open on Windows / any `ps` error so normal recording is untouched).
- Stop-hook re-record (a `/clear` followed by instant app quit could lose the SessionStart record to the hook timeout — the next completed turn re-records).
- Symlink guard (won't write through `state` or the map dir if either exists as a symlink, same hazard class `ensureGitignoreEntries` defends with `lstat`).
- Uniqueness sweep (a conversation can be LIVE in only one tab — if another tab's entry points at this same conversation, the latest record wins and the displaced entry is dropped, so two tabs don't double-attach on relaunch).
- Pruning (MAX_ENTRIES = 40; oldest entries pruned on each record so a long-lived vault doesn't grow unbounded closed-tab files).
- Team-brain gitignore (`buildBrainGitignore` includes `state/.agent-session-map/` so team-synced brains never commit machine-local conversation IDs).
- Auto-title retry cap (8 attempts per session, tracked in `autoTitledRef` + `titleInFlightRef` split so an interrupted first turn doesn't permanently lose its name).
- `$0` positional only-when-prompt (the prompt operand is appended to the shell argv ONLY when a prompt exists, so promptless agent tabs keep their real `$0` during rc sourcing; fish shells get `"$argv[1]"` instead of `"$0"`).
- Version-skew degrade-to-visible-typing (the sleep spawn checks the cached `/health` version handshake; against a stale server it degrades to typing the prompt visibly instead of a silent no-op).
- Tab→space prompt sanitize (`sanitizePrompt` folds `\t` into the whitespace-to-space replace so `fix\tbug` arrives as `fix bug`).

**Verification:** `tsc` clean, 2851 unit tests passing (including a REAL-process integration test for the parent-death watchdog), e2e hook probes green.

**Load-bearing exports:** `UUID_RE` (the shared session-id gate; both keys and values must be shell-inert UUIDs — the regex is an injection guard), `recordAgentSession()`, `resolveAgentSession()`, `liveTranscriptPath()`.

### Auto-submit mechanism (2026-07-06)

**Current path (positional arg at spawn):** `src/server/routes/agent-terminal.ts` reads the `prompt` URL param, sanitizes it via `sanitizePrompt()` (strips control chars, collapses newlines to spaces, caps at 8000 chars), and passes it as the login shell's `$0` positional: `['-ilc', 'exec claude … "$0"', initialPrompt]`. Claude boots the interactive TUI with the first message already submitted, autonomously — no reliance on client-side readline detection. `$0` is a real execve argument (never re-parsed by the shell), so a prompt with spaces/quotes/any metacharacter is inert.

**Old path (readline injection, REMOVED 2026-07-06):** client-side `initialPrompt` + busy/idle detection fired a readline send after guessing the TUI was ready. Racy during slow boots (MCP auth pauses) — the send could fire before the readline was mounted, dropping the message. This path is GONE for auto-submit; it survives only for the "write-but-don't-send" composer skill-add case (where the user finishes the prompt, so the timing race is moot).

### Notch Redesign (2026-06-28)

**Rust shell (`desktop/src-tauri/src/lib.rs`):** `tauri-nspanel` v2 plugin; `PanelEnabled` `AtomicBool` (default false); `apply_sleepy_enabled(enabled)` command: `show_perch()` / hide any capture panel + `order_out` perch. `build_perch_panel` builds hidden (no startup `order_front`). `show_perch` and hover-to-open watcher gated on `is_enabled`. Cursor poll thread: reads `CGEventGetLocation`, checks notch rect, emits `sleepy:hover-enter/leave` events.

**`SleepyMascot.tsx/.css`:** coded animated mascot — violet diamond shape, `blink` keyframe (eyelid clip-path), `breath` scale oscillation, `zzz` floating text. Mood class (`idle`/`sleepy`/`sleeps`) applied via `data-mood` attribute; CSS handles all visual transitions with zero JS re-render.

**`sleepy.ts` — PanelEnabled:** `enableSleepy(enabled)` calls `POST /api/launcher/sleepy-config` with `{enabled}`, then emits `sleepy:enabled` event across windows. Launcher JS listens on `storage` events to mirror enabled state. `applySleepyEnabled` in `App.tsx` sends `invoke('apply_sleepy_enabled', {enabled})` to Rust.

**Rust shell (`desktop/src-tauri/src/lib.rs`):** adds `tauri-plugin-global-shortcut` plugin; sets `DREAMCONTEXT_SLEEPY_DIR` env to `<resource_dir>/sleepy` (where bundled `.webp` and `.mp4` clips live — legacy, superseded by coded mascot).

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

### 2026-07-06 - Auto-submit race eliminated: prompt passed positionally at spawn (working tree)
- **BREAKING the old auto-submit mechanism.** The 2026-07-04 "auto-types and submits" path (`initialPrompt` + busy/idle detection firing a client-side readline injection) was **racy** — during a slow boot (3 MCP servers need authentication), the send could fire before the prompt was ready, dropping the consolidation message and leaving the Sleep agent stalled on an empty prompt. The new mechanism passes the prompt to `claude` as a **positional CLI arg** at spawn via a `prompt` URL param (`src/server/routes/agent-terminal.ts`): the prompt is passed as the login shell's `$0` positional and referenced as `"$0"` after all flags → `claude … "<prompt>"` starts the interactive TUI with the first message already submitted, autonomously. Client-side readline injection survives ONLY for the "write-but-don't-send" composer skill-add case (the user finishes the prompt).
- `sanitizePrompt(v)`: strips control chars (NUL truncates a C arg; CR/LF would submit a partial line), collapses newlines to spaces, caps at 8000 chars. Never interpolated into the shell string — `$0` is a real execve argument, inert regardless of metacharacters.
- **Constraint (added below)**: never type into a spawned TUI's readline after a timing guess — pass the message positionally at spawn. The old path was the exact failure mode this constraint guards against.

### 2026-07-06 - Terminal-native status line redesign (working tree)
- **AgentComposerBar restyled as the terminal's own status line** (`AgentComposerBar.tsx`, `AgentComposerBar.css`): same background/JetBrains Mono/zoom-tracked grid as xterm (no seam), Claude Code hint-row design language (dim monospace, accent-colored glyphs, `·` separators, `@` instead of 📎), TUI-box popovers (terminal bg, accent border, `❯` caret with reserved caret column for label alignment), split-view focus ring moved to a pointer-events-none `::after` overlay so it wraps terminal+status-line as one surface, per-theme dim ink derived from xterm foreground, pane-width degradation (labels→glyphs, context/cost readout hides with its `·`).
- Dim ink: `readXtermTheme()` now extracts `--color-bg` AND the per-theme foreground (`#cdd3de` dark / `#33383f` light) and derives a calmed dim ink (same per-theme mixing the terminal itself uses for dim text) — so the status-line buttons match xterm's dim text in both themes instead of floating as a separate widget tone.
- All chrome (borders, pill backgrounds, emoji) removed from buttons — they're now dim monospace words with accent-colored leading glyphs, deliberately mirroring Claude Code's own `⏵⏵ bypass permissions on (shift+tab to cycle) · …` row. Labels lowercased (`files`, `dreamcontext skills`, `fable`, `high`) to match the CLI's hint-row voice. The `@` glyph replaces 📎 (Claude Code's file-reference character). The `◆`/`◈`/`✦` glyphs are tinted the accent purple the way the CLI colors its `⏵⏵` prefix.
- Spacing/sizing: JetBrains Mono at `14.5px × --zoom` (identical font, size, and zoom-tracking as the terminal cells), body letter-spacing reset, left padding aligned to `.xterm` 20px gutter.
- Verified: tsc clean, production build passes, restart the dev server to see it.

### 2026-07-06 - Composer skill-add UX: two-pane skill browser with live detail (working tree)
- The AgentComposerBar's ✦ Skills popover was redesigned as a **two-pane skill browser** (`AgentComposerBar.tsx`, `agentComposer.ts`): left pane shows capability chips grouped by category ("Brain lifecycle" / "Build & review" / "Decide & draw"); right pane shows a live detail card that follows hover/focus, rendering WHAT the skill is (one sentence) and HOW it works (ordered phase flow + dispatched sub-agents if any). Clicking a chip drops its trigger into the focused terminal's input line (the "write-but-don't-send" inject — the user finishes the prompt).
- Each `SkillTrigger` now carries rich detail: `what`, `how[]`, `agents[]` — so the popover can render a meaningful explainer without relying on a native one-line tooltip.
- Skill groups reorganized: "Brain lifecycle" (initializer, curator, deep-research, dream-sync), "Build & review" (goal-skill, multi-review), "Decide & draw" (council, excalidraw).
- This extends the existing AgentSurface/composer workflow (same domain); not a separate feature.

### 2026-07-06 - Auto-title retry fix: interrupted first turns no longer permanently lose their name (working tree)
- AgentSurface auto-title was guarded to "once per session" via `autoTitledRef` — but an interrupted or not-yet-flushed first turn (a busy→idle edge before Claude Code writes the transcript) returns an empty title, permanently marking that session as "handled" so it never got a second chance. Fixed: split `autoTitledRef` (successfully named or permanently ineligible) from `titleInFlightRef` (one outstanding Haiku call at a time). A call that comes back empty leaves the id retryable — so the tab you actually worked on gets named on its next completed turn instead of losing the race to a slower, older tab's late rename.

### 2026-07-04 - Sleep-agent launcher integrated into header SleepDebtTracker (working tree, feat/sleep-debt-header-tracker)
- The header SleepDebtTracker became an **interactive in-app Sleep-agent launcher**: clicking the sleepy-face widget (previously a nav-to-Sleep-page link) now opens a dropdown menu with "Show sleep details" (old behavior) and "Run sleep agent" (new).
- "Run sleep agent" is capability-gated (desktop + node-pty + Claude CLI via `/agent/capabilities` AND Agents surface enabled in Settings) — disabled with a tooltip when prereqs are missing.
- When clicked, it dispatches a `dreamcontext-run-sleep-agent` window event; the always-mounted `AgentSurface` spawns a real "Sleep" Claude Code session in the bottom-right dock, kept collapsed to a chip. ~~The session auto-types and submits the consolidation prompt once (after the SessionStart brain-preload goes idle, via `initialPrompt` + busy/idle detection).~~ **[SUPERSEDED 2026-07-06]** The prompt is now passed as a positional arg at spawn (see above) — no readline injection.
- Active-consolidation UI: when `sleep_started_at` is stamped (real sleep in flight), the tracker flips to a violet "Sleeping" chip with the face asleep, the bar breathing, and animated "z z z" — and the "Run sleep agent" dropdown item is disabled (matches the backend's one-consolidation lock).
- The spawned Sleep session runs with default permission settings (bypass OFF) — respects the project's `.claude` allow-list, not auto-armed to skip permissions.
- New files: `lib/sleepAgent.ts` (event + prompt), `hooks/useAgentCapabilities.ts` (readiness gate). Touched: `SleepDebtTracker.tsx/.css`, `agentSession.ts`, `AgentSurface.tsx`, `I18nContext.tsx`.
- Verified in the packaged Tauri app (real agent spawn, auto-type, status chip). Not yet committed or merged.

### 2026-06-28 - Notch panel redesign: NSPanel, hover-to-open, coded mascot, PanelEnabled
- Non-activating `NSPanel` via `tauri-nspanel` v2: works from any app without stealing focus. Global hotkey reliable; `Cmd+H` reserved-key fallback to `Alt+Cmd+S`.
- `SleepyMascot.tsx` coded animated mascot replaces animated WebP (blink/breath/Zzz, zero asset cost).
- Open-from-notch cap-drop animation (`clip-path` reveal on `sleepy:shown`).
- Hover-to-open: Rust CoreGraphics cursor poll triggers show; auto-close on leave unless committed.
- `PanelEnabled` atomic Rust state (default false — opt-in): disabling hides notch entirely.
- Status: in_review.

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
