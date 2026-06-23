---
id: forward-compatible-field-cast
name: "Forward-Compatible Field Cast (cross-feature coordination seam)"
description: "A UI/consumer reads a not-yet-existing model field through a typed cast plus a fallback, so it works today and auto-upgrades the moment a parallel feature lands the field — no rework, no coupling, no blocking dependency between two in-flight efforts. Used in the dashboard Timeline/Gantt: taskSpan() prefers start_date (absent from the Task type) and falls back to created_at."
tags: ["kind:architecture", "kind:decisions", "layer:frontend", "topic:dashboard"]
pinned: false
date: "2026-06-22"
---

## Why This Exists

Two features were in flight at once: (a) three time-axis task views (Timeline/Gantt, Calendar, Heatmap), and (b) a backend change adding a `start_date` field to the task model (date ranges + sync). The Gantt genuinely wants a start date — but blocking the views on the model change (or vice-versa) would serialize two efforts that were progressing in parallel, and merging a hard dependency invites a half-built `start_date` reference that breaks `tsc`.

The seam that let both ship independently: the consumer reads the future field **defensively** and degrades gracefully when it's absent.

## The Pattern

In `dashboard/src/components/tasks/calendar-utils.ts`, `taskSpan()` derives a Gantt bar `[start, end]` from what exists today, while preferring the field that doesn't exist yet:

```ts
// Task type has NO start_date yet (sibling feature is adding it).
const explicitStart = dateOf((task as { start_date?: string | null }).start_date);
const created = dateOf(task.created_at);
const candidate = explicitStart ?? created ?? due;   // prefer start_date when present
const start = candidate <= due ? candidate : due;     // clamp: never start after due
```

Three ingredients:
1. **Typed cast at the access point** (`task as { start_date?: string | null }`) — reads a field absent from the declared type without weakening the shared `Task` interface or sprinkling `any`. The cast is local and self-documenting.
2. **Null-coalescing fallback chain** (`start_date ?? created_at ?? due`) — correct behavior with the field absent, *better* behavior once it's present.
3. **A one-line comment naming the seam** so the next reader knows this is deliberate coordination, not an oversight, and where to simplify once the field lands.

When the sibling feature adds `start_date` to the `Task` type and populates it, the Gantt starts using real start dates with **zero code changes** — the cast becomes redundant (can be dropped) but never wrong.

## When To Use / Avoid

- **Use** when two features touch the same entity in parallel and one consumes a field the other is still adding; when you want to ship the consumer now without a blocking dependency or a stub-and-rip-out cycle.
- **Avoid** for fields that change *semantics* (not just presence) — a cast can't paper over a meaning change. Avoid if the absent field is load-bearing for correctness (then it's a real dependency, sequence the work). Don't let the cast outlive the coordination: once the field is in the type, delete the cast in the next pass so it doesn't accrete as permanent `as`-noise.

## Related

- Applied during the dashboard time-axis views work (PR #68); reviewed and confirmed forward-compatible by the multi-reviewer pass (see [[multi-reviewer-pattern]]).
- Pairs with scoped commits: the views were committed without the concurrent `start_date` work, keeping each PR reviewable on its own.
