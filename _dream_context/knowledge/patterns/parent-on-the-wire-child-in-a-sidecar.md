---
id: know_parentwire01
name: parent-on-the-wire-child-in-a-sidecar
type: knowledge
description: >-
  Syncing a richer local model to a remote that cannot express it: never ask the
  provider to create anything. Every extra local value declares a PARENT that is
  one of the values the remote already understands; the wire carries only the
  parent, and the child identity rides in a sidecar channel the remote already
  tolerates (a label, a tag, an HTML-comment block). Pull precedence: the sidecar
  wins only while it still agrees with the remote's own value, so a human moving
  the record in the provider's UI always beats a stale sidecar.
tags:
  - 'kind:pattern'
  - 'kind:architecture'
  - 'topic:task-backend'
  - 'topic:github'
  - 'topic:clickup'
  - 'layer:backend'
pinned: false
date: '2026-09-06'
---

## Why This Exists

dreamcontext lets a project declare its own task statuses (`overrides/task.md`
→ `statuses:`), but the two cloud backends cannot hold them: GitHub Issues have
only `state` + `state_reason`, and **ClickUp's public API cannot create a list
status at all**. The first design made that the user's problem — push the
closest thing, warn loudly, and add a `doctor` check telling them to go create
the status by hand in the provider UI. That is a real failure mode with a manual
remedy, i.e. a feature that only works after homework.

The shape that removed it generalizes well past statuses, and this project had
already used pieces of it four times (`version:` tags, `dcproject:` provenance
tags, `<!-- dc:dates -->`, `<!-- dc:fields -->`) without naming the rule.

## The Pattern

### 1. Every extra local value declares a PARENT the remote already has

The richer local model is defined **relative to** the poorer remote one. Each
value the remote cannot express names a parent from the set the remote *can*:

```ts
// PARENT_BY_KIND — the default; a declaration may override it, but the parent
// must always be one of the SHIPPED values the remote already understands.
cancelled → completed   open → todo   active → in_progress   review → in_review
```

Validation refuses a parent outside that set. The consequence is the whole
point: **a declared value needs nothing provisioned on the provider**, because
its parent is a value every list/repo already carries.

### 2. The wire carries the parent; the child rides a sidecar the remote tolerates

Pick a channel the provider already accepts arbitrary strings in, and that
round-trips without schema work:

| remote | parent goes to | child sidecar |
|---|---|---|
| GitHub Issues | `state` + `state_reason` | a `dc:<key>` **label** (auto-provisioned in the declared colour) |
| ClickUp | the list's own status | a single-valued `dc:<key>` **tag**, reconciled against live remote tags like `version:` |
| any body-only remote | the prose body | an `<!-- dc:… -->` comment block, composed above prose and stripped before the 3-way merge |

Try the child's own names FIRST. A ClickUp list that genuinely has a "Cancelled"
status should get the honest value — the parent is the *fallback*, not the first
choice. Falling back too eagerly makes the remote lie about data it could have
held.

### 3. Pull precedence: the sidecar wins ONLY while it agrees with the remote's own value

```ts
// The dc:<key> tag resolves the child only while its parent still equals the
// parent of the remote's own status. Otherwise the remote wins.
return parentOf(statuses, child.key) === parentOf(statuses, base) ? child.key : base;
```

This is the rule that keeps the sidecar from becoming a lie. A human drags the
task from Complete to In Progress in the ClickUp UI; the `dc:cancelled` tag is
now stale, its parent no longer matches, and the human's move wins. Same rule
lets an *open* GitHub issue ignore a stale terminal label.

Without this, a sidecar written once outranks every later human edit — the
classic "our cache beat your intent" bug.

### 4. Drift must be a downgrade, never a deletion

The sidecar travels by a different route than the declaration (here: the
override file travels by git, the label travels by API), so a machine will read
a sidecar key it has never heard of. That machine must:

- record the **parent** (the value it does understand), never guess and never delete;
- **warn** in the sync report, naming the unknown key;
- self-correct on the first sync after it receives the declaration.

Two sub-rules make this hold, and both are easy to get wrong:

- **The sidecar emitter is string-derived, never gated on finding a definition.**
  A key this machine does not know still yields `dc:<key>`. Otherwise — because a
  label PATCH *replaces the whole set* — a drifted machine strips a teammate's
  label on an unrelated push, and the protection removes itself.
- **An unknown key omits the state fields entirely.** `statusToGitHub` for an
  unknown key emits no `state`/`state_reason`, so it can never reopen an issue
  the user deliberately closed.

### 5. Never overload a channel that already carries a destructive signal

The rejected design (three review rounds, four lenses) mapped `cancelled` onto
GitHub's `closed + state_reason: not_planned` — which is *also* dreamcontext's
soft-delete signal — and told the two apart by the presence of the label. Every
finding against it was structural, not a bug to fix: the label-replacing push
path defeats the guard, the pure mapping function cannot see the local record it
would need, a human's "close as not planned" regresses, and stale labels resurrect
deleted work as *live* work.

**Rule: a sidecar may disambiguate two benign states; it must never be the only
thing standing between a benign state and a destructive one.** Pay the cosmetic
cost instead — github.com shows "Closed as completed" beside a grey `dc:cancelled`
label — and the worst residual failure drops from *permanent deletion* to a
*self-healing downgrade*.

## Where This Applies Next

Any time a local model outgrows a remote schema you do not control: a priority
scale richer than the provider's three levels, a workflow state machine over a
two-state API, per-record metadata on a system with fixed fields. Ask in order:
*what is the nearest value the remote already has (the parent)? which channel
already tolerates a free string (the sidecar)? and what does the remote's own
value mean when the two disagree (precedence)?*

Do **not** reach for this when the provider CAN create the value (ClickUp custom
*fields* can be API-provisioned — so they are provisioned, not carried), or when
the sidecar channel is also load-bearing for a destructive operation (rule 5).

## Sources

- `src/lib/task-status.ts` — `PARENT_BY_KIND`, `parentOf`, `subStatusMarker`, `statusSetFingerprint`
- `src/lib/task-backend/clickup-map.ts` — the tag carrier and the pull-precedence check
- `src/lib/task-backend/github-map.ts` — `subStatusLabel` (string-derived), optional `GitHubStatePatch.state`
- `tests/unit/github-statuses.test.ts`, `tests/unit/clickup-statuses.test.ts`
- Full decision record: `[[decisions/decision-github-task-backend]]` (§ "THE PARENT IS THE WIRE", § the five killed findings)
- Feature record: `[[features/task-management]]` (Constraints & Decisions, 2026-09-06)
- Prior unnamed instances of the sidecar half: `version:` / `dcproject:` tags, `<!-- dc:dates -->`, `<!-- dc:fields -->`
