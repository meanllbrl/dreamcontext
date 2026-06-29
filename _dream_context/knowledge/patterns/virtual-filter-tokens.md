---
id: virtual-filter-tokens
name: "Virtual Filter Tokens (semantic @-prefixed pseudo-values resolving at filter time)"
description: "Pattern for filter values that resolve against live project state at filter time rather than equalling a stored field value — so a saved view stays semantically accurate as state changes. Paired with a normFilters() migration discipline to rewrite persisted literal tokens when a UI option folds out, preventing ghost filter rows. Used in the dashboard version filter: @current / @backlog / @completed."
tags: ["kind:architecture", "kind:decisions", "layer:frontend", "topic:dashboard"]
pinned: false
date: "2026-06-29"
---

## Why This Exists

Filter facets often have semantic states that outlive any specific stored value. A version filter has a concept of "the current sprint" — but if the filter stores the literal sprint name (`v0.11.0`), a saved view becomes stale the moment the team advances to the next sprint. The user has to remember to update the view, or the view silently filters the wrong thing.

Virtual filter tokens solve this by making the filter value a *semantic reference* (`@current`) that resolves against live project state (the active sprint from `.active-version.json` + RELEASES.json) at filter-match time, not at save time. The saved view stays correct automatically.

A second problem is persistence hygiene: when a literal value is later promoted into a virtual token bucket (e.g., the string `"backlog"` gets folded into the `@backlog` bucket), any persisted filter using the old literal must be migrated on load, or it becomes an un-dismissable ghost row that refers to a token no longer in the rendered option list.

## The Pattern

### 1. Define sentinel constants

```ts
// boardModel.ts
export const VV_CURRENT   = '@current';
export const VV_BACKLOG   = '@backlog';
export const VV_COMPLETED = '@completed';
```

Prefix with `@` to namespace clearly away from real field values. The `@` prefix is unambiguous: no real version name starts with `@`.

### 2. Resolution function (pure)

```ts
function versionTokenMatches(
  token: string,
  taskVersion: string | null,
  versionMeta: VersionMeta
): boolean {
  switch (token) {
    case VV_CURRENT:
      return !!versionMeta.activeVersion && taskVersion === versionMeta.activeVersion;
    case VV_BACKLOG:
      return !taskVersion || taskVersion === 'backlog';
    case VV_COMPLETED:
      return versionMeta.releasedVersions.has(taskVersion ?? '');
    default:
      return taskVersion === token;   // literal version name: exact match
  }
}
```

`versionMeta` is built once per render from `useActiveVersion()` + RELEASES data and passed down — not re-read per task.

### 3. Integrate into the filter pipeline

```ts
function matchVersionField(task, selected: string[], versionMeta): boolean {
  if (!selected.length) return true;
  return selected.some(token => versionTokenMatches(token, task.version, versionMeta));
}

// filterTasks receives versionMeta as a param (not captured from closure)
function filterTasks(tasks, filters, versionMeta) {
  return tasks.filter(t => matchVersionField(t, filters.version, versionMeta));
}
```

### 4. Gate rendering on applicability

Virtual bucket chips should only appear when the bucket is meaningful:

- `@current`: only when `versionMeta.activeVersion !== null`
- `@backlog`: when relevant (always reasonable to show)
- `@completed`: only when `versionMeta.releasedVersions.size > 0`

When a bucket renders, fold out the corresponding literal row from the option list to prevent duplication (e.g., when `@backlog` is shown, remove the literal `"backlog"` option from the version picker).

### 5. normFilters() migration discipline

When a literal value is superseded by a virtual token, any persisted filter using the old literal must be migrated on load — not at save time (because the old value was valid when it was saved):

```ts
function normFilters(filters: BoardFilters): BoardFilters {
  return {
    ...filters,
    version: filters.version?.map(v =>
      v === 'backlog' ? VV_BACKLOG : v   // fold literal → virtual token
    ),
  };
}
```

Call `normFilters()` at every saved-view filter load. It is idempotent — calling it on already-migrated data is a no-op. This prevents the ghost row problem: the literal `'backlog'` is no longer rendered as an option (the `@backlog` chip replaced it), so a saved view with `'backlog'` would show a broken active-filter chip with no way to remove it.

## When To Use / Avoid

**Use** when:
- A filter facet has semantic states that refer to live project state (current sprint, active user, today's date).
- The states' concrete values change over the project lifecycle.
- Saved views or persisted filters should stay accurate without manual updates.

**Avoid** when:
- The literal stored value is the right answer (filtering to a specific named version is a valid use case alongside `@current`). The pattern co-exists with literal values — the resolution function handles both.
- The "live state" is too expensive to compute per filter invocation. Build `versionMeta` once per render pass, not per task match.

## When To Add normFilters() Migration

Add a migration entry any time a UI option folds out or is promoted into a bucket. The rule: if a literal value can appear in any persisted filter state (saved views, URL params, localStorage) and the option that would let the user remove it is being removed from the UI, add a migration.

## Related

- Applied in `boardModel.ts` + `BoardToolbar.tsx` + `KanbanBoard.tsx` for the version filter — see `web-dashboard` PRD Constraints & Decisions [2026-06-29] for the full context.
- Companion pattern: `shared-local-config-split` (how the filter state is persisted across server restarts — `overrides/board.json` + `state/board.local.json`).
- `normFilters()` is the load-time normalization layer; `shared-local-config-split.md` explains where the state lives.

## Last Verified

2026-06-29
