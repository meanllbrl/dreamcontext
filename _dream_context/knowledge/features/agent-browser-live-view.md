---
id: feat_WdclLjZO
type: feature
name: agent-browser-live-view
description: >-
  A chat's Playwright MCP browser runs headless with a loopback CDP port; the
  server screencasts it and the Chat pane draws it live inside the browser tool
  step, so no Chrome window ever takes the screen or the keyboard
pinned: false
date: '2026-10-09'
status: in_review
created: '2026-10-09'
updated: '2026-10-09'
released_version: null
tags:
  - 'topic:agents'
  - 'topic:desktop'
  - 'layer:frontend'
  - 'layer:backend'
  - 'kind:enhancement'
related_tasks:
  - >-
    the-agent-s-playwright-browser-runs-headless-and-shows-live-above-the-chat-composer-never-taking-the-screen
---

## Why

Owner 2026-10-08: "I want the Playwright screen shown live inside the chat, and the computer's focus must stay inside dreamcontext." `@playwright/mcp` opens a HEADED Chrome by default, so every `browser_navigate` from an agent put a Chrome window in front of the owner and took the keyboard while he typed elsewhere, and the only way to see what the browser was doing was that window, outside dreamcontext.

## User Stories

- [ ] As the owner, an agent that browses never opens a Chrome window or takes my keyboard; I keep typing wherever I was. *(built and verified headless with the real CLI; awaiting the owner's check in the installed app)*
- [ ] As the owner, I watch the agent's browser live inside the chat, in the browser step that is driving it, framed as a small Mac window I can roll up or open full-window.
- [x] As the owner, a chat that never browses pays nothing: Chrome only starts at the agent's first browser call.

## Acceptance Criteria

- [x] A project Playwright MCP (local, project or user scope) is re-declared per chat spawn under the same name, headless, with a loopback CDP port; its `--mcp-config` rides last (measured: a dynamic server replaces same-named servers; the later file wins).
- [x] A project `.mcp.json` definition is never re-emitted as its committed command/env (canonical `npx @playwright/mcp@latest` only); owner-scope definitions keep command, flags, env and their own `--config` (merged); `--cdp-endpoint` / `--extension` servers are left alone.
- [x] The server attaches only after the agent calls a `mcp__<server>__` tool, refuses a non-Chrome answer on the port, screencasts the newest page (~6 fps, latest wins), re-sends on a late title, ignores a stale info answer, and restarts a stalled screencast after navigation.
- [x] Frames bypass the conversation model (`browserLiveStore`, keyed by session, dropped on close and dispose), so six frames a second never re-render the transcript.
- [x] The view lives inside the LAST browser tool step of the transcript (a collapsed run card keeps it under its header), as a macOS-style window (traffic lights, address bar with live dot, title and host): yellow or a title-bar click rolls it up, green opens it full-window; it hugs the page ratio; reduced motion is respected.
- [x] Unit tests (override, mirror incl. a mutation-checked race, protocol, lockstep) and `npm run verify:chat-browser-live` 25/25 (including the view moving into the newest browser step); dashboard + root tsc and build green.
- [x] Real `claude` + real `@playwright/mcp`: server source dynamic, system Chrome launched with `--headless` and our port, frames through example.com with the title "Example Domain".
- [ ] Owner sign-off in the installed app (a Tilki chat that browses: no window appears, the view feels right).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-10-09]** Owner picked, from three previews, "inside the Playwright row": the composer dock read as detached from the conversation. Only ONE step hosts the view (the last browser step); a column of live windows is the wall the tool-row collapse rule exists to prevent. The view is a Mac window frame, collapsible (owner, same day).
- **[2026-10-08]** The live view comes from CDP `Page.startScreencast` on a side port of the MCP's own browser, not from screenshots: Playwright keeps driving over its pipe, our client only watches. Chrome starts lazily at the first browser call.
- **[2026-10-08]** Chrome never announces a document's own title via `targetInfoChanged` (only navigation commits and script-set titles), so the mirror asks `Target.getTargetInfo` at most every 600 ms while frames arrive.
- **[2026-10-08]** Out of scope: Bash-driven Playwright scripts (already headless by default; their post-hoc card is a separate task, `task_WSdCA2Tn`).

## Technical Details

- **Override:** `src/lib/browser-override.ts` finds the project's Playwright MCP in any scope and writes a per-spawn `--mcp-config` that re-declares it under the same name with `--headless` and a config whose `browser.launchOptions.args` carries `--remote-debugging-port=<n>` (loopback). Tool names stay `mcp__<name>__*`, so permission rules keep matching. Wired from `src/server/routes/agent-chat.ts` / `src/server/chat-surface.ts`.
- **Mirror:** `src/server/browser-mirror.ts` is a second, read-only CDP client. It attaches when the stdout stream shows an `assistant` frame with a `tool_use` named `mcp__<server>__…` (a structured field, never prose), polls `/json/version` until Chrome answers, refuses anything that does not look like Chrome's DevTools endpoint on that port, follows the page that most recently appeared or navigated, and pushes JPEG frames to the pane as `_meta` frames (`dashboard/src/lib/chatProtocol.ts`).
- **View:** `dashboard/src/components/sleepy/chat/browserLiveStore.ts` (frames per session, outside the conversation model), `BrowserLive.tsx` / `.css` (the Mac window), `browserHost.tsx` (`BrowserHostProvider`, `isBrowserTool`, `lastBrowserToolId`, `BrowserSlot`); `ChatPane.tsx` computes the host step from `conv.items`; `ToolCard.tsx` and `ToolRunCard.tsx` render the slot.
- **Verify:** `scripts/verify/chat-browser-live.mjs` (`npm run verify:chat-browser-live`); unit tests `tests/unit/browser-override.test.ts`, `browser-mirror.test.ts`, `chat-protocol.test.ts`, `chat-surface-lockstep.test.ts`. Docs: `skill/references/integrations.md`, README, the chat briefing line.
- **Status (2026-10-09):** uncommitted in the working tree; task in review; the owner's in-app check is the remaining gate.

## Notes

- Known: the first frames after launch can be 1280x633 before the 1280x720 viewport lands, one ratio change at start.
- The task's title still says "above the chat composer"; the shipped placement is inside the browser tool step (owner, 2026-10-09).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-09 - Created from the built work (sleep reconcile)
- PRD created from task `the-agent-s-playwright-browser-runs-headless-and-shows-live-above-the-chat-composer-never-taking-the-screen`. Seven criteria ticked from code, unit tests, `verify:chat-browser-live` 25/25 and the real-CLI check; the owner's in-app sign-off stays open. Placement recorded as of the 2026-10-09 owner pick (inside the last browser step, Mac window frame), not the original composer dock.
