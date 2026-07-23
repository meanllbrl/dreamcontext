---
id: know_O7shgtDO
name: Lean Task Authoring Pattern
description: >-
  How every task is authored since the lean-scaffold change: sentence-style
  names (never slugs), mandatory --why on every create surface, and a lean
  scaffold — only Why + Changelog at birth; other sections are created on first
  insert, before Changelog. Never insert placeholder content.
tags:
  - 'kind:decisions'
  - 'topic:tasks'
  - 'layer:cli'
pinned: true
date: '2026-07-23'
---

## Why This Exists

Tasks used to scaffold with dummy content — an empty mermaid flowchart, "As a [role]…" placeholder stories, blank criteria — so every new task looked half-finished and the real content drowned in skeleton. Tasks could also be created with no reason recorded, which made them unreadable months later, and agents named tasks like type-prefixed slugs (feat-x-y) that hide what the work actually is. Fixed in the "Task creation scaffolds lean and every task says why it exists" task (v0.20.x).

## The Pattern

1. **Name = a short plain sentence** describing the outcome: "Fix the login redirect loop", "Dashboard renders the summary as a paragraph". Never a slug — the file slug derives from the name automatically (slugify).
2. **--why is mandatory on every create surface.** CLI refuses without -w/--why, the API returns 400 missing_why, the dashboard modal requires the field. created_at + the Changelog "Created" entry cover the "when".
3. **Lean scaffold.** A new task contains only `## Why` and `## Changelog`. Every other section (user_stories, acceptance_criteria, workflow, constraints, technical_details, notes) is created on FIRST `dreamcontext tasks insert`, slotted before Changelog in canonical position (insertToSection createIfMissing).
4. **A section with nothing to say does not exist.** Never insert placeholders to "complete" a task shape. The Workflow mermaid flowchart is opt-in — `tasks doctor` validates it against Acceptance Criteria only once present.

## When To Use / Avoid

- **Use** always — this is the standing contract for task authoring in every dreamcontext project (enforced in code since the lean-scaffold change; documented in the shipped skill).
- **Avoid** fighting it: do not hand-write empty sections back into templates, and do not bypass --why with filler text — the Why is what makes a task readable months later.

## Related

- Enforcement: src/templates/task.md, src/lib/task-backend/local.ts (both scaffolds), src/lib/markdown.ts insertToSection, src/cli/commands/tasks.ts, src/server/routes/tasks.ts, dashboard TaskCreateModal.
- Shipped agent contract: skill/SKILL.md § Tasks — essentials, skill/references/tasks-and-features.md § Create.
