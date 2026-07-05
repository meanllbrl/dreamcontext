---
title: 'Demo: Daily Active Users'
description: null
group: Engagement
render: line
unit: users
source:
  adapter: script
  script:
    file: scripts/demo-dau.mjs
refresh:
  ttl_minutes: 1440
tweaks:
  - key: range
    type: enum
    label: Range
    options:
      - last_30_days
      - last_1_year
    value: last_30_days
binding: null
credentials_used: []
created_at: '2026-07-05'
updated_at: '2026-07-05'
---
## Meaning

DEMO FIXTURE (throwaway, `demo-` prefix) — synthesized daily active users across the resolved `range` tweak window. Exists to exercise the `line` chart and the granularity-coarsening behavior (daily at `last_30_days`, monthly at `last_1_year`) for the manual dashboard checklist, not a real metric.
