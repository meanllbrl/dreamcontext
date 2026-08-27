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
updated: '2026-08-27'
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
  - an-agent-can-drop-a-pin-whose-fact-stopped-being-true
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
- [x] **A pin can be RETIRED by the agent** — `{"type":"pin","id":"…","drop":true}` removes that id from the shelf and from the store, takes every fact of that pin with it, leaves every other pin present and in order, and closes the panel if it was the open one. A drop naming an id the shelf isn't holding changes nothing and says nothing. A drop that also carries `facts`/`lede`/`detail` is still a drop, and names what it ignored.
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
- [x] **The shelf's type is ONE zoom-aware ladder** — `--pin-text` / `--pin-text-sm` / `--pin-num` / `--pin-marker` / `--pin-glyph` declared once on `.pin-shelf`, every rung `calc(<px> * var(--zoom, 1))`, and NO raw `font-size: <n>px` left in `pinShelf.css` or `progressPanel.css`. `.pin-pop` re-declares the two text rungs one step up because it is a reading surface, not a strip. Proven by MEASUREMENT, not by declaration: `verify:chat-shelf-ui` samples computed `font-size` at every rung at 100% / 120% / 85% and asserts each scales proportionally and returns exactly.
- [x] **Verification script** — `scripts/verify/chat-shelf-ui.mjs` drives resting state, row opening/closing, ceiling, scroll-invariance against real server in Chromium (geometry via boundingBox at scroll positions, ±2px tolerance).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-08-27 - dream-html rendering advances: height bridge handshake, pen-stroke markers, hover tips
Three commits landed on the chat's dream-html rendering, all tied to the Meeting Room exposing what the shelf relies on:

**The height bridge is now a handshake** (dd8008e): the bridge spoke ONCE and deduped against its last value, so a single missed report froze the block at its 40px floor. The host's listener attached in a passive effect (flushed after paint, behind the frame's parser task), and a settled body never resizes again. Fixed: host listens in `useLayoutEffect` (synchronously inside the commit, before the parser task), can ASK (`__dreamHtmlMeasure`) on load + every 250ms until answered (forced past the child's dedupe, capped at 16 retries), measurement is stored with the body it measured `{html, height}` so no reset clobbers a delivered height, and the bridge moved into `<head>` (an escaped `</script>` in the body left it unparsed). verify:chat-html § 8 goes deaf for 2.5s and requires the block to recover.

**The `dc-mark` is a pen stroke, not a swatch** (c954090): `.dc-mark` painted `--color-accent-text` (white in BOTH themes, the foreground for a solid accent fill) over `--color-accent-soft` (a 12-18% tint), so the phrase an author marked as the one to read was the only phrase that could not be read. Now the SAME pen `styles/global.css` gives the transcript's `==highlight==`: `--color-highlight` ink stopping short of the ascender line and baseline gap, `color: inherit`, `box-decoration-break: clone` so a wrapped highlight is two strokes. `--color-highlight` / `--color-highlight-edge` added to `CHAT_KIT_TOKENS` (variables do not cross the iframe boundary). Test: every token the kit reads must be one the host resolves, and the kit may not reference `var(--color-accent-text)`.

**Hover tips join the kit** (7f0861b): `dc-hit` wraps a mark, `dc-tip` inside it reveals on hover/focus (`dc-tip--below` flips under; in SVG the tip is a `<g>` painted by `dc-tip-box`/`dc-tip-text`), plus free hover feedback on table rows and bars. The `CHAT_HTML_KIT_CSS` constant is now emitted by `scripts/gen-chat-html-kit-mirror.mjs` from the .css (never hand-edited), and verify:chat-html asserts a tip actually appears on hover in a real browser.

### 2026-08-25 - The drop: a pin can be retired by the agent that pinned it
Same day, same report, owner's call: hygiene prose alone leaves an already-stale pin standing, so the shelf gets the retirement it never had. `{"type":"pin","id":"…","drop":true}` removes that id. Four decisions are load-bearing and none of them is the obvious one:

(1) **A drop WINS over content that rode along with it.** A payload saying both "remove this" and "show that" is an agent contradicting itself, and the half worth honouring is the removal — the defect this field exists to end is a pin that cannot die, and it must not be resurrected by a leftover `facts` key. The ignored half is named in a notice. Rejecting the ambiguous block was the alternative and it is worse: notices are read by the USER, not fed back to the model, so a refusal would leave the stale chip standing and report the agent's confusion to the person it inconveniences.

(2) **A drop for an id the shelf isn't holding is a SILENT no-op.** The user may have dismissed that pin already, or the cap may have evicted it; neither is a state the agent can observe. This is the one place the shelf deliberately does NOT degrade loudly, because the loud version would be noise about the agent's ignorance.

(3) **`foldViews` moved from an array-plus-index-map onto a Map.** `set` on an existing key keeps that key's POSITION (the update-in-place rule that stops the tag line reshuffling under the cursor, unchanged) and `delete` removes one without invalidating every index after it. Insertion order IS list order, so a dropped-then-re-sent id correctly returns as the newest.

(4) **A retired id is RETURNED, not swallowed** — `{entries, evicted, retired}`. `useShelf` closes the open panel when its pin is retired, exactly as a user dismissal does: the id can be re-sent later and must come back CLOSED.

The briefing's size budget (`agent-board-assets.test.ts`) went 4300 → 4600, per its own protocol: the shelf paragraph was compressed from 1020 to 734 characters FIRST — the old "re-send the `id` to update" and "pin what only you know" were folded into the new rule rather than left saying the same thing twice — and the raise is documented in the test with the actual count (4499).

Progress rows are deliberately NOT droppable: `progress:<slug>` is not a spellable pin id (`validatePin` forbids `:`), and a run's row already closes itself when the task file reports all-done.

### 2026-08-25 - The shelf's type is a ladder, and the ladder multiplies --zoom
Owner report with two screenshots: the progress row, and the progress panel open over a conversation. Both read small, and the panel — a list of full sentences, several of them wrapping to four lines — read smallest. Two distinct causes, and neither was a judgement call about one rule:

(1) **The shelf was the only surface in the chat written in raw px.** `pinShelf.css` and `progressPanel.css` named sixteen sizes between 9px and 12px, each typed at its own rule. The conversation they dock to is `--chat-text` (15px), so the shelf sat a full step under the thing it annotates — and no single edit could move it, because there was no ladder to move.

(2) **Raw px does not multiply `--zoom`.** Every token in `styles/tokens.css` is `calc(<n>px * var(--zoom))` and `ChatPane.css` follows it for `--chat-text`; the shelf did not. So a user who zoomed the window grew the transcript, the composer and the tray, and the shelf alone stayed put — the gap the owner saw gets WORSE the more you zoom.

The fix is one ladder on `.pin-shelf` (`--pin-text` 13.5 / `--pin-text-sm` 12.5 / `--pin-num` 12 / `--pin-marker` 11 / `--pin-glyph` 10, each `* var(--zoom, 1)`), plus the boxes that are font-coupled (chip height, caret and bullet gutters, the dismiss target) scaling with it so nothing clips when the ladder moves. Mono sits a rung BELOW the text it aligns with rather than matching it, because mono renders larger at equal px.

`.pin-pop` re-declares the two text rungs one step up (14.5 / 13). This is the only place on the surface that departs from the ladder, and it is deliberate: the row is a one-line strip where every extra px is spent out of the criterion's ellipsis budget, while the panel is a list you read. That override needs no import order — a custom property resolves against the nearest declaring ANCESTOR, and `.pin-pop` is a descendant of `.pin-shelf`.

DELIBERATELY NOT DONE: raising `.pin-pop`'s 46vh cap. Bigger type in the same box shows fewer criteria, which is a real cost — but "still under half the pane: it is a glance, not a document" is this file's own recorded constraint, and the sticky in-flight strip keeps the live criterion on screen at every scroll position. If the panel now reads as too short, the cap is the next change and it is a one-line one.

### 2026-08-25 - A pin outlives the fact it states, so the briefing now teaches hygiene
Owner report with a screenshot: a session's tag line read `Brave CDP :9222 — KAPATMA`, `SensorTower: login gerekli`, `AdSpyLab: login gerekli` — three TRANSIENT conditions pinned as permanent facts, still standing after they had been dealt with. Nothing is misbehaving: `foldViews` is id-keyed UPDATE-only, `layoutShelf` has no notion of expiry, and `validatePin` SKIPS a pin carrying no facts/lede/detail (with a notice) rather than reading it as a retirement — so an agent can never unpin, and only the user's `×` takes a tag down. The briefing taught WHAT to pin and never that a pin outlives its truth.

The fix is prose in `CHAT_SURFACE_BRIEFING`, not a new mechanism: pin only what still holds when the session ends (an address, a port, a checkout); a to-do, a blocker, a "login needed" or anything you are waiting on goes in the MESSAGE, where it ages with the transcript; when a pinned fact does change, re-send that `id` with the new truth in the same turn you learn it.

DELIBERATELY NOT DONE: an agent-side retire (explicit `"drop"`, or empty-facts-means-remove). Naming one in the briefing before it exists is the exact failure this file's header forbids, so the instruction asks for hygiene it cannot repair — a pin that goes stale anyway still needs the user's `×`. If stale tags survive this, that retire path is the next change, and it is a schema + `foldViews` + lockstep change, not a prose one. — AMENDED the same day: the owner's answer to "hygiene it cannot repair" was to build the repair. See the entry above.

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

### 2026-08-27 - dream-html rendering fixes (3 commits)
- Height bridge handshake (dd8008e): synchronous listener in `useLayoutEffect`, retry ASK loop (250ms × 16), measurement stored with the body, bridge moved to `<head>`
- Pen-stroke markers (c954090): `dc-mark` is now `--color-highlight` (inherits text color, same pen as transcript `==highlight==`), not white-on-tint
- Hover tips (7f0861b): `dc-hit`/`dc-tip` join the kit, the CSS constant is now generated by `scripts/gen-chat-html-kit-mirror.mjs`
- verify:chat-html 61/61 including new § 8 (2.5s deaf, requires block to recover)

### 2026-08-25 - The pin drop
- `drop` on the pin schema (`chatViewSpec.ts`), retirement in `foldViews` (`shelfModel.ts`, rewritten onto a Map), `retired` closing the open panel in `useShelf.ts`, and the rule + worked example in `CHAT_SURFACE_BRIEFING`.
- Tests: +9 parser (`chat-view-pin`), +11 fold (`shelf-model`), +1 lockstep pinning the briefing's drop example, budget raised 4300 → 4600 with the count documented. Full suite 7561 passed / 0 failed (426 files).
- Runtime: `verify:chat-shelf-ui` in real Chromium at 1200px and 740px — 5 new checks (the no-op, the removal, neighbours standing, order preserved, the composer seam holding) plus "a DROPPED pin stays dropped" across a reload. 171/172 on my tree alone; the single failure is PRE-EXISTING ("pins survive a reload" — 2/2 red on baseline without this change) and is a timing race in the CHECK, not in persistence: with another session's added post-reload wait the same run is 172/172.
- `tsc` clean both projects, `npm run build` clean.

### 2026-08-25 - The shelf reads at the conversation's scale
- `dashboard/src/components/sleepy/chat/pinShelf.css`: type ladder declared on `.pin-shelf`; all 16 raw `font-size` values replaced by rungs; `.pin-chip` height 22 → `calc(24px * --zoom)`, `.pin-caret`/`.pin-task-glyph` gutters → `--pin-hit`, `.pin-x` 18 → `calc(20px * --zoom)`.
- `dashboard/src/components/sleepy/chat/progressPanel.css`: `.pin-since` and `.pin-group-name` onto the ladder; `.pin-pop` re-declares the two text rungs one step up (14.5 / 13) as the reading surface.
- Evidence: `verify:chat-shelf-ui` 134/134 in real Chromium — including the three byte-identical-at-every-scroll-position checks, the ceiling, the tag wrap and "THE TAG LINE DID NOT MOVE", i.e. the growth cost the shelf none of its invariants. 117 unit tests green (placement, shelf-model, view-pin, lockstep). `build:dashboard` clean.
- `scripts/verify/chat-shelf-ui.mjs`: new stage `2d — the type ladder MULTIPLIES app zoom` — 14 checks per width. It samples COMPUTED font-size (never the declaration) at five rungs, at 120% and 85% (the ends of `WindowChrome.ZOOM_LEVELS`), asserts each scales within 1.5% and returns exactly at 100%, and guards the baseline separately: the panel's criteria must resolve ≥14px and above the row's, so a perfectly proportional scale of the old 12px cannot pass.
- `verify:chat-shelf-ui` **172/172** after the stage (was 134/134 before it). Two `pins survive a reload` failures seen mid-work were collateral: another process rebuilt `dashboard/dist` at 12:27 during the run, so the post-reload page loaded a different bundle. Clean on a rebuilt tree.
- Screenshot: `_dream_context/tmp/shelf-type/run-progress-panel.png`.

### 2026-08-25 - Pin hygiene reaches the briefing
- `src/server/chat-surface.ts`: the shelf paragraph gains six lines — a shelf fact never expires and the agent cannot take one down, so pin only session-durable facts, keep transient conditions in the message, and re-send the `id` the moment a pinned fact changes.
- Prose-only: no schema, model, route or renderer change. `tests/unit/chat-surface-lockstep.test.ts` + `tests/unit/chat-view-pin.test.ts` green (54 tests).
- Open: no agent-side retire exists, and the decision above records why it was not invented in prose.

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
