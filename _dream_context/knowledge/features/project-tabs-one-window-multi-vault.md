---
id: feat_nLvaWOhX
type: feature
name: project-tabs-one-window-multi-vault
description: >-
  Transform desktop from one OS window per project to one window with a chip
  strip where every open project stays live with per-instance isolation
pinned: false
date: '2026-08-10'
status: in_review
created: '2026-08-10'
updated: '2026-08-14'
released_version: null
product: desktop
tags:
  - 'topic:desktop'
  - architecture
  - 'layer:frontend'
  - 'topic:agents'
related_tasks:
  - one-window-holds-every-open-project-as-a-live-chip-strip
  - >-
    a-project-chip-says-how-many-chats-it-holds-and-how-many-are-working-one-counted-bubble-per-status
---

## Why

**Problem:** dreamcontext desktop used the "one OS window per project" model (inherited from v0.8 beta multi-window architecture). Switching between projects meant hunting windows. When a background project's agent asked a question, it was invisible until you found that window. This friction made multi-project workflows painful.

**Constraint:** A background project with a live chat cannot be unmounted — its PTY is bound to a live WebSocket, so unmounting kills the conversation. Any solution must keep every open project LIVE.

**Solution:** Transform the desktop app into one window with a center-aligned chip strip where every open project stays live in the same window, isolated by per-instance state. A background chip's badge shows its active chat count and jumps when an agent asks, firing a native banner even when the window is focused.

**Who benefits:** Anyone working across multiple dreamcontext projects (team members with multiple clients, personal + work vaults, multi-product portfolios).

## User Stories

- [x] As a user, I want to open multiple projects in one window as a chip strip so that I don't have to hunt between OS windows
- [x] As a user, I want background projects to stay live (WebSocket connections maintained) so that long-running agent tasks continue when I switch away
- [x] As a user, I want to see when a background project's agent asks a question (chip badge shows active chat count, chip jumps once, native banner fires) so that I don't miss questions
- [x] As a user, I want the terminal to stay correctly fitted after switching projects so that TUI output isn't clipped or wrapped
- [x] As a user, I want per-project isolation for settings and permissions so that enabling bypass mode in one project doesn't affect others
- [x] As a user, I want the system to enforce a ceiling (6 live instances) and evict idle projects to cold chips so that the window doesn't degrade under load
- [x] As a user, I want to see how many chats a project holds and how many are in each state (asking/working/idle) so that I know what each chip is doing at a glance
- [ ] As a user, I want multi-window to remain an escape hatch (Shift-click to open in new window) so that I can spread projects across displays

## Acceptance Criteria

### Automated (9/9 PASS at in_review)
- [x] `npx tsc --noEmit` at repo root: exit 0, zero diagnostics
- [x] `cd dashboard && npx tsc --noEmit`: exit 0, zero diagnostics
- [x] `npm test` green: 0 failed, 0 skipped
- [x] NEW unit test `tests/unit/agent-status-project-rollup.test.ts` green (11 tests: rollupProject worst-of ordering, saved/ended/shell excluded from live, `alive` field regression lock)
- [x] NEW unit test `tests/unit/scoped-storage.test.ts` green (17 tests: scoped-key shape, legacy→scoped migration, second vault gets fallback, keepLegacy preserves legacy key)
- [x] `npm run build` exits 0 and produces dashboard bundle
- [x] `grep -rn 'getActiveVault()' dashboard/src` matches ONLY inside `dashboard/src/api/client.ts` (module-global activeVault dead except deprecated pair)
- [x] Only sanctioned `window.dispatchEvent` sites remain: dreamcontext-zoom, AGENT_SETTINGS_EVENT, ANNOUNCEMENTS_READ_EVENT, dead AUTO_CHECKPOINT_EVENT
- [x] RED LINE: `grep -rn 'isActive' dashboard/src/components/sleepy/{agentSession.ts,chatSession.ts}` returns zero matches — WebSockets never tied to visibility
- [x] NEW unit test `tests/unit/agent-status-project-rollup.test.ts` expanded 10→19 tests: bucket split (asking/working/idle partition `live`), starting-folds-into-working, attention-lands-in-asking, urgent-bucket-wins, saved/ended counted nowhere, shells excluded from all three, shell-bell regression lock, partition invariant (asking+working+idle===live)

### Runtime (6/9 proven at in_review, 3 unproven)
- [x] Register two vaults, open both as chips: both render in centered strip, both instances live with their own data
- [ ] Start chat in A, switch to B: A's chat keeps streaming, WebSocket never closed, B's page data loads independently
- [x] A's chat asks while on B: A's chip dot red, bounces once, badge shows active chat count, native banner fires even though window focused
- [ ] Return to A: term.cols/rows match visible grid, no clipped/wrapped TUI, scrollback intact (M-x1 measurement)
- [ ] Close one chip: only that project's sessions end, other project still streaming, no orphaned claude process
- [ ] Open same project twice (via +, via CMD-P, from second window): in-window focuses existing chip, from another window that window focused
- [ ] Open 7th tab: if any instance has `rollup.live === 0` oldest torn down to cold chip; if all busy tab refused with stated reason. Instance with no published rollup never evicted
- [x] Add 3rd chip then close one with cursor over strip: adding re-centers; pointer inside strip freezes layout on close; leaving re-centers; overflow left-aligned + scrollable
- [x] Quit and relaunch: exactly ONE project returns (launcher's ?vault=), no tab list persisted
- [x] Status bubbles (verified): a project holding no chats draws no bubbles; three distinct non-transparent fills; equal heights across states and digit counts; loading ring animated by @property angle (Safari 16.4+)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-08-14 - The pick moved from ⌃Tab to ⌥Tab

- **⌥Tab / ⌥⇧Tab now walks the chip strip; Control is given back to the shell.** User request, and the rationale outlives the preference: Control chords belong to the PTY. ⌃C, ⌃D, ⌃W, ⌃A and the rest have to arrive intact, and a `window`-level capture-phase listener that eats one is a bug the terminal can never explain to the user. Claiming Option instead costs nothing — macOS binds ⌥Tab to nothing, and the app's only other Option chord is ⌥⌫ (delete-word, inside the terminal), which is not a Tab. ⌘Tab remains impossible for the reason recorded on 2026-08-13.
- **The gesture's SHAPE is unchanged** — still a held pick, not a press-to-switch: the first ⌥Tab opens a cursor, each further Tab (or ← / →) moves it, and the switch happens once on the RELEASE of Option. Everything the hold bought (never rebuilding a cold instance you only tabbed past) is intact.
- **Three handler edits, all in `WindowChrome.tsx`** — the keydown guard flipped from `metaKey || altKey` to `metaKey || ctrlKey` (Option must now be ALLOWED through, and the guard is what would otherwise swallow the arrow keys mid-pick, since they carry `altKey: true` while Option is held); the chord test became `key === 'Tab' && altKey`; and the keyup arm became `key !== 'Alt' && altKey` — macOS reports the Option key as `Alt`.
- **Proven by real keystroke, not by reading the handler** — `npm run verify:project-tabs` 19/19, with M5 (⌥Tab / ⌥⇧Tab cycle, no remount) and M6 (preview while held, commit on release) green against a real Chromium. This was the check worth running rather than reasoning about: whether macOS delivers ⌥Tab to a web view as `key: 'Tab'` at all is an empirical question, and the answer is yes.

### 2026-08-14 - Status bubble redesign: counted marks per state, loading legibility

**Owner report (2026-08-14):** "bana kaç chat var kaçı çalışıyoru vermiyor, loading olduğunu bile anlamıyorum doğru dürüst." The chip rolled N sessions into ONE dot + ONE live count, so composition was lost — nothing said how many were working, waiting, or loading.

**Shipped solution:**
- **Counted bubbles per state** — sessions in the SAME STATE collapse into ONE bubble carrying their count; a state with nothing in it draws nothing. Three states (asking/working/idle), so at most three bubbles whether the project holds 2 chats or 20. This is why the strip is handed counts rather than a list of sessions: one mark per session answers the same questions but does not fit in 150px.
- **rollupProject partition** — `asking`/`working`/`idle` are FLAT primitives (not a nested object — AgentSurface publishes through a dependency array, and a fresh object identity would republish several times per second while a turn streams). Invariant-tested: `asking + working + idle === live`.
- **Starting folds into working** — a session attaching its PTY is doing something, and a fourth bubble would spend a third of the row on a state lasting under a second.
- **Saved/ended counted nowhere** — they are not live, not asking, not working, not idle.
- **Shells excluded from all three** — so the counts PARTITION `live`. A shell ringing its bell moves `waiting` without moving a bubble (same as existing `live`/`alive` split).
- **`waiting` vs `asking` NOT collapsed** — `waiting` counts every session kind so the chip still bounces for a finished build; `asking` is chat-only so the partition holds. Regression-locked.
- **Color collision fixed** — the accent violet used to mean "working" on the project strip and "ready" on the chat tab strip 40px below it (one hue, two opposite meanings on one screen). Now the chip segment is neutral in every state and the bubbles name their own state, so the collision is gone by construction.
- **Loading legibility rule** — an 8px dot changing opacity reads as flicker, not progress. A mark that TRAVELS (a ~24px ring) reads as running. The ring is a conic-gradient masked to its own border, animated via a registered `@property` angle (not a transform — a rotate would spin the stadium SHAPE at two-digit counts instead of running a mark around its edge). Under `prefers-reduced-motion` it STOPS rather than hides, so the state never lives in the animation alone. Ring inset (4px) kept under bubble gap (7px) so it cannot smear into its neighbour.
- **Bubble height fixed at 16px** — pill grows sideways, so a count crossing 9 cannot nudge the chips beside it.
- **`handleRollup` comparison bug fixed** — the inline three-field comparison became `sameRollup()` which walks every key. The old form silently dropped `alive`, so a shell opening or closing could not reach the chrome while the other three sat still.

**Hover peek deferred:** showing which chat is in which state needs session TITLES at chip level (a new cross-instance channel on a bus that already warns about republish frequency). Design decision worth its own pass, not a rider on this one.

### 2026-08-13 - ⌃Tab cycling + harness race fix

- **⌃Tab / ⌃⇧Tab walks the chip strip** — Control+Tab moves forward, Control+Shift+Tab back, wrapping both ends. The user asked for ⌘Tab and it is impossible: macOS hands ⌘Tab to the app switcher before any web view is offered it — `dashboard/src/lib/sleepy.ts` already refuses it in `RESERVED_HOTKEYS` for the same reason. Listener on `window` in the CAPTURE phase so a chip is switchable while a terminal pane holds focus WITHOUT the keystroke also reaching the PTY (this is the app's second and last claimed Ctrl chord — `AgentSurface` has ⌃\` — every other Ctrl chord must reach the shell). The key is NOT claimed at all with a single chip. Cold chips are cycled into (revival, same as a click), and at the instance ceiling with every other project busy that revival can be refused, leaving the cycle still with the same notice a click would raise. Tooltip gains "· ⌃Tab to switch" once a second chip exists.
- **Instant presence check on async-raised UI is a race** (harness S7 fix) — The announcements modal is raised by an API round trip, so an instant `.count()` check can read lateness as "no modal appeared" — and then the scrim would arrive on its own schedule and swallow the next click (the `+` that opens a second project), surfacing as a misleading failure about chips. Both sites (S7 check and `clearScrims()` helper) now wait bounded (`await scrim.first().waitFor({ state: 'attached', timeout: N })`) while still failing when nothing ever appears. An announcement that never comes is still a failure (the point of the check), it is just no longer a failure the harness manufactures by looking too early. This pattern has been seen ONCE (one fix, two similar sites in the same harness) — does not yet earn a pattern file, lives here until it recurs in a different context.

### Hard Constraints (red lines)
- **Live chats NEVER unmounted.** PTY bound to live WebSocket; unmounting kills conversation. Hiding is `display:none` + `inert`, nothing else.
- **WebSockets NEVER tied to `isActive`.** Only page-data `refetchInterval` pauses; agent surface's own polling continues in background so a background goal-skill run's badge doesn't freeze.
- **No tab persistence.** Every launch opens exactly ONE project (launcher's `?vault=`). Deliberate simplicity.
- **Ceiling of 6 live instances.** At ceiling, oldest instance with `rollup.live === 0` torn down to cold chip (sessions disposed, remounted on click). If all busy, new tab refused with stated reason.
- **Same project never open twice** (in this window or another). Focus existing chip/window instead.

### Closed Decisions
- **Per-vault isolation:** `chatPermissionMode` (permission gate), `autoCheckpointOnOpen` (git behavior), `githubSyncSeen` (brain enable CTA), `activePage` (navigation), `chat.mediaBoxes` (path collisions) all scoped. `sidebarCollapsed` hoisted to chrome. Theme/zoom/announcements stay global.
- **Attention throttle per source.** Map keyed by vault name gates banner + Dock bounce separately; global floor for chime (one AudioContext, one voice correct).
- **Chip activity probe.** `setChipActiveProbe((vault) => vault === activeRef.current)` registered by WindowChrome so attention system knows which chip is visible.
- **No escape to new window from chip strip itself** — only via Shift-click in ProjectSwitcher or right-click context menu (cut on YAGNI).
- **Eviction gate is `alive`, not `live`.** `ProjectRollup.live` excludes shells (it's the chat badge count); a project with only a running shell (dev server) must not report `live:0` and be evictable mid-process. `ProjectRollup.alive` counts any row with a live PTY/WebSocket, shells included.

### Review Findings (Waves 2-4, then post-in_review hardening)
- **M7 (T8):** `fitVisible()` must early-return on `!isActive` — two other paths call it while hidden, and fitting a `display:none` xterm degrades to no-op only by luck (position:absolute;inset:0 → height auto → NaN → FitAddon bails).
- **M8 (T11):** `markSleepPending`/`clearSleepPending` gained `vault` — a global key meant clicking "Run sleep" in A put B's tracker into "Waiting to sleep..." and disabled its menu item.
- **M9 (T18/T19/T20, CRITICAL):** `ProjectRollup.live` was the eviction test but excludes shells → project with only a running shell reported `live:0`, was evicted, PTY killed mid-process. Fixed by adding `ProjectRollup.alive` as sole eviction gate, regression-locked.
- **2026-08-10 post-in_review defects** (session 26f43715, committed `480b4f3` + PR #291):
  - **Escape stack broken in both directions.** Single LIFO across mounted-but-hidden projects didn't know which was on-screen. A opens panel → switch to B → B opens panel → return to A: A's visible panel was Escape-deaf. Reverse order: B's Escape closed A's hidden panel. `popAllWithPrefix` existed but was uncalled — and calling it wouldn't fix it, because a mounted panel leaves no record on return so the bug would just move. Fixed: scope captured at PUSH time, Escape answered per-scope. This also fixed three popovers (tooltip, command palette, insight drill-in) using `useId()` vault-unaware.
  - **Eviction ceiling read the `live` badge counter,** which excludes shells. A project whose only live row was a dev server looked idle (`live:0`) and would have had its PTY killed. Fixed: separate `alive` counter (any live PTY/WebSocket, shells included), regression test named after the bug.
  - **Smoke test was single-vault** — the one shape that could never catch a cross-project bug. Now opens two vaults, 12/12. Step S7 had been passing with no modal to close (correctly rejected).

## Technical Details

### Architecture
- **ProjectInstance** (`dashboard/src/ProjectInstance.tsx`): one mounted React app per vault, each with its own `instanceQueryClient` (React Query cache isolation), `VaultContext`, scoped localStorage, and event bus.
- **WindowChrome** (`dashboard/src/components/layout/WindowChrome.tsx`): the shell that owns the instance lifecycle, chip registry (`OpenProject[]`), ceiling enforcement (`MAX_LIVE_INSTANCES=6`), eviction (oldest `rollup.alive === 0`), window registry heartbeat, and ⌥Tab cycling (capture-phase listener on `window`, only claimed with ≥2 chips). Also publishes chrome slots via `ChromeSlotsProvider`.
- **ProjectTabs** (`dashboard/src/components/layout/ProjectTabs.tsx` + `.css`): the center-aligned chip strip. Rule 1 (freeze): `pointerenter` snapshots leading gap + each chip's width, so a chip closed while frozen leaves a ghost and neighbors don't slide under cursor. Rule 2 (fall left): `margin-inline:auto` collapses to 0 when content exceeds container, so CSS and overflow flag can't disagree. Tooltip appends "· hold ⌥ and press Tab to switch" when ≥2 chips. **Status bubbles** (2026-08-14): the old dot+badge is gone; now up to three counted bubbles (asking/working/idle) with fixed 16px height and horizontal growth, neutral chip segment (the accent violet collision is fixed by construction), and a ~24px loading ring animated via registered `@property` angle that stops (not hides) under `prefers-reduced-motion`.
- **One-bar chrome refactor** (`dashboard/src/components/layout/chromeSlots.tsx`, `Header.tsx`): The window has ONE bar, but the collapse toggle, search pill, and sleep tracker belong to whichever PROJECT is on screen — they read that instance's query cache, bus, and palette state. The chrome publishes two mount points (`ChromeSlots: {left, right}`) and the active instance's `Header` portals its controls into them. Only the ACTIVE instance renders into the slots; a hidden instance renders nothing, because a portal escapes the `.project-instance` subtree and would ignore its `hidden`/`inert` shroud entirely. The `--header-height` double-rebase in `ProjectTabs.css` is GONE because there is only one bar again; the manual refresh button was dropped.
- **Per-vault ApiClient** (`dashboard/src/api/client.ts`): was module-level singleton `api`, now a class. Module-global `api` survives for capture/perch windows (separate OS windows, legitimately single-vault). Migrated ~28 hooks + 12 components off `getActiveVault()`.

### State Isolation
- **VaultContext** (`dashboard/src/context/VaultContext.tsx`): `{vault, bus: EventTarget, instanceId}`. `useVault()` never throws (launcher safe); `useApi()` reads vault from context, returns per-instance `ApiClient`.
- **Scoped storage** (`dashboard/src/lib/scopedStorage.ts`): `scopedKey(vault, key)` → `dc:${vault}:${key}`. Migration: on first read, `getItem(key)` copies to scoped key for that vault. `keepLegacy: true` preserves bare key (e.g., `autoCheckpointOnOpen` — unset default is ON, so inheritance would silently enable git auto-commit everywhere).
- **Instance QueryClient** (`dashboard/src/lib/instanceQueryClient.ts`): default `refetchInterval: false` (paused when backgrounded). Three hooks override explicitly: `useAgentSessionStats` (5s), `useAgentGoalLive` (2s), `useAgentCouncilLive` (2s) — session-stats/goal/council polling survives backgrounding so badge stays current.

### Event Bus Migration
Ten events moved from `window` to instance bus: `navigate`, `agent-open-page`, `delegate`, `run-sleep-agent`, `sleep-pending`, `brain-resolve`, `automation-run-chat`, `claude-signin`, `chatPermissionMode` consumption. Four correctly stayed global: `dreamcontext-zoom`, `AGENT_SETTINGS_EVENT`, `ANNOUNCEMENTS_READ_EVENT`, dead `AUTO_CHECKPOINT_EVENT`.

### Cross-Instance Coordination
- **Window registry** (`dashboard/src/lib/windowRegistry.ts`): `localStorage['dc.windows.v1']` heartbeat (5s), 15s staleness GC. `findWindowForVault(vault)` → label or null (registry-only, skips this window's own row). `resolveLiveWindowForVault(vault)` corroborates against `WebviewWindow.getAll()` (registry ∩ actual windows).
- **Desktop bridge** (`dashboard/src/lib/desktop.ts`): `focusWindow(label)`, `goToProject` seam (module-level `setGoToProjectHandler(fn|null)` registered by WindowChrome, falls back to `openVaultWindow` when nothing registered — launcher window byte-identical).
- **Checklist submit** (`dashboard/src/lib/checklistBridge.ts`): corroborated label (registry ∩ `WebviewWindow.getAll()`), returns `false` when it can't — fail-closed, no derived labels.

### Attention System
- **Per-source throttle** (`dashboard/src/lib/attention.ts`): `lastRaiseBySource: Map<string, number>` keyed on vault name gates banner + Dock bounce separately. Separate module `lastChime` keeps global 1500ms floor for `playAskChime()` (one AudioContext).
- **Chip active probe:** `setChipActiveProbe((vault) => vault === activeRef.current)` — closes over ref, not value, registered mount-only by WindowChrome. Guard: `isWatchingThisWindow() && (chipActiveProbe?.(source) ?? true)` — short-circuits true for empty source (source-less alarm can't be attributed to any chip).

### Lab Route Ownership
- **labRoute.ts** (`dashboard/src/components/lab/funnel/labRoute.ts`, 232 lines): routing moved to the bus. `setLabRouteWritable(on: boolean, bus: EventTarget)` claims/releases address bar ownership. Ownership held as **bus, not boolean** — stale release from outgoing instance can't unseat incoming one. Release parks `pathname+search` in `WeakMap` keyed by bus, resets path to `/` (query kept) so reload can't resurrect one vault's funnel under another. Re-activation flushes parked route with `replaceState` (not `pushState` — returning to chip isn't Back-button step). `LabPage` owns toggle; background instances read parked route, never live URL.

### Overlay ID Namespacing
- **useOverlayId** (`dashboard/src/lib/useOverlayId.ts`): `` `${instanceId}::${local}` `` via `useVault()`. Five literal-id sites converted: `command-palette`, `chat-history`, `announcements-modal`, `insight-detail-panel`, `automation-detail-panel`. `popAllWithPrefix(prefix)` for future chip-deactivate call.

### XTerm Re-Drive
- **agentSession.ts** (`dashboard/src/components/sleepy/agentSession.ts`): `ensureOpen` gained `{focus?: boolean}`. New activation effect keyed `[isActive, fitVisible]` with rAF. RO gate tightened to `!expanded || !isActive`. Unmount-only teardown disposing `sessions.current`. `fitVisible()` early-returns on `!isActive` (M7 fix).

### ProjectRollup
- **agentStatus.ts** (`dashboard/src/components/sleepy/agentStatus.ts`): `rollupProject(rows): ProjectRollup` → `{worst: SessionStatusKind; live: number; waiting: number; alive: number; asking: number; working: number; idle: number}` (2026-08-14 expanded). `alive` counts rows where `info.kind ∉ {'saved','ended'}` (shells included); `live` excludes shells (chat badge count). `asking`/`working`/`idle` are flat primitives (not nested — fresh object identity would republish on every render). Partition invariant: `asking + working + idle === live`. Starting folds into working; saved/ended counted nowhere; shells excluded from all three. Eviction gate reads `rollup.alive === 0`, never `live`.

### Verification
- **scripts/verify/project-tabs.mjs**: runtime verification script (19/19 green against real server with isolated scratch HOME and `DREAMCONTEXT_DESKTOP=1`). Proven: vault window boots, one ProjectInstance mounts, chip renders, instance neither hidden nor inert, `.project-instance[hidden]` computes `display:none`, reload returns one project (S1-S7), two registered vaults open as two chips with both instances mounted, exactly one visible (M1-M4), ⌥Tab/⌥⇧Tab cycle the chip strip by real keystroke without remounting instances (M5), a HELD ⌥Tab previews and commits only on release (M6), Escape cancels a held pick (M7), **B1-B4 (NEW, 2026-08-14)** — a project holding no chats draws no bubbles, three distinct non-transparent fills, equal heights across states and digit counts, loading ring animated by registered `@property` angle. S7 and `clearScrims()` fixed for async modal race: both now wait bounded for the modal to appear (see Constraints & Decisions 2026-08-13).

### Wave-by-Wave Rollout
20 tasks across 4 waves, dependency map mechanically audited (0 collisions). Wave 1 (contracts, behavior-neutral) → Wave 2 (instance shell, still one chip) → Wave 3 (global collisions, riskiest) → Wave 4 (badge + window bridge). Full plan: `_dream_context/workspace/project-tabs/plan-validated-v1.md` (838 lines).

## Notes

- **Multi-window escape hatch** (Shift-click) lands in a follow-up task — deliberately scoped out of this PRD to ship the core first.
- **Runtime validation partial:** 3 of 9 runtime criteria unproven at `in_review` (B2, M-x1 terminal fitting after 5 switches, B5/B6/B7 multi-chip lifecycle). Automated validation 9/9 PASS provides strong confidence.
- **Supersedes knowledge/desktop-beta-tauri-multivault.md** — that doc explicitly stated "multi-vault == multi-window, one shared Node server. No in-window switcher" — this PRD documents the replacement model.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-08-14 - Status bubble redesign (commit e0cd5cb)
- Replaced one dot+badge with up to three counted bubbles (asking/working/idle). Sessions in the same state collapse into ONE bubble carrying their count; a state with nothing in it draws nothing. Fixed color collision (accent violet meant "working" on project strip but "ready" on chat tab 40px below — now neutral chip segment, bubbles name their state). Loading legibility: ~24px ring animated via registered `@property` angle (not a transform — wouldn't spin stadium shape), stops under `prefers-reduced-motion` instead of hiding. `rollupProject` expanded with `asking`/`working`/`idle` flat primitives (partition invariant: asking+working+idle===live). Starting folds into working; saved/ended counted nowhere; shells excluded from all three. Unit tests 10→19, verify:project-tabs 13→19 (B1-B4 bubble checks). `handleRollup` comparison bug fixed (walked every key instead of inline three-field check that dropped `alive`). Task: `a-project-chip-says-how-many-chats-it-holds-and-how-many-are-working-one-counted-bubble-per-status`.

### 2026-08-11 - Post-in_review hardening (session 26f43715, committed 480b4f3 + PR #291)
- Fixed two real defects found by repeated review: (1) Escape stack broken in both directions across mounted-but-hidden projects — scope now captured at PUSH time, Escape answered per-scope; (2) eviction ceiling read `live` badge counter (excludes shells) — a project with only a running shell would have been evicted mid-process. Separate `alive` counter added, regression-locked. Smoke test upgraded from single-vault (could never catch cross-project bugs) to two-vault, 12/12. Commit split from concurrent automations work via `git apply --cached`, verified in isolated worktree. Status remains `in_review` — 3 runtime criteria still require live agent (B2, M-x1, B5/B6/B7).

### 2026-08-10 - Created at in_review
- Feature PRD created after Waves 2–4 landed (all 20 tasks done). Automated validation 9/9 PASS; runtime 6/9 proven. Status `in_review` reflects partial runtime validation — human should close remaining 3 criteria against a second registered vault + live shell session.
