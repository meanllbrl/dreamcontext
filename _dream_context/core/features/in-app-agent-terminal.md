---
id: "feat_nM4EnT8k"
status: "in_review"
created: "2026-06-28"
updated: "2026-07-01"
released_version: null
tags:
  - topic:desktop
  - topic:agents
  - layer:frontend
  - layer:backend
related_tasks:
  - feat-desktop-in-app-conversational-agent-surface-bm25-search-claude-chat-embedded-terminal
  - agent-terminal-readability-and-prereq-installer
  - feat-sleepy-agent-surface-ux-redesign
  - agent-terminal-rendering-readability-polish
---

## Why

Developers using the dreamcontext desktop app need to run Claude Code interactively without leaving the app or opening a separate terminal window. The in-app Agent terminal embeds a full Claude Code TUI session directly in the Sleepy/Agent screen — full session parity (slash menu, skills, sub-agents, reasoning effort, real permission prompts) because it IS the client. In-app prerequisite detection and installation (node-pty, claude CLI) eliminate setup friction so the feature works out of the box.

## User Stories

- [x] As a developer, I can run Claude Code in an embedded terminal inside the dreamcontext desktop app so I do not need a separate terminal window.
- [x] As a developer, I can navigate away from the Agent tab and return without losing my Claude Code session.
- [x] As a developer, I can opt into bypassing Claude Code's permission prompts so I can let it operate autonomously (with a standing warning shown while armed).
- [x] As a developer, I can split the view into side-by-side agent sessions to run parallel tasks.
- [x] As a developer, I can read Claude Code's output clearly in both light and dark themes without eyestrain or same-luminance-on-same-luminance blocks.
- [x] As a developer, I can install missing prerequisites (Claude CLI, node-pty) from within the app with one click so I never need to open a terminal just to unblock the Agent screen.
- [x] As a developer, I can access the agent terminal from any page via a global bottom-right FAB so I never need to navigate to a dedicated Sleepy page.
- [x] As a developer, I can see per-pane tab bars so it is always unambiguous which tab controls which pane.
- [x] As a developer, I can minimize an agent session to a corner dock chip and restore it as a new pane by clicking the chip, without losing state.
- [x] As a developer, I can use ⌘K to search the project brain (knowledge, features, tasks) from anywhere and navigate directly to a result.
- [x] As a developer, sessions I reopen correctly receive `--resume` only when a prior transcript exists, avoiding "No conversation found" errors on freshly created tabs.
- [x] As a developer, I can copy text out of the terminal — including non-ASCII characters — without a mangled clipboard or a jarring macOS beep.
- [x] As a developer, I can drop any file (not just images) onto the pane under my cursor and have its path handed to that session.
- [ ] As a developer, I can use a read-only plan mode that shows Claude's intent without allowing file writes.

## Acceptance Criteria

- [x] WS bridge (`/api/agent/terminal`) spawns `$SHELL -ilc 'exec claude [--dangerously-skip-permissions]'` via node-pty; desktop-only (`DREAMCONTEXT_DESKTOP=1` gate) and loopback-only (strict `remoteAddress` check).
- [x] Session persists via `display:none` hoist of `AgentSurface` above `App.tsx` page switch; torn down only on explicit Close/Restart or app quit.
- [x] `agentSession.ts` renders xterm.js with the DOM renderer (WebGL addon REMOVED 2026-07-01 for native macOS anti-aliasing, since the WebGL atlas produced hard "sharp" edges users found eye-tiring); `.xterm { -webkit-font-smoothing: auto }` overrides the app-wide CSS reset's forced `antialiased`.
- [x] JetBrains Mono — the actually-loaded `--font-mono` primary, real 400/500/700 weights — loaded via `FontFaceSet.load()` and fully committed before `term.open()` (prevents wrong-cell-width glyphs on font-load-after-open); the originally-intended Sometype Mono was never actually loaded (no `@font-face`), so text had silently been JetBrains Mono @400 with a faux-synthesized bold.
- [x] `bypassPermissions` default OFF; orange warning chip shown in the UI while armed.
- [x] Drag-to-split: tab drag onto another tab or terminal body creates side-by-side layout; `⌘D` and `⊟` button also split.
- [x] `readXtermTheme()` uses `minimumContrastRatio: 3` (calmed down 2026-07-01 from an initial 4.5 that force-brightened dim/secondary text) + a softened default foreground (`#cdd3de` dark / `#33383f` light) + per-theme conventional grayscale ANSI ramp (slot 0=darkest, slot 15=lightest); readable in both light and dark mode without flattening text hierarchy.
- [x] Comfort defaults: 14.5px font size (was 13.5), 1.65 line-height (was 1.4).
- [x] Copy (⌘C) and cut (⌘X) copy the current selection via a hidden-textarea `execCommand('copy')` path (UTF-8-safe — WKWebView's `navigator.clipboard.writeText` mangles non-ASCII) and `preventDefault()` so no macOS system beep fires; ⌘V remains native (bracketed paste intact); ⌘A selects all.
- [x] Text selection is visible in both light and dark themes regardless of terminal focus: `selectionBackground` and `selectionInactiveBackground` both pinned to a solid `#6a57d6` with white `selectionForeground`.
- [x] Inactive split panes are no longer dimmed (the `opacity: 0.82` + overlay were removed) — both panes stay fully legible; only the active pane's accent ring + top bar marks focus.
- [x] File drag-drop targets the pane UNDER THE CURSOR (`elementFromPoint` → `.agent-pane-slot[data-pane]`), not the last-focused pane, and drop also activates that pane; any file type is accepted (not just images) — non-images are saved verbatim server-side and their path is injected into the target session.
- [x] `GET /api/agent/capabilities` returns `{ desktop, embeddedTerminal, openTerminal, nodePty, claudeCli, npm }`; `nodePty`/`claudeCli`/`npm` probed via `$SHELL -ilc` (interactive login shell, matching PTY spawn PATH).
- [x] `POST /api/agent/install { target: 'claude'|'pty' }` starts a background install tracked in `installRuns` Map; `GET /api/agent/install/status?id=` polls `{ state, output }`.
- [x] `pty` install target: `npm install node-pty@^1.1.0 --no-save` into CLI package root (walk up from `process.argv[1]`) + `ensurePtyHelperExecutable()` + bust memoized `ptyAvailable` cache.
- [x] `claude` install target: `npm install -g @anthropic-ai/claude-code` in login shell.
- [x] `Prereqs` component in `AgentSurface.tsx` lists missing prerequisites with one-click Install + live log tail + auto re-check on completion.
- [x] Start-agent button gated on BOTH `embeddedTerminal` (node-pty present) AND `claudeCli` (claude on PATH); npm-absent shows guidance instead of failing silently.
- [x] Install routes: desktop-gated, loopback-only, bad target → 400; registered in `src/server/index.ts` in `VAULT_AGNOSTIC_PREFIXES`.
- [x] Global `AgentFab` (bottom-right) launches the fullscreen overlay from any page; `SleepyPage.tsx` deleted; overlay `display:none`-hoisted above `App.tsx` page switch (same persistence invariant as before).
- [x] Per-pane tab bars render at z-index 7 (above split drop overlay at z-index 6); each pane is independently controlled.
- [x] Active-pane blue accent ring; clicking anywhere in a pane activates it; `dreamcontext-navigate` custom window event auto-collapses the overlay on page navigation.
- [x] `AgentDock` rendered as a sibling of `.agent-surface` in `App.tsx` at z-index 25 — NOT a child (avoids `contain:layout paint` containing-block trap and `.agent-surface > *` forced-width rule).
- [x] Auto-resume: before spawning, server checks `~/.claude/projects/<cwd-dashes>/<uuid>.jsonl` exists → `--resume <uuid>`; absent → `--session-id <uuid>`.
- [x] ⌘K opens `CommandPalette` (BM25 + optional Haiku intelligent toggle); clicking a result navigates via `recallNav` + `useFocusTarget` wired `PageRouter → pages`.
- [ ] Read-only plan mode (`--permission-mode plan`) available in the UI.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-01] DOM renderer over WebGL, and JetBrains Mono is the real primary font.** WebGL's glyph atlas gave crisp text but hard "sharp" edges that read as eye-tiring; the DOM renderer's real text nodes get native macOS anti-aliasing (requires `.xterm { -webkit-font-smoothing: auto }` to override the app-wide reset's forced `antialiased`). Separately discovered: Sometype Mono was never actually loaded (no `@font-face`/Google-Fonts link), so `--font-mono` silently fell through to JetBrains Mono @400 the whole time — JetBrains Mono is now loaded for real (400/500/700) and listed first, and the font-load-before-open gate reads the primary family off `--font-mono` dynamically instead of a hardcoded name.
- **[2026-07-01] minimumContrastRatio 4.5 was too aggressive — lowered to 3, foreground softened.** 4.5 force-brightened dim/secondary text along with the raw near-white default foreground (`#f5f6fa` on `#14171f`, ~17:1), reading as harsh over long sessions. Softened the default foreground to `#cdd3de` dark / `#33383f` light and lowered the floor to 3 — still enough to rescue ANSI-on-ANSI block fills, low enough to preserve dim-text hierarchy.
- **[2026-07-01] Selection must pin BOTH `selectionBackground` and `selectionInactiveBackground`.** xterm draws `selectionInactiveBackground` (a much fainter default) whenever the terminal isn't the focused element — a selection made unfocused was invisible in light mode until both were pinned to the same solid `#6a57d6`.
- **[2026-07-01] WKWebView clipboard mangles UTF-8 — copy via hidden textarea + `execCommand`, not `navigator.clipboard`.** `navigator.clipboard.writeText()` re-decodes UTF-8 as Mac Roman in this WKWebView (ç→"√ß", —→"‚Äî"). The `execCommand('copy')` path routes through the OS's native copy pipeline and round-trips correctly; `navigator.clipboard` is kept only as a last-resort fallback. `⌘V` is left untouched so xterm's native bracketed paste stays intact.
- **[2026-07-01] Any file type may now be dropped, routed by cursor position.** The prior 415 rejection of non-images was removed (images still magic-byte-verified for extension; non-images saved verbatim); drop routing changed from last-focused-pane to the pane under the cursor (`elementFromPoint`) so a drop always lands where the user pointed.
- **[2026-06-30] WKWebView DnD: execute on `dragend`, never on `drop`.** WKWebView does not deliver the HTML5 `drop` event to targets that are mounted mid-drag (even though `dragover` fires on them). WKWebView also strips custom-MIME `getData()` on `drop` (value is empty; type appears in `dataTransfer.types` during `dragover`). Fix pattern: carry session id in a React ref on `dragstart`; record hovered target on every `dragover`; execute split/combine on the source's `dragend`. **This rule applies to ALL future WKWebView drag-and-drop features.** Standard `text/plain` on always-mounted targets (Kanban/Eisenhower) is unaffected.
- **[2026-06-30] `AgentDock` must be a DOM sibling of `.agent-surface`, not a child.** `.agent-surface` has `contain: layout paint` (new containing block for `position:fixed` children) and a `> *` rule forcing `width:100%` on direct children. A child dock is deformed by both. Sibling render + z-index 25 is required.
- **[2026-06-30] Auto-resume requires transcript existence check.** `claude --resume <uuid>` errors "No conversation found" when no JSONL file exists (tab created but never used). Always check `~/.claude/projects/<cwd-dashes>/<uuid>.jsonl` before choosing `--resume` vs `--session-id`.
- **[2026-06-29] minimumContrastRatio 4.5 over palette fidelity.** Embedding someone else's TUI (Claude Code) requires yielding colour control to xterm's contrast engine. Setting `minimumContrastRatio: 1` "to keep the exact palette" causes unreadable block fills in both themes. Conventional grayscale ANSI ramp (0=darkest, 15=lightest) is the correct baseline; brand tokens belong in the non-ANSI theme colours only.
- **[2026-06-29] Prerequisite installer targets are a CLOSED whitelist.** `claude` and `pty` only; any other value → 400. Desktop-gated AND loopback-only. Package names are internal literals, never user input (no injection).
- **[2026-06-29] node-pty installed into CLI package root.** Walking up from `process.argv[1]` to find the nearest `package.json` ensures `import('node-pty')` resolves correctly from the bundled dist. Installing globally would not be visible to the server's module resolution.
- **[2026-06-29] Capabilities probed via -ilc (interactive login shell).** `claude` is commonly added to PATH in `~/.zshrc` (e.g. `~/.local/bin`), which a non-interactive `-lc` shell does NOT source. Using `-ilc` for the probe matches the PTY spawn exactly so detection can never disagree with the real spawn.
- **[2026-06-28] bypassPermissions opt-in, default OFF.** The terminal runs real `claude` with full file-write capability. The bypass is powerful and must be explicitly armed by the user.
- **[2026-06-28] Session persistence via display:none, not re-mount.** `AgentSurface` must live above the `App.tsx` page switch; unmounting kills the PTY and the user loses their live session.
- **[2026-06-28] Sometype Mono load-before-open.** The WebGL glyph atlas is committed at `term.open()` time; loading the font after results in incorrect cell metrics. `FontFaceSet.load()` + await before `term.open()` is the required sequence.

## Technical Details

Architecture, key files, and dev-workflow notes are in `_dream_context/knowledge/desktop-beta-tauri-multivault.md`:
- §"In-app Agent Terminal" — PTY bridge, bypassPermissions, prereq installer, and the 2026-07-01 readability polish (DOM renderer replacing WebGL, real JetBrains Mono load, calmed contrast, clipboard/selection/pane-dimming fixes) which supersedes the original WebGL-era design.
- §"WKWebView DnD" (inside Key decisions) — dragend-not-drop rule, ref-carried payload, custom-MIME stripped on drop.
- §"Multi-session pane redesign" — FAB+overlay, per-pane tabs, new/deleted components list.
- §"Minimize-to-corner (AgentDock)" — contain:layout paint gotcha, sibling render fix.
- §"Auto-resume reliability" — transcript path format, --resume vs --session-id decision.
- §"⌘K command palette" — recallNav + useFocusTarget wiring.

Key files summary (post-2026-07-01 readability polish):
- `src/server/routes/agent-terminal.ts` — WS bridge + node-pty spawn, capabilities, prereq installer, osascript fallback.
- `src/server/routes/agent-sessions.ts` — session management (added 2026-06-30).
- `src/server/routes/agent-drop.ts` — any-file DnD drop endpoint; routes to the pane under the cursor (opened up from image-only + last-focused-pane on 2026-07-01).
- `src/server/index.ts` — orchestration, VAULT_AGNOSTIC_PREFIXES.
- `dashboard/src/components/sleepy/AgentSurface.tsx` — `Prereqs`, multi-pane layout, dragend split pattern, cursor-targeted drop routing (`onTermDrop` → `elementFromPoint`).
- `dashboard/src/components/sleepy/agentSession.ts` — `createSession()` (xterm DOM renderer, `@xterm/addon-fit`, WebGL removed), `readXtermTheme()` (`minimumContrastRatio: 3`, softened foreground, solid `#6a57d6` selection for both active/inactive), JetBrains-Mono-aware font-load-before-open, `copyPreservingUnicode()` + beep-free ⌘C/⌘X/⌘A handler.
- `dashboard/src/components/sleepy/AgentTerminal.css` — inactive-pane dimming removed; `.xterm` font-smoothing override (`-webkit-font-smoothing: auto`).
- `dashboard/src/styles/tokens.css` + `dashboard/index.html` — `--font-mono` primary is JetBrains Mono (loaded 400/500/700); Sometype Mono removed (was never loaded).
- `dashboard/src/components/sleepy/AgentDock.tsx` — minimize-to-corner chip (sibling of .agent-surface).
- `dashboard/src/components/sleepy/AgentTabs.tsx` — per-pane tab bars.
- `dashboard/src/components/sleepy/AgentFab.tsx` — global FAB.
- `dashboard/src/components/search/CommandPalette.tsx` — ⌘K palette.
- `dashboard/src/hooks/useFocusTarget.ts`, `dashboard/src/lib/recallNav.ts` — recall navigation wiring.

## Notes

- Desktop-only feature; never ships in the npm package. Gated on `DREAMCONTEXT_DESKTOP=1` (injected by the Rust shell).
- The `claude` PTY grandchildren this feature spawns are now reaped on server shutdown (a tracked-child registry added as part of the 2026-06-30 orphaned-dashboard-server fix) — see `[[desktop-beta-tauri-multivault]]` § orphaned-server root-cause fix. This is an infra-level lifecycle fix, not a terminal-feature change; documented there, not duplicated here.
- `ensurePtyHelperExecutable()` runs at startup to restore `+x` on the prebuilt spawn-helper (tarball strips execute bit → `posix_spawnp failed`); idempotent.
- Plan mode (`--permission-mode plan`) is always available via the external-terminal fallback (`POST /api/agent/open-terminal`); the in-app embedded plan mode is the remaining open AC.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-01 — Readability polish shipped (task agent-terminal-rendering-readability-polish, v0.10.5)
- WebGL addon removed; xterm now uses the DOM renderer for native macOS anti-aliasing (kills the "sharp"/eye-tiring glyph edges); `.xterm { -webkit-font-smoothing: auto }` overrides the app-wide `antialiased` reset.
- Sometype Mono was never actually loaded (no `@font-face`; JetBrains Mono @400 was the silent fallback the whole time). JetBrains Mono is now the real `--font-mono` primary with loaded 400/500/700 weights; font-load-before-open reads the primary family off `--font-mono` dynamically.
- Contrast calmed: `minimumContrastRatio` 4.5 → 3, default foreground softened to `#cdd3de` dark / `#33383f` light (dim text stays dim).
- Comfort defaults: 14.5px font size (was 13.5), 1.65 line-height (was 1.4).
- Copy/cut (⌘C/⌘X) now UTF-8-safe (hidden-textarea `execCommand`, not `navigator.clipboard`) and beep-free; ⌘A selects all; ⌘V untouched.
- Selection visible in both themes and regardless of focus: `selectionBackground` + `selectionInactiveBackground` both pinned to solid `#6a57d6`.
- Inactive split-pane dimming removed — both panes stay fully legible.
- Drag-drop now targets the pane under the cursor (not last-focused) and accepts any file type (not just images).
- Status: in_review (unchanged — plan mode AC still open).

### 2026-06-30 — Multi-session pane redesign shipped (feat/sleepy-agent-surface-ux-redesign)
- SleepyPage deleted; agent surface now a global FAB + fullscreen overlay accessible from any page.
- Per-pane tab bars, active-pane accent ring, click-to-activate.
- Minimize-to-corner: `AgentDock` chip (sibling of `.agent-surface`; `contain:layout paint` gotcha resolved).
- Drag-to-split fully fixed for WKWebView: `dragend` pattern (ref-carried session id, dragover hover recording, execute on source's `dragend` not `drop`; mid-drag-mounted targets never receive `drop` in WKWebView; custom-MIME `getData()` stripped on drop).
- Auto-resume: transcript existence check (`~/.claude/projects/<cwd-dashes>/<uuid>.jsonl`) before `--resume` vs `--session-id`.
- ⌘K command palette: BM25 + Haiku intelligent toggle; `recallNav` + `useFocusTarget` wiring through `PageRouter → pages`; `dreamcontext-navigate` event for cross-tree overlay collapse.
- New: `AgentDock`, `AgentFab`, `AgentTabs`, `SessionRail`, `agentStatus.ts`, `CommandPalette`, `useFocusTarget`, `recallNav`, `agent-sessions.ts`, `agent-drop.ts`.
- Deleted: `DockBubble.tsx`, `agentSlots.tsx`, `SleepyPage.tsx`, `SleepyPage.css`.
- Status: in_review (unchanged — plan mode AC still open).

### 2026-06-29 - Readability fix + prerequisite installer shipped (commit 351d14e)
- `readXtermTheme()` rewritten: `minimumContrastRatio: 4.5` + per-theme ANSI grayscale ramp — readable in both light and dark mode.
- `GET /api/agent/capabilities` extended: `claudeCli`, `nodePty`, `npm` fields probed via `$SHELL -ilc`.
- `POST /api/agent/install` + `GET /api/agent/install/status` — in-app prereq installer (Sleepy capture-run pattern).
- `Prereqs` component in `AgentSurface.tsx` — setup panel with one-click install + live log tail + auto re-check.
- Start-agent gated on BOTH node-pty AND claude CLI; npm-absent guidance shown.
- Component renamed `AgentTerminal.tsx` → `AgentSurface.tsx`.
- Status: in_review.

### 2026-06-28 - Initial embedded terminal shipped
- Full PTY terminal embedded in Sleepy/Agent screen: xterm.js + WebGL + node-pty WS bridge.
- Session persistence via `display:none` hoist above `App.tsx` page switch.
- `bypassPermissions` opt-in; drag-to-split; WebGL renderer + Sometype Mono font-load-before-open.
- Status: in_progress → in_review (shipped; pending readability + prereq installer).

### 2026-06-29 - Created
- Feature PRD created.
