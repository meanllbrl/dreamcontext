---
id: task_u4rsHoky
name: sleep-dispatch-dedup
description: sleep-dispatch-dedup
priority: medium
urgency: medium
status: completed
created_at: '2026-03-10'
updated_at: '2026-03-10'
tags:
  - backend
  - architecture
parent_task: null
related_feature: null
version: null
---

## Why

(To be defined)

## User Stories

- [ ] As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- (Specific, testable conditions for this task to be complete)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

## Technical Details

(Key files, services, dependencies, implementation approach.)

## Notes

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest entry at top -->


### 2026-03-10 - Session Update
- Added sleep_started_at guard to getConsolidationDirective() and user-prompt-submit hook. When consolidation in progress: debt>=4 returns 'Do NOT dispatch another sleep agent', debt<4 returns null (silent). Fixes race where multiple agents could both dispatch rem-sleep in the same session. 4 new integration tests, 473 total passing.
### 2026-03-10 - Created
- Task created.
