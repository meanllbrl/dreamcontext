---
id: task_bAxijcTt
name: marketing-dashboard-v0
description: >-
  Dashboard v0 for the meta-marketing skill — 3-tab UI (Overview, Performance,
  Creatives), deferred from meta-marketing-skill PR 7.
priority: high
urgency: medium
status: todo
created_at: '2026-04-26'
updated_at: '2026-05-09'
tags:
  - skill
  - marketing
  - dashboard
  - meta
  - frontend
parent_task: null
related_feature: null
version: v0.3.0
---

## Why

PR 7 of the meta-marketing-skill was scoped to add a marketing-specific dashboard view to `dreamcontext dashboard`. It was deferred to keep the meta-marketing-skill task focused and avoid scope creep into the web-dashboard feature. Lifted to a standalone task so it doesn't get lost.

## User Stories

- [ ] As a marketer using dreamcontext, I want a Marketing tab in the dashboard showing active cohorts, recent run summaries, and budget pacing so I don't need the terminal for day-to-day monitoring.
- [ ] As a marketer, I want a Performance tab (uPlot charts) showing CPM/CTR/ROAS trends from the insights cache so I can spot regressions visually.
- [ ] As a marketer, I want a Creatives tab listing active creatives with thumbnail previews and performance scores.

## Acceptance Criteria

- [ ] Three tabs present: Overview, Performance (uPlot), Creatives
- [ ] Asset-serving locked (no arbitrary file reads outside `_dream_context/marketing/`)
- [ ] Brain graph layer toggle defaults OFF on the Marketing tab
- [ ] KnowledgePage deep-links to `knowledge/marketing-learnings/` when navigating from Marketing tab
- [ ] No new external npm dependencies beyond uPlot (already planned)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-04-25 — Deferred from meta-marketing-skill PR 7
Dashboard v0 was the original PR 7 in the meta-marketing-skill plan. Deferred because PRs 8 and 5 (pre-commit hook, mk council wrapper, Reinfluence vision pass) were higher priority and the dashboard tab is a standalone UI concern. The original PR 7 spec (3 tabs, locked asset-serving, Brain toggle OFF, KnowledgePage deep-link) is fully preserved here.

## Technical Details

- Integrates with `dreamcontext dashboard` (existing React 19 + Vite 6 + Node HTTP server).
- Data source: `_dream_context/marketing/` (insights cache, runs WAL, learnings index).
- uPlot for Performance charts (lightweight, already used elsewhere in the meta-marketing skill design).
- See web-dashboard feature PRD for dashboard architecture conventions.
- Related: `src/server/routes/` for new API endpoints, `dashboard/src/pages/` for new page components.

## Notes

- Coordinate with web-dashboard task (in_review) — ensure new Marketing tab follows the same page/tab pattern and doesn't conflict with Dashboard Phase 5 work (a11y, responsive, i18n).
- Original PR 7 design had the Brain graph layer toggle OFF by default on the Marketing tab to reduce visual noise for non-technical users.

## Changelog
<!-- LIFO: newest entry at top -->


### 2026-05-09 - Status → todo
- Attaching to v0.3.0 planning version — untracked, no status change
### 2026-04-26 - Created (lifted from meta-marketing-skill PR 7 deferral)
- Task created from the deferred PR 7 of meta-marketing-skill. Original spec preserved in full above.
- meta-marketing-skill task is now fully closed (PRs 0/0.5/1/2/3/4/5/6/8 shipped).
