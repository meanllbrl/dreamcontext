---
id: task_4DrRAN-6
name: snapshot-pinned-preview
description: snapshot-pinned-preview
priority: medium
urgency: medium
status: completed
created_at: '2026-05-02'
updated_at: '2026-05-02'
tags:
  - cli
  - snapshot
  - knowledge
parent_task: null
related_feature: null
version: null
---

## Workflow
<!-- Mermaid flowchart of milestones + acceptance-criteria nodes. Keep in sync with the Acceptance Criteria checklist: 1 node per criterion, status class matches checkbox state. -->

```mermaid
flowchart TD
  subgraph M1 ["Milestone 1"]
    A1[First criterion]:::todo
  end

  classDef done fill:#86efac,stroke:#15803d,color:#052e16
  classDef active fill:#fde68a,stroke:#b45309,color:#451a03
  classDef todo fill:#e5e7eb,stroke:#6b7280,color:#111827
  classDef blocked fill:#fecaca,stroke:#b91c1c,color:#450a0a
```

## Why

(To be defined)

## User Stories

- [ ] As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- [ ] First criterion (must match a node in Workflow)

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

## Technical Details

(Key files, services, dependencies, implementation approach.)

## Notes

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest entry at top -->


### 2026-05-02 - Session Update
- Implemented (2026-05-02 session 67873c11): KnowledgeEntry gains optional pinnedPreviewLines/pinnedPreviewAll from frontmatter. snapshot.ts: extractPinnedPreview() + DEFAULT_PINNED_PREVIEW_LINES=60. Both generateSnapshot() and generateSubagentBriefing() cap pinned content with '→ Read full: ...' pointer. Snapshot shrunk 1242→730 lines (112KB→80KB). 11 new test assertions (44 affected tests pass). Unrelated marketing-council test failure is pre-existing.
### 2026-05-02 - Created
- Task created.
