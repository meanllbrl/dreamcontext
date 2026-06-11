# Remote Task Backend — Recommended Setup (ClickUp)

dreamcontext tasks can live in a ClickUp list (`taskBackend: "clickup"`). The
sync engine adapts to whatever the list looks like, but the closer the remote
structure is to this reference, the more of each task round-trips losslessly.
This document is the **source of truth for configuring the remote side** —
update it whenever the field bridge learns new names.

> Everything here is **opt-in by construction**: a missing status or custom
> field never breaks sync — that value simply stays local until the remote
> grows a place for it. Sync re-reads the list's statuses, members, and custom
> fields on every run, so remote structure changes take effect immediately.

## 1. Connection

```bash
dreamcontext config task-backend clickup        # guided onboarding (token + IDs)
dreamcontext config clickup-list <teamId> <spaceId> <listId>
dreamcontext config clickup-token [--user <name>]
```

- `teamId`: first number in any ClickUp URL — `app.clickup.com/{teamId}/…`
- `spaceId`: `…/v/s/{spaceId}` when a Space is open
- `listId`: `…/v/li/{listId}` when the List is open
- The API key lives in the gitignored `_dream_context/state/.secrets.json`
  (mode 0600) — never in `.config.json`. Resolution: env (`CLICKUP_TOKEN`,
  per-person `tokenEnv`) → secrets file.

## 2. Statuses

dreamcontext has four canonical statuses. Name your list statuses so each one
has a match — the matcher is case/diacritic-insensitive (`In Revıew` typed on
a Turkish keyboard matches fine) and falls back down a candidate chain:

| dreamcontext | Recommended ClickUp status | Also recognized |
|---|---|---|
| `todo` | **to do** | open, todo, backlog, planning |
| `in_progress` | **in progress** | in development, doing, active, started |
| `in_review` | **in review** | review, code review, qa, testing — *falls back to* in progress |
| `completed` | **complete** | done, closed |

- A status the list doesn't have is **never pushed** (no 400s): the nearest
  candidate is used, or the field is omitted entirely.
- Custom remote statuses fold by intent on pull (`cancelled` → completed,
  `at risk`/`on hold` → todo) — and a folded push can never bounce back and
  overwrite the richer local status.

## 3. Custom fields (the field bridge)

Create these fields **on the list** and sync starts writing/reading them.
Matching is by folded field name; create only the ones you care about.

| Create this field | Type | dreamcontext source | Direction |
|---|---|---|---|
| `Urgency` | Dropdown: `low, medium, high, critical` | `urgency` | both |
| `Summary` (or `Description`) | Short text | `description` (one-liner) | both |
| `Reach` | Number | `rice.reach` | both |
| `Impact` | Number | `rice.impact` | both |
| `Confidence` | Number | `rice.confidence` | both |
| `Effort` | Number | `rice.effort` | both |
| `Score` (or `RICE Score`) | Number | `rice.score` | **push-only** — always recomputed locally, never trusted from the remote |
| `Feature` (or `Related Feature`) | Short text | `related_feature` | both |
| `Version` (or `Milestone`) | Short text | `version` — outranks the `version:` tag on pull | both |
| `Created By` / `Updated By` | Short text | attribution | push-only |

Dropdown values match by **option name** (option ids are resolved
automatically). Field writes are delta-based: only values that moved since
the last sync are sent.

## 4. Native field mapping (no setup needed)

| dreamcontext | ClickUp |
|---|---|
| `name` | task name |
| body sections (Why / Stories / AC / …) | description (markdown, Changelog stripped) |
| `Changelog` entries | **comments** (union-merged, conflict-free) |
| `status` | status (see §2) |
| `priority` | priority (critical→urgent, high, medium→normal, low) |
| `tags` | tags (`version:<v>` tag carries the version; `person:` tags stay local) |
| `due_date` (YYYY-MM-DD) | due date (UTC noon — calendar day stable in any timezone) |
| `assignee` / `person:<slug>` tag | assignees (see §5) |

## 5. People / assignees

No manual mapping needed: each sync caches the list's members
(`dreamcontext tasks members` shows them with their slugs — display names are
ascii-folded, e.g. "Mehmet Nuraydın" → `mehmet-nuraydin`).

- Tag a task `person:<slug>` (or set the `assignee` field) → push assigns the
  ClickUp member. Explicit `assignee` wins over the tag.
- A remote assignment pulls back as both the `assignee` field and the
  `person:` tag; handovers/removals push as add/rem deltas.
- ClickUp only allows assigning people who can access the list — make sure
  your teammates are members of the Space.
- `dreamcontext config clickup-member <person> <memberId> [--token-env ENV]`
  stays available as an explicit override (and for per-person API tokens).

## 6. Sync behavior cheat-sheet

| Concern | Behavior |
|---|---|
| When | manual `tasks sync`, git post-commit/pre-push (best-effort, can never block git), post-`sleep done` |
| Direction | watermark-based two-way; watermarks use ClickUp **server time** only |
| Writes | mirror-first + write-ahead queue; network only inside `sync()` (offline-safe, idempotent replay) |
| Changelog | union merge — conflict-free by construction |
| Scalars (status/assignee/priority/…) | 3-way vs base; both-changed → last-write-wins |
| Prose | section-level 3-way vs `base_snapshot` |
| Conflict / missing base | ClickUp wins, the local copy is preserved under `state/.conflicts/` and surfaced — nothing is silently lost |
| Rate limit | ~100 req/min queue, one field-level PUT per task, retry/backoff |

## 7. Known limits (v1)

- One active backend per project; ClickUp is the source of truth.
- Webhooks/realtime are out of scope — sync is trigger-based.
- Switching the target list does not migrate task mappings yet (reset the
  gitignored `state/.tasks-{map,sync,queue}.json` to re-create everything in
  the new list).
- Task deletion does not propagate in either direction.
