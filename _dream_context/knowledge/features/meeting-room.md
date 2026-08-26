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
updated: '2026-08-26'
released_version: null
tags:
  - 'topic:desktop'
  - 'topic:federation'
  - frontend
  - backend
related_tasks:
  - meeting-room-hidden-launcher-chat-where-all-agents-convene
---

## Why

Peer mail addresses one vault; the user had no surface to address ALL agents at once. Announcements, house rules and cross-project questions meant repeating the same message into N windows. The Meeting Room turns N context-switches into one post, and moves the relevance decision to the agents themselves: each wakes with its own brain loaded and replies or answers exactly PASS.

## User Stories

- [x] As the launcher's owner, I can click the dreamcontext core logo (projects in orbit) and get the Meeting Room — an easter-egg entrance, no menu item, no List-view door
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

- **[2026-08-26]** NOT peer mail: the room is global, owned by no vault, no connection/consent gate (owning the launcher is the consent). Reuses ONLY `runPeerHeadless` + `resolvePeer`; never writes into any vault's `state/.peer-mail/`.
- **[2026-08-26]** UI-only, hidden: single entrance is the Space core's click when projects exist; empty sky keeps the add-project wizard. No CLI surface in v1.
- **[2026-08-26]** Roster glances come from `buildPeerSummary` (direct read, any registered vault), not `readPeerSummaryCache` — the cache is per-vault-about-its-connected-peers and cannot describe arbitrary registered vaults; lines degrade to name-only.
- **[2026-08-26]** The room composer is a thin feed/composer, not the chat's Composer/ItemView: those mount on a live ChatSession and the room has no session (a post is a store write, replies arrive by polling). The markdown renderer (`MarkdownPreview` over `markdownBlocks`) and design tokens ARE reused.

## Technical Details

Store `src/lib/meeting-room.ts` (thread JSON, sync single-writer mutations, one-active invariant) → orchestrator `src/lib/meeting-delivery.ts` (routing, `buildMeetingPrompt` with fenced untrusted trigger + PASS contract, run queue at concurrency 3, mention chain + caps) → routes `src/server/routes/meeting.ts` (`/api/meeting/state|thread/:id|post|reply|close`, vault-agnostic, orchestrator singleton in the launcher-mode server) → UI `dashboard/src/components/meeting/MeetingRoom.tsx` + `meetingRoom.css` + `dashboard/src/hooks/useMeetingRoom.ts` (2s/10s/stop polling) → entrance `SpaceLauncher.tsx` core click + `LauncherPage.tsx` overlay mount. Verification `scripts/verify/meeting-room-ui.mjs`. Docs: Meeting Room section in `skill/references/integrations.md`.

## Notes

Cost is accepted, not solved: a PASS still costs a full context load per agent per announcement — revisit with a cheap-triage stage if it stings. One orchestrator instance holds because only one launcher window exists; if that ever changes the thread-file writer needs a real lock. Possible later: CLI verbs so agents can post to the room from sessions.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-08-26 - Created
- Feature PRD created.
