---
id: feat_Xq9g-s2p
type: feature
name: meeting-room
description: >-
  Hidden Meeting Room behind the launcher's core logo: one Slack-like thread
  where an announcement wakes EVERY registered vault's agent headless in its own
  directory, reply-or-PASS protocol, bounded agent-to-agent mentions (1 hop +
  follow-up), one active thread with kept history
pinned: false
date: '2026-08-26'
status: in_review
created: '2026-08-26'
updated: '2026-08-27'
released_version: null
tags:
  - 'topic:desktop'
  - 'topic:federation'
  - frontend
  - backend
related_tasks:
  - meeting-room-hidden-launcher-chat-where-all-agents-convene
  - >-
    the-meeting-room-becomes-its-own-window-built-out-of-the-chat-with-one-global-model-pick-and-one-answer-per-agent
  - >-
    the-meeting-room-gets-its-own-byte-channel-so-a-dropped-or-pasted-file-reaches-every-agent
---

## Why

Peer mail addresses one vault; the user had no surface to address ALL agents at once. Announcements, house rules and cross-project questions meant repeating the same message into N windows. The Meeting Room turns N context-switches into one post, and moves the relevance decision to the agents themselves: each wakes with its own brain loaded and replies or answers exactly PASS.

## User Stories

- [x] As the launcher's owner, I can click the dreamcontext core logo (projects in orbit) and get the Meeting Room — an easter-egg entrance, no menu item, no List-view door
- [x] As the user, the room opens in its OWN window, so I can read it while working in the projects it is talking about — and it holds the SAME composer and message rendering as a project chat, not a look-alike
- [x] As the user, I pick a model and reasoning effort ONCE in the room and every project's run uses it — there is no per-project override to keep in sync
- [x] As the user, one question gets me ONE answer per project: two agents naming the same third one no longer wake it twice
- [x] As the user, when an agent answers the room by DRAWING something (a `dream-html` block), I see the drawing here — and anything the room cannot resolve says so instead of vanishing
- [x] As the user, I post one announcement and every registered vault's agent wakes headless in ITS OWN directory and answers from its own brain — or passes
- [x] As the user, I see live per-agent presence (thinking / replied / passed / error) without a socket, and past threads stay browsable in the rail
- [x] As the user, I can @mention one vault (roster-driven menu, names with spaces work) and wake only it
- [x] As an agent in the room, I can @mention another participant when its answer would change mine, and I get one follow-up run carrying that answer

## Acceptance Criteria

- [x] Global store `~/.dreamcontext/meeting-room/threads/<id>.json` (injectable home); at most ONE thread active — opening a new one closes the active one; closed threads still accept in-flight answers
- [x] Meeting sanitize keeps newlines (multiline markdown announcements), strips other control chars, caps at 8000 — deliberately NOT peer-mail's newline-collapsing `sanitizeBody`
- [x] Delivery reuses `runPeerHeadless` (auto perms, 10-min timeout), 3 runs in parallel — no second spawn implementation
- [x] Routing: root without mentions → ALL; with mentions → ONLY mentioned; thread reply without mentions → engaged set; mention parse roster-driven longest-name-first
- [x] Reply-or-PASS: an exact `PASS` sets state passed and never renders as a message
- [x] Mention chain bounded: one directed run + one follow-up, depth 1; caps 8 mention runs/thread, 3 runs/agent/thread; cap hits are visible system lines
- [x] Proven end to end by `npm run verify:meeting-room` (33 checks): real launcher-mode server, 3 scratch vaults, scripted claude echoing its own cwd, Playwright-driven UI, poll cadence measured (2s thinking / 10s idle / stopped when closed)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-08-27]** `dream-html` IS DRAWN IN THE ROOM, and the gate that stopped it was wrong for every host. `TranscriptItem` charged every block `!!onAction && !!conversationId`; a `dream-view` needs both (a checklist's Submit needs a conversation, an insight needs a project) but `dream-html` needs NEITHER — it is a sandboxed, network-less render. Split to `viewsAllowed = !!conversationId`, with the notice strip UNGATED: a strip whose job is to make a drop honest cannot be conditional on the capability that caused the drop. Closed the same class for buttons (no `onAction`) and boards (no `onOpenBoard`). Consequence beyond the room: the sub-agent drill-in now says what it could not draw instead of dropping it silently.
- **[2026-08-27]** THE CARET FIX TRAVELS THE OTHER WAY. Adopting the chat's composer inherited a bug the room had already solved: the chat restored the post-insert caret in a `requestAnimationFrame`, which loses the race against fast typing (`@alpha` + "just you: ping" → `@alpha  pingjust you:`). The retired room composer's `pendingCaret` + `useLayoutEffect` is now in `Composer.tsx`, covering the `@` menu, the `/` menu and ↑ recall — so the chat and the peer panel got a fix they had carried broken since they shipped. It was a RACE: the run before it was noticed passed 47/47, which is why a green suite was not evidence.
- **[2026-08-27]** ONE ANSWER PER AGENT PER USER MESSAGE, replacing "every mention gets a run". A wave is the user message that started the fan-out; a mention wakes a target the wave has not woken and COALESCES into the run in flight for one it has (prompts are built at dequeue time from the thread as it stands, so a mention written while its target is still queued is already in that target's transcript). The follow-up keeps a SEPARATE budget, one per agent per wave, so the chain still closes its loop where a mention genuinely reached someone new. Worst case per agent per message is 2 runs — a constant, where before it grew with the size of the room. Owner evidence 08-27: one announcement, `dreamcontext` posted at 11:59, 12:02 AND 12:03, the last two re-answering the same session-limit question, because nativeminds-kb and one other agent had each written `@dreamcontext`. The 3-run/agent cap was working; the amplification was the design.
- **[2026-08-27]** MODEL AND EFFORT ARE APP-GLOBAL HERE, not room-scoped and not per-project. The room has no session to scope a model to, so its composer writes `chatDefaultModel`/`chatDefaultEffort` in `~/.dreamcontext/agent-ui.json` — the blob every project window already shares — and `readAgentUiChatDefaults()` (launcher.ts, the file's one owner) is injected into the orchestrator as `chatDefaults`, read PER RUN so a change mid-fan-out reaches agents that have not woken yet. No new store, no new route. `''` on either stays the documented "omit the flag, inherit the CLI's default". Consequence: the model menu offers no "Set as default" (`modelScope: 'global'`) — the pick already IS the default.
- **[2026-08-27]** REVERSES the 08-26 "thin feed/composer, not the chat's Composer/ItemView" decision. That decision was right about the FACT (the room has no ChatSession) and wrong about the conclusion: the composer's dependency on a session was never essential, only unexamined. `ComposerHost` (`chat/composerHost.ts`) is the structural seam — `ChatSession` satisfies it unchanged, so widening the prop type was the whole edit on the chat's side — and the room supplies a ref-backed host over its polled thread (`meeting/meetingHost.ts`). The room's own textarea+Post box, its mention menu and its message bubble are DELETED. What the room still owns is what only it has: the thread rail, the presence strip, and the message→ChatItem mapping. Precedent: `PeerSessionCard`'s "a peer session is a chat; it gets the chat".
- **[2026-08-27]** A WINDOW (`?meeting=1`, `openMeetingWindow`, label `meeting-room`), not an overlay on the launcher. A modal is the wrong shape for a conversation you leave running while N agents think — dismissing it to look at anything, including the projects it is talking to, was the only way to use the app. Mirrors `openVaultWindow` (normal resizable window, `titleBarStyle: 'overlay'`, focus-if-open) rather than `openChecklistWindow` (always-on-top is the checklist's whole point and would be an imposition here). NO `VaultProvider` in that window: `useVault()` resolving to `vault: null` is what correctly drops the composer's Attach control (no project temp dir for a pasted image) and skips the per-vault peer fetch in favour of the room's roster.
- **[2026-08-27]** A CONTROL IS DRAWN WHERE SOMETHING SITS BEHIND IT — the rule that let one composer serve three surfaces without a `surface` flag. Mode+permission follows `onModeChange` (the peer panel passes an inert one deliberately, to keep the read-out it has always shown); Attach follows `useVault().vault`; "Set as default" follows `modelScope`. The `@` picker's SOURCE is injected (`mentions`) while `onPeerMessage` stays absent in the room — supplying names says "these are addressable", not "route to them", so `@Name` reaches the server as text and the server routes it.

- **[2026-08-26]** NOT peer mail: the room is global, owned by no vault, no connection/consent gate (owning the launcher is the consent). Reuses ONLY `runPeerHeadless` + `resolvePeer`; never writes into any vault's `state/.peer-mail/`.
- **[2026-08-26]** UI-only, hidden: single entrance is the Space core's click when projects exist; empty sky keeps the add-project wizard. No CLI surface in v1.
- **[2026-08-26]** Roster glances come from `buildPeerSummary` (direct read, any registered vault), not `readPeerSummaryCache` — the cache is per-vault-about-its-connected-peers and cannot describe arbitrary registered vaults; lines degrade to name-only.
- **[2026-08-26]** The room composer is a thin feed/composer, not the chat's Composer/ItemView: those mount on a live ChatSession and the room has no session (a post is a store write, replies arrive by polling). The markdown renderer (`MarkdownPreview` over `markdownBlocks`) and design tokens ARE reused.

## Technical Details

Store `src/lib/meeting-room.ts` (thread JSON, sync single-writer mutations, one-active invariant) → orchestrator `src/lib/meeting-delivery.ts` (routing, `buildMeetingPrompt` with fenced untrusted trigger + PASS contract, run queue at concurrency 3, mention chain + caps) → routes `src/server/routes/meeting.ts` (`/api/meeting/state|thread/:id|post|reply|close`, vault-agnostic, orchestrator singleton in the launcher-mode server) → UI `dashboard/src/components/meeting/MeetingRoom.tsx` + `meetingRoom.css` + `dashboard/src/hooks/useMeetingRoom.ts` (2s/10s/stop polling) → entrance `SpaceLauncher.tsx` core click + `LauncherPage.tsx` overlay mount. Verification `scripts/verify/meeting-room-ui.mjs`. Docs: Meeting Room section in `skill/references/integrations.md`.

Since 0.26.2 the UI half is: window opener `openMeetingWindow` + `MEETING_WINDOW_LABEL` (`dashboard/src/lib/desktop.ts`) → route `?meeting=1` in `App.tsx` (Theme + QueryClient + I18n, no VaultProvider) → `components/meeting/MeetingRoom.tsx` (window shell, thread rail, presence strip) + `meetingHost.ts` (`meetingChatItem`, `rosterMention`, `useMeetingComposerHost`) rendering `chat/TranscriptItem`'s `ItemView` and `chat/Composer` over `chat/composerHost.ts`'s `ComposerHost`. `meetingRoom.css` keeps only what the room owns; the bodies and the composer are `ChatPane.css` + `chat/cards.css` + `chat/composer.css`, with `.meeting-main` wearing `.chat-pane` for the reading tokens and the auto-grow ceiling. Delivery-side: `RunTask.wave` + the orchestrator's per-thread wave ledger, and `runPeerHeadless`'s new `effort` option beside `model`.

## Notes

Cost is accepted, not solved: a PASS still costs a full context load per agent per announcement — revisit with a cheap-triage stage if it stings. One orchestrator instance holds because only one launcher window exists; if that ever changes the thread-file writer needs a real lock. Possible later: CLI verbs so agents can post to the room from sessions.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-08-27 - Reconciled to f4bbc17 (its own window, built out of the chat)
- All user stories and acceptance criteria ticked — the feature shipped as described, verified 52/52
- The room is now a WINDOW (`openMeetingWindow`, `?meeting=1`, resizable overlay title bar), not a modal — so you can read it while working in the projects it talks about
- ONE COMPOSER: `chat/composerHost.ts` is the structural seam — `ChatSession` satisfies it unchanged, and `meeting/meetingHost.ts` supplies the room's host over its polled thread. The room's own textarea, Post button, mention menu and message bubble are DELETED. It renders `chat/TranscriptItem`'s `ItemView` and `chat/Composer`, with the room keeping only what only it has: the thread rail, the presence strip, and the author line an eight-project room needs
- The caret fix traveled BACK: adopting the chat's composer inherited a bug the room had already solved (the chat restored post-insert caret in an rAF, losing the race against fast typing). The retired room composer's `pendingCaret` + `useLayoutEffect` is now in `Composer.tsx`, covering @ menu, / menu and ↑ recall — so the chat and the peer panel got a fix they had carried broken since they shipped
- Model and effort are APP-GLOBAL here (`chatDefaultModel`/`chatDefaultEffort` in `~/.dreamcontext/agent-ui.json`, read PER RUN so a change mid-fan-out reaches agents that haven't woken yet), not room-scoped and not per-project
- ONE ANSWER PER AGENT PER USER MESSAGE: `RunTask.wave` + per-thread wave ledger — a mention wakes a target the wave has not woken and COALESCES into the run in flight for one it has. Worst case per agent per message is 2 runs (constant), not growing with room size
- The room DRAWS `dream-html`: `TranscriptItem` split `!!onAction && !!conversationId` to `viewsAllowed = !!conversationId` (a sandboxed HTML render needs neither), with the notice strip UNGATED. Same class closed for buttons (no `onAction`) and boards (no `onOpenBoard`). Beyond the room: the sub-agent drill-in now says what it could not draw instead of dropping it silently
- New verify:composer-shared 17/17 (atomicity claim falsifiable by comparing every chat-cmp class as a set across both surfaces)
- Related commits: 46cb535 (hidden Meeting Room in launcher, one announcement wakes every vault's agent), e89d8ae (tests lock Meeting Room + peer-mail contracts by parsing them)

### 2026-08-26 - Created
- Feature PRD created.
