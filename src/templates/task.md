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

## Why
<!-- What problem does this solve? What breaks if we don't do it? Be concrete — name the user, the friction, the cost. One paragraph beats five bullets. -->

{{WHY}}

<!-- Other sections (User Stories, Acceptance Criteria, Workflow, Constraints & Decisions, Technical Details, Notes) are created on first insert — `dreamcontext tasks insert <task> <section> "…"`. A section that has nothing to say doesn't exist. -->

## Changelog
<!-- LIFO: newest entry at top. Auto-prepended by `dreamcontext tasks log`. Each entry is a session-shaped breadcrumb — what shipped, what was decided, where you stopped. -->

### {{DATE}} - Created
- Task created.
