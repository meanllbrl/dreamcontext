---
id: feat_EoAQ7k5f
type: feature
name: chat-composer-shelf
description: >-
  A shelf docked to the chat composer that holds pinned facts and progress rows
  outside the transcript, so session-critical information never scrolls away.
  Supports dream-view pin and progress blocks, with tags wrapping to multiple
  lines (no fold), progress detail opening as a floating popover, and loopback
  URL clicks.
pinned: false
date: '2026-08-23'
status: in_review
created: '2026-08-23'
updated: '2026-08-24'
released_version: null
tags:
  - 'topic:agents'
  - 'topic:desktop'
  - 'layer:frontend'
  - 'layer:backend'
related_tasks:
  - >-
    two-new-agent-actions-pinned-session-facts-that-stay-put-and-progress-read-from-the-task-file
  - >-
    session-facts-name-the-checkout-the-session-is-actually-in-and-the-worktree-brief-covers-basic-develop
  - >-
    run-progress-reads-as-a-live-checklist-not-two-lines-under-a-number-it-never-explains
---

## Why

Everything the chat agent renders today is a transcript event: it is drawn once, then scrolls away. Two kinds of information do not belong in a transcript.

(1) **Session facts** the user needs THE WHOLE SESSION — which worktree and branch this session acts on, and which localhost:PORT the running work can be tested on — get buried within a few turns and the user re-asks.

(2) On a **long run** the user cannot see how far along it is; the agent narrates progress in prose that is unverifiable and instantly stale, while the task file already holds the ground truth (ticked acceptance criteria, changelog entries).

Both need a surface that PERSISTS and, for progress, one that is DERIVED from the task file rather than asserted.

## User Stories

- [x] As someone driving work from Chat, I can see which worktree/branch this session acts on and the localhost:PORT it can be tested on at any point in the session, without scrolling back or re-asking.
- [x] As someone who kicked off a long run, I can see how far along it is, what was just finished and what is being worked on now — read from the task file, not from the agent's prose.
- [x] As the agent, I can update a pin or a progress view in place by re-sending the same id, instead of stacking a new card on every turn.
- [x] As a developer, the shelf docks to the composer and does NOT react to scroll — no hide-on-scroll-up, no reveal-on-scroll-down, always visible.
- [x] As a developer, tags in the shelf wrap onto additional lines when they don't fit — tags are NEVER hidden behind a fold or +N chip.
- [x] As a developer, clicking a progress row opens its detail as a floating popover (not in-place expansion), so the shelf stays one predictable height.
- [x] As a developer, I can click a localhost:PORT pin to open it in my browser, so I can test the running work immediately.

## Acceptance Criteria

- [x] **The shelf docks to the composer's TOP EDGE**, shares its width and radius, and is not a child of the transcript's scroll container — after scrolling to the top and back, it is still on screen and unchanged.
- [x] **It does NOT react to scroll direction or position**: no hide-on-scroll-up, no reveal-on-scroll-down, no resize. Geometry is byte-identical at scroll-top, mid-scroll and scroll-bottom.
- [x] **Hard two-row ceiling**: no sequence of agent blocks, however many pins it sends, produces a third row.
- [x] **Resting state is ONE tag line** — with nothing running there is no open row.
- [x] **The tag line is the row nearest the composer** and does not move when a row opens or closes above it: its y-coordinate is identical with and without an open row.
- [x] **Tags ALWAYS wrap** — no +N fold, no per-line cap. The tag area wraps onto as many lines as needed, capping at ~25% of the pane and scrolling inside itself. `MAX_TAGS_PER_LINE` is declared but unreferenced.
- [x] **Overflow degrades loudly**: past the ceiling the oldest row demotes to a tag (the ⌃ demote chip). The +N fold and fold row DO NOT EXIST.
- [x] **Pin: a fact with a weight** — `dream-view` block `{"type":"pin","id":"…","weight":"tag"|"row","facts":[…]}` renders in the shelf, outside the transcript flow.
- [x] **Weight is a REQUEST**: the surface may demote a row whose content is tag-sized; criteria hold either way.
- [x] **Re-sending the same id updates that pin in place** and never produces a second one (id-keyed contract).
- [x] **Session facts are server-derived and not dismissable** — branch and worktree marker from `GET /api/agent/session-facts?session=<uuid>` (git symbolic-ref, worktree via --git-common-dir ≠ --absolute-git-dir). AMENDED 2026-08-24: the route is SESSION-scoped, not vault-scoped. It first answered for the vault's project root, which is only right until the agent moves — see the decision below.
- [x] **Loopback URL carve-out** — `http://localhost:PORT` / `127.0.0.1` facts are clickable and open in the OS browser. Post-parse `sanitizeLoopbackUrl` accepts exactly localhost / 127.0.0.1 / [::1] (and their normalizing spellings), REJECTS 0.0.0.0 / evil.com tricks / javascript: / credentials in URL. Search and hash are stripped. Pin-facts-only carve-out; chatActions.ts url action stays https-only.
- [x] **Pins survive reopening** (persisted per conversation, like checklistStore).
- [x] **Long pins: lede + detail** — A pin with long content occupies ONE row showing lede + open affordance at rest. Clicking opens detail IN PLACE (M2b unchanged), growing UPWARD, capped at ~40% of pane height (scrolls inside), one pin open at a time. Tag line and composer y unchanged between collapsed/expanded.
- [x] **Progress: derived from disk** — `{"type":"progress","task":"<slug>"}` opens as a ROW above the tag line. Clicking opens DETAIL as a FLOATING POPOVER (not in-place) — header with title + count + ×, dismissed by × or click-away. Costs the shelf no height.
- [x] **Percent from disk** — derived from task's acceptance-criteria checkboxes via existing counter in src/lib/markdown.ts. Percent supplied by agent is ignored with a notice.
- [x] **Row shows latest changelog entry and first unticked criterion**, refreshes as task file changes on disk during run.
- [x] **When run ends, row closes** and tag line stays without moving.
- [x] **Zero criteria / unknown slug / all-ticked task degrade loudly** with notice — no NaN%, no silent empty row.
- [x] **VIEW_TYPES in chatViewSpec.ts** gains both types with explicit caps (pins per conversation = 24, facts per pin = 6, NO per-line tag cap — that limit was removed), following degrade-loudly convention.
- [x] **CHAT_SURFACE_BRIEFING** documents both types and teaches the weight. chat-surface-lockstep.test.ts green.
- [x] **Verification script** — `scripts/verify/chat-shelf-ui.mjs` drives resting state, row opening/closing, ceiling, scroll-invariance against real server in Chromium (geometry via boundingBox at scroll positions, ±2px tolerance).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-08-24 - The branch tag follows the SESSION, not the vault
Owner report with two screenshots: a run whose every step happened in a worktree, under a tag that still read `main`; and a Develop session that called the harness's own `EnterWorktree` tool, still reading `main`. The original design read git in `projectRootOf(contextRoot)` — where `claude` is spawned — which is correct at t=0 and never again, because Develop mode's briefing is what invites the agent to leave.

Three decisions came out of it. (1) The SIGNAL is the harness's tool frames, not the model's prose: the chat bridge already parses the stdout NDJSON, so an `EnterWorktree` move arrives structured. Prose is the fallback only for a manual `git worktree add` + `cd`, which produces no frame. (2) A directory named by a frame is VALIDATED before git runs there — its `--git-common-dir` must match the project root's, bounding the blast radius to sibling checkouts of the project already open. A refused move leaves the session where it was; there is deliberately no heuristic fallback, because a surface whose promise is "you never have to re-ask" cannot afford a guess. (3) `useSessionFacts`' query key now carries the session id. The old comment — "these facts belong to the CHECKOUT, so every pane subscribes to one cache entry" — was itself the bug: a session does not stay in the checkout it was spawned in, and one shared entry showed every pane whichever answer arrived last.

Not covered: the tag visibly flipping in a BROWSER after a move. Proven at the HTTP/WS layer only.

### 2026-08-24 - The worktree paragraph belongs in basic too, not just develop
`WORKTREE_ALLOWED`/`WORKTREE_FORBIDDEN` were appended only in `develop`, so the one paragraph standing between an agent and a forked brain was absent from `basic` — `DEFAULT_CHAT_MODE`, the mode a fresh chat is in, carrying exactly the same tools. Owner decision: basic and develop both get it from one shared constant; `plan` stays excluded because it opens with "Do not edit code in this session"; `jarvis` still returns `''`. This REVERSES the earlier "basic is plain Claude Code — the surface briefing and nothing else" decision, and both arms now end with the instruction to declare a move the shelf cannot see.

### 2026-08-23 - Tags NEVER fold — the +N chip was cut after live testing
After live testing, owner decision: tags are ALWAYS visible. The tag area wraps onto as many lines as needed (flex-wrap), capping at ~25% of the pane and scrolling inside itself. The +N / −N fold chip and its fold row were REMOVED from shelfModel/PinShelf. A fact you must press a button to see is not a pinned fact. MAX_TAGS_PER_LINE no longer folds anything; the only tag-count bound is MAX_PINS_PER_CONVERSATION eviction (24), which stays loud.

### 2026-08-23 - Progress detail is a POPOVER, not in-place expansion
After live testing, owner decision: the progress ROW stays pinned in the shelf, but clicking it opens the DETAIL as a floating POPOVER over the conversation (the design's .pin-pop variant — header with title + count + ×, own shadow, dismissed by × or click-away), NOT as an in-place expansion. In-place expansion remains ONLY for long pins (M2b unchanged). The popover costs the shelf no height and never moves the tag line or composer.

### 2026-08-22 - Placement DECIDED: shelf docks to composer top edge (option A)
Owner decision: the shelf docks to the composer's top edge, resting as a single tag line. It does NOT scroll, does NOT react to scroll direction, and never hides. Options B (transcript-top dock), C (floating rail), and D (slide-over panel) were rejected. Spec: `_dream_context/knowledge/diagrams/product/chat-pinned-surface/chat-pinned-surface.excalidraw.md`.

### 2026-08-23 - Loopback URL carve-out is pin-facts-only
The loopback http:// carve-out is post-parse and its accept list is deliberate. sanitizeLoopbackUrl compares WHATWG-normalized hostname against exactly localhost / 127.0.0.1 / [::1]. It ACCEPTS normalizing spellings (http://127.1, http://0177.0.0.1, etc — each yields hostname 127.0.0.1, safe by construction). It REJECTS localhost.evil.com / 127.0.0.1.evil.com / credentials in URL / javascript: / 0.0.0.0 (not loopback). Search and hash are stripped. Carve-out is pin-facts-only — chatActions.ts url action stays https-only. Narrower blast radius is the point.

### 2026-08-23 - Empty shelf renders nothing
The empty shelf renders nothing — no tags and no row ⇒ PinShelf returns null. Never contributes zero-height strip or stray border.

### 2026-08-23 - Dock seam is one object
With an open row, .pin-shell.has-rows carries 12px top corners and no bottom border while .chat-cmp-card.is-shelved squares its top corners. At rest (tag line only) the composer keeps its full radius. The shelf and composer fuse into one visual object.

## Technical Details

### Implementation files

- **`dashboard/src/lib/shelfModel.ts`** (305 lines) — shelf state machine: processViewBlock parses dream-view pin/progress blocks, applies ceiling (2 rows max), demotes oldest row to tag past ceiling, manages pin store + progress derivation.
- **`dashboard/src/lib/pinStore.ts`** (149 lines) — persistent pin storage per conversation (IndexedDB via localforage), eviction at 24 pins, coerceEntry/coerceFact validation, flushPendingPins + lazy pagehide hook for durability.
- **`dashboard/src/components/sleepy/chat/PinShelf.tsx`** — shelf render: tag line + optional open row, wrap layout for tags (no fold), loopback URL click handler, dismiss affordances.
- **`dashboard/src/components/sleepy/chat/ProgressPopover.tsx`** — floating popover for progress detail (header + criteria list + × dismiss).
- **`dashboard/src/lib/chatViewSpec.ts`** — VIEW_TYPES definitions for pin + progress, caps (MAX_PINS_PER_CONVERSATION = 24, MAX_FACTS_PER_PIN = 6, NO per-line tag cap), parseViewBlock with notices.
- **`src/server/routes/agent-shelf.ts`** — GET /api/agent/session-facts (resolves `?session=` through the checkout registry, then reads git THERE), GET /api/agent/task-progress (reads task file, derives percent from checkboxes, extracts latest changelog + first unticked criterion).
- **`src/lib/session-facts.ts`** — SessionFacts (+ `worktreeName`) + readSessionFacts + UNKNOWN_SESSION_FACTS, 12s TTL memo, isRepo/branch/worktree via git commands, and the exported `gitCommonDir` that identifies a REPOSITORY (TTL-memoized, bounded 128).
- **`src/lib/session-cwd.ts`** — the per-session checkout registry. A directory is accepted only when its `--git-common-dir` canonicalises to the project root's, i.e. a worktree of the SAME repo; bounded at 64 sessions, oldest-first eviction; a removed worktree falls back to the project root on the next read.
- **`src/server/worktree-frames.ts`** — reads `EnterWorktree`/`ExitWorktree` moves off the NDJSON relay `agent-chat.ts` already parses. The path comes from the tool RESULT, never the call.
- **`src/lib/markdown.ts`** — firstUnticked + shared CHECKBOX_LINE_RE (extracted from countCheckboxes).
- **`src/server/chat-surface.ts`** — CHAT_SURFACE_BRIEFING updated to document pin and progress types.

### Tests

- **`tests/unit/chat-view-pin.test.ts`** (18 tests) — pin parsing, id-keyed update, weight, loopback URL validation.
- **`tests/unit/pin-store.test.ts`** (30 tests) — persistent storage, eviction, coercion, flush timing.
- **`tests/unit/shelf-model.test.ts`** (22 tests) — ceiling enforcement, row-to-tag demotion, progress derivation.
- **`tests/unit/task-progress.test.ts`** (17 tests) — percent calculation, states, notices for edge cases.
- **`tests/unit/session-facts.test.ts`** (9 tests) — git probes, worktree detection, TTL memo.
- **`tests/unit/session-cwd.test.ts`** (16 tests) — the same-repository gate against real `git worktree add`: sibling accepted; foreign repo, non-repo, missing dir, a file, a relative path all refused and the session KEEPS its previous checkout; removed-worktree fallback; bounded eviction.
- **`tests/unit/worktree-frames.test.ts`** (11 tests) — driven by frames captured from real transcripts (structure verbatim, paths anonymised): result-not-call, Created and Entered, errored tool moves nothing, ids consumed once, two watchers isolated.
- **`tests/unit/agent-session-facts-route.test.ts`** (7 tests) — session scoping, no-id and unknown-id compatibility, two sessions two branches, non-UUID param ignored, desktop gate.
- **`tests/unit/chat-surface-lockstep.test.ts`** — briefing examples execute through real parser, bidirectional coverage.
- **`tests/unit/chat-shelf-placement.test.ts`** (4 tests) — shelf geometry invariant across scroll positions.
- **`scripts/verify/chat-shelf.mjs`** (34 checks) — HTTP validation: 64% from 7/11, in-flight criterion, tick → 73%, zero-criteria → null + notice, unknown slug → 200 state, hostile slugs → 400, branch reported, worktree detection, desktop gate. Check 9 drives a REAL chat WebSocket against a scripted `claude` replaying captured EnterWorktree frames and proves the branch MOVES for that session while a no-id caller, a different session and a non-UUID param all still read the project root.
- **`scripts/verify/chat-shelf-ui.mjs`** (6 screenshots + geometry assertions) — real Chromium against dist server: resting shelf, 29 tags → 3 lines, progress row, progress popover, long pin expanded, background-commands tray. Placement verified: shelf y unchanged at scroll-top/mid/bottom.

### Routes

- **GET /api/agent/session-facts?session=&lt;uuid&gt;** — returns {branch, isRepo, worktree, mainRoot, worktreeName}. Answers for the checkout THAT SESSION is in; an absent or unknown id answers for the project root, which is the pre-2026-08-24 behaviour and keeps a fresh pane, a resumed conversation and the terminal view working. Branch via `git symbolic-ref --short HEAD`, worktree via `--git-common-dir` ≠ `--absolute-git-dir` (both realpaths to fix macOS /var symlink). The id is held to `sanitizeUuid` before it keys anything. Desktop-gated, 12s TTL memo.
- **GET /api/agent/task-progress/:slug** — returns {percent, state, now, last, updatedAt, notice}. 400 invalid_slug before fs, 200 unknown-slug for well-formed-missing. Percent from countCheckboxes, null never NaN. Now = firstUnticked, last = latest changelog. Desktop-gated, vault-scoped.

### Key behaviors

- **Ceiling enforcement**: shelfModel processes pins FIFO, demotes oldest row to tag once 2 rows exist, never produces 3rd row.
- **Tag wrap, no fold**: .pin-tags is flex-wrap, tags never hidden, cap at ~25% pane height then scroll inside.
- **Progress is derived**: percent read from disk via markdown.ts countCheckboxes, agent-supplied percent ignored + notice.
- **Persistence**: pinStore writes to IndexedDB (localforage), lazy pagehide flush, clearPins on session close (AgentSurface.tsx closeSessionById), boot janitor sweeps expired pins + checklists.
- **Loopback URL**: sanitizeLoopbackUrl post-parse, WHATWG URL normalized hostname compared against exactly localhost / 127.0.0.1 / [::1], rejects 0.0.0.0 / evil domains / credentials / javascript:, strips search + hash.

## Notes

### Phase 6 verification captured real screenshots
Six screenshots from real Chromium against dist server in scratch HOME: resting shelf, 29 tags wrapping to 3 lines (no fold), progress row, progress popover, long pin expanded, background-commands tray. All measurements from getBoundingClientRect, never hand-computed CSS.

### Git realpath bug found by test
Git realpaths --absolute-git-dir but not --git-common-dir. On macOS (/var → /private/var) naive comparison reported every plain checkout under symlinked path as worktree. Both sides now canonicalized; mainRoot documented as realpath.

### The +N fold was cut late
MAX_TAGS_PER_LINE is declared at chatViewSpec.ts:163 but has zero references anywhere (verified grep). The design originally specified a 12-tags-per-line cap with +N fold; owner cut it after live testing 2026-08-23. Tags wrap onto as many lines as needed.

### Progress detail opens as popover, not in-place
Original design had progress detail expand in-place (like long pins). Owner changed to floating popover after live testing 2026-08-23 so row costs same height open or closed. In-place expansion scoped to long PINS only.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-08-24 - Session-scoped session facts + the worktree brief reaches basic
- Shipped and pushed: `7c5857f` (worktree brief → basic + develop, plan excluded) and `282e3fe` (session-scoped facts) on `main`.
- New: `src/lib/session-cwd.ts`, `src/server/worktree-frames.ts`; `SessionFacts.worktreeName`; `gitCommonDir` exported and TTL-memoized after a test caught four git forks per pane per poll.
- Evidence: 34 new unit tests; `verify:chat-shelf` 34/34 (was 28) incl. a real chat WS replaying captured EnterWorktree frames; `verify:chat-modes` 28/28; `verify:chat-shelf-ui` 100/100 in real Chromium; tsc clean both projects; build clean.
- Task: `[[session-facts-name-the-checkout-the-session-is-actually-in-and-the-worktree-brief-covers-basic-develop]]`.

### 2026-08-23 - Shipped (uncommitted)
- All acceptance criteria met across 6-session goal-skill v2 run (waves D1-E1-E2-E3, D2-A/B/C, phases 1-6).
- Implementation: shelfModel, pinStore, PinShelf, ProgressPopover, chatViewSpec updates, agent-shelf routes, session-facts, markdown firstUnticked.
- Tests: 5 new unit test files (99 tests), lockstep test updated, 2 verify scripts (28 HTTP + 6 UI checks).
- Owner decisions: tags never fold (wrap instead), progress detail is popover (not in-place), loopback URL carve-out pin-facts-only.
- Status → in_review (uncommitted work, pending PR merge).

### 2026-08-23 - Created
- Feature PRD created from task two-new-agent-actions-pinned-session-facts-that-stay-put-and-progress-read-from-the-task-file and 6-session implementation work.
