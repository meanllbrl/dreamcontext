---
name: dashboard-build-verification
type: pattern
tags: [topic:build, topic:dashboard, domain:engineering]
updated: "2026-08-08"
description: Dashboard build workflow requirements for CLI distribution
---

# Dashboard Build Verification

**Source**: Migrated verbatim from `core/1.user.md` by migration 0.23.0 (`distribute-user-md-residue`). This content is un-distilled and preserved as originally written.

## Extended Workflow Patterns

> Extended workflow patterns (sub-agent orchestration, stacked PRs, multi-account gh, issue+test-first, high-effort review, desktop verification, always-run-tests) archived to knowledge/archive/1.user-2026-h2.md (2026-07-28 ceiling enforcement).

## Dashboard Build Requirement

Two dashboard directories exist and only one is ever rendered: `vite build` writes
`dashboard/dist/`, but the server serves `dist/dashboard/` (`getDashboardDir()` — sibling of
`dist/index.js`). They drift the moment you rebuild only the UI.

**Now enforced, not remembered (2026-08-08).** Root `build:dashboard` ends in
`node scripts/sync-dashboard-dist.mjs`, which REMOVES `dist/dashboard` and re-copies
`dashboard/dist` into it. Remove-then-copy, never merge: asset names are content-hashed, so a
plain `cpSync` over a populated directory leaves every previous build's chunks behind forever
(tsup's `clean: true` hides this for `build:cli`; a dashboard-only rebuild had no such guard).
No-op when `dist/` doesn't exist yet — tsup's `onSuccess` copy populates it on the next
`build:cli`.

**Why it earned a script.** A `ReferenceError: CHART_COLORS is not defined` was chased through
the source import graph (`lab/funnel/funnelModel.ts` → `lab/chartColors.ts`) for an hour. The
graph was correct and five consecutive builds were clean. The browser was simply being served a
months-stale `dist/dashboard` snapshot — one taken by whichever `build:cli` ran last. The
symptom looks exactly like a bundler bug and is not one.

**When a browser-level result contradicts the source, check the served entry first:**
`diff <(grep -o 'index-[A-Za-z0-9_-]*\.js' dashboard/dist/index.html) <(grep -o 'index-[A-Za-z0-9_-]*\.js' dist/dashboard/index.html)`
