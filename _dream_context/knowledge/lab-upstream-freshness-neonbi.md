---
name: lab-upstream-freshness-neonbi
description: NeonBI's REST API exposes data-freshness fields enabling source-aware sync, implemented as an upstream freshness gate in Lab reports (2026-09-02)
tags:
  - topic:lab
  - domain:database
  - decisions
  - kind:integration
pinned: false
date: '2026-09-02'
---

## Why This Exists

Lab insights sync from external sources on a TTL schedule. Before 2026-09-02, opening a Lab report posted `force: true` over every insight it referenced, causing each open to re-run every upstream query regardless of TTL or source staleness. This was reported from NeonBI's side as burst traffic of identical queries.

The fix (commit c2d4aa3b) changed reports to post `force: false`, handing the decision back to the sync engine's TTL gate. But the deeper discovery is that **NeonBI's REST API now exposes data-freshness metadata** that enables true source-aware sync.

## NeonBI Data Freshness Fields

NeonBI's REST API provides `tableLastModified` and sibling freshness fields in query responses. This allows a client to:

1. **Skip queries entirely when source data hasn't changed** — the API returns metadata without executing the query if the client's cached timestamp matches the source's last-modified time.
2. **Implement an upstream freshness gate** — Lab's TTL gate can now be elevated to a source-staleness gate: check if the upstream table changed since last sync, and skip the adapter call if it hasn't.

This is a **real integration fact** worth permanent capture, not just a commit note.

## Current Implementation (2026-09-02)

The shipped fix is TTL-based only: `force: false` on report opens means the engine's existing TTL logic applies — a slug within its `ttl_minutes` skips with zero adapter calls, an expired one refetches.

The data-freshness fields are **not yet used** by Lab's sync engine. The API capability exists; the client-side integration is future work.

## Sources

- Commit c2d4aa3b: "fix(lab): opening a report is not a request to refetch everything"
- Task: `lab-request-budget-an-upstream-freshness-gate...`
- Related task: `neonbi-request-diyeti-source-freshness-aware-sync-insight-report`
- NeonBI API documentation (not in-tree; external vendor docs)

## Last Verified

2026-09-02 — TTL-based gate shipped; data-freshness API capability documented but not yet integrated.
