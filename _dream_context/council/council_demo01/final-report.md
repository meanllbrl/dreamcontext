---
debate_id: "council_demo01"
topic: "Should we migrate from Postgres to Firestore?"
synthesized_at: "2026-04-19"
personas:
  - migration-risk-auditor
  - dx-champion
  - user-advocate
rounds: 2
---

## Verdict

Defer full Firestore migration. Run a scoped proof-of-concept on a read-heavy subset this quarter, with a clear go/no-go gate before any production cutover.

## Why

- **Operational risk of cutover is unacceptable unaddressed** — surfaced by migration-risk-auditor in R1; reinforced by user-advocate in R2; not invalidated by dx-champion in R2 (who conceded the point and adjusted to favor a PoC).
- **Team Firestore expertise is insufficient for direct migration** — named by migration-risk-auditor in R1 and R2; dx-champion in R2 acknowledged and adjusted.
- **User-visible reliability bar is load-bearing** — user-advocate in R2 framed why delay is preferable to a shaky cutover. A failed migration would cost more trust than the features unlock.
- **Real-time feature value is real but not yet unblocking** — dx-champion in R1 and R2 established the feature case; user-advocate conceded the value; neither argument supports skipping the PoC.

## What was debated

R1: migration-risk-auditor opened with a clear risk-deferral position. dx-champion countered with a feature-velocity go-case. user-advocate did not submit.

R2: user-advocate joined, siding with the auditor on reliability grounds. dx-champion shifted position from GO to PIVOT (PoC with Q2 gate), acknowledging team readiness gaps. migration-risk-auditor held position with sharpened reasoning. Clear consensus emerged around a phased PoC.

## Minority views

dx-champion's residual position: the Q2 go-live window should remain on the table if PoC results are favorable. This is not dissent against the PoC — it is advocacy for speed if the gate passes. Worth preserving because compressing the feature timeline has real business value.

## Open risks

- Cutover SLA is still undefined. Recommend defining an acceptable downtime budget (e.g., ≤ 2 hours) before the PoC hands off.
- Rollback procedure is undefined. MUST be tested before any production exposure; this is the single largest unaddressed risk.
- Q2 stakeholder pressure is real. If the product/business side pushes for Q2 regardless, migration-risk-auditor's PoC timeline may not survive negotiation.
- User communication around the PoC → go-live arc has not been scoped.

## Appendix: per-agent per-round summaries

### migration-risk-auditor — Round 1

Firestore migration introduces significant operational risk. Our team lacks Firestore expertise, and cutover procedures are untested. Rollback is undefined.

### migration-risk-auditor — Round 2

Migration carries high operational risk: untested cutover, zero production Firestore experience, no rollback procedure. Recommend deferring full migration and running a phased proof-of-concept on a read-heavy subset first.

### dx-champion — Round 1

Real-time sync is a killer feature we keep delaying. Firestore is mature, the migration is tractable, and the team can upskill quickly on it.

### dx-champion — Round 2

PoC is sensible. But we shouldn't let risk aversion push the Q2 window. If the PoC shows healthy read latency and manageable model shape, Q2 go-live remains feasible with a 2-week Firestore bootcamp.

### user-advocate — Round 1

(No report submitted.)

### user-advocate — Round 2

Users care about reliability first and real-time second. A botched cutover loses more trust than a delayed feature ever will. Phased PoC, user-visible reliability SLAs, and clear comms.
