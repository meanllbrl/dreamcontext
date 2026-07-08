---
id: feat_3VeOJa6a
status: active
created: '2026-05-09'
updated: '2026-07-08'
released_version: v0.8.7
tags:
  - tasks
  - prioritization
  - 'topic:dashboard'
  - 'topic:cli'
related_tasks: []
type: feature
name: rice-prioritization
description: ''
pinned: false
date: '2026-05-09'
---

## Why

Priority/urgency (Eisenhower) is too coarse for comparing tasks numerically. When a backlog has 16+ items, gut-feel triage cannot distinguish "this will move 5x more users" from "this is just louder." RICE forces rigor — Reach × Impact × Confidence ÷ Effort — and produces a numeric score that makes cross-task comparison possible without replacing the existing system. Eisenhower stays for quick triage; RICE adds the math layer. The two systems coexist per-view: each view has one source of truth.

## User Stories

- [x] As a solo dev, I can rate a task with R/I/C/E and see a derived score, so that I can compare tasks numerically instead of by gut feel.
- [x] As a solo dev, I can leave RICE blank on a task and still use priority/urgency for it, so that the new system is opt-in per task.
- [x] As a solo dev, I can open the Scatter view and see rated tasks placed on Impact × Effort with quadrant labels (Quick Wins / Big Bets / Fill-ins / Time Sinks), so that I can spot quick wins at a glance.
- [x] As a solo dev, I can click a dot in the Scatter view to open the task detail panel with RICE expanded, so that I don't need a separate editor surface.
- [x] As a solo dev, I can see unscored tasks in a collapsible tray below the Scatter, so that they don't disappear from view.
- [x] As a CLI user, I can run `dreamcontext tasks rice <slug> --reach 5 --impact 3 --confidence 80 --effort 2` to rate a task without editing other fields.
- [x] As a CLI user, I can run `dreamcontext tasks rice <slug>` (no flags) to print current RICE values and score.

## Acceptance Criteria

**Schema, CLI, Server**
- [x] `Task` interface in `dashboard/src/hooks/useTasks.ts` has `rice: RiceFields | null` and `UpdateTaskInput` extended.
- [x] `src/lib/rice.ts` exports `validateRiceInput`, `mergeRice`, `normalizeRice`, `computeScore`, `RiceFields`, `RiceInput` types.
- [x] Score formula: `score = (reach × impact × (confidence / 100)) / effort`. Stored in frontmatter.
- [x] `dreamcontext tasks create --reach --impact --confidence --effort` flags work and validate.
- [x] `dreamcontext tasks rice <slug>` subcommand prints current values (no flags) or updates them (with flags).
- [x] Unit tests for score formula in `tests/unit/rice.test.ts` covering all-set, partial, effort-guard, score precision.

**Dashboard detail panel**
- [x] `TaskDetailPanel` renders a collapsible "RICE" block with 4 numeric inputs and a computed score badge.
- [x] Score badge shows `—` when any field is empty; colored by threshold when set.
- [x] "Clear RICE" button sets all 4 fields to null in one PATCH.
- [x] TaskFilters sort dropdown includes "RICE score" option.
- [x] TaskFilters has a "Min RICE" numeric filter; tasks below threshold are hidden.
- [x] All new strings registered in `I18nContext.tsx`.

**Scatter view**
- [x] `RiceScatter.tsx` renders raw SVG (no chart lib) with X = Effort, Y = Impact, dot radius from Reach, opacity from Confidence.
- [x] Quadrant overlay with fixed midpoints (effort = 2 weeks, impact = 3) and labels: Quick Wins / Big Bets / Fill-ins / Time Sinks.
- [x] View switcher in TaskFilters: Kanban / Eisenhower / Scatter / List, persisted via `usePersistedState`.
- [x] Clicking a dot opens TaskDetailPanel with the RICE block expanded.
- [x] Unscored tasks render in a collapsed tray below the chart.
- [x] Off-screen `<ul>` ordered by score for screen readers; dots are keyboard-focusable with visible focus ring.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-05-09]** No drag-to-rate in the Scatter view. Click-to-open detail panel is the editing path.
- **[2026-05-09]** Coexistence per-view: Kanban sorts by priority+updated_at (ignores RICE). Eisenhower drives off priority/urgency. Scatter drives off RICE only. List view gets sort dropdown including RICE. No global precedence rule.
- **[2026-05-09]** Fixed quadrant thresholds (effort = 2 weeks, impact = 3), not median-based. Median moves the goalposts with each new task. Fixed thresholds give a stable mental map.
- **[2026-05-09]** Unified 1–N integer scales: Reach 1–10, Impact 1–5, Confidence ∈ {25,50,75,100}, Effort 0.5–8 person-weeks. One mental model: bigger is better, pick a number.
- **[2026-05-09]** No migration of existing tasks. Tasks appear in Scatter only when rated.
- **[2026-05-09]** No chart library. Raw SVG with manual scale math (~150 lines). Adding d3/recharts for one chart is unjustified.
- **[2026-05-09]** Schema is additive only. `priority` and `urgency` stay alongside `rice`. If only RICE is used after a month, drop them in a follow-up.
- **[2026-05-09]** Nested YAML `rice:` block round-trips cleanly with gray-matter. Confirmed by spike at start of implementation — no fallback to flat keys needed.

## Technical Details

**Frontmatter shape** (additive, all-optional):```yaml
rice:
  reach: 5          # integer 1–10
  impact: 3         # integer 1–5
  confidence: 80    # integer in {25, 50, 75, 100}
  effort: 2         # number > 0, <= 52, weeks (0.5 step)
  score: 6.0        # derived, null if any input missing```
**Key files**:
- `src/lib/rice.ts` — `validateRiceInput`, `mergeRice`, `normalizeRice`, `computeScore`. Pure functions, no I/O.
- `src/cli/commands/tasks.ts` — `--reach/--impact/--confidence/--effort` on `create`; new `rice <slug>` subcommand.
- `dashboard/src/hooks/useTasks.ts` — `Task.rice: RiceFields | null`, `UpdateTaskInput.rice`.
- `dashboard/src/components/tasks/TaskDetailPanel.tsx` + `.css` — collapsible RICE block, score badge, clear button.
- `dashboard/src/components/tasks/TaskFilters.tsx` — sort dropdown (RICE option), min-RICE filter, Scatter view switcher entry.
- `dashboard/src/components/tasks/RiceScatter.tsx` + `.css` — raw SVG scatter: axes, quadrants, dots (radius=reach, opacity=confidence), unscored tray.
- `dashboard/src/context/I18nContext.tsx` — RICE strings: `rice.reach`, `rice.impact`, `rice.confidence`, `rice.effort`, `rice.score`, `rice.clear`, `sort.rice`, `filter.min_rice`.
- `tests/unit/rice.test.ts` — score formula unit tests.

**Score formula**: `score = (reach × impact × (confidence / 100)) / effort`. Computed on every read and write when all 4 inputs present; `score: null` if any missing. Stored in frontmatter so it shows in raw markdown.

**Scatter implementation**: pure SVG, no d3 or recharts. X-axis is effort (low effort = right, log-ish scale via `Math.log2(effort + 1)`). Y-axis is impact. Dot radius clamped 6–24px from reach. Opacity min 0.4 from confidence. Dot color from task status CSS vars (already themed). Quadrant overlay is low-opacity surface var. Clicking a dot opens TaskDetailPanel in RICE-expanded state. Off-screen `<ul>` ordered by score for screen readers; dots are `role="button"`, `aria-label` with task + score, `tabindex="0"`.

## Notes

- Completed tasks are filtered out of the Scatter view by default (mirrors existing EisenhowerMatrix behavior).
- RICE score is stored in frontmatter so it appears in raw markdown views without a server read.
- Two prioritization systems coexisting on one task is confusing — mitigated by per-view source-of-truth rule: each view is blind to the other system.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-05-09 - Shipped (all 3 PRs in one session)
- `src/lib/rice.ts` created with validation, merging, scoring logic.
- CLI `tasks create` extended with RICE flags; `tasks rice <slug>` subcommand added.
- `TaskDetailPanel` RICE collapsible block + score badge + clear button.
- `TaskFilters` sort-by-RICE + min-RICE filter + view switcher (Kanban/Eisenhower/Scatter/List).
- `RiceScatter.tsx` SVG scatter with quadrants, unscored tray, a11y mirror list.
- `I18nContext.tsx` RICE string keys added.
- `tests/unit/rice.test.ts` score formula tests.
- Nested YAML round-trip confirmed; no fallback to flat keys needed.

### 2026-05-09 - Created
- Feature PRD created.
