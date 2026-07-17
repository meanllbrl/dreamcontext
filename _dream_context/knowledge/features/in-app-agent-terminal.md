---
id: feat_nM4EnT8k
status: in_review
created: '2026-06-28'
updated: '2026-07-17'
tags:
  - 'topic:desktop'
  - 'topic:agents'
  - 'layer:frontend'
  - 'layer:backend'
related_tasks:
  - >-
    feat-desktop-in-app-conversational-agent-surface-bm25-search-claude-chat-embedded-terminal
  - agent-terminal-readability-and-prereq-installer
  - feat-sleepy-agent-surface-ux-redesign
  - agent-terminal-rendering-readability-polish
  - feat-desktop-basic-terminal-mode-in-agent-surface
type: feature
name: in-app-agent-terminal
description: ''
pinned: false
date: '2026-06-28'
released_version: v0.14.2
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
- [x] As a developer, I can open a plain terminal tab (no Claude agent) scoped to the vault root alongside my agent tabs, so I can run shell commands without leaving the Agent surface.
- [x] As a developer, a new session's tab is auto-titled from my first message (via a cheap one-shot Haiku call), so I don't have to manually rename "Agent 1"/"Agent 2" tabs to tell them apart.
- [x] As a developer, I can toggle the whole Agents (beta) surface on/off, toggle tab-restore-on-launch, toggle auto-title, and set a custom in-app hotkey to open/close the Agents overlay, from Settings → Agents, so the surface fits how I actually work.
- [x] As a developer, when I open a task's in-pane agent session (Task Manager), the session boots idle with the pin prompt deferred to my first message, so I can type my question immediately instead of waiting for an auto-submitted prompt to complete.

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
- [x] WS `/api/agent/terminal` accepts `?kind=agent|shell`; `kind=shell` spawns `$SHELL -il` (plain interactive login shell in the vault root — no `exec claude`, no bypass/resume/session-id machinery) with a generic exit message; `kind=agent` (or absent) is unchanged.
- [x] `agentSession.ts` `createSession(...)` takes a `SessionKind` (`'agent' | 'shell'`) and sends `&kind=shell` (dropping claude-only params) for shells; `AgentSurface.tsx` threads `kind` through spawn/`addSession`/`addSplitSession`/`resumeSession`/roster persistence/hydration — shells restore dormant and resume as a fresh shell (no conversation to resume); agents unchanged.
- [x] Header gains a split `＋ New ▾` button (Agent/Terminal dropdown) plus `⌃\`` as a direct new-terminal shortcut; the empty-state gains a `>_ Start terminal` button gated on `node-pty` only (not the `claude` CLI — a shell tab needs no agent). Tabs show a `◇` (agent) / `>_` (shell) glyph.
- [x] `POST /api/agent/title { claudeId }` (desktop-gated): finds the session's transcript via `findTranscriptPath` (extracted from the existing resume-check helper, now shared), reads the first genuine user message (skips tool-result/`<...>`-wrapped reminder lines), and returns a Haiku-generated title (`claude --model haiku -p`, run in `homedir()` so it never fires the project's SessionStart brain-preload; 30s timeout; sanitized to ≤6 words / 40 chars, Title Case, no quotes/punctuation).
- [x] `AgentSurface.tsx` calls `/agent/title` once per session (`autoTitledRef` dedup) on the session's busy→idle edge (first turn complete), ONLY when `agentSettings.enabled && agentSettings.autoTitle` and the tab still holds its default `Agent N` name (a manual rename always wins, even mid-flight); `kind !== 'agent'` (shells) are skipped.
- [x] `GET`/`POST /api/launcher/agent-settings` (`~/.dreamcontext/agent-ui.json`, app-global not vault-scoped) persists `{ enabled, restoreTabs, defaultAgent, autoTitle, hotkey }`; `dashboard/src/lib/agentSettings.ts` mirrors `lib/sleepy.ts`'s pattern (localStorage + server write-through + `dreamcontext-agent-settings` window event so the always-mounted `AgentSurface` picks up a Settings-page change live, no reload).
- [x] Settings → Agents (BETA, desktop-only) section: enable toggle, restore-tabs toggle, default-agent select (Claude Code only today), auto-title toggle, and a captured-hotkey field (`accelFromKeyEvent`/`matchesAccel` shared builder — same accelerator format as the existing Sleepy hotkey capture; Backspace/Delete clears the binding).
- [x] `createSession(...)` accepts `deferPrompt: boolean`; when true, the client sends `&deferPrompt=1` on the WS upgrade; server parks the sanitized prompt in a tmpdir file (`dreamcontext-deferred-<uuid>.txt`, mode 0600), exports `DREAMCONTEXT_DEFERRED_PROMPT=<path>` on the PTY env, and does NOT auto-submit it. On a real resume the flag is dropped (transcript already pinned). File cleaned on PTY exit.
- [x] `user-prompt-submit` hook (src/cli/commands/hook.ts) calls `consumeDeferredPrompt()` BEFORE all other gates: single-use print+delete if `DREAMCONTEXT_DEFERRED_PROMPT` exists and passes the basename-prefix guard (`dreamcontext-deferred-*`), so the parked prompt rides the USER's first message.
- [x] Any DOM slot receiving `.agent-pane-term` (xterm container, absolutely positioned inset:0) MUST declare `position: relative` to act as the containing block; without it the terminal resolves against the nearest positioned ancestor (e.g. a fixed overlay) and paints over the whole page.
- [x] Any slot hosting an agent terminal MUST carry the `agent-pane-slot` CLASS (all xterm visual rules — 14/20px padding, transparent viewport, scrollbar skin, letter-spacing measurement fix — are scoped to it) but NOT `data-pane` (the surface's pane-homing query).
- [x] Any slot hosting an agent terminal MUST sit on `--color-bg` canvas and be observed for resize (the overlay's ResizeObserver only watches `hostRef` — page-tree slots need their own, 150ms settle debounce) or the xterm grid goes stale and clips.
- [x] Any slot hosting a composer MUST declare `container: agentpane / inline-size` or the `@container` breakpoints never match.
- [x] Per-pane `PaneComposer` is React-portaled from `AgentSurface` into a page-owned anchor div (`.agent-task-manager-composer[data-task]`) for Task Manager sessions — the React-rendered counterpart of the raw-DOM terminal hoist. Composer actions need surface-owned session state, so the surface renders the portal; TM sessions are roster-less by design, so TM action helpers resolve straight from the live sessions map and never `setExpanded`.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-17] Terminal slot contract — position:relative, agent-pane-slot class, resize observation, container query.** Any DOM slot receiving the agent terminal's container must: (a) be `position:relative` (container is `absolute inset:0` — without it the terminal resolves to the nearest positioned ancestor, e.g. a fixed overlay = whole-page takeover); (b) carry the `agent-pane-slot` CLASS (all xterm visual rules — 14/20px padding, transparent viewport, scrollbar skin, letter-spacing measurement fix — are scoped to it) but NOT `data-pane` (the surface's pane-homing query); (c) sit on `--color-bg` canvas; (d) be observed for resize (the overlay's ResizeObserver only watches `hostRef` — page-tree slots need their own, 150ms settle debounce) or the xterm grid goes stale and clips; (e) declare `container: agentpane / inline-size` if it hosts the composer, or the `@container` breakpoints never match.
- **[2026-07-17] Portal composer pattern for in-pane sessions (Task Manager).** The per-pane composer bar (`PaneComposer`) is reused OUTSIDE the overlay by React-portaling it from `AgentSurface` into a page-owned anchor div (`.agent-task-manager-composer[data-task]`) — the React-rendered counterpart of the raw-DOM terminal hoist. Rule: composer actions need surface-owned session state, so the surface renders the portal; TM sessions are roster-less by design, so TM action helpers resolve straight from the live sessions map and never `setExpanded`.
- **[2026-07-17] Deferred first-message context (deferPrompt).** A new cross-layer mechanism: the embedded terminal can park an initial prompt instead of auto-submitting it. Client: `deferPrompt` param through `createSession`/spawn → `&deferPrompt=1` on the WS upgrade. Server (`agent-terminal.ts` `startPtySession`): parks the sanitized prompt in tmpdir (`dreamcontext-deferred-<uuid>.txt`, 0600), exports `DREAMCONTEXT_DEFERRED_PROMPT` on the PTY env, drops the prompt entirely on a real resume (transcript already pinned — this also killed the duplicate-pin-after-relaunch bug), cleans the file on PTY exit. Hook (`user-prompt-submit`): `consumeDeferredPrompt()` — single-use print+delete BEFORE all other gates, basename-prefix guard. Effect: the session boots idle; the pin context rides the USER's first message. Old servers ignore the flag. 6 tests in `tests/unit/hook.test.ts`.
- **[2026-07-10] WKWebView clipboard is persistently hostile to UTF-8 — third fix, Tauri native clipboard is durable.** Copying Turkish/UTF-8 text from the terminal regressed AGAIN (Ş→"≈û", ü→"√º"), despite the 2026-07-01 `execCommand('copy')` fix. Root cause this time: environmental, not code — `execCommand` degraded in a newer WKWebView and the code fell through to its own `navigator.clipboard.writeText` fallback (the exact call that mangles non-ASCII). Timeline: (1) 2026-07-01 original UTF-8 corruption discovered, fixed with hidden-textarea `execCommand` primary + `navigator.clipboard` fallback; (2) 2026-07-10 `execCommand` degraded silently (WKWebView update?), fell through to the mangling fallback; (3) 2026-07-10 durable fix: on desktop, **bypass the WKWebView JS clipboard entirely** and write via Tauri's clipboard plugin (Rust-side OS clipboard). New `clipboard.ts` strategy order: desktop = [tauri, exec-command, navigator]; web = [exec-command, navigator]. The mangling `navigator` path is never reached before an encoding-safe one. Lesson: **WKWebView JS clipboard APIs are not reliable for non-ASCII; always route to the native OS clipboard on desktop.**
- **[2026-07-04] Auto-title reads the transcript file, never the raw PTY stream.** Every agent tab is pinned to a known conversation UUID and Claude Code already writes that conversation to `~/.claude/projects/<slug>/<uuid>.jsonl` (used for the existing resume check) — reading the first user message from there is far simpler and more reliable than parsing PTY output. `findTranscriptPath()` is now the shared primitive behind both auto-resume and auto-title.
- **[2026-07-04] Auto-title runs in `homedir()`, not the vault.** A titling call is a plain `claude -p` invocation; running it inside the vault would trigger that project's SessionStart brain-preload for a throwaway one-shot call — wasteful and pointless for a 6-word title.
- **[2026-07-04] A manual rename always wins over auto-title, even mid-flight.** The dedup guard (`autoTitledRef`) fires at most once per session, but the apply step itself re-checks that the tab still holds its default `Agent N` name before overwriting — so a user who renames a tab while Haiku is still "thinking" never gets clobbered.
- **[2026-07-04] Shell tabs (`kind=shell`) deliberately skip the whole claude-specific machinery** (bypass permission mode, `--resume`/`--session-id`, auto-title) — a plain login shell has no conversation and no permission model, so threading those through would be dead code paths, not future-proofing.
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

Key files summary (post-2026-07-01 readability polish; 2026-07-04 basic-terminal-mode + auto-title + agent-settings additions):
- `src/server/routes/agent-terminal.ts` — WS bridge + node-pty spawn, capabilities, prereq installer, osascript fallback, `?kind=agent|shell` branch, `findTranscriptPath`/`firstUserMessage`/`generateTitle`/`handleAgentTitle` (auto-title).
- `src/server/routes/agent-sessions.ts` — session management (added 2026-06-30).
- `src/server/routes/agent-drop.ts` — any-file DnD drop endpoint; routes to the pane under the cursor (opened up from image-only + last-focused-pane on 2026-07-01).
- `src/server/routes/launcher.ts` — `handleAgentSettingsGet`/`handleAgentSettingsSet` (`GET`/`POST /api/launcher/agent-settings`, `~/.dreamcontext/agent-ui.json`).
- `src/server/index.ts` — orchestration, VAULT_AGNOSTIC_PREFIXES.
- `dashboard/src/components/sleepy/AgentSurface.tsx` — `Prereqs`, multi-pane layout, dragend split pattern, cursor-targeted drop routing (`onTermDrop` → `elementFromPoint`), `kind` threaded through spawn/split/resume/hydration, auto-title effect (`autoTitledRef` dedup on busy→idle edge), split `＋ New ▾` Agent/Terminal control + `⌃\`` shortcut, `>_ Start terminal` empty-state button.
- `dashboard/src/components/sleepy/agentSession.ts` — `createSession()` (xterm DOM renderer, `@xterm/addon-fit`, WebGL removed, `SessionKind` param), `readXtermTheme()` (`minimumContrastRatio: 3`, softened foreground, solid `#6a57d6` selection for both active/inactive), JetBrains-Mono-aware font-load-before-open, `copyPreservingUnicode()` + beep-free ⌘C/⌘X/⌘A handler.
- `dashboard/src/components/sleepy/AgentTerminal.css` — inactive-pane dimming removed; `.xterm` font-smoothing override (`-webkit-font-smoothing: auto`).
- `dashboard/src/components/sleepy/AgentTabs.tsx` — per-pane tab bars; `◇`/`>_` session-kind glyph.
- `dashboard/src/styles/tokens.css` + `dashboard/index.html` — `--font-mono` primary is JetBrains Mono (loaded 400/500/700); Sometype Mono removed (was never loaded).
- `dashboard/src/components/sleepy/AgentDock.tsx` — minimize-to-corner chip (sibling of .agent-surface).
- `dashboard/src/components/sleepy/AgentFab.tsx` — global FAB.
- `dashboard/src/lib/agentSettings.ts` — `AgentSettings` type, `readAgentSettings`/`writeAgentSettings`/`initAgentSettingsFromServer`, `accelFromKeyEvent`/`matchesAccel` (shared hotkey-capture format with `lib/sleepy.ts`).
- `dashboard/src/pages/SettingsPage.tsx` — Settings → Agents (BETA, desktop-only) section wired to `agentSettings.ts`.
- `dashboard/src/components/search/CommandPalette.tsx` — ⌘K palette; now shares `lib/overlayStack.ts` with the `⌘P` `ProjectSwitcher` (see `core/features/launcher-project-switcher.md`) for correct Esc-closes-topmost behavior when both are open.
- `dashboard/src/hooks/useFocusTarget.ts`, `dashboard/src/lib/recallNav.ts` — recall navigation wiring.

## Notes

- Desktop-only feature; never ships in the npm package. Gated on `DREAMCONTEXT_DESKTOP=1` (injected by the Rust shell).
- The `claude` PTY grandchildren this feature spawns are now reaped on server shutdown (a tracked-child registry added as part of the 2026-06-30 orphaned-dashboard-server fix) — see `[[desktop-beta-tauri-multivault]]` § orphaned-server root-cause fix. This is an infra-level lifecycle fix, not a terminal-feature change; documented there, not duplicated here.
- `ensurePtyHelperExecutable()` runs at startup to restore `+x` on the prebuilt spawn-helper (tarball strips execute bit → `posix_spawnp failed`); idempotent.
- Plan mode (`--permission-mode plan`) is always available via the external-terminal fallback (`POST /api/agent/open-terminal`); the in-app embedded plan mode is the remaining open AC.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-17 — Deferred prompt + terminal slot contract + portal composer (commits ef0ebf7→ee957c2, tasks: in-app-task-detail-inline-agent-curate…, delegate-a-task…)
- **Deferred first-message context (`deferPrompt`)**: opening a task's Task Manager no longer auto-submits the pin prompt — the session boots idle, and the prompt rides the USER's first message instead. Client: `deferPrompt` threaded through `createSession`/spawn → `&deferPrompt=1` on the WS upgrade; the TM prompt is reworded as accompanying context ("answer the user's message") rather than a standalone opener. Server (`agent-terminal.ts`): a deferred prompt is parked in a tmp file (0600) and its path exported as `DREAMCONTEXT_DEFERRED_PROMPT` on the PTY; on a real resume it is dropped entirely (the transcript already holds the pin — this also kills the duplicate pin message after every app relaunch). Cleaned up on PTY exit. Hook (`user-prompt-submit`): `consumeDeferredPrompt()` — single-use print+delete before any other gate, so the context joins the first user message — typed or via a quick action. Basename-prefix guard keeps a mangled env value from splicing arbitrary files into context. Old servers ignore the flag and keep the previous auto-submit behavior. 6 tests in `tests/unit/hook.test.ts`.
- **Terminal slot contract**: formalized the DOM/CSS requirements for any slot that receives the agent terminal's container: `position:relative` (the container is `absolute inset:0` — without it the terminal resolves to the nearest positioned ancestor, e.g. a fixed overlay = whole-page takeover); carry the `agent-pane-slot` CLASS (all xterm visual rules — 14/20px padding, transparent viewport, scrollbar skin, letter-spacing measurement fix — are scoped to it) but NOT `data-pane` (the surface's pane-homing query); sit on `--color-bg` canvas; be observed for resize (the overlay's ResizeObserver only watches `hostRef` — page-tree slots need their own, 150ms settle debounce) or the xterm grid goes stale and clips; declare `container: agentpane / inline-size` if it hosts the composer, or the `@container` breakpoints never match. Fixes the terminal painting over the whole page when Task Manager opened or the task went fullscreen.
- **Portal composer pattern**: the per-pane composer bar (`PaneComposer`) is reused OUTSIDE the overlay by React-portaling it from `AgentSurface` into a page-owned anchor div (`.agent-task-manager-composer[data-task]`) — the React-rendered counterpart of the raw-DOM terminal hoist. Rule: composer actions need surface-owned session state, so the surface renders the portal; TM sessions are roster-less by design, so TM action helpers resolve straight from the live sessions map and never `setExpanded`. The portal anchor sits below the terminal slot and observes its own resize.
- Touched files: `AgentSurface.tsx`, `agentSession.ts`, `TaskManagerPane.tsx` + `.css`, `taskManagerAgent.ts`, `agent-terminal.ts`, `hook.ts`, `tests/unit/hook.test.ts`.

### 2026-07-10 — UTF-8 clipboard regression fix, third iteration (commit f293db0, #171)
- Turkish/UTF-8 copy mojibake regressed AGAIN (Ş→"≈û", ü→"√º"), despite the 2026-07-01 `execCommand('copy')` fix. Root cause: `execCommand` degraded in a newer WKWebView (environmental, not code change) and fell through to the `navigator.clipboard.writeText` fallback — the exact call that mangles non-ASCII.
- Durable fix: on desktop, bypass the WKWebView JS clipboard entirely and write via **Tauri's clipboard plugin** (Rust-side OS clipboard). New `dashboard/src/lib/clipboard.ts`: pure `clipboardStrategyOrder()` — desktop = [tauri, exec-command, navigator]; web = [exec-command, navigator]. The mangling `navigator` path is never reached before an encoding-safe one.
- Added tauri-plugin-clipboard-manager v2 (Cargo + lib.rs init) + capability `clipboard-manager:allow-write-text`; `@tauri-apps/plugin-clipboard-manager` on JS side.
- Added `tests/unit/clipboard-encoding.test.ts` (6 tests): strategy order + UTF-8 byte-identity + Mac-Roman corruption model with Turkish fixture.
- Lesson: **WKWebView JS clipboard APIs are not reliable for non-ASCII; always route to the native OS clipboard on desktop.**
- Status: committed to branch `fix/171-agent-copy-utf8-mojibake`, pending merge.

### 2026-07-04 — Settings polish + split-button fix (working tree, feat/sleep-debt-header-tracker)
- **Settings → Agents section now uses the "Lab" chip** (the violet marker shared with Council in the sidebar) instead of a generic BETA badge — Sleepy/Agents surfaces are experimental, and the app's existing Lab language unifies them.
- **Double-tap-a-single-modifier hotkey support** (⌃⌃, ⌥⌥, ⌘⌘, ⇧⇧ / Ctrl×2, Option×2, Cmd×2, Shift×2): click the hotkey field and tap a lone modifier twice within 400ms → binds as e.g. `Ctrl+Ctrl`, displays as "Ctrl ×2". Auto-repeat while holding is ignored; an intervening key resets the sequence. Runtime: a stateful double-tap matcher toggles the terminal. Crucially, a double-tap of a bare modifier toggles from **anywhere — including inside a focused terminal** (a lone modifier never reaches the PTY), which is exactly what "double-tap Ctrl to close/open the terminal" wants. Chords still yield to a focused terminal as before.
- **Split-button dropdown fix** (`＋ New ▾` in AgentSurface header): the dropdown menu was unreachable (positioned with a 6px gap below the wrapper but `onMouseLeave` closed it the instant the cursor left the narrow button+caret box to cross the gap). Fixed: click-driven dropdown (no hover-close), stays open until you pick an item, click outside, or press Esc. The collapse-overlay Esc handler now yields when the menu is open (`if (document.querySelector('.agent-new-menu')) return;`) so Esc closes just the menu, not the whole agent surface. Picking "New agent" or "New terminal" still works; clicking the main `＋ New` face still spawns an agent directly (unchanged).
- Touched: `dashboard/src/lib/agentSettings.ts` (double-tap helpers: `loneModifierToken`, `doubleTapToken`, `createDoubleTapMatcher`, `formatHotkey`), `AgentSurface.tsx` (split-button ref + outside-click/Esc effect, double-tap runtime matcher, collapse-Esc deconfliction), `SettingsPage.tsx` (Lab chip, double-tap capture, `lastModTapRef` state), `SettingsPage.css`, `I18nContext.tsx` (i18n hint update). Verified in the packaged Tauri app. Not yet committed or merged.

### 2026-07-04 — Basic-terminal mode + auto-title + Agents settings (task feat-desktop-basic-terminal-mode-in-agent-surface, working tree)
- Basic-terminal mode: `kind=agent|shell` on the WS bridge; shell tabs run a plain vault-scoped login shell alongside agent tabs (split `＋ New ▾` control, `⌃\`` shortcut, `>_ Start terminal` empty-state button gated on node-pty only); tabs show a `◇`/`>_` glyph. Verified end-to-end in the packaged Tauri app (real zsh prompt scoped to the vault, side-by-side agent+shell).
- Auto-title: `POST /api/agent/title` reads the session's transcript (not the raw PTY stream) and returns a one-shot Haiku-generated tab title; applied once per session on the busy→idle edge, skipped if the user already renamed the tab or auto-title is disabled. Verified live (bad-UUID→400, no-transcript case, and a real crafted-transcript→Haiku title).
- Settings → Agents (BETA, desktop-only): enable/restore-tabs/default-agent/auto-title toggles + a captured in-app hotkey to open/close the Agents overlay; persisted server-side (`~/.dreamcontext/agent-ui.json`, app-global) via `lib/agentSettings.ts`, mirroring the existing Sleepy-hotkey persistence pattern.
- `⌘K` `CommandPalette` now shares `lib/overlayStack.ts` with the new `⌘P` `ProjectSwitcher` (see `core/features/launcher-project-switcher.md`) so Esc always closes the topmost overlay regardless of which opened first.
- Status: in progress (working tree changes, not yet committed); Tauri arm64 build installed locally and smoke-tested (session aac95f46).

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
