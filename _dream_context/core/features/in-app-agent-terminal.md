---
id: "feat_nM4EnT8k"
status: "in_review"
created: "2026-06-28"
updated: "2026-06-29"
released_version: null
tags:
  - topic:desktop
  - topic:agents
  - layer:frontend
  - layer:backend
related_tasks:
  - feat-desktop-in-app-conversational-agent-surface-bm25-search-claude-chat-embedded-terminal
  - agent-terminal-readability-and-prereq-installer
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
- [ ] Read-only plan mode (`--permission-mode plan`) available in the UI.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-29] minimumContrastRatio 4.5 over palette fidelity.** Embedding someone else's TUI (Claude Code) requires yielding colour control to xterm's contrast engine. Setting `minimumContrastRatio: 1` "to keep the exact palette" causes unreadable block fills in both themes. Conventional grayscale ANSI ramp (0=darkest, 15=lightest) is the correct baseline; brand tokens belong in the non-ANSI theme colours only.
- **[2026-06-29] Prerequisite installer targets are a CLOSED whitelist.** `claude` and `pty` only; any other value → 400. Desktop-gated AND loopback-only. Package names are internal literals, never user input (no injection).
- **[2026-06-29] node-pty installed into CLI package root.** Walking up from `process.argv[1]` to find the nearest `package.json` ensures `import('node-pty')` resolves correctly from the bundled dist. Installing globally would not be visible to the server's module resolution.
- **[2026-06-29] Capabilities probed via -ilc (interactive login shell).** `claude` is commonly added to PATH in `~/.zshrc` (e.g. `~/.local/bin`), which a non-interactive `-lc` shell does NOT source. Using `-ilc` for the probe matches the PTY spawn exactly so detection can never disagree with the real spawn.
- **[2026-06-28] bypassPermissions opt-in, default OFF.** The terminal runs real `claude` with full file-write capability. The bypass is powerful and must be explicitly armed by the user.
- **[2026-06-28] Session persistence via display:none, not re-mount.** `AgentSurface` must live above the `App.tsx` page switch; unmounting kills the PTY and the user loses their live session.
- **[2026-06-28] Sometype Mono load-before-open.** The WebGL glyph atlas is committed at `term.open()` time; loading the font after results in incorrect cell metrics. `FontFaceSet.load()` + await before `term.open()` is the required sequence.

## Technical Details

Architecture, key files, and dev-workflow notes (including the npm-linked dev footgun with node-pty) are in `_dream_context/knowledge/desktop-beta-tauri-multivault.md` §"In-app Agent Terminal". Summary of key files:

- `src/server/routes/agent-terminal.ts` — all agent routes: WS bridge + node-pty spawn, `GET /api/agent/capabilities`, `POST /api/agent/install`, `GET /api/agent/install/status`, `POST /api/agent/open-terminal` (osascript fallback).
- `src/server/index.ts` — `attachAgentTerminal(server)` wired at bottom; install routes in `VAULT_AGNOSTIC_PREFIXES`.
- `dashboard/src/components/sleepy/AgentSurface.tsx` — xterm.js, WebGL addon, font load, `readXtermTheme()`, `Prereqs` component, drag-to-split logic.
- `dashboard/src/components/sleepy/AgentTerminal.css` — stylesheet (filename retained).
- `dashboard/src/pages/SleepyPage.tsx` — Agent tab; `<AgentSurface />` hoisted above `App.tsx` page switch.

## Notes

- Desktop-only feature; never ships in the npm package. Gated on `DREAMCONTEXT_DESKTOP=1` (injected by the Rust shell).
- `ensurePtyHelperExecutable()` runs at startup to restore `+x` on the prebuilt spawn-helper (tarball strips execute bit → `posix_spawnp failed`); idempotent.
- Plan mode (`--permission-mode plan`) is always available via the external-terminal fallback (`POST /api/agent/open-terminal`); the in-app embedded plan mode is the remaining open AC.

## Changelog
<!-- LIFO: newest entry at top -->

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
