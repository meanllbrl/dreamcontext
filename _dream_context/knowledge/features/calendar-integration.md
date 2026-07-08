---
id: feat_34wMAtiM
status: planning
created: '2026-07-04'
updated: '2026-07-08'
tags:
  - 'topic:agents'
  - backend
  - 'topic:cli'
  - integration
  - backlog
related_tasks: []
type: feature
name: calendar-integration
description: ''
pinned: false
date: '2026-07-04'
released_version: v0.14.2
---

## Why

The agent should know the user's day and week the moment a session starts, and be able to act on the calendar, not just read it. Today the brain already tracks dated work (task `due_date`, objective `start_date`/`target_date`, the roadmap forecast), but it has no awareness of the user's actual lived schedule. That gap means the agent plans work against a calendar it cannot see.

This is deliberately scoped as a **first-class dreamcontext capability, not a generic tool connection.** A plain MCP calendar tool would give the agent read/write actions, but it would not give us the two things dreamcontext uniquely owns:

1. **Zero-tool-call context injection.** The user's agenda is pre-loaded into every session via the SessionStart snapshot, the same mechanism that already loads soul/user/memory. No MCP tool can do that; it is the core dreamcontext thesis applied to the calendar.
2. **Cross-linking with the brain's own dated data.** Calendar events sit next to tasks, objectives, and the roadmap. That opens a two-way loop: agenda flows *in* as context, and the brain's own artifacts (daily summaries, task due dates, session digests) can flow *out* as calendar events and invites.

The action-taking (create event, invite, block time) can sit on top of a real calendar API or delegate to an MCP under the hood. dreamcontext owns the injection, the dashboard view, and the cross-linking. That division is what makes this worth building natively.

## User Stories

- [ ] As a user, I want to connect my Google/Outlook calendar via OAuth so the agent knows my real schedule.
- [ ] As a user, I want my calendar connection and event cache to be gitignored and private, never committed, visible only to me and my Claude.
- [ ] As an agent, I want today's and this week's agenda auto-injected at session start so I plan work around the user's real day without any tool calls.
- [ ] As a user, I want a proper calendar view in the dashboard so I can see the same agenda the agent sees.
- [ ] As an agent, I want CLI commands (and/or a calendar API) to create events, so I can act, not just observe.
- [ ] As a user, I want the agent to write a daily summary back to my calendar as an event, so my day is captured where I already look.
- [ ] As a user, I want the agent to be able to send/attach invites where relevant, so calendar actions are complete, not read-only.

## Acceptance Criteria

- (To be refined when this leaves the backlog. Draft:)
- OAuth connect flow for at least one provider (Google Calendar first) completes and stores tokens in a **gitignored** local secret store.
- SessionStart snapshot injects a "Today / This week" agenda section, demotable under token budget, always reflecting fresh data.
- Dashboard renders a calendar view of the connected account.
- Agent can create an event via CLI command.
- Agent can write a daily summary as a calendar event.
- All calendar data (tokens + cached events) is confirmed gitignored; nothing personal is ever committed.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **2026-07-04 — Privacy: fully gitignored, per-user.** Calendar tokens and any cached events live in the gitignored secret/local space (same posture as `.secrets.json`). This is personal data for the user and their Claude only; it must never enter version control. This is a hard requirement, not a preference.
- **2026-07-04 — First-class capability, not just a tool connection.** Justified by (a) SessionStart context injection, which no MCP tool provides, and (b) cross-linking calendar with the brain's existing dated data (tasks/objectives/roadmap). The generic read/write actions may still delegate to a calendar API or MCP internally; dreamcontext owns injection + view + cross-linking.
- **2026-07-04 — Read path is a transient view, not persisted brain state.** Unlike tasks (which sync into `state/` with a ledger and conflict merge), calendar events are fetched fresh each SessionStart and injected, then discarded. No sync ledger for the read path. Keeps it simple and always-current. The *write* path (agent creating events) is a separate action surface.
- **2026-07-04 — Not urgent, backlog.** Captured for planning; no committed timeline.

## Technical Details

Grounded in the current architecture (verified 2026-07-04):

- **Injection point:** `generateSnapshot()` in `src/cli/commands/snapshot.ts` assembles the SessionStart context; `src/cli/commands/hook.ts` (`session-start`) prints it. Add a demotable "Today's Calendar" `BudgetSection` here (full agenda when budget allows, collapse to "N events today" under pressure). The snapshot already has a section-demotion framework to reuse.
- **Backend pattern to mirror:** `src/lib/task-backend/` (ClickUp/GitHub) shows the established shape: a backend router, per-provider clients, config in `.config.json`, tokens in `.secrets.json`, field mappers. A parallel `src/lib/calendar-backend/` (google-calendar / ical / local) follows the same convention. NOTE: unlike task-backend, the read path needs no sync-state ledger (transient view).
- **Cheapest MVP path:** a private **`.ics` feed URL** (Google/Outlook/Apple all expose one) avoids OAuth entirely for v1: HTTP GET + ICS parse → inject. OAuth (Google Calendar API) is additive on top and is what unlocks the *write*/action surface (create event, invite).
- **Cross-link surface:** task `due_date` and objective `start_date`/`target_date` are already in frontmatter; `dreamcontext roadmap --json` already computes a dated forecast. These are the natural bridge points for pushing brain artifacts out to the calendar.
- **Dashboard:** the React dashboard + Node server (see knowledge `desktop-beta-tauri-multivault`) is the surface for the calendar view; a new page + a server route reading the calendar backend.
- **Auth precedent:** see task `feat-web-hosted-dreamcontext-com-github-oauth-collaboration-layer` for the OAuth pattern already being designed in the project.

## Notes

Open questions for when this leaves the backlog:

- Which provider(s) first? Recommend `.ics` read MVP → Google Calendar OAuth (read+write) → Outlook.
- Where exactly do tokens live, and is that path already in `.gitignore`? Confirm the gitignore posture before any token is written.
- Multi-calendar (work + personal): one connection or several? How is that surfaced in the injected agenda?
- Timezone / all-day event handling in the injected block.
- Staleness: with a live fetch at SessionStart, freshness is automatic; if a cache is introduced for speed, add a "synced Xh ago" note.
- Action guardrails: creating events and especially **sending invites** are outward-facing actions. Define a confirm/dry-run posture (mirror the agent-feedback draft-confirm-file flow) so the agent never silently invites people.
- Delegation boundary: for the write/action surface, decide build-native vs delegate-to-MCP. Leaning delegate-for-actions, own-the-injection.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-04 - Created
- Feature PRD created and scoped as a backlog item. Captured the "first-class capability vs tool connection" rationale, the gitignored/private constraint, the transient-view read path, the `.ics`-first then OAuth build order, and the cross-linking opportunity with tasks/objectives/roadmap.
