---
id: know_bf31UpUb
name: decision-sync-identity-and-reconciliation
description: >-
  Why sync reconciliation must key on stable dcId (not name-slug), and the
  assignee pull-back drift/heal pattern: dcId-keyed ledger primitives,
  migrateSlug(), reconcileRenamedTasks(), planAssigneeHeal(), and the opt-in
  --reconcile heal path. PENDING: PR #79 (open as of 2026-06-24).
tags:
  - decisions
  - architecture
  - topic:task-backend
  - topic:clickup
  - topic:github
  - backend
pinned: false
date: '2026-06-24'
---

## Why This Exists

Two architectural gaps in the sync engine were discovered together and fixed in
PR #79 (issues #77 and #78). This file records the decisions so future sessions
do not re-derive them or revert the architecture.

**STATUS: IN REVIEW.** PR #79 open as of 2026-06-24. Fix targeted v0.10.0.
Feature impact captured in `core/features/task-management.md`.

---

## Decision 1 — Key sync reconciliation on the stable `dcId`, not the name-slug

### The bug (issue #77)

Renaming a task changes its name-derived **slug** (the filename, the `.tasks-map.json` key). The sync engine joined local-to-remote entries by slug. After a rename:
- The old map entry no longer matched any local file.
- The renamed file looked new to the engine.
- Result: a **duplicate** remote task (ClickUp/GitHub) was created under the new slug; the original remote task was orphaned; `.tasks-map.json` ended up with **two entries sharing the same `dcId`**.

This affected **both** backends (ClickUp and GitHub) because it lived in the provider-generic engine.

### The architectural decision

**Sync reconciliation identity = the stable `dcId` (`id:` in task frontmatter), not the name-slug.**

The `dcId` is generated once at `tasks create` time (`generateId('task')`, nanoid-based, prefixed `task_`), never changes, and is already present in both the task frontmatter and `.tasks-map.json`. Using it as the join key makes identity rename-proof.

**Corollary:** the slug is only the join key for a task that has **never been synced** (no `dcId` in the map yet). Once a `remoteId` is established, `dcId` is the sole link.

### Implementation (PR #79, `sync-state.ts`)

- `entryForDcId(dcId)` — look up a ledger entry by `dcId` regardless of current slug.
- `migrateSlug(oldSlug, newSlug)` — re-keys the map entry and any queued WAL operations, preserving `dcId` / `backend` / `remoteId` / base snapshot intact.
- `reconcileRenamedTasks(ledger, liveTasks)` — **provider-agnostic pre-pass** that runs before push+pull. For each local task, if the map has a `dcId` entry whose slug differs from the current file slug, it calls `migrateSlug` to heal the map. Non-destructive and idempotent: genuine deletions are left alone; an already-mapped target is never clobbered (duplicate residue from old corruption is left for manual `--reconcile`).
- **Runtime guarantee**: `sync()` in `clickup.ts` and `github.ts` now runs `reconcileRenamedTasks()` **first**, before pull+push. The per-task `dcId` fallback in `pushTask()` is a safety net so the CREATE branch is only taken for a genuinely new, never-synced task.

### New CLI verb

`dreamcontext tasks rename <name> <new-name>` — rewrites `name:` in frontmatter, renames the file, updates the map slug in place (remoteId unchanged), and pushes a name update to the remote. Agents and users MUST use this instead of hand-editing `name:` + renaming the `.md` file, which bypasses the ledger migration.

---

## Decision 2 — Assignee sync drift and the `--reconcile` heal path

### The bug (issue #78, corrected diagnosis)

The issue report claimed `base_snapshot` stored only `{hash, body}` so the delta engine could not diff frontmatter assignees. **This turned out to be inaccurate**: `base_snapshot.body` is the full file; the merge engine already diffs frontmatter assignees on a normal pull. Forward pull-back (remote assignees to `person:` tags) already worked.

**The real gap:** the delta pull is **watermark-gated**. A remote-side assignee change made below the current watermark (i.e., before the last sync timestamp) is never re-examined. Accumulated assignee drift from ClickUp/GitHub UI assignments never self-heals during a normal `sync pull`.

### The architectural decision

Normal `sync pull` stays watermark-gated (performance, idempotency). A separate opt-in path reads the **full** remote state to detect below-watermark drift.

**`--reconcile` flag** on `tasks sync` (and `tasks doctor --remote`):
1. `detectAssigneeDrift()` — read-only full remote fetch, returns tasks where remote assignees diverge from local `person:` tags.
2. `reconcileAssignees()` — for each drifted task, adopt the remote assignee set into `person:` tags, re-baseline the ledger entry, journal the change. Idempotent.
3. Heal runs **LAST** in `sync()`, after push settles local-first changes, so a heal never clobbers an unpushed local change.

**`planAssigneeHeal(local, base, remote, pendingPush)`** (pure, in `merge.ts`) — the decision function. Heals only when remote moved AND local did not AND no pending push exists for that task. The four-case decision table:
- In-sync: no-op
- Local change pending push: skip (local wins; push will propagate)
- Two-sided divergence: skip (conflict resolution is outside scope)
- Remote moved, local did not: heal

**`tasks doctor` stays local-only by default.** The `--remote` flag is opt-in to avoid network probes during the default offline doctor pass.

### Rule going forward

When someone reports "task assigned in ClickUp/GitHub UI is not reflected locally" — instruct them to run `dreamcontext tasks sync --reconcile`. That is the designed self-heal path.

---

## Sources

- Issue #77: https://github.com/meanllbrl/dreamcontext/issues/77
- Issue #78: https://github.com/meanllbrl/dreamcontext/issues/78
- PR #79: https://github.com/meanllbrl/dreamcontext/pull/79 (fix/77-rename-sync-dcid branch)
- Related feature: `core/features/task-management.md`
- Provider-generic sync engine: `src/lib/task-backend/sync-state.ts`, `merge.ts`, `api-adapter.ts`

## Last Verified

2026-06-24 — PR #79 open (fix/77-rename-sync-dcid branch). 138 tests green on the branch: `sync-rename` (12 tests), `assignee-reconcile` (10 tests), and full task-backend/sync/CLI suites.
