---
name: dashboard-build-verification
type: pattern
tags: [topic:build, topic:dashboard, domain:engineering]
updated: "2026-08-01"
description: Dashboard build workflow requirements for CLI distribution
---

# Dashboard Build Verification

**Source**: Migrated verbatim from `core/1.user.md` by migration 0.23.0 (`distribute-user-md-residue`). This content is un-distilled and preserved as originally written.

## Extended Workflow Patterns

> Extended workflow patterns (sub-agent orchestration, stacked PRs, multi-account gh, issue+test-first, high-effort review, desktop verification, always-run-tests) archived to knowledge/archive/1.user-2026-h2.md (2026-07-28 ceiling enforcement).

## Dashboard Build Requirement

**Dashboard changes: root `npm run build` REQUIRED** — `dashboard/npm run build` only updates `dashboard/dist/`; CLI serves from `dist/dashboard/` (populated by tsup `onSuccess`). Always verify `dist/dashboard/assets/` timestamps match source.
