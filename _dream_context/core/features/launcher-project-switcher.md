---
id: "feat_OhUtxfpb"
status: "in_review"
created: "2026-07-04"
updated: "2026-07-04"
released_version: null
tags:
  - topic:desktop
  - frontend
  - topic:agents
related_tasks: []
---

## Why

The desktop app is multi-window (one window per vault plus the Launcher), but
switching between projects was slow: the only way to get from project X to
project Y was hunting for another OS window, and closing the Launcher meant
`⌘Q` + relaunch just to get back to it. This feature adds a fast, tab-like
project switcher (`⌘P`) available in EVERY window — launcher or vault — plus
`⌘1…⌘9` quick-jumps, so moving between projects feels like switching browser
tabs instead of window-hunting. It reuses the `⌘K` command palette's proven
overlay/keyboard infrastructure rather than inventing a second, divergent modal
system.

## User Stories

- [x] As a user, I can press `⌘P` in any window (Launcher or a vault) to open a
  "Go to project" switcher, so I never have to hunt for another window.
- [x] As a user, I can type to filter projects by name or path, and use
  arrow keys + Enter to jump to one, so the switcher works like a command palette.
- [x] As a user, I can press `⌘1`–`⌘9` from anywhere to jump straight to the Nth
  open-able project without opening the palette first.
- [x] As a user, in a vault window the switcher hops THIS window to the chosen
  project in place (no new window); in the Launcher window it opens/focuses that
  project's own window — so the action always matches the window I'm in.
- [x] As a user, a "← Launcher" row is always available from a vault window's
  switcher so I can get back home without `⌘Q`.
- [x] As a user, `⌘P` and `Esc` behave correctly even when the embedded agent
  terminal has focus, and even when `⌘K` and `⌘P` are open at the same time, so
  the two palettes never fight over which one a keystroke controls.
- [x] As a user, each project row shows its live status dot (up to date / needs
  update / folder missing) so I know a project's state before I switch to it.

## Acceptance Criteria

- [x] `ProjectSwitcher.tsx` renders a `⌘P`-triggered overlay in every window;
  fetches `useLauncherStatus` only while open (gated `enabled=open`) so it never
  inherits the app-wide 15s status poll while closed.
- [x] `isTerminalTarget(el)` guard (`.xterm`, `.agent-surface`) prevents `⌘P` from
  opening the switcher when the embedded agent terminal has focus — `⌘P` still
  reaches xterm's own key handler there instead of leaking into the PTY; `⌘P`
  still opens the switcher normally from any plain input/page.
- [x] `isEditableTarget(el)` guard (`input`, `textarea`, `select`,
  `[contenteditable]`, `.xterm`, `.agent-surface`) prevents `⌘1`–`⌘9` from
  hijacking normal typing/PTY input; the quick-jump only fires elsewhere.
- [x] `goToProject(name)` (in `lib/desktop.ts`) is context-aware: in a vault window
  it navigates the current window in place; in the Launcher window it opens/focuses
  that project's own window.
- [x] A window-level **capture-phase** `Escape` listener closes the switcher
  regardless of whether the input holds focus (element-scoped listeners are not
  sufficient once focus has moved to a non-focusable element).
- [x] Shared **`overlayStack`** (`lib/overlayStack.ts`) is a LIFO stack that both
  `⌘K` (`CommandPalette`) and `⌘P` (`ProjectSwitcher`) push/pop on open/close;
  `Escape` closes only the topmost overlay (`isTopOverlay(id)`), so `⌘K` then `⌘P`
  then `Esc` closes `⌘P` first, and `Esc` again closes `⌘K` — correct in either
  open order, and any future overlay gets correct `Esc` behavior for free just by
  adopting the same push/pop pair.
- [x] Shared **`<VaultDot>`** component (`components/layout/VaultDot.tsx`/`.css`)
  renders the exists/needs-update/missing status dot; used by both the Launcher
  vault list and `ProjectSwitcher` so the status glyph has one implementation, not
  three inline copies.
- [x] `desktop.ts` exposes a single `DRAG_EXEMPT_SELECTOR` constant + `isDragExempt`
  helper, replacing three inline copies of the same drag-exempt selector logic
  across the Launcher drag handling.
- [x] `prefers-reduced-motion` respected on the switcher's copy/open animation
  (regression from an earlier pass was caught and fixed in code review).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-04]** **`overlayStack` is the general fix, not a `⌘K`/`⌘P`
  special-case.** The bug (⌘P opened while ⌘K was open, then `Esc` closed the
  wrong one) was fixed at the right altitude: a shared LIFO overlay stack that any
  future overlay pushes/pops on open/close, rather than hardcoding "if CommandPalette
  is open, defer to it" inside `ProjectSwitcher`. Every future overlay's `Esc`
  behavior is correct automatically by adopting the same two calls.
- **[2026-07-04]** **`isTerminalTarget` is intentionally narrower than
  `isEditableTarget`.** `⌘P` inside a plain text input is a harmless print-shortcut
  override (browser print is not reachable in the Tauri shell anyway), so `⌘P` is
  still allowed to open the switcher there. Only `.xterm`/`.agent-surface` block
  it, because xterm actively forwards `⌘P` to the PTY (its custom key handler only
  intercepts `⌘C`/`⌘X`/`⌘A`/`⌘⌫`) and opening the switcher there would leak a
  stray keystroke into the running Claude Code session.
- **[2026-07-04]** **Status polling is gated to "while open" (`useLauncherStatus(open)`),
  matching the `⌘K` `useRecall(open?…)` pattern.** `ProjectSwitcher` is always
  mounted (so `⌘P`/`⌘1-9` work globally), so an ungated query would have polled
  `/api/launcher/status` every 15s in every vault window forever. This was an
  actual shipped bug caught in code review (the code's own comment claimed
  "only fetch while open" but the gate was missing) — the review fix made the
  comment true.
- **[2026-07-04]** **Deferred as debt: no shared `<CommandModal>` shell yet.** `⌘K`
  and `⌘P` still duplicate ~180 lines of CSS + modal/keyboard-list scaffolding.
  Unifying them requires touching `⌘K`'s already-proven scrim/focus/Esc structure,
  which is a bigger blast radius than a bug-fix pass — parked as a follow-up
  refactor with its own review, not bundled into this cycle's fixes.

## Technical Details

**Key files:**
- `dashboard/src/components/search/ProjectSwitcher.tsx` / `.css` — the `⌘P`
  overlay: filterable project list, `⌘1`-`⌘9` quick-jump, keyboard nav
  (arrows/Enter), "← Launcher" home row.
- `dashboard/src/lib/overlayStack.ts` — `pushOverlay(id)` / `popOverlay(id)` /
  `isTopOverlay(id)`; shared LIFO stack consumed by both `ProjectSwitcher` and
  `CommandPalette`.
- `dashboard/src/components/layout/VaultDot.tsx` / `.css` — shared status-dot
  component (exists / needs-update / missing), used by the Launcher vault list and
  the switcher.
- `dashboard/src/lib/desktop.ts` — `goToProject(name)` (context-aware navigate),
  `openLauncherHome()`, `DRAG_EXEMPT_SELECTOR` constant + `isDragExempt()` helper.
- `dashboard/src/hooks/useLauncher.ts` — `useLauncherStatus(enabled)`, gated to
  `open` from the switcher (mirrors `⌘K`'s `useRecall(open?…)` gating pattern).
- `dashboard/src/components/search/CommandPalette.tsx` — `⌘K`; now shares
  `overlayStack` with `ProjectSwitcher` instead of independent Esc handling.

**Global keybindings (window-scoped, work in every window):**
- `⌘P` — toggle the switcher (blocked only inside `.xterm`/`.agent-surface`).
- `⌘1`–`⌘9` — jump straight to the Nth open-able (existing) project (blocked
  inside any editable target, including the terminal).
- `Esc` — closes the topmost overlay per `overlayStack`, from anywhere (capture
  phase), regardless of input focus.

## Notes

- Built without a dedicated tracked task in this cycle (ad hoc UX pass triggered by
  direct user feedback about the launcher experience); this PRD is the first
  durable record of the feature. Consider creating a task if further switcher work
  is planned so future sessions have a working document.
- The shared `<CommandModal>` shell consolidation (see Constraints) is open debt —
  a natural next task once someone picks it up.
- Related existing feature: `core/features/launcher-federation-graph.md` (the
  Launcher's per-project status indicator and federation graph — `VaultDot`'s
  status semantics originate there; this feature reuses rather than reimplements
  the status color mapping).
- Related existing feature: `core/features/in-app-agent-terminal.md` (owns the
  `⌘K` command palette this feature's `overlayStack` is shared with).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-04 - Created (sleep-product consolidation)
- Feature PRD created from working-tree code (`ProjectSwitcher.tsx`/`.css`,
  `overlayStack.ts`, `VaultDot.tsx`/`.css`, `desktop.ts` changes) plus a code-review
  pass (session fc7f1b5c) that fixed: missing "fetch only while open" gate, Esc not
  working off-focus, `⌘P` leaking into the terminal PTY, wrong overlay closing when
  `⌘K`+`⌘P` were both open, a `prefers-reduced-motion` regression, and consolidated
  three inline status-dot / drag-exempt-selector copies into shared helpers.
  6 of 7 findings from that review are reflected as shipped ACs above; the shared
  `<CommandModal>` shell (finding #5) is recorded as deferred debt, not shipped.
