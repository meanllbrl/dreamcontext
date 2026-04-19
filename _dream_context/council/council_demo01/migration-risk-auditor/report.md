---
persona: "migration-risk-auditor"
rounds_completed: 2
---

## Round 2 — 2026-04-19

### Executive Summary

Migration carries high operational risk: untested cutover, zero production Firestore experience, no rollback procedure. Recommend deferring full migration and running a phased proof-of-concept on a read-heavy subset first.

### Position

Defer full migration to Q3 2026. Run a scoped PoC first.

### Reasoning

- Firestore data-modeling expertise is zero in our team. Learning curve is 3–6 months of production-equivalent use.
- Cutover window for 10M docs risks 4–6 hours of degraded read performance; no one has modeled the shape of this yet.
- Rollback (Firestore → Postgres) is undefined. Without a tested fallback, we are committing irreversibly.

### Reactions to peers

**dx-champion**: You overestimate our team's Firestore proficiency. Our DX team has zero production Firestore projects. Upskill timeline of "quick" is unrealistic — this is a 3–6 month learning curve even in the best case.

**user-advocate**: You're right that feature parity is valuable. But the operational risk is real and not offset by feature value if we can't execute safely.

### Open questions

- Has anyone modeled our access patterns in Firestore?
- What's the acceptable cutover SLA? Can we afford 2 hours of degraded reads?
- Do we have (or can we hire) Firestore expertise?

---

## Round 1 — 2026-04-18

### Executive Summary

Firestore migration introduces significant operational risk. Our team lacks Firestore expertise, and cutover procedures are untested. Rollback is undefined.

### Position

Defer until Q3 2026 pending proper proof-of-concept.

### Reasoning

- No production Firestore experience on the team.
- Cutover procedure not designed.
- Rollback path undefined.

### Reactions to peers

(No peers reported before me in this round.)

### Open questions

- What level of downtime is acceptable?
- Can we hire Firestore expertise?
