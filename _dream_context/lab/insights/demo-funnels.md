---
title: 'Demo: Onboarding Funnels'
description: null
category: Product
group: Onboarding
render: funnel
unit: null
source:
  adapter: script
  script:
    file: scripts/demo-funnels.mjs
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
created_at: '2026-07-23'
updated_at: '2026-07-23'
---
## Meaning

DEMO FIXTURE (throwaway, `demo-` prefix) — synthesized onboarding funnel variants (classic / short / video / paywall-first, plus a tiny TR test) as a `funnel-set/v1` payload. Exists to exercise the funnel UI end-to-end: overview table with Δ-vs-previous-period and the low-sample chip, detail node lane with drop badges and the A→B arc gesture, language/device client filters and breakdowns, multi-funnel compare (including a ghosted step), and benchmark tinting. Not real data.
