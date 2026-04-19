---
id: task_N0tVdTwR
name: install-claude-md
description: install-claude-md
priority: medium
urgency: medium
status: in_progress
created_at: '2026-04-19'
updated_at: '2026-04-19'
tags:
  - cli
  - onboarding
  - templates
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


### 2026-04-19 - Session Update
- Created install-claude-md command: dreamcontext install-claude-md installs a terse CLAUDE.md template (84 lines / ~3k tokens) to project root. Three modes: append (default interactive, idempotent via <!-- dreamcontext:start -->...<!-- dreamcontext:end --> fence), replace (always backups as CLAUDE.md.bak-<timestamp>), skip. Template sections: role, limitations, security, dreamcontext, coding, communication, rules, pushback, decisions, sub_agents. Registered in src/cli/index.ts. Optional setup step added to init.ts (y/n prompt, default no). Token savings: ~11k tokens per session (vs old ~14k template). All 6 idempotency test cases pass.
### 2026-04-19 - Created
- Task created.
