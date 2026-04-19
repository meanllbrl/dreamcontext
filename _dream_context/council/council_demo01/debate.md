---
id: "council_demo01"
topic: "Should we migrate from Postgres to Firestore?"
status: "complete"
rounds_planned: 2
current_round: 2
interrupt_between_rounds: true
personas:
  - migration-risk-auditor
  - dx-champion
  - user-advocate
promoted_to_knowledge: null
created_at: "2026-04-18"
updated_at: "2026-04-19"
---

## Question

Should we migrate from Postgres to Firestore for our primary datastore?

## Constraints & Known Facts

- Current workload: 10M documents/month
- SLA: 99.95% uptime
- Team familiarity: Postgres (high), Firestore (low)
- Real-time sync is a frequently requested feature
