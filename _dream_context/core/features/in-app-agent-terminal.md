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
- [ ] As a developer, I can use a read-only plan mode that shows Claude's intent without allowing file writes.

## Acceptance Criteria

- [x] WS bridge (`/api/agent/terminal`) spawns `$SHELL -ilc 'exec claude [--dangerously-skip-permissions]'` via node-pty; desktop-only (`DREAMCONTEXT_DESKTOP=1` gate) and loopback-only (strict `remoteAddress` check).
- [x] Session persists via `display:none` hoist of `AgentSurface` above `App.tsx` page switch; torn down only on explicit Close/Restart or app quit.
- [x] `AgentSurface.tsx` renders xterm.js with WebGL addon (`@xterm/addon-webgl`); automatic fallback to canvas on context-loss.
- [x] Sometype Mono font loaded via `FontFaceSet.load()` and fully committed before `term.open()` and WebGL addon attachment (prevents glyph-atlas wrong-width on font-load-after-open).
- [x] `bypassPermissions` default OFF; orange warning chip shown in the UI while armed.
- [x] Drag-to-split: tab drag onto another tab or terminal body creates side-by-side layout; `⌘D` and `⊟` button also split.
- [x] `readXtermTheme()` uses `minimumContrastRatio: 4.5` + per-theme conventional grayscale ANSI ramp (slot 0=darkest, slot 15=lightest); readable in both light and dark mode regardless of Claude's ANSI block-fill choices.
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
- §"In-app Agent Terminal" — original PTY bridge, WebGL, bypassPermissions, readability fix, prereq installer.
- §"WKWebView DnD" (inside Key decisions) — dragend-not-drop rule, ref-carried payload, custom-MIME stripped on drop.
- §"Multi-session pane redesign" — FAB+overlay, per-pane tabs, new/deleted components list.
- §"Minimize-to-corner (AgentDock)" — contain:layout paint gotcha, sibling render fix.
- §"Auto-resume reliability" — transcript path format, --resume vs --session-id decision.
- §"⌘K command palette" — recallNav + useFocusTarget wiring.

Key files summary (post-redesign):
- `src/server/routes/agent-terminal.ts` — WS bridge + node-pty spawn, capabilities, prereq installer, osascript fallback.
- `src/server/routes/agent-sessions.ts` — session management (added 2026-06-30).
- `src/server/routes/agent-drop.ts` — image/file DnD drop (added 2026-06-30).
- `src/server/index.ts` — orchestration, VAULT_AGNOSTIC_PREFIXES.
- `dashboard/src/components/sleepy/AgentSurface.tsx` — xterm.js, WebGL, font load, readXtermTheme, Prereqs, multi-pane, dragend split pattern.
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
