---
id: decision-github-task-backend
name: "Decision: GitHub Issues as the second remote task backend"
description: "Why dreamcontext added GitHub Issues (not Projects) as its second cloud task backend, and the exact field/status/close mapping (issue-body-as-task, completed↔closed(completed), not_planned↔soft-delete, dc:* labels, Projects-v2 deferred to Tier-2). Also the 2026-09-06 declared-status wire record for BOTH backends — THE PARENT IS THE WIRE, and why cancelled must not share not_planned."
tags: ["decisions", "architecture", "topic:github", "topic:task-backend", "backend", "topic:cli"]
pinned: false
date: "2026-06-23"
updated: "2026-09-06"
---

## Why This Exists

dreamcontext shipped a pluggable task backend in issue #11, but only the **ClickUp** remote backend was built — issue #11 originally floated a GitHub *Projects* direction and shipped ClickUp-ONLY, which in turn caused issue #14 (teams onboarding/notifications layer) to be closed `not_planned`. The user asked to revisit GitHub as a second cloud sync target. This file captures the design we converged on so a future session does not relitigate it or re-derive the mapping from scratch.

**STATUS: SHIPPED.** PR #38 merged to `main` 2026-06-21. 129 tests green. Feature captured in `knowledge/features/task-management.md` (extended with GitHub backend user stories + ACs). This doc is the durable *why* + mapping table; do not duplicate rationale in the feature file.

**2026-07-04 forward pointer:** the new `knowledge/features/brain-repo-sync.md` PRD
(design-only, brain lives in its own GitHub repo separate from the code repo,
auto post-sleep sync) plans to reuse the GitHub OAuth/token plumbing documented
here (`ApiAdapter`, auth handling) for its login step, and its P3 issue-sync
onboarding builds on the mapping in this file. Do not re-derive the auth/mapping
design there — this file stays the source of truth for it.

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

GitHub REST **cannot hard-delete an issue** (only the GraphQL `deleteIssue` mutation, which needs admin/owner perm). ClickUp's `delete()` enqueues a real remote delete; GitHub's `delete()` instead **closes the issue as `not_planned`** (soft-delete). This is safer — issue history is preserved and the issue can be reopened. Inbound, a `not_planned` close is interpreted as the delete signal and the local mirror is removed. *(User-confirmed 2026-06-21: not_planned = soft-delete, chosen over adding a `cancelled` status or folding into `completed`. SUPERSEDED in part 2026-09-06 — a cancelled status now exists as project-declarable data, but `not_planned` is STILL exclusively the delete signal; see the next section.)*

### Declared statuses on the wire — and WHY `cancelled` does NOT share `not_planned` (2026-09-06, task_adYgpCxk)

Statuses became project-declarable data with a semantic `kind` (`src/lib/task-status.ts`; declared under `statuses:` in `overrides/task.md`). The wire mapping is now **by kind**:

| local status (kind) | push | pull |
|---|---|---|
| `completed` (done) | closed + `state_reason: completed`, no `dc:*` label | closed + completed/null, no cancelled-kind `dc:*` label → `completed` |
| any **cancelled-kind** (e.g. `cancelled`) | closed + `state_reason: completed` **+ `dc:<key>` label** | closed + completed/null + a `dc:*` label resolving to a cancelled-kind status → that status |
| any other KNOWN status | open (+ `dc:<key>` label unless `todo`); `state_reason: reopened` when the base snapshot was terminal | open → status from the `dc:*` label (a stale terminal label on an open issue is ignored), default `todo` |
| an UNKNOWN key | **no `state`, no `state_reason`** — still emits `dc:<key>` | open + unknown `dc:*` → `todo`; closed + unknown `dc:*` → `completed`; both WARN in the SyncReport, nothing deleted |
| `tasks delete` | closed + `state_reason: not_planned` — UNCHANGED, no label mutation | closed + `not_planned` → remove the local mirror — UNCHANGED, regardless of any `dc:*` label |

**THE PARENT IS THE WIRE (2026-09-06, owner's call).** Every declared status lives UNDER one of the four shipped statuses (`parent`, defaulted from its kind — `cancelled` → `completed`), and **a cloud backend only ever sees that parent**. This is what makes a declared status need NOTHING created on the provider:

- **GitHub** takes the parent's open/closed state, plus the child's `dc:<key>` label (auto-provisioned in its colour).
- **ClickUp** — whose API *cannot* create a list status — takes a status every list already has. The child rides as a `dc:<key>` **tag**, single-valued and reconciled against the live remote tags exactly like `version:`. A declared status still tries its OWN names first (its `clickup:` aliases and label), so a list that genuinely carries "Cancelled" gets the honest value; the parent is the fallback, not the first choice.
- **Pull precedence:** the `dc:<key>` tag resolves the child ONLY while its parent still equals the parent of the remote's own status. Drag the task from Complete to In Progress in the ClickUp UI and the tag is stale — the human's move wins. Same rule as an open GitHub issue ignoring a stale terminal label.

Before this, a declared status ClickUp could not express was pushed as the list's first open status with a loud warning and a `doctor` check telling the user to create it by hand. That was a real failure mode with a manual remedy; the parent carrier removes it entirely. The `doctor` check that remains is informational (which statuses ride as a tag) plus the genuinely broken case: a list carrying none of the four shipped spellings either.

**The load-bearing decision — do not revert it.** The obvious design (plan v1/v2) mapped a cancelled-kind status onto `closed + state_reason: not_planned` — honest in the GitHub UI — and told it apart from soft-delete by the `dc:cancelled` label, with guards. Three review rounds (four lenses: critic / pragmatist / edge-cases / security) killed it, and every finding was structural, not a bug to fix:

1. **The guard is defeated by our own push path.** `PATCH /issues/{n}` `labels` REPLACES the whole set, and the label set is recomputed on every push. A machine that has not pulled the override does not know `dc:cancelled`, so ANY unrelated edit (a title typo) strips the label. On its next pull the issue is a bare closed+not_planned — every guard passes — and the mirror is **permanently deleted**. The protection removes itself.
2. **The local-status guard cannot read what it needs.** `statusFromGitHub` is pure/no-I/O and takes only the issue; at its call site the slug is not resolved yet. Implementing "only delete if the local task was not cancelled" means restructuring `applyRemoteIssue` and breaking a documented module boundary.
3. **It regresses a working flow.** A human closing an issue on github.com as "not planned" never runs `deleteToGitHub()`, so a task that was `in_progress` keeps its `dc:in-progress` label. A "labels present ⇒ not a delete" guard then refuses that delete forever, and nothing ever clears the label.
4. **Stripping labels on delete is itself destructive.** The WAL delete op carries no label snapshot, so a naive "clear dc:* on soft-delete" wipes every `priority:` / `urgency:` / `version:` / user tag with the full-set replace.
5. **Legacy resurrection was deterministic, not rare.** A deleted issue re-fetched on a full re-read recreates the mirror, and the rebuild takes `status: in_progress` from the stale label — deleted work returning as LIVE work in roadmap rollups, every full re-fetch.

Under v3, `not_planned` stays EXCLUSIVELY the soft-delete signal and that path is untouched byte for byte (`github-map.ts` `DELETED_SENTINEL` → `github.ts` `applyRemoteSoftDelete`). Cancelled closes as `completed` + `dc:<key>`. The whole cost is cosmetic: github.com shows "Closed as completed" beside a grey `dc:cancelled` label. In exchange, five blocking findings vanish outright and the worst residual failure drops from **permanent deletion** to a **self-healing status downgrade**: a machine without the override records `completed` (closed) or `todo` (open), warns, and corrects itself on the first sync after it pulls `overrides/task.md`.

Two further rules make the drift non-destructive and are tested (`tests/unit/github-statuses.test.ts`):
- `subStatusLabel` is **string-derived**, never gated on finding a def — a key this machine does not know still yields `dc:<key>`, so a drifted machine cannot strip a teammate's label on an unrelated push.
- `statusToGitHub` for an unknown key **omits `state`/`state_reason` entirely** (`GitHubStatePatch.state` is optional), so it can never reopen an issue the user deliberately closed; `readTaskFile` preserves an unknown status rather than coercing it to `todo` for the same reason.
- The `dc:<key>` label for a declared status is provisioned in its declared colour through `createMissingLabels`, and the hourly provision throttle is bypassed whenever the status set's fingerprint changes — so the label exists before the PATCH that applies it.

ClickUp's wire is the same shape (see "THE PARENT IS THE WIRE" above, which supersedes an earlier
draft of this paragraph): its API cannot create statuses, so a declared status matches its own
`clickup:` aliases first (exact match BEFORE the fuzzy fold, which is unchanged) and otherwise
rides the PARENT's list status plus a `dc:<key>` tag. The push warning + `doctor` check now fire
only in the genuinely broken case — a list carrying neither the declared status NOR any spelling
of its parent.

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
