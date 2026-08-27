---
title: 'Demo: Acquisition Report'
description: null
category: Marketing
group: Growth
render: app
size: null
unit: signups
source:
  adapter: script
  script:
    file: scripts/demo-acquisition-app.mjs
refresh:
  ttl_minutes: 1440
tweaks:
  - key: range
    type: enum
    label: Date range
    options:
      - last_7_days
      - last_28_days
      - last_90_days
    default: last_28_days
binding: null
credentials_used: []
created_at: '2026-08-27'
updated_at: '2026-08-27'
---
## Meaning

(What does this number MEAN? Why does it matter, and how should a reader interpret a move?)
