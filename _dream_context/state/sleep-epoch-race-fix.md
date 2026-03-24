---
id: task_EpochRace
name: sleep-epoch-race-fix
description: >-
  Fix race condition where sleep done unconditionally cleared all sessions and
  dashboard_changes, losing records from parallel sessions that finished during
  consolidation. Implemented epoch-based filtering.
priority: critical
status: completed
created_at: '2026-02-25'
updated_at: '2026-02-25'
tags:
  - backend
  - architecture
  - decisions
parent_task: null
---

## Why

When `sleep done` runs at the end of rem-sleep consolidation, it unconditionally clears `sessions = []` and `dashboard_changes = []`. If a parallel session finishes (`hook stop`) or the dashboard records changes while rem-sleep is working, those records get written to `.sleep.json` but then wiped by `sleep done`. The data is permanently lost and never processed by any future consolidation cycle.

## Solution

Epoch-based filtering. Added `sleep_started_at` timestamp to `SleepState`. The rem-sleep agent calls `dreamcontext sleep start` before doing any work, which sets the epoch. When `sleep done` runs, it only clears sessions/changes from BEFORE the epoch. Post-epoch records survive for the next consolidation cycle. Fully backward compatible when `sleep start` is not called.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-02-25 - Implemented
- Added `sleep_started_at: string | null` to `SleepState` interface and defaults
- New `sleep start` command records timestamp epoch in `.sleep.json`
- Rewrote `sleep done`: filters sessions by `stopped_at > epoch`, dashboard_changes by `timestamp > epoch`, recalculates debt from survivors. Falls back to clear-all if no epoch (backward compat).
- Updated rem-sleep agent: Step 0 runs `sleep start` before any consolidation work
- Updated SKILL.md: command reference, epoch safety note in sleep system section
- Snapshot shows "Consolidation in progress" when epoch is active
- Dashboard frontend interface updated with `sleep_started_at` field
- 274 tests passing (was 258), 8 new tests (2 unit, 6 integration)
