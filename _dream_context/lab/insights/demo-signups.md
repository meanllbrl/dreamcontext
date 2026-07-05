---
title: 'Demo: Daily Signups'
description: null
group: Engagement
render: number
unit: signups
source:
  adapter: script
  script:
    file: scripts/demo-signups.mjs
refresh:
  ttl_minutes: 1440
tweaks: []
binding: null
credentials_used: []
created_at: '2026-07-05'
updated_at: '2026-07-05'
---
## Meaning

DEMO FIXTURE (throwaway, `demo-` prefix) — synthesized daily signup counts. Exists to exercise the `number` render + fresh staleness badge for the manual dashboard checklist, not a real metric.
