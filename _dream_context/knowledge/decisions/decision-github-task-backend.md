---
id: decision-github-task-backend
name: "Decision: GitHub Issues as the second remote task backend"
description: "Why dreamcontext added GitHub Issues (not Projects) as its second cloud task backend, and the exact field/status/close mapping: issue-body-as-task, completed↔closed(completed), delete↔closed(not_planned) soft-delete, dc:* labels for sub-status, Projects-v2 GraphQL custom fields deferred to Tier-2. Reuses the issue-#11 pluggable TaskBackend + provider-generic sync engine. SHIPPED: PR #38 merged, 129 tests green."
tags: ["decisions", "architecture", "topic:github", "topic:task-backend", "backend", "topic:cli"]
pinned: false
date: "2026-06-23"
---

## Why This Exists

dreamcontext shipped a pluggable task backend in issue #11, but only the **ClickUp** remote backend was built — issue #11 originally floated a GitHub *Projects* direction and shipped ClickUp-ONLY, which in turn caused issue #14 (teams onboarding/notifications layer) to be closed `not_planned`. The user asked to revisit GitHub as a second cloud sync target. This file captures the design we converged on so a future session does not relitigate it or re-derive the mapping from scratch.

**STATUS: SHIPPED.** PR #38 merged to `main` 2026-06-21. 129 tests green. Feature captured in `core/features/task-management.md` (extended with GitHub backend user stories + ACs). This doc is the durable *why* + mapping table; do not duplicate rationale in the feature file.

## The Architecture It Plugs Into (already built, issue #11)

- `TaskBackend` interface — `src/lib/task-backend/types.ts`. Provider-agnostic; nothing provider-specific may appear in it (boundary test).
- Provider-GENERIC sync engine — `merge.ts` (conflict resolution), `sync-state.ts` (ledger / watermark / write-ahead queue), `api-adapter.ts` (auth header + base URL + rate-limit + retry/backoff + error normalization). Verified: **zero** "clickup" strings in these three files — reusable as-is.
- `getTaskBackend()` switches on `cfg.taskBackend` in `index.ts` (`'local'` | `'clickup'`). Adding GitHub = one `'github'` branch + a `createGitHubBackend()`.
- `ClickUpTaskBackend extends LocalTaskBackend` and mirrors the remote to local files (offline reads/writes; only `sync()` needs the network). The GitHub backend follows the same pattern.

So the new provider-specific surface is essentially `github.ts` (paralleling `clickup.ts`) + `github-map.ts` (paralleling `clickup-map.ts`). The generic engine is untouched.

## Decision

Add **GitHub ISSUES** (not Projects) as the second remote backend. Chosen model: **use the issue BODY as the task markdown.** dreamcontext tasks are already markdown, so the body maps ~1:1 — a better conceptual fit than ClickUp for the developer audience, and REST fits the existing `ApiAdapter` directly (Bearer-token auth; 5000 req/hr vs ClickUp's 100/min).

## Field & Status Mapping

| dreamcontext | GitHub Issue (REST) |
|---|---|
| body (Why / User Stories / AC / …) | **issue body** (markdown) |
| `## Changelog` entries | **issue comments** (union-merged, conflict-free — same pattern as ClickUp `clickup-map.ts` `bodyToDescription`/`splitChangelogEntries`) |
| priority / urgency / tags / version | **labels** (`version:x` rides as a label, exactly as ClickUp) |
| assignee (v0.8.6 person-tags) | issue **assignees** (must be repo collaborators; `listMembers` = repo collaborators) |
| start_date + due_date | `<!-- dc:dates start="…" due="…" -->` block inside issue body (no native date fields on GitHub Issues; milestone is too coarse — superseded by PR #67) |
| status (4-state) | see below — **only `completed` closes the issue** |

### Status / close model (the sharp edge)

GitHub issues have no free-form status — only `state` (`open`|`closed`) + `state_reason` (`completed`|`not_planned`|`reopened`). So the 4-state dreamcontext status splits:

**Push (dreamcontext → GitHub)**
- `todo` / `in_progress` / `in_review` → issue **open**, sub-status carried on a `dc:*` label (`dc:in-progress`, `dc:in-review`; `todo` = no label / `dc:todo`)
- `completed` → **closed**, `state_reason: completed`  ← *the only thing that closes an issue*
- `tasks delete` → **closed**, `state_reason: not_planned` (**SOFT-delete** — see below)
- reopen (completed → active again) → **open**, `state_reason: reopened`, sub-status label re-applied

**Pull (GitHub → dreamcontext)**
- closed + `completed` → `completed`
- closed + `not_planned` → **remove the local mirror** (soft-delete symmetry)
- open → status from the `dc:*` label (default `todo`)

### The one behavioral divergence from ClickUp: delete

GitHub REST **cannot hard-delete an issue** (only the GraphQL `deleteIssue` mutation, which needs admin/owner perm). ClickUp's `delete()` enqueues a real remote delete; GitHub's `delete()` instead **closes the issue as `not_planned`** (soft-delete). This is safer — issue history is preserved and the issue can be reopened. Inbound, a `not_planned` close is interpreted as the delete signal and the local mirror is removed. *(User-confirmed 2026-06-21: not_planned = soft-delete, chosen over adding a `cancelled` status or folding into `completed`.)*

## Deferred — Tier-2: GitHub Projects v2 custom fields

The "open a field" idea (priority/urgency/status/RICE as first-class fields) is only possible via **GitHub Projects v2**, which is **GraphQL-ONLY** and does not fit the REST `ApiAdapter` cleanly (GraphQL returns HTTP 200 with an `errors[]` array; field writes are multi-step `createIssue` → `addProjectV2ItemById` → `updateProjectV2ItemFieldValue` node mutations). It is therefore a later layer for users who want a board view with a full 4-state Status single-select field.

**Fidelity note:** on plain issues the 4-state status degrades to 2 native states + labels. A Tier-2 Projects-v2 Status field would restore full fidelity. Ship plain-issues first; layer Projects-v2 only on demand.

## provision / discover analogs

- `provisionRemote()` → create the recommended `dc:*` label set on the repo (the GitHub analog of ClickUp custom-field provisioning).
- `discoverContainers()` → list the user's/org's repos (the pickable "container" is a repo).
- `testConnection()` → `GET /user` with the token.

## Pre-sync consolidation hygiene

**Pattern (verified 2026-06-21):** before syncing a brain that has accumulated many completed tasks to GitHub for the first time, merge completed tasks **by version** into one "shipped" task per release, then archive the originals to `state/archive/`. This keeps the GitHub tracker clean — one closed issue per release instead of dozens or hundreds of granular tasks.

**Why a plain archive move is sync-invisible (load-bearing facts from source):**
- Task discovery globs `state/*.md` NON-recursively (`src/lib/task-backend/local.ts` + `src/cli/commands/tasks.ts`). Anything under `state/archive/` is excluded from both `tasks list` and `sync`.
- A plain filesystem move (`state/<task>.md` → `state/archive/<task>.md`) does NOT enqueue a remote close. The moved tasks simply disappear from the sync ledger.
- Only `dreamcontext tasks delete` triggers a remote close (soft-delete → closed as `not_planned` on GitHub).
- New (un-synced) tasks without a `remoteId` never push a close either — they are treated as local-only until a `sync` push creates the remote issue.

**Practical checklist for a mass-consolidation run before first sync:**
1. Group all completed tasks by version tag.
2. For each version, create one "shipped-vX.Y.Z" summary task (captures the aggregate user stories / what shipped).
3. Move the originals to `state/archive/` (plain `mv` — sync-invisible).
4. Run `dreamcontext tasks sync` — only the summary tasks push as new issues, which are then immediately closed as `completed`.
