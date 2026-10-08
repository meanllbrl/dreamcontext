---
id: task_d3lwG4JP
name: >-
  A whiteboard shows a funnel as its explorer, any Lab card as a widget, and the
  date window on the card
description: >-
  Funnel render on whiteboard insight widgets (L/XL explorer, S/M headline +
  mini lane), a lab-card widget kind (<board>/<card-id>), a date-window chip on
  insight and lab-card widgets (insight-level tweak + re-sync), tweaks_from
  window sharing, bar % ticks, and the lookup-mode segments 'Not measured' fix.
priority: high
urgency: medium
status: in_review
created_at: '2026-10-04'
updated_at: '2026-10-08'
tags:
  - 'topic:whiteboard'
  - 'topic:lab'
parent_task: null
related_feature: whiteboards
version: 0.30.0
start_date: '2026-10-04'
---

## Why
<!-- What problem does this solve? What breaks if we don't do it? Be concrete — name the user, the friction, the cost. -->

Tilki (2026-10-04): the founder's Acquisition whiteboard draws the edinim funnel as a 5-row mini-table, with no date control and no way to put the Lab funnel explorer on the board; the agent faked it with two derived bar insights whose conversion lives in label text and whose windows drift apart.

<!-- Other sections (User Stories, Acceptance Criteria, Workflow, Constraints & Decisions, Technical Details, Notes) are created on first insert — `dreamcontext tasks insert <task> <section> "…"`. A section that has nothing to say doesn't exist. -->

## Acceptance Criteria

- [x] A funnel insight widget at L/XL draws the funnel explorer (breakdown chips + Daily/Benchmark/Flow/Steps/Segments tabs); at S/M it shows top-step users, final conversion and a mini lane with % of previous and % of top on every step

- [x] A lab-card widget (ref <board>/<card-id>) draws that Lab card as Lab does, with its selection, tabs and a full-screen view; whiteboard add <slug> lab-card --ref <board>/<card-id> works

- [x] Insight and lab-card widgets carry a date-window chip that shows the window the data is for and opens the Lab range control; applying it writes the insight tweak and re-syncs

- [x] An insight manifest may declare tweaks_from: <slug>; a window change on the source moves its followers to the same window and re-syncs them

- [x] A bar insight with unit % draws percent axis ticks

- [x] lab board show --select on a lookup funnel no longer prints Not measured above measured segment rows

- [x] Docs: skill whiteboards reference, cli-reference and the README cover the new widget kind, the funnel widget and the window chip

## Changelog
<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->






### 2026-10-08 - Session Update
- Follow-up 938b7b58 (2026-10-07, on main): an app/v1 or html/v1 insight on a whiteboard (lab-card and L/XL insight widget) now fills its card instead of clamping at 320px; whiteboard-lab-card.mjs 35/35 with a new tall-app check. Include it in the owner's installed-app check.
### 2026-10-04 - Status → in_review
- Shipped and pushed; owner's check of the funnel widget, Lab card and window chip in the installed app is the open gate
### 2026-10-04 - Session Update
- Committed and pushed as 6de92e15 (builder guard), 82da8340 (lab: tweaks_from, explorer endpoint, resolvedRange, % ticks, segments fix), ab6752c2 (whiteboard: funnel widget, lab-card, window chip, docs). Committed through a temporary index built from HEAD + only this work's hunks, because the agent-card and hands-free sessions edit 9 of the same files (their hunks stay uncommitted in the working tree). Commit 82da8340 type-checks standalone (git archive + both tsc); ab6752c2's tree passed both tsc and 2130 related tests. Rebuilt dist, ran dreamcontext update --yes in all 6 vaults (global CLI linked to this checkout, 0.30.0). Peer note to Tilki 1791128091537-47aca6c0.
### 2026-10-04 - Session Update
- Built all five requests + the bug. (1) Funnel insight widget: S/M = FunnelMini (top-step users, final conversion, lane with % prev/% top), L/XL = the Lab funnel explorer via new GET /api/lab/explorer/:slug (buildExplorerResponse in lab-boards.ts, same preset blocks + frame engine), opened on Steps, full screen. (2) New widget kind lab-card (<board>/<card-id>) in both contract mirrors + validator + CLI add/update + palette picker; LabCardView renders BoardCard with its own view state and a portal full screen. (3) WidgetWindowChip: prints the DATA window (cache funnel/matrix/dataset/app range, else new resolvedRange on /api/lab/:slug) and opens RangeControl; applies via useApplyTweaks (insight-level, decided over a per-widget cache: two widgets of one insight share a window, as in Lab). (4) tweaks_from manifest field + windowGroup/writeWindowTweaks: any member's window change writes the group, PATCH returns moved[], client re-syncs them, lab tweak names them. (5) Bar % ticks when unit is %. Bug: segments explorer view no longer carries a slice header (its projected frame drops the bare-selection path). Excalidraw builder refuses whiteboards/ paths and dreamcontext-whiteboard files. DECLINED: tombstoning elements that vanish from the server (violates a-delete-is-never-inferred-from-absence; source fixed instead). Evidence: tests/unit/whiteboard-lab-card.test.ts 12/12, mirror test updated, scripts/verify/whiteboard-lab-card.mjs 28/28 in Chromium (shots tmp/whiteboard-lab-card-shots/). Not committed. Concurrent agent-card lane is adding an 'agent' kind to the same contract files.
### 2026-10-04 - Status → in_progress
- started
### 2026-10-04 - Created
- Task created.
