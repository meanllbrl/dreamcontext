---
id: task_DCH-wxKa
name: v06-control-panel-vaults-tauri
description: >-
  WS4 of the re-platform epic. Depends on
  v05-positioning-easy-install-update-nudge (version-check lib).
priority: high
urgency: medium
status: todo
created_at: '2026-05-31'
updated_at: '2026-05-31'
tags:
  - control-panel
  - tauri
  - vaults
  - desktop
  - security
parent_task: null
related_feature: null
version: 0.6.0
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

Replace dreamcontext dashboard with an installable always-on control panel: multi-vault (open multiple projects), per-project settings, per-project update detection (reuses the v0.5 version-check lib), and skill/skill-pack management. Build the browser control-plane (backend APIs + wire the existing React dashboard) first, then wrap in a Tauri native shell with auto-update. Deferred from the v0.5 run as a dedicated next epic.

## User Stories
<!-- As a <role>, I can <action>, so that <outcome>. Tick when demonstrably true in the running system. -->

- [ ] As a [role], I can [action], so that [outcome]

## Acceptance Criteria
<!-- The contract. Each line is testable and gets a node in the Workflow flowchart above. -->

- [ ] First criterion (matches node A1 in Workflow)

## Constraints & Decisions
<!-- LIFO: newest at top. Capture the why, not just the what. -->



- **[2026-05-31]** DEFER: bundling a standalone agent runtime for non-technical users (multi-month, separate epic); in-panel SKILL.md editing (view/install/update only in v1); Windows/Linux packaging beyond one dev target.
- **[2026-05-31]** SECURITY (do FIRST in this run, HIGH priority, carried from the v0.5 plan review): the dashboard server (src/server/index.ts) binds 0.0.0.0 with Access-Control-Allow-Origin:* and exposes mutating routes (PUT /api/core/:filename, PATCH /api/sleep, etc.) — a CSRF/drive-by-write surface. Bind 127.0.0.1 by default, drop wildcard CORS, add an Origin/Host allowlist (or CSRF token) on all mutating routes, and add a path-traversal guard (reject .. ) on routes that build filesystem paths from request input. The new PATCH /api/config must strict-pick {platforms,packs} from the body, never pass-through.
## Technical Details
<!-- Where the work lives. Files, services, key functions to reuse. Body is current truth — update in place; don't append. -->

(Key files, services, dependencies, implementation approach.)


v1a (browser control-plane, vitest-validatable): CREATE src/lib/vaults.ts (~/.dreamcontext/vaults.json, validate each path has _dream_context/), src/cli/commands/vaults.ts (add/list/remove), src/server/routes/{config,packs,version}.ts (GET/PATCH /api/config, GET /api/packs, GET /api/version-check reusing version-check.ts), register in src/server/index.ts buildRouter; wire the existing React dashboard with a vault switcher, Settings page, update badge, packs page. Multi-vault Option A = launch one server per vault.

v1b (Tauri shell, manual-validation): CREATE desktop/ Tauri project that spawns dreamcontext dashboard as a sidecar and loads it; tauri-plugin-updater against GitHub Releases; EDIT dashboard.ts to accept --vault. Code-signing/notarization is its own CI+secrets sub-project.
## Notes
<!-- Loose ends, edge cases, open questions. -->

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->

### 2026-05-31 - Created
- Task created.
