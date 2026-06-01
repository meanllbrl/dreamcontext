---
id: "task_ebhxn2LF"
name: "v06-tauri-launch-fix"
description: "v06-tauri-launch-fix"
priority: "high"
urgency: "medium"
status: "todo"
created_at: "2026-06-01"
updated_at: "2026-06-01"
tags: []
parent_task: null
related_feature: null
version: "v0.6.0"
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
<!-- What problem does this solve? What breaks if we don't do it? Be concrete — name the user, the friction, the cost. -->

The bundled Mac .app crashes immediately when double-clicked: a Finder-launched app has no node on PATH and cwd=/ (so the dev-default CLI/vault paths are wrong) → spawn fails → setup() returns Err → .expect() panics → abort. Fix: resolve node absolutely (Homebrew/nvm/volta/usr), bundle the CLI package (dist+skill-packs+skill) as app resources + resolve from resource_dir, default the vault from ~/.dreamcontext/vaults.json, and FAIL GRACEFULLY with an error window instead of crashing.

## User Stories
<!-- As a <role>, I can <action>, so that <outcome>. Tick when demonstrably true in the running system. -->

- [ ] As a [role], I can [action], so that [outcome]

## Acceptance Criteria
<!-- The contract. Each line is testable and gets a node in the Workflow flowchart above. -->

- [ ] First criterion (matches node A1 in Workflow)

## Constraints & Decisions
<!-- LIFO: newest at top. Capture the why, not just the what. -->

## Technical Details
<!-- Where the work lives. Files, services, key functions to reuse. Body is current truth — update in place; don't append. -->

(Key files, services, dependencies, implementation approach.)

## Notes
<!-- Loose ends, edge cases, open questions. -->

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->

### 2026-06-01 - Created
- Task created.
