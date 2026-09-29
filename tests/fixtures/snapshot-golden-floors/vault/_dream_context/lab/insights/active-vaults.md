---
title: Active Vaults
description: null
category: null
group: Adoption
render: number
unit: vaults
source:
  adapter: http
  http:
    endpoint: https://example.com/api/metric
    method: GET
    headers: {}
    body: null
    extract:
      seriesPath: data
      seriesKey: null
      x: date
      y: value
      agg: last
refresh:
  ttl_minutes: 1440
tweaks: []
binding: null
credentials_used: []
created_at: '2026-01-02'
updated_at: '2026-01-02'
---

## Meaning

Deliberately never synced. A manifest with no cache renders "no data yet" and
"never synced", neither of which reads the clock, so the golden stays stable.
