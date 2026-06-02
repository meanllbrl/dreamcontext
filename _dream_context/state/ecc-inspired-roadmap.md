---
id: task_z5xBwOJs
name: ecc-inspired-roadmap
description: >-
  Future improvements inspired by ECC competitive analysis (P1-P3). Items: (1)
  Strategic compact suggestion - tool call counter with threshold-based compact
  recommendation. (2) Basic security hooks - .env/.key/.pem read warning, prompt
  secret pattern scan. (3) console.log audit in Stop hook. (4) Doc file sprawl
  warning for non-standard .md creation. See
  knowledge/competitive-analysis-ecc.md for full analysis.
priority: medium
status: in_review
created_at: '2026-03-01'
updated_at: '2026-06-02'
version: v0.6.0
tags:
  - roadmap
  - competitive-analysis
  - hooks
parent_task: null
related_feature: null
---

## Why

ECC competitive analysis (`knowledge/competitive-analysis-ecc.md`) identified several P1-P3 improvements dreamcontext is missing. The recall/memory items have now been addressed (Wave 0-2 of [[memory-engine-360-roadmap]]). The remaining items are security hooks and strategic-compact tooling. These are also tracked as **Wave 4 in [[memory-engine-360-roadmap]]** — see that task for the authoritative remaining work list. This task tracks the ECC-origin context and the two concrete items not yet shipped.

## User Stories

- [ ] As a user, I want `.env`/`.key`/`.pem` read warnings and prompt secret-scan so that sensitive credentials are never accidentally leaked through the agent.
- [ ] As a user, I want a strategic compact suggestion (tool-call counter with threshold-based compact recommendation) so that context degradation is proactively surfaced.

## Acceptance Criteria

- [ ] PreToolUse hook warns (or blocks) reads of `.env`, `*.key`, `*.pem`, and similar credential files.
- [ ] Prompt secret-scan detects and warns on patterns matching API keys, tokens, passwords embedded in user messages.
- [ ] Tool-call counter tracks across a session and emits a compact suggestion at a configurable threshold.
- [ ] All new hooks covered by tests; no regressions in existing hook suite.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->
- 2026-06-02: Security secret-scan + strategic-compact items also appear as Wave 4.4 in [[memory-engine-360-roadmap]]. The memory roadmap is the authoritative delivery tracker; this task retains the ECC competitive context. Do NOT duplicate implementation work — one task should drive implementation when Wave 4 is prioritized.
- The `.env` PreToolUse gate was partially revived in `1451ab5` (Batch 3 D2 — registers the Edit|Write matcher correctly). The prompt secret-scan is the remaining P1 security gap.

## Technical Details

See `knowledge/competitive-analysis-ecc.md` for the full analysis. Overlap with [[memory-engine-360-roadmap]] Wave 4.4.

Key file: `src/lib/install-skill.ts` (hook registration), `src/lib/hook.ts` (PreToolUse handler).
## Changelog
<!-- LIFO: newest entry at top -->



### 2026-06-02 - Status → in_review
- Body filled; .env gate partially addressed (1451ab5). Prompt secret-scan + strategic compact remain, tracked under memory-engine-360-roadmap Wave 4.4. User to verify cross-reference and prioritize.
### 2026-06-02 - Session Update
- Body filled after long staleness. .env gate partially revived by memory-uplift Batch 3 (1451ab5). Remaining: prompt secret-scan + strategic compact. Cross-referenced to memory-engine-360-roadmap Wave 4.4 as authoritative delivery tracker. Attached to v0.6.0.
### 2026-06-02 - Triaged and cross-referenced
- Body filled in after long staleness. The `.env` gate was partially revived by memory-uplift Batch 3 (`1451ab5`). Remaining items (prompt secret-scan, strategic compact) cross-referenced to Wave 4.4 in [[memory-engine-360-roadmap]]. Status bumped to in_progress; memory-engine-360-roadmap is the authoritative delivery tracker for Wave 4.

### 2026-03-01 - Created
- Task created.
