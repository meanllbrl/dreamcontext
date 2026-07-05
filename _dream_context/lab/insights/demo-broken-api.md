---
title: 'Demo: Broken API (expected to fail)'
description: null
group: Marketing
render: number
unit: requests
source:
  adapter: http
  http:
    endpoint: 'http://127.0.0.1:9/nope'
    method: GET
    headers: {}
    body: null
    extract:
      seriesPath: data
      seriesKey: null
      x: date
      'y': value
      agg: last
refresh:
  ttl_minutes: 1440
tweaks: []
binding: null
credentials_used: []
created_at: '2026-07-05'
updated_at: '2026-07-05'
---
## Meaning

DEMO FIXTURE (throwaway, `demo-` prefix) — deliberately points at a closed local port (http://127.0.0.1:9/nope) so every sync fails with a connection error. Exists to exercise the loud per-insight refresh error toast and the "one failure among a successful sync-all" flow for the manual dashboard checklist. NOT a real metric — safe to delete after validation.
