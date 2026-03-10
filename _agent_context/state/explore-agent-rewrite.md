---
id: task_cxDSexq4
name: explore-agent-rewrite
description: explore-agent-rewrite
priority: medium
urgency: medium
status: completed
created_at: '2026-03-10'
updated_at: '2026-03-10'
tags:
  - architecture
  - backend
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
- Current session: Added SKILL.md rule #12 'Reuse before create' - before building any UI component/utility/hook, search for existing via agentcontext-explore. Added Track C proactive Reusable output section to explore agent. Together these enforce component reuse as a hard rule, not just a recommendation.
### 2026-03-10 - Session Update
- Rewrote agentcontext-explore agent (105->78 lines). Briefing-first philosophy, three-track routing (Track A: documented knowledge, Track B: find code, Track C: reusable component check), budget caps by thoroughness (Quick 1-3, Medium 4-8, Thorough 9-20 tool calls). Proactive Reusable output section added. Removed hardcoded file mapping table and sleep debt read. Research-backed: AGENTS.md arXiv 2602.11988, SWE-Search ICLR 2025.
### 2026-03-10 - Created
- Task created.
