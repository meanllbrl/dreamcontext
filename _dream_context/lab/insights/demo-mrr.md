---
title: 'Demo: MRR (bound to make-it-a-business)'
description: null
group: Business
render: number
unit: $
source:
  adapter: script
  script:
    file: scripts/demo-mrr.mjs
refresh:
  ttl_minutes: 1440
tweaks: []
binding:
  objective: make-it-a-business
  value: latest
credentials_used: []
created_at: '2026-07-05'
updated_at: '2026-07-05'
---
## Meaning

DEMO FIXTURE (throwaway, `demo-` prefix) — synthesized MRR, bound to the `make-it-a-business` roadmap objective's Key Result. Exists to exercise the insight-side "feeds &lt;objective&gt;" provenance chip for the manual dashboard checklist. NOT a real revenue number — its sync will overwrite `make-it-a-business`'s `metric.current` (was 0 before this fixture; see the task changelog for the value written).
