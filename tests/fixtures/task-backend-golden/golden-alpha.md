---
id: task_golden001
name: Golden Alpha
description: First golden task
priority: medium
urgency: medium
status: todo
created_at: '2026-06-11'
updated_at: '2026-06-11'
tags:
  - alpha
  - golden
parent_task: null
related_feature: null
version: 0.7.1
rice: null
---

## Workflow
<!-- The shape of this task at a glance. One node per acceptance criterion, grouped under milestone subgraphs. Update node classes as work progresses: `:::done` (green), `:::active` (amber), `:::todo` (gray), `:::blocked` (red). Run `dreamcontext tasks doctor` to verify sync. -->

```mermaid
flowchart TD
  subgraph M1 ["Milestone 1 — rename me"]
    A1[First criterion]:::todo
  end

  classDef done fill:#86efac,stroke:#15803d,color:#052e16
  classDef active fill:#fde68a,stroke:#b45309,color:#451a03
  classDef todo fill:#e5e7eb,stroke:#6b7280,color:#111827
  classDef blocked fill:#fecaca,stroke:#b91c1c,color:#450a0a
```

## Why
<!-- What problem does this solve? What breaks if we don't do it? Be concrete — name the user, the friction, the cost. One paragraph beats five bullets. -->

Because golden bytes matter

Extra rationale appended

## User Stories
<!-- Who benefits, what they can do, why it matters. Format: As a <role>, I can <action>, so that <outcome>. Tick the box when the story is demonstrably true in the running system. -->

- [ ] As a dev, I can replay golden ops, so that refactors are provably safe

## Acceptance Criteria
<!-- The contract. Each line is testable, observable, and gets a node in the Workflow flowchart above. Tick `[x]` AND flip the node to `:::done` in the same edit. -->

- [ ] Criterion one is met

## Constraints & Decisions
<!-- LIFO: newest decision at top. Format: **[YYYY-MM-DD]** Decision + one-line rationale. Capture trade-offs, not just outcomes — future you needs the "why". -->


- **[2026-06-11]** Constraint captured
## Technical Details
<!-- Where the work lives. Files to touch, services involved, key functions to reuse. Update this in place when the approach changes — don't append; the body is current truth, the changelog is history. -->

Lives under tests/unit

## Notes
<!-- Loose ends. Edge cases, open questions, things to verify, ideas for later. -->

A working note

## Changelog
<!-- LIFO: newest entry at top. Auto-prepended by `dreamcontext tasks log`. Each entry is a session-shaped breadcrumb — what shipped, what was decided, where you stopped. -->





### 2026-06-11 - Status → todo
### 2026-06-11 - Status → in_review
- Ready for review
### 2026-06-11 - Session Update
- Session progress note
### 2026-06-11 - Update
- Inserted changelog line
### 2026-06-11 - Created
- Task created.
