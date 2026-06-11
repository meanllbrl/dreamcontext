---
id: "{{ID}}"
name: "{{NAME}}"
description: "{{DESCRIPTION}}"
priority: "{{PRIORITY}}"
urgency: "{{URGENCY}}"
status: "{{STATUS}}"
created_at: "{{DATE}}"
updated_at: "{{DATE}}"
tags: {{TAGS}}
# tags: use canonical faceted vocabulary (facet:value, kebab-case singular) — run: dreamcontext taxonomy vocab
parent_task: null
related_feature: null
version: {{VERSION}}
# RICE prioritization (optional). Uncomment + fill to enable Scatter view + RICE sort.
# rice:
#   reach: 5         # integer 1–10
#   impact: 3        # integer 1–5
#   confidence: 75   # one of 25, 50, 75, 100
#   effort: 2        # weeks, > 0 and ≤ 52 (0.5 step OK)
#   score: null      # derived server-side; leave null
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

{{WHY}}

## User Stories
<!-- Who benefits, what they can do, why it matters. Format: As a <role>, I can <action>, so that <outcome>. Tick the box when the story is demonstrably true in the running system. -->

- [ ] As a [role], I can [action], so that [outcome]

## Acceptance Criteria
<!-- The contract. Each line is testable, observable, and gets a node in the Workflow flowchart above. Tick `[x]` AND flip the node to `:::done` in the same edit. -->

- [ ] First criterion (matches node A1 in Workflow)

## Constraints & Decisions
<!-- LIFO: newest decision at top. Format: **[YYYY-MM-DD]** Decision + one-line rationale. Capture trade-offs, not just outcomes — future you needs the "why". -->

## Technical Details
<!-- Where the work lives. Files to touch, services involved, key functions to reuse. Update this in place when the approach changes — don't append; the body is current truth, the changelog is history. -->

(Key files, services, dependencies, implementation approach.)

## Notes
<!-- Loose ends. Edge cases, open questions, things to verify, ideas for later. -->

(Working notes, edge cases, open questions.)

## Changelog
<!-- LIFO: newest entry at top. Auto-prepended by `dreamcontext tasks log`. Each entry is a session-shaped breadcrumb — what shipped, what was decided, where you stopped. -->

### {{DATE}} - Created
- Task created.
