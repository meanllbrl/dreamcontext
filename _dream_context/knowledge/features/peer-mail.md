---
id: "feat_b61i3P-C"
type: "feature"
name: "peer-mail"
description: "Agent-to-agent messaging across connected vaults: notes/questions/commands delivered by headless claude runs rooted in the peer's directory, with CLI commands, snapshot integration, generated envoy sub-agents, and a live UI panel in Chat"
pinned: false
date: "2026-08-26"
status: "in_progress"
created: "2026-08-26"
updated: "2026-08-26"
released_version: null
tags:
  - "topic:federation"
  - "architecture"
  - "frontend"
  - "backend"
related_tasks:
  - "peer-mail-cross-vault-agent-messaging"
---

## Why

Federation provided read-only recall across vaults — a local agent could SEARCH a peer's corpus, but could not ASK it a question and get a reasoned answer from the peer's own brain. The only way to hand a task to a sleeping project was to context-switch into that project manually.

Peer mail turns a federation connection into a live two-way channel: one vault can address another with a note (deferred, appears in the peer's next snapshot), a question (live — spawns the peer, answer returns on the same thread), or a command (live, may do work under `auto` permissions). The peer answers from its OWN brain, rooted in its OWN directory, even while otherwise asleep.

## User Stories

- [x] As an agent in one vault, I can send a note to a connected peer, which surfaces in its next SessionStart snapshot without spawning it
- [x] As an agent, I can ask a peer a question and receive a reasoned answer from the peer's own knowledge, not a summary of it
- [x] As an agent, I can hand a peer a command to execute in its own context under auto permissions
- [x] As a user in the dashboard Chat view, I can @ mention a connected peer and type directly into a live session panel with that project's brain
- [x] As a user, I see pending peer mail in the snapshot's "Peer mail" section, which never evicts (a peer waiting on a reply is load-bearing)
- [x] As an agent, when I recall a peer and find nothing useful, I know I can escalate to `peer ask` for a reasoned answer

## Acceptance Criteria

- [x] Three message kinds implemented and routed correctly: `note` (deferred), `question` (live spawn), `command` (live, may modify under auto)
- [x] Storage at `state/.peer-mail/<id>.json` on BOTH ends of a thread (correspondence is duplicated, not copied like the parked digest path)
- [x] Consent gate: an active connection is sufficient consent (following the v0.23.0 `shareable`-retirement precedent)
- [x] Delivery: a headless `claude -p --permission-mode auto` rooted in the PEER's project root, so the peer's SessionStart hook fires and it answers with its own brain
- [x] Permission mode is a constant (`auto`) with no caller-supplied path to bypass — a peer may ask, never silently escalate
- [x] CLI surface: `peer send|ask|inbox|read|thread|reply|done`
- [x] Server routes: `/api/peer/peers|mail|send|mail/:id/status`
- [x] Snapshot integration: "Peer mail" section with pending count, never evicts
- [x] Generated envoy sub-agents: `.claude/agents/peer-<vault>.md` created on connect, retracted on disconnect, carry routing rules
- [x] Dashboard Chat @ mention picker lists connected peers with their soul one-liner
- [x] Peer session UI: a docked row above the composer (peer name, state chip, answer preview, amber "needs you" + unread dot when blocked)
- [x] Clicking the row opens a side panel with the peer's live session: ItemView transcript, PermissionCard for prompts, real Composer
- [x] Panel portaled to `.chat-pane` (not rendered in place) so its positioned ancestor is correct
- [x] "Open in new tab" hands the peer PROJECT to the window chrome (not just the conversation)
- [x] Verified end-to-end against real Tilki vault: answered in 56s citing a file this vault has no copy of
- [x] Browser verification: `npm run verify:peer-mail` (Playwright, 43 assertions, screenshots in `_dream_context/workspace/peer-mail/shots/`)
- [x] Headless delivery proven: the answer's session object reports `perm=auto` and `cwd=<peer's directory>`
- [ ] UI browser-verified for panel close→reopen survivability (holder stays mounted, session persists)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-08-27 - The logo setter hides behind RIGHT-CLICK, not a button
Owner call: setting a logo is a once-per-project act and does not earn a permanent button on every card. The "Set logo…"/"Change logo…" action moved into a context menu — `useVaultLogoMenu` (VaultLogo.tsx), wired via `onContextMenu` on the List card, the Space chip and the Space open card, rendered once per page next to the picker's hidden input. Same transient-popover lifecycle as the project-tab chip menu (dismiss on pointerdown/resize/blur, Escape stopped before surface handlers), same visual CSS (`.vault-logo-menu`, mirrored from `.project-tab-menu` so every right-click popover in the app is the same popover). Playwright-verified: zero visible logo buttons, right-click → menu → OS chooser → upload lands and the stamp moves, menu closes on pick; Space chips needed `force: true` clicks in the harness (orbital drift makes them "unstable" to Playwright — a harness note, not a product bug).

### 2026-08-26 - Logo is SETTABLE from the launcher: picked file → magic-byte verify → assets/logo.<ext>
`POST /api/launcher/logo?vault=` takes the picked image's raw bytes (capped streaming read, 5MB — the agent-drop discipline), identifies it by MAGIC BYTES never the client's content-type (raster only: png/jpeg/webp/gif; svg stays hand-drop-only since it can't be sniffed), clears every other `logo.*` candidate first (a stale `logo.png` would shadow a new `logo.webp` — candidate order is preference order), and writes `logo.<canonical ext>`. UI: `useVaultLogoPicker` in VaultLogo.tsx — ONE hidden `<input type=file>` per page + the `useSetVaultLogo` mutation, shared by the List cards ("Logo…"/"Set logo…" action) and the Space card. Cache-bust: `logoStamp` (file mtime) rides `/launcher/status` + `/launcher/federation-graph` and is appended to the image URL as `&ts=`, so a replaced logo shows without a reload despite the 300s image cache. Verified end-to-end with Playwright driving the real OS file chooser (stamp moved, logo:true).

### 2026-08-26 - Launcher wears the logos too, through a SECOND route with a weaker gate
The launcher's List cards and Space chips/cards render each vault's logo via `GET /api/launcher/logo?vault=` — deliberately NOT the peer route: `/api/peer/logo` serves ANOTHER vault's file and rides the federation consent line (active connection required), while the launcher serves the user their OWN registry, so registration is the only gate (same trust level as `/launcher/status` printing every path). `computeVaultStatus` adds `logo: boolean` (flows into `/launcher/status` AND `/launcher/federation-graph`, so both views get it for free). UI: shared `VaultLogo` component (`components/layout/VaultLogo.tsx`, the `VaultDot` pattern — the flag gates the request, a 404/broken image collapses to NOTHING rather than an empty placeholder circle; the dot stays beside it: dot is health, logo is identity).

### 2026-08-26 - Vault identity: a logo is a FILE convention, not a config key
Each vault may ship `_dream_context/assets/logo.{png,jpg,jpeg,webp,svg}` (raster preferred, `src/lib/vault-logo.ts` owns the candidate order). Dropping the file in IS the whole setup — no command, no config key that could drift from the asset. Server: `GET /api/peer/logo?peer=<vault>` serves the peer's logo bytes (browser `<img src>` carries no headers, so self vault rides `?vault=`), gated on an ACTIVE connection — same consent line as mail. `/api/peer/peers` answers `logo: boolean`; the client builds URLs via `peerLogoUrl`. The logo appears everywhere the peer is named: the `@` picker row, the docked peer-session row + panel head (`PeerMark`, `◈` glyph as the never-empty floor), and — via `peerForAgent(subagentType, peers)` — on `peer-<slug>` envoy runs in `SubAgentCard`/`SubAgentRail`/drill-in, where the run also wears the VAULT's name on an accent badge instead of the generated slug.

### 2026-08-26 - Composer mention highlight is a transparent mirror, not a rich editor
A `<textarea>` cannot color a span of itself, so the picked `@peer` gets its emphasis from a mirror div (`.chat-cmp-hl`) painted BEHIND the field: identical text/metrics, everything transparent except an accent pill under each token that names a known peer (`mentionSegments` — same token-boundary rule as `mentionQueryAt`, so an email's `@` never lights up). The textarea's own text renders on top; typing/selection/caret are untouched. Rendered only while a mention exists, scroll-synced on the field's `onScroll`. Rejected: contenteditable (would rebuild the whole composer for one emphasis).

### 2026-08-26 - Drill-in panels get "↓ Latest" as a sticky child of the scroller
A drill-in opens at the transcript's top (reading order) but what the user waits on is at the END — so `useJumpToLatest` + the `JumpToLatest` pill (SlideOver.tsx, reused by the peer panel) give an atomic one-click way down. The pill is the LAST child of the scrolling body with `position: sticky; bottom`, deliberately not absolute: sticky needs no knowledge of what sits under the panel (the peer panel has a whole composer there; the drill-ins have nothing), and it self-hides at the bottom because `away` is false there.

### 2026-08-26 - UI reuse-first: mount the chat's components on a different session object
The first iteration hand-rolled a composer (textarea), permission UI (Allow/Deny buttons), and transcript renderer (pre-wrapped string). The owner corrected: a peer session IS a chat, so it gets THE CHAT. The panel now mounts the app's own pieces on the peer's session object:
- transcript → `ItemView` (markdown/tool cards/code fences/file chips render as themselves)
- permission → `PermissionCard` (command preview, edit diff, always-allow)
- composer → the REAL `Composer` (slash menu, attachments, model/effort/mode triggers, steer-into-turn, queue, drafts)

The hand-rolled version had none of that and would drift the moment the real components changed. Lesson (generalizes past this surface): when a new surface needs a chat-shaped thing, the session is the parameter; the components are not. Verified: `verify:peer-mail` asserts on `.chat-cmp-input` / `.chat-cmp-modeltrigger` / `.chat-cmp-send` / `.chat-permcard` INSIDE `.peer-panel`, so a regression back to bespoke widgets fails by construction. Dropped ~1KB of hand-rolled CSS.

### 2026-08-26 - Deliberate NOT the digest inbox
Peer mail lives at `state/.peer-mail/`, separate from the parked `state/.federation-inbox/`. The digest inbox carried *derived knowledge copies* (the thing that broke SSoT and was retired); peer mail carries *addressed correspondence*, which is supposed to be duplicated on both ends and never materializes as knowledge files. Same disk neighborhood, different contract.

### 2026-08-26 - Headless delivery vs dashboard session: permission asymmetry
In a HEADLESS delivery (CLI `peer ask`), a permission prompt has nobody to answer it — the peer reports itself blocked and the run times out. In the DASHBOARD peer session, the socket is two-way and the holder stays mounted, so there IS somebody to ask: the permission renders Allow/Deny in the panel and answering it there unblocks the peer's turn. This asymmetry is by design and worth documenting.

### 2026-08-26 - Per-connection generated envoy sub-agents
Each active connection generates `.claude/agents/peer-<vault>.md` carrying the peer's identity, routing rule ("ask when the answer must be reasoned, or when recall came back empty and the peer would still know"), and real path. Retracted on disconnect — a dead envoy is worse than none. The agent knows it can call a peer because the envoy exists and the snapshot's "Connected projects" section names the verbs.

### 2026-08-26 - Holder/Row/Panel split is load-bearing
`PeerSessionHolder` owns the ChatSession (WebSocket + child process in another project) and never unmounts while the session is alive. `PeerSessionRow` is the docked message line. `PeerSessionPanel` is the side panel view. If the session lived inside the panel, it would be disposed every time the panel closed, killing the peer's turn mid-answer. The split keeps the session alive across close→reopen.

## Technical Details

**Storage:**
- `state/.peer-mail/<id>.json` — one file per message, mutated in place for status transitions
- `state/.peer-mail/archive/` — closed threads
- Messages live in the vault they were addressed TO; replies are written back into the sender's dir on the same thread, so both sides hold the full correspondence locally

**Message schema (v1):**
- `kind: note | question | command`
- `status: pending | read | answered | done`
- `delivery: deferred | live`
- `thread` (root message id), `replyTo` (parent message id or null)
- `sessionId` (Claude conversation id of the headless run that handled it)

**Delivery (live messages):**
- `src/lib/peer-delivery.ts` — spawns `claude -p --permission-mode auto` rooted in the PEER's project root
- `PEER_PERMISSION_MODE = 'auto'` is a constant — no caller-supplied path to bypass
- Timeout: 10 minutes default
- The peer's SessionStart hook fires, so it answers from its own soul/memory/knowledge

**CLI:**
- `src/cli/commands/peer.ts` — `send|ask|inbox|read|thread|reply|done`
- `peer ask <vault> "<question>"` — live question, returns the answer
- `peer send <vault> "<note>"` — deferred note, surfaces in peer's next snapshot

**Server routes:**
- `src/server/routes/peer.ts` — `/api/peer/peers|mail|send|mail/:id/status`
- Integrates with `createChatSession(vault, bypass=false, …)` for the dashboard panel

**Snapshot integration:**
- "Peer mail" section in SessionStart, never evicts (a peer waiting is load-bearing)
- "Connected projects" section names the peer verbs + routing rule

**Generated envoy sub-agents:**
- `src/lib/peer-agent-gen.ts` — writes `.claude/agents/peer-<vault>.md` on connect, removes on disconnect
- Carries peer's identity, whatItIs, routing rule, real path

**Dashboard UI:**
- `dashboard/src/components/sleepy/chat/PeerSessionCard.tsx` — Holder/Row/Panel
- `dashboard/src/hooks/usePeerMentions.ts` — @ mention picker integration
- Panel mounts: `ItemView`, `PermissionCard`, `Composer` (the app's own components on the peer's session object)
- Panel portaled to `.chat-pane` for correct positioned ancestor resolution
- CSS: `peerSession.css` (row + shell; ~1KB less than the hand-rolled version)

**Vault identity (logo):**
- `src/lib/vault-logo.ts` — `findVaultLogo(contextRoot)`: `assets/logo.*` convention, mime map, candidate order
- `src/server/routes/peer.ts` — `handlePeerLogo` (`GET /api/peer/logo?peer=`), `logo: boolean` on the peers list
- `dashboard/src/api/client.ts` — `peerLogoUrl(vault, peer)` for `<img src>`
- `dashboard/src/lib/agentComposer.ts` — `peerForAgent`, `mentionSegments` (+ unit tests in `tests/unit/peer-identity.test.ts`)
- `AgentAvatar` (atoms.tsx) takes `src` — logo with the hue ring, Sleepy face as fallback on load error

**Verification:**
- `scripts/verify/peer-mail-ui.mjs` — Playwright harness, 46 assertions (incl. picker logo actually loads, mention highlight pill, peer row wears the logo)
- Builds two connected scratch vaults, drives real server + browser
- Captures screenshots to `_dream_context/workspace/peer-mail/shots/`
- Verified end-to-end against real Tilki vault: 56s answer citing `functions/src/triggers/lesson-payout.ts` (a file this vault has no copy of)

**Key files:**
- `src/lib/peer-mail.ts` — message store, threads, archive, quarantine, schema v1
- `src/lib/peer-delivery.ts` — consent gate + headless spawn
- `src/lib/peer-agent-gen.ts` — envoy generation/retraction
- `src/cli/commands/peer.ts` — CLI surface
- `src/server/routes/peer.ts` — HTTP API
- `dashboard/src/components/sleepy/chat/PeerSessionCard.tsx` — UI
- `dashboard/src/hooks/usePeerMentions.ts` — @ picker

## Notes

**Remaining work (per task in_progress status):**
- Panel close→reopen survivability verification (§6b mentioned but not yet in the assertion count)
- Full suite already green: 7978 passed / 0 failed

**Design choice: why correspondence stays duplicated, not deduplicated:**
Unlike the parked digest path (which copied knowledge and broke SSoT), peer mail is supposed to be duplicated — both sides hold the full thread so `peer thread <id>` works offline and a sleeping vault's inbox is readable without touching the sender.

**Permission asymmetry between CLI and dashboard:**
- CLI headless delivery: permission prompt → nobody to answer → peer reports blocked
- Dashboard peer session: permission prompt → renders in panel → user can answer → peer unblocks
This is by design. The dashboard session is the surface where a blocking prompt CAN be answered.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-08-26 - Created
- Feature PRD created.
