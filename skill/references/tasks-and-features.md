# Tasks & Features — full protocol

## Tasks: a card and a journal

A task is two files. The **card**, `state/<slug>.md`, holds what the work IS: Why, Acceptance Criteria, Constraints & Decisions, Technical Details, Notes (plus User Stories and Workflow when needed). It carries no history and no template comments, and stays under **12,000 chars** (`tasks insert` refuses past it, except into Acceptance Criteria; overflow goes to the journal via `tasks log`, or to knowledge). The **journal**, `state/journal/<slug>.md`, holds what HAPPENED: every `tasks log`, status change, evidence record and approval, newest first, each entry headed `### YYYY-MM-DD HH:MM - <kind> [je_<id>]` (kinds: `created`, `log`, `evidence`, `status`, `approval`, `sleep`, `remote`). The id is permanent: evidence refs, sync and merge use it. Features are retrospective product docs updated only during sleep — never put in-progress context in a feature.

The auto-loaded snapshot already lists every non-completed task with status, priority, and last-updated date. Answer "what am I working on?" / "which tasks are active?" directly from it — no tool calls. Read the card when you need the plan, and the newest journal entries when you need where the previous session left off.

- **The journal is not a task.** Recall never returns it as one; with a remote task backend it travels through the backend (GitHub/ClickUp comments), never the brain repo; a git merge unions entries by id.
- **A Changelog that comes back is folded.** A card that regains `## Changelog` (an older CLI, an old merge driver, a pull) is folded into its journal on the next write to that task or the next `tasks doctor`, deduplicated by normalised text with copy counting: nothing is dropped, nothing is doubled.
- **Migration.** `dreamcontext update` to 0.33.0 moves every card's Changelog into its journal once (`dreamcontext tasks migrate-journal [--dry-run]` runs it by hand): backup under `_dream_context/tmp/pre-migration-<stamp>/`, template comments stripped, old ticked criteria marked `(evidence: legacy)`, a byte ledger proving card + journal + stripped = original. It is idempotent, leaves `state/archive/` alone, and retries on its next run when a task is locked or a sync is running.

### Lifecycle
```
todo → in_progress → in_review → completed          # the shipped four — always present
```
A project can **declare more statuses** (e.g. `planned`, `cancelled`) in `_dream_context/overrides/task.md`, each **under one of the four above** — see "Task format, custom-field & status overrides" below. Every status carries a semantic **kind** (`open | active | review | done | cancelled`), and every derived behaviour reads the kind, never the literal: a `cancelled`-kind task is terminal (hidden from `tasks list`, never overdue, out of roadmap progress on both sides, closes its GitHub issue) without being "done". `dreamcontext tasks statuses` prints the project's set with its remote mapping.

The sleep agent picks the status that matches reality: `completed` for work that's demonstrably done, low-risk, already validated; `in_review` only when a human genuinely must verify (a behavior change, a design decision, a risky/critical-path change). It does not reflexively park everything in `in_review`, and it closes finished work — so tasks neither rot in `todo` nor rot half-closed in `in_review`.

### Create
```bash
dreamcontext tasks create "Readable sentence name" \
  --description "..." --why "What this accomplishes" \
  [--person "Ada"] [--due 2026-07-01] [--tags backend,api]
dreamcontext tasks plan <name> now|next|later   # where it sits (see Cycles, the queue, releases)
```
Defaults: `status=todo`, no cycle (reads as Next). Nothing lands in a cycle on its own: planning is a person's call. `-p/-u` are retired (accepted, ignored, warned); `-v` is deprecated (a cycle number/id plans it there, `BACKLOG` means Later, anything else is kept as a legacy label).

- **Name = a short plain sentence** describing what the task does ("Fix the login redirect loop"). Never a type-prefixed slug (`feat-x-y`) — the file slug is derived from the name automatically.
- **`--why` is mandatory.** Creation fails without a non-empty reason; `created_at` covers the "when". A task must be readable months later on its Why alone.
- **Lean card.** A new card contains only `## Why`; its journal starts with a `created` entry. Every other section (`user_stories`, `acceptance_criteria`, `workflow`, `constraints`, `technical_details`, `notes`) is created on first `tasks insert`, in canonical position. Never insert placeholders to "complete" the shape; a section with nothing to say shouldn't exist.
- **Sleep's own filing** needs a basis or goes to proposals: see [Sleep files only at high confidence](#sleep-files-only-at-high-confidence-proposals-and-the-filing-rules).
- **`--neighbor-checked <slug>` / `--declined-checked <key>` — proof of having looked (sleep only).** During a sleep cycle the filing bar refuses a task whose nearest existing task is semantically close, or that looks like an idea somebody declined. Both refusals name the exact flag that lifts them, and each takes the **slug/key it named** — passing a different one is refused again. They are not bypasses: they say "I read that neighbor / that declined reason, and this is genuinely separate". A near-verbatim duplicate (the merge band) has no flag at all; fold it in instead. A person filing their own task during a background cycle uses `--by human`, which is never checked. When the CLI prints `neighbor check skipped (…)` the semantic floor is OFF for that run — do the keyword dedup yourself (`memory recall "<topic>" --types task`) and check `tasks declined` by hand.

### Sub-tasks: a parent and its steps (two levels)
A **feature** is an area, a **parent task** is a deliverable with an end, a **sub-task** is one step of it. Two levels only.
```bash
dreamcontext tasks create "Step one" -w "…" --parent <parent>   # inherits objectives, feature, cycle (not cycle when sleep files it)
dreamcontext tasks parent <task> <parent|clear>                  # place, move or detach
dreamcontext tasks show <task>                                   # the context packet
```
- **Enforced:** the parent must exist, be top-level and open; a task with sub-tasks cannot become one. `parent_task` holds the parent's slug (a legacy id still resolves).
- **The parent's status is computed** from its sub-tasks and stored (journaled): none started → `todo`, some → `in_progress`, all done → `in_review` when its own criteria pass the gate, else `in_progress`; never `completed` on its own. A parent cannot reach done while a sub-task is open, cannot be deleted with a live one (closed ones are detached), and cancelling it needs a decision per open sub-task: `tasks status <p> cancelled --child <t>=cancel|detach|move:<other> …` or `--children <decision>`. A rename repoints the sub-tasks. Roadmap progress counts leaves only; the snapshot folds sub-tasks under their parent with `n/m done`.
- **The context packet** (`tasks show`, ≤ 12,000 chars): the parent's card (Why, Constraints & Decisions, every sibling with its status) first, then this card, then the newest 3 journal entries and the paths, fenced as task DATA under a fresh marker. Over the cap it drops journal entries, then Notes, then Technical Details; never the parent's Why or decisions, never the criteria. Develop, assign-to-agent, automations, the handoff banner, Delegate and goal-skill builders all receive this packet (or the command), never a bare path.
- **The Read hook:** reading a sub-task's card in a session adds its parent's card next to it (`.claude/hooks/read-task-guard.cjs`, PostToolUse `Read`; any other Read costs one node start and adds nothing).
- **Session binding:** a Develop run (`goal-live start`), a handoff, an agent run for a task, or `tasks bind <task>` binds the session (`state/.session-task/<id>.json`, machine-local); after a compaction the packet is delivered again. It survives Stop and compaction, ends with SessionEnd (a resume re-binds), `/clear` unbinds, 7 days idle reaps it. `tasks unbind` clears it.
- **Sync:** GitHub sub-issues and ClickUp subtasks, both ways. A remote three levels deep is flattened onto the top parent (warned); a remote that drops a link never clears the local one; a remote close of a parent with open sub-tasks is held open here (journaled) and the next push reopens it. ClickUp cannot un-subtask through its API: a local detach warns.

### Sleep files only at high confidence: proposals and the filing rules

What sleep may put on the board itself, in order (the first fit wins): a **criterion** on an existing task, a **sub-task** under an existing parent, a **new top-level task** only with a basis, and otherwise a **proposal**. Only a new top-level task waits for the owner. Sleep never plans: what it files sits in no cycle (a sub-task does not inherit its parent's).

```bash
dreamcontext tasks create "<sentence>" --by sleep --basis ask --quote "<the owner's words>" -w "…"     # they asked for it
dreamcontext tasks create "<sentence>" --by sleep --basis defect --evidence "<failing output>" -w "…"  # a proven defect
dreamcontext tasks propose "<sentence>" -w "…" --quote "<session line>" [--parent <p>]  # everything else
dreamcontext tasks proposals [--json]        # what waits: proposals + tasks sleep opened
dreamcontext tasks accept <tp_id> [--name … -w … --parent <p>|--no-parent]   # owner only → Next queue
dreamcontext tasks reject <tp_id|slug> --reason <reason> [--note "…"]        # every reject has a reason
dreamcontext tasks keep <slug>               # owner only: a task sleep opened is fine
dreamcontext tasks rules                     # read the task-filing rules (sleep must, each cycle)
dreamcontext tasks rules pending|history     # rejects no rule cites yet / every change
dreamcontext tasks rules set [R<n>] --title … --dont … --do … --rests-on <fb ids>
dreamcontext tasks rules merge <keep> <drop>; dreamcontext tasks rules revert <R<n>>   # revert: owner only
```

- **The basis is checked, not trusted.** `--quote` must appear, as whole words, in a turn the owner TYPED in a session this sleep consolidates and share a word with the task's name or Why; tool results, hook context, sub-agent notifications, skill-loader text, compaction summaries and `tasks show` output do not count, and a refusal says where the words did appear. Quotes are stored and journaled scrubbed of secrets, on one line. `--evidence` must appear in a tool result (or an owner turn). A proposal's `--quote` must appear in the session (owner or assistant words). Sessions an orchestrator spawned are never searched.
- **Proposals live on the Tasks screen** (the Proposals section and a count on Tasks in the sidebar), never in a chat or the snapshot: sleep often runs with nobody in a session. Each shows the name, the Why, the session quote and the suggested parent; accept and reject are one tap. Tasks sleep filed itself show in the same section as "opened by sleep" until kept or rejected.
- **Accept** creates the task in the **Next** queue with `created_by: human` (the owner decides when it enters a cycle); a corrected name or Why is recorded as the diff. `accept`, `keep` and `rules revert` refuse an agent environment; the dashboard is the owner's path.
- **Reject reasons:** `already-exists`, `abandoned`, `too-small`, `badly-written`, `wrong-project`, `not-work`. Every reject is written to `state/.task-feedback.json` (the proposal, its basis, the quote, the reason, the note) and to the declined store, so no later cycle re-files it. A rejected task sleep filed moves to the project's cancelled-kind status (refused when none is declared).
- **What the reasons change, deterministically:** each `already-exists` lowers this project's neighbour review threshold by 0.01 (at most 0.05); three rejects of the same kind of candidate (similar name + Why) block that kind for both `create` and `propose`, and if they were `too-small` the refusal points at a criterion instead.
- **The brake:** when more than 30% of sleep's last 20 judged items (filed tasks + decided proposals) were rejected, direct filing is off and only criteria, sub-tasks and proposals remain, until accepted proposals bring the rate down. `sleep done` prints what was filed, proposed and rejected, the brake when it is off, and a warning when the active cycle ends within 2 days with open work.
- **The task-filing rules** (`knowledge/patterns/task-filing-rules.md`) are sleep's distillation of the rejects: every rule cites the reject ids it rests on and gives a don't/do pair; a near-duplicate rule is refused (merge), and the file is capped (8,000 chars, 15 rules). While a sleep runs, `tasks create --by sleep` and `tasks propose` refuse until `tasks rules` was read in that cycle (and again after a change). Every change is in `state/.task-filing-rules-history.json` (written before the file, under one lock); the owner reverts a rule from the Tasks screen in one tap, and a revert of a change that is no longer the latest is refused. A ledger, verdict or history file that cannot be read is never overwritten: writes refuse, and sleep files and proposes nothing until it is fixed.
- **Storage:** `state/.task-proposals.json` (proposals + the ledger of tasks sleep filed) and `state/.task-feedback.json` are brain content the generated brain ignore does not exclude, so they sync like `.task-declined.json`; a brain that ignores all of `state/` keeps them on this machine. `created_by: sleep` on a card is informational only: a remote backend's pull may overwrite it.

### Moving the open backlog onto the new model (migration 0.33.0)

Nobody starts it: it is a registry migration (`src/migrations/0.33.0-backlog.ts`, after the journal split).

- **Code step** (`update` / `sleep start`): every `planning` entry leaves `core/RELEASES.json` and `state/.active-version.json` is removed (both kept verbatim in the change list); every open task without a place gets one: legacy version `BACKLOG` → Later, everything else → Next, ranked so the old active version's work and work in flight lead; legacy `parent_task` ids become slugs; `<x>-step-<n>` goes under the one open `<x>-epic…`. Legacy `version`, `priority`, `urgency` stay on the card, unread. It takes stock: every task open at that moment gets a record waiting for an outcome.
- **Agent task** `reorganize-open-tasks` (sleep-migration, in the next sleep, background included): each waiting task gets exactly one outcome, keep (optionally under a parent, or in Later), merge (cancelled + `absorbed_by: <slug>`, never deleted) or cancel, each with its own reason. A family is an AREA, so it becomes a feature link (`related_feature`, set on the parent and passed to its steps), never a parent; only a deliverable gets a parent, born clean (name ≤80, a criterion). The agent never moves a task off a feature it already has. What it is not sure about it does not apply: the task is kept and the change waits in the **Proposals** section of the Tasks screen as a change card (Apply / Keep as is; owner only). These never touch sleep's brake or feedback.
- **Any brain:** the rules are generic; a brain with nothing open writes nothing and never lists the agent task, and a second run writes nothing. `migrations record` refuses while a task still waits.
- **The change list** `state/.backlog-migration.json`: every value the migration replaced (`before`/`after`, who, when), the retired planning entries, the old active-version file, the parents it created, every outcome. It is the undo record; it syncs like `.task-declined.json` (machine-local where `state/` is ignored).

```bash
dreamcontext migrations backlog show [--pending] [--json]   # what waits, and every decision
dreamcontext migrations backlog decide <slug> keep|merge|cancel [--parent <p>] [--feature <f>] [--queue next|later] [--into <slug>] --reason "…"
dreamcontext migrations backlog parent "<deliverable>" --why "…" --criterion "…" --children a,b[,…] [--feature <f>]
dreamcontext migrations backlog propose <slug> merge|cancel|parent|later|feature [--into|--parent <slug> | --feature <f>] --why "…"
dreamcontext migrations backlog report [--json]             # open / top-level / parents / groups by feature before → now, outcomes, proposals
dreamcontext tasks list -g feature                          # the board by area: where the families become few
dreamcontext tasks list -g parent                           # families under their parent, standalone last, top-level count
```

A decision taken in an agent run is the agent's; one taken in a person's shell, or on the Tasks screen, is the owner's, and an agent never overrules it.

### Declining an idea (work that never became a task)

When the user drops, cancels or says no to a piece of work that has **no task yet**, record it — otherwise the next sleep cycle sees only that it was discussed, and files it.

```bash
dreamcontext tasks decline "<topic sentence>" --reason "<why it was dropped>"   # --reason is MANDATORY, >= 20 chars
dreamcontext tasks declined [--json]                                            # what this brain has declined
dreamcontext tasks undecline <key>                                              # the decision changed — lift it
```

- **Key = the slugified topic** (`"Drop the offline mode"` → `drop-the-offline-mode`), which is what `undecline` takes and what the filing bar's refusal names. `tasks declined` prints the keys.
- **Scope: ideas only.** Work that DID become a task ends through the task lifecycle instead — a cancelled-kind status where the project declares one (else `in_review "confirm close"`), or `tasks delete --into <slug>` — and those already leave a tombstone sleep respects. `decline` therefore refuses a topic whose live task exists and points you at the status verb. A slug that is only *tombstoned* may still be declined: the task is gone, the idea can still come back.
- **`--reason` is the payload, not ceremony.** It is what a later cycle (or a teammate) reads to decide whether the decision still holds, so "no" is not a reason; the CLI enforces a 20-character floor.
- **Stored as brain content** in `_dream_context/state/.task-declined.json` (newest-first, cap 500) and it **syncs** like `.task-tombstones.json` — a teammate's sleep cycle must not re-file what you declined here.
- **How sleep uses it.** A sleep-filed task whose slug matches a declined key is refused outright with the date and reason. One that merely *looks* like a declined idea (semantic match) is refused with `--declined-checked <key>` named in the message — the specialist reads the reason and either drops the candidate or re-runs naming that key. Reversing a decision is an awake act: `tasks undecline <key>`, then file.

### Enrich (insert into any section during active work)
```bash
dreamcontext tasks insert <name> user_stories "As a user, I want X so that Y"
dreamcontext tasks insert <name> acceptance_criteria "API returns 200 with paginated results"
dreamcontext tasks insert <name> constraints "Use native fetch, no axios"
dreamcontext tasks insert <name> technical_details "Key file: src/api/tasks.ts (Express router)"
dreamcontext tasks insert <name> notes "Edge case: empty results return [] not null"
dreamcontext tasks insert <name> changelog "Implemented pagination for /api/tasks"   # goes to the journal
```
Sections: `why`, `user_stories`, `acceptance_criteria`, `workflow`, `constraints`, `technical_details`, `notes`, and `changelog` (kept as a name: it writes a journal entry, never a card section). A missing section is created on first insert; `workflow` holds the mermaid flowchart — add it only when the task is big enough to need one (`tasks doctor` validates it against the criteria once present).

### Lifecycle commands
```bash
dreamcontext tasks log <name> "what was done"        # journal entry — MANDATORY each session
dreamcontext tasks status <name> in_progress "reason" # bump status; first in_progress auto-stamps start_date if unset, completed stamps due_date with the real end
dreamcontext tasks status <name> in_review "reason"  # bump status (logs automatically; any declared status key works too)
dreamcontext tasks statuses                        # the project's status set: key, kind, order, colour, GitHub/ClickUp mapping
dreamcontext tasks complete <name> "summary"         # mark complete (same evidence gate as status completed)
dreamcontext tasks check <name> <n|phrase> --run "npm test"   # tick a criterion WITH evidence (below)
dreamcontext tasks approve <name> [--note "what I checked"]  # the owner's verdict: review → done (never from an agent)
dreamcontext tasks doctor [name]                     # card-standard checks + Workflow drift
dreamcontext tasks delete <name> --yes               # delete (propagates to remote on sync; the journal moves to state/journal/.deleted/)
```

### Evidence changes status

A criterion is ticked only with a reference to its proof: `- [x] <text> (evidence: <ref>)`.

| ref | means | written by |
|---|---|---|
| `cmd:<je_id>` | an `evidence` journal entry: the command, its exit code and a scrubbed output tail (≤ 2,000 chars) | `tasks check --run "<cmd>"`, or `--output-file <path> --exit <code>` for a command already run |
| `commit:<sha>` | a commit reachable from the current branch of the project or a linked repo | `tasks check --evidence commit:<sha>` |
| `shot:<path>` | a project-relative screenshot that exists (no symlinks, nothing outside the project) | `tasks check --evidence shot:<path>` |
| `owner:<je_id>` | an `approval` journal entry | a tick in the dashboard, `tasks approve` |
| `legacy` | ticked before evidence existed (the migration) | the migration only |

- **`tasks check` refuses** a non-zero exit (nothing is ticked), a `cmd:` that names no evidence entry, a `commit:` that is not reachable, a typed `owner:<date>`, and a phrase that matches zero or several criteria (it lists the candidates). Never flip a box with Edit: the gate counts an unreferenced tick as unproven.
- **The gate.** A move to a review- or done-kind status (`tasks status`, `tasks complete`, a dashboard drag) is refused while any criterion is unticked or has no ref, and lists them. **Done directly** also needs every ref to be `cmd:` or `commit:` and no criterion marked `(observed)`; `shot:`, `owner:`, `legacy` and observed criteria reach review, and the owner closes them. A task with no criteria cannot close on its own word: done is refused (nothing proves it), review is open, and the owner closes it from there (or `--force --reason`). A body line starting `###` is demoted inside a journal entry, so a log can never forge an entry.
- **The owner's paths.** `tasks approve` (review → done, writes an `approval` entry) and the dashboard (a ticked box writes an approval entry, then `owner:<its id>`; dragging a review card to done is an approval). `--force --reason "<why>"` passes the gate and is journaled. `approve` and `--force` are refused from a Claude session or agent run: an accident guard, not a security boundary; every approval and force is a journal entry with its actor.
- **Evidence never leaves the machine.** `evidence` and `sleep` entries are not posted to GitHub/ClickUp; a card pulled from another machine keeps its refs and is not re-resolved.
- **`tasks doctor`** reports: a template HTML comment, a name over 80 chars, a Why over 600 chars, a card over 12,000 chars, an open task with no criteria, a review task with unproven criteria, a review older than 7 days, and a typed owner date. It also folds a card's returned Changelog into its journal.

### Filtering & discovery
```bash
dreamcontext tasks list --version S5                              # one milestone
dreamcontext tasks list --tag memoryos --tag backend --status todo  # --tag repeatable, AND
dreamcontext tasks list --any-tag lina --any-tag studio          # --any-tag repeatable, OR
dreamcontext tasks list --priority critical
dreamcontext tasks list --feature recall-engine                  # match related_feature
dreamcontext tasks list --group-by version --all                 # sectioned + counts
dreamcontext tasks list --tag lina --json                        # scriptable (use this, not awk/grep)
dreamcontext tasks tags                                           # distinct tags with counts
```
Filters compose (AND across flags), case-insensitive; version/priority/feature match exactly.

---

## RICE prioritization

Optional, additive to priority/urgency; stored on the card and synced. The dashboard no longer shows it: the RICE scatter view and sort were retired in 0.33.0 (decision 10), and importance is now a card's rank inside its cycle or queue (see [Cycles, the queue, releases](#cycles-the-queue-releases)).
```bash
dreamcontext tasks create <name> --reach 5 --impact 3 --confidence 75 --effort 2
dreamcontext tasks rice <name>                 # print current values
dreamcontext tasks rice <name> --effort 4      # update one field, recompute
dreamcontext tasks rice <name> --clear         # remove all RICE values
```
- `--reach` integer 1–10 · `--impact` integer 1–5 · `--confidence` one of 25/50/75/100 (%) · `--effort` person-weeks (>0, ≤52, 0.5 steps).
- Score = `(reach × impact × confidence/100) / effort`, computed server-side, stored in frontmatter.

## Dates & urgency
A task has an optional **date range** — a planned `start` and a `due`/end. Either end is independently settable or clearable, and both sync to the remote backend.
```bash
dreamcontext tasks start <name> 2026-06-25   # set planned start (range start)
dreamcontext tasks due <name> 2026-07-01     # set due/end (range end)
dreamcontext tasks start <name> clear        # clear the start
dreamcontext tasks due <name> clear          # clear the due
dreamcontext tasks priority <name> high      # change priority (omit the value to print it); logs "priority: medium -> high", syncs on next `tasks sync`
dreamcontext tasks urgency <name> critical   # same for urgency; same value = no-op
dreamcontext tasks create <name> --start 2026-06-25 --due 2026-07-01
```
- `start` is always **on or before** `due`. Moving the **start** past the due date doesn't fail — the due date is pushed out by just enough to preserve the window's length (a 5-day job that starts late is still a 5-day job). Moving the **due** end before the start is still rejected, since that's a direct contradiction.
- Status transitions record real-world timing: the first `in_progress` stamps `start_date` (and reschedules a due date it would have invalidated), `completed` stamps `due_date` with the actual end date. Completing a task that never had a start means it went not-started → done in one move, so it gets today at **both** ends (and loses its `backlog` tag, since it is now dated).
- Setting either date on a `backlog`-tagged task **removes the `backlog` tag** (a dated task is planned, not backlog). The rule runs the other way too: adding the tag clears both dates. That direction is enforced in the BACKEND, so every surface inherits it. The board no longer writes the tag: its **Move to Later** plans the card into the Later queue (`queue: later`), which is a place on the "when?" axis, not a tag.
- Both dates render in the dashboard's Timeline (Gantt) view.

`urgency` (critical/high/medium/low) stays on the card, in the CLI and in sync. The dashboard no longer shows or edits priority or urgency (decision 3): the Eisenhower matrix was retired in 0.33.0, and a saved view grouped or sorted by either opens grouped by Now / Next / Later and sorted by rank.

---

## People & assignees (multi-person)

**The roster lives in `_dream_context/people/people.json`** (since 0.23.0 — `dreamcontext config people` is a redirect that writes nothing). Every person also has a constitution at `people/<slug>.md`. Full surface → [cli-reference.md](cli-reference.md#people--who-works-in-this-vault).

Single-person projects ignore most of this. For teams:
```bash
dreamcontext people add "Ada" --email ada@example.com --role backend   # roster row + people/ada.md
dreamcontext people list                           # who is on the roster; `← you` marks the active person
dreamcontext people whoami --set ada               # bind THIS machine (machine-local, never synced)
dreamcontext tasks create <name> --person "Ada"    # records a person:ada tag
dreamcontext tasks tag <name> person:kerem        # add another assignee
dreamcontext tasks tag <name> person:ada --remove  # unassign
```
- `person:<slug>` tags are the source of truth for assignment and support **multiple assignees**. The legacy scalar `assignee` field is deprecated (still read, not written).
- **`--person` defaults to the active person.** Omit it and the work is attributed to whoever this machine resolves to (`DREAMCONTEXT_PERSON` → machine pin → git `user.email` → a solo vault's only person → nothing). Pass `--person`/`--authors` explicitly only to attribute to **someone else**. On a vault with no `people/people.json` at all, author stamping stays **absent** — the field is omitted, not written empty, so an un-migrated vault's output is byte-identical to before.
- When a cloud backend is active, `--person`/`tag person:<slug>` **resolves the name against the real member roster** (`tasks members`): an exact or fuzzy match is canonicalized to the member's slug, an **ambiguous** match aborts (be more specific), and an unmatched name is recorded but **warns** that it won't sync until that person is a member. Assignments are never silently dropped.
- With ClickUp enabled, the full assignee set round-trips to ClickUp's native `assignees[]` bidirectionally; map each person to a member with `dreamcontext config clickup-member <person> <memberId>`. With **GitHub** enabled, `person:<slug>` tags round-trip to issue assignees (repo collaborators; a non-collaborator is skipped, never a sync error). (see [integrations.md](integrations.md)).
- `DREAMCONTEXT_PERSON` env names the current person for attribution — rung 1 of the resolution ladder, above the machine pin and git email. It must name a real roster slug.
- A **release** records `contributors` (derived from the changelog authors and task `person:` tags of everything it discovered, sorted, deduped, bots dropped). The key is omitted when empty.

---

## Assign to agent

A task can be handed to an **agent** (`agents/<slug>.md`, see [automations.md](automations.md#agents-who-does-the-work)): the agent runs on it now, headless, and logs what it did on the task.

```bash
dreamcontext tasks assign-agent <task> <agent> [--note "…"]   # assign and run it now (foreground)
dreamcontext tasks assign-agent <task> --clear                 # remove the agent; runs nothing
```

In the dashboard: **Assign to agent** on the task (pick an agent, optional note). The route is `POST /api/tasks/:slug/assign-agent {agent, note?}`.

- **The field.** `agent: <slug>` in the task's frontmatter. **Agents are not people**: it is never a `person:` tag, never an assignee, never in `people/people.json`, and it never syncs to ClickUp or GitHub (a local-only field). The board card shows the agent's face with a ring; agents are not part of the assignee grouping.
- **Assign versus Delegate.** **Assign to agent** runs a named agent from the Agents page under its own approved prompt, unattended. **Delegate to Claude** opens a live Claude session on the task that you watch and steer.
- **The status rule.** Assigning moves the task to `in_progress` only when it has no status or an open-kind one (`todo` and declared children). It never moves a task out of active, review, done, cancelled or an unknown status. Assigning itself is allowed at any status.
- **What the agent gets.** The task name (capped at 200 characters) and a `--note` arrive fenced as data, never as instructions. A note typed in the dashboard is the owner speaking and goes in as the run's ask. The agent's own human gates stay on: a `## Flow` `hitl` node or `review` still stops it to ask.
- **The result.** The agent logs its own entries with `tasks log`. On top of that the run writes exactly one sanitized entry: ``### <date> - Agent <title> (`slug`)`` and `- Run <runId>: <status>. Document: <path or none>.`, never the document body. The journal entry syncs to ClickUp/GitHub like any other log, so only the status and the document path leave the machine.
- **First use: approval.** The agent must be approved **to run** on this machine (a scheduled agent's automation approval does not count). Otherwise the CLI refuses with "Approve it on the Agents page", and the dashboard composer shows the review with **Approve and assign**. A disabled agent, an unknown agent or task, or an over-long note is refused too.
- **Who may assign.** The owner, from the dashboard or their own terminal. An agent run cannot (`tasks assign-agent` refuses inside one).
- **How long.** An assigned run uses the agent's call settings: a 15-minute timeout unless a former on-call agent carried its own.

---

## Objectives — the OKR roadmap (task ↔ objective, many-to-many)

Objectives are **PO-authored outcomes** ("increase retention 20%", "ship v0.2.3", "launch mobile") stored one file each in `_dream_context/core/objectives/<slug>.md` — first-class, durable, recallable (`memory recall --types objective`), independent of any task. The roadmap is NOT a derived shadow of tasks and NOT a list of releases: the PO owns the structure; computation is the assist layer (rollups, forecast, slip detection).

**The load-bearing relationship:** a task declares the objectives it serves via `objectives: [a, b]` frontmatter — **many-to-many** (one shipped task often lifts revenue AND retention). The reverse direction (objective → member tasks, objective → dependents) is always **computed**, never stored — so the two sides cannot drift.

```bash
dreamcontext roadmap                                  # text board + regenerate knowledge/roadmap/board.md
dreamcontext roadmap --json                           # the typed RoadmapModel (query surface; no writes)
dreamcontext roadmap objective create <slug> --title "..." [--target YYYY-MM-DD] [--depends-on a,b] [--feature <prd-slug>] [--why "..."]
dreamcontext roadmap objective list|show <slug>       # show = members + dependents + "if this slips, so do: …"
dreamcontext roadmap objective edit <slug> [--title] [--target <date>|clear] [--status not_started|active|review|done|clear] [--feature <slug>|clear]
dreamcontext roadmap objective depend <A> <B>         # A depends on B — REJECTED at write time if it would create a cycle
dreamcontext roadmap objective undepend <A> <B>
dreamcontext roadmap objective metric <slug> [--current <n>] [--target <n>] [--baseline <n>] [--label ..] [--unit ..] [--clear]   # Key Result: --current is the common nudge
dreamcontext roadmap objective delete <slug> --yes    # also heals other objectives' depends_on
dreamcontext tasks create <name> --objectives a,b     # link at creation (slugs must exist)
dreamcontext tasks objectives <task> a,b|clear        # set/clear on an existing task
dreamcontext tasks list --objective <slug>            # all tasks serving an objective
```

**The computed model** (per objective, from `roadmap --json`):
- **Progress** = done ÷ total member tasks, by KIND (each objective counts over its OWN member set — a shared task contributes to each independently). A `cancelled`-kind task leaves BOTH the numerator and the denominator — abandoned work is neither progress nor remaining work.
- **Rollup status** (real enum, by kind): all live members `done`→`done` 🟢 · any `active`-kind→`active` 🔵 · any `review`-kind→`review` 🟡 · else `not_started` ⚪. Cancelled members are ignored, so an objective whose remaining tasks are all cancelled rolls up `done`. A manual `--status` override wins (`status_source: override`).
- **Forecast cascade — full transitive DAG:** `forecast_start = max(earliest member start, max(forecast_end of dependencies))`; `forecast_end = max(latest member due, forecast_start)`. A slip anywhere propagates to ALL transitive dependents (diamond shapes included).
- **Milestone forecast:** an objective with NO dated tasks of its own but WITH dependencies inherits its forecast from its latest dependency (finish-to-start) — so a pure milestone ("launch", which only depends on others) slips when an upstream slips. Only an objective with neither dated tasks nor a forecastable dependency stays `null` ("unforecastable") — and a null-forecast objective still never drags its dependents to "now".
- **Slipping** 🔴 = `forecast_end > target_date` (the PO's committed date). The model also exposes `slip_days` (how many days late) and `slip_upstream` (the auto-derived cause — the dependency slug(s) responsible, else empty = the objective's own tasks overrun). Surfaced in the snapshot and the board.
- **Prioritization + description:** each objective also carries `impact` (1–5), `effort` (weeks) and a one-line `description` (first body line) — rendered in the snapshot, which now surfaces current-month/quarter targets first.

**Rules for agents:**
1. **Propose, never overwrite.** Suggest `objectives:` for tasks you create or find unlabeled; an existing non-empty list is a PO decision — never change it unless the user asks.
2. **Local-only field.** `objectives` is never pushed/pulled by cloud sync backends. Do not try to map it to remote labels.
3. **Objectives are orthogonal to versions/cycles.** `version` = WHEN (the time-box); `objectives` = WHAT outcomes it serves. Both live on the task independently.
4. **`knowledge/roadmap/board.md` is auto-generated** — regenerate with `dreamcontext roadmap`, never hand-edit it. Objective files themselves are PO-authored prose — edit `## Why`/`## Notes` freely, but rollups/members are computed and don't belong in them.
5. A feature PRD *may* back an objective via the objective's `feature:` field — a convenience link, not a requirement.

### Proactive objective capture (in-session — ASK, never auto-create)

Objectives are PO-authored, so this is an **offer-and-confirm** flow, never a silent write. When, during a session, the user **states or clearly implies an outcome/goal** — an explicit target ("hedefimiz $2000 MRR", "we want to launch mobile by Q4") OR an inferred one from how they talk about direction ("we really need to grow this", "the whole point is to make it a business") — do this:

1. **Dedup first.** Run `dreamcontext roadmap objective list` and `dreamcontext memory recall "<the outcome>" --types objective`. If an objective already covers it, DON'T propose a new one — offer to update the existing one instead (or just link the current work to it).
2. **Offer it.** If it's genuinely new, ask: *"This sounds like a roadmap objective — want me to add it?"* Never create without a yes.
3. **Ask the dates.** On yes, ask for the committed window — start and target date (`--target`, and set start via `objective edit`/dashboard). Don't invent dates.
4. **Offer a Key Result.** Ask whether to track it by a number rather than member tasks: *"Track this by a metric (e.g. MRR 0→2000) or by its tasks?"* If a metric, capture `label` + `baseline`/`target` (`--metric*` flags on create, or `objective metric` after). If a Lab insight already measures this outcome (`memory recall "<outcome>" --types insight`), offer to connect it — `dreamcontext lab bind <insight> <objective>` — so `current` is measured, not asserted.
5. **Detect + propose dependencies.** From the existing objective list, infer likely `depends_on` edges ("make-it-a-business can't happen before simplified-ux and team-ready ship") and **propose them for confirmation**; on yes, apply with `objective depend <A> <B>` (the write-time cycle guard protects you). Never write a dependency edge silently.
6. **Keep the Key Result current — unless an insight feeds it.** When the session later surfaces a real observed value for a tracked objective ("MRR just hit $1,250", "we're at 400 active users"), offer to update it: `dreamcontext roadmap objective metric <slug> --current <n>`. Use a value you actually observed — never estimate. (Sleep may also refresh `--current` autonomously from observed values.) **Exception:** if a bound insight feeds the objective (`dreamcontext lab list --json` → a manifest whose `binding.objective` is the slug), `current` is *measured* — hands off; suggest `dreamcontext lab sync <insight>` instead of writing a number the next sync would overwrite. And when removing a fed objective's metric (`--clear`), disconnect the feeder first (`lab bind <insight> --clear`) — a binding with no Key Result warns on every sync.

The through-line: **you detect and propose; the PO confirms.** Every create, date, dependency, and metric write waits for a yes — matching the "objectives are PO-authored" invariant and the board-first ritual (`knowledge/visual-first-board-ritual.md`).

---

## Lab insights — curated analytics metrics

An **insight** is a named, curated **metric backed by an external source** — "Weekly Active Users from our PostHog API", "MRR from a billing script". It is a number/series that **re-syncs on demand**, never a prose document. This is the entity users mean by "create an insight", "track signups", "I want to see MRR every session".

**What an insight is NOT (route correctly):**
- NOT **knowledge** — knowledge is prose you write and maintain; an insight fetches its value from a source. Never `knowledge create` for a metric.
- NOT an **objective** — an objective is an outcome with a target date; an insight is the *measurement*. (The two connect: an insight can *feed* an objective's Key Result via binding, below.)
- NOT a raw data dump — rollup structurally caps every series at 62 points (daily→weekly→monthly coarsening by span). Insights are curated metrics, by design.

**Where it lives:** manifest at `_dream_context/lab/insights/<slug>.md` (frontmatter config + a `## Meaning` prose section that makes it recallable), cached series at `lab/cache/<slug>.json`, custom scripts at `lab/scripts/<slug>.mjs`, secrets in gitignored `lab/credentials.json`. Manifests + caches sync in the brain repo; only credentials stay local.

**How agents READ it — the ladder, before reaching anywhere else:**

1. **Snapshot.** The SessionStart hook renders a **Lab** section (title / latest value / staleness / group). "What's our MRR?" is answered from it with **zero tool calls**.
2. **`dreamcontext lab show <slug>`** — the manifest plus the **full cached series** (and per-funnel step tables for `render: funnel`), and it **never fetches**. This is the right call the moment the question needs more than the latest number: a breakdown, a trend, a month-over-month comparison, "which step leaks". The snapshot only carries the latest value, so *not knowing the series is not a reason to go outside* — it is a reason to run `lab show`.
3. **`render: app` (or any dimensional data): `dreamcontext lab query <slug> [--where][--group-by][--top]`** to slice the cached `dataset/v1` numbers, or **`dreamcontext lab body <slug> [--page][--format text|md|html]`** to read what a script-authored page actually shows — both cache-only, both never fetch. This is how you answer "what does this card show?" or "what's this insight broken down by X?" without opening the dashboard, on a body you did not author.
4. **Don't know the slug?** `dreamcontext lab list [--json]` (every insight + latest value + staleness) or `dreamcontext memory recall "<meaning phrase>" --types insight` — this is what the `## Meaning` section exists for.
5. **Stale only:** `dreamcontext lab sync <slug>` when the cache is past TTL (`--force` to refetch a fresh one).

**An MCP tool, a raw API call, or a hand-written script is the LAST resort.** If `lab/insights/` already holds the metric, fetching it another way bypasses the manifest, cache, tweaks and KR binding — and produces a number the next session cannot reproduce. A real past failure: an agent asked for revenue reached for a billing MCP while the synced Paddle series was already cached, and the project had to hand-write a memory note to stop it. When you genuinely must go outside (the insight doesn't exist, or the question needs a dimension the manifest doesn't carry), say so explicitly — and offer to `lab create` it if the user will want it again. Full rule: SKILL.md Operational Rule 13.

The dashboard's **Insights** page (Beta) is a set of **boards** (§ Boards below): cards on a 12-column grid, each drawing an insight through its render (the table below) or through blocks from the catalog, with a date-range control, refresh, tweak editing and a freshness line on every insight card.

```bash
dreamcontext lab create <slug> --title "Weekly Active Users" [--render <render>] [--size s|m|l] [--adapter http|script] [--category <board title>] [--group <section>] [--unit users] [--ttl 1440] [--board <slug>|--no-board]
dreamcontext lab create <slug> --title "…" --preset funnel-explorer [--locale en|tr]   # a snapshot-fed funnel explorer (§ Funnel explorer)
dreamcontext lab data check|write <slug> --file <path>   # validate / validate + write + hard-sync its snapshot lab/data/<slug>.json
dreamcontext lab sync <slug> [--force]      # one insight (TTL-fresh is skipped; --force skips the TTL, the freshness probe still decides)
dreamcontext lab sync --all [--force]       # every insight; exits non-zero if any fail
dreamcontext lab sync --all --dry-run       # what would be fetched / probed / skipped, ZERO upstream requests
dreamcontext lab sync <slug> --force-hard   # skip the TTL AND the probe: always a full fetch
dreamcontext lab list [--json]              # all insights with latest value + staleness
dreamcontext lab show <slug> [--json]       # manifest + cached series (never fetches)
dreamcontext lab tweak <slug> <key> <value> # a declared tweak, or well-known range/from/to (e.g. range last_1_year)
dreamcontext lab bind <slug> <objective>    # connect to an objective's KR (--value latest|series:<name>; --clear)
dreamcontext lab credentials set <key>      # hidden prompt; the ONLY way to store a secret
dreamcontext lab credentials list           # key NAMES only — values are never printed
```

**Renders — pick how the metric is DRAWN.** Every render below reads the same cached `Series[]` (only `funnel` takes its own payload), so switching one is a manifest edit, not a re-model. The engine's `RENDERS` list is the single source of truth: the `--render` enum, doctor's validation and the dashboard's chart registry all derive from it, and an unrecognised value degrades to `number` instead of blanking the board.

| `render` | Draws | Reach for it when |
|---|---|---|
| `number` | Latest value + Δ + inline sparkline | One figure IS the answer (MRR, WAU) |
| `line` | Multi-series trend over time | The shape of the movement matters |
| `pie` | Share of total by series | Composition — "who makes up the whole" |
| `bar` | Horizontal bar per series (latest) | "Who is biggest right now" |
| `bar_compare` | Grouped bars, series × last N buckets | Period-over-period comparison per series |
| `stacked` | Stacked bars over time | Composition *and* total, together |
| `table` | Series × latest + Δ + trend, sortable | Many series, exact numbers, scanned not eyeballed |
| `heatmap` | Week × weekday grid (daily buckets) | Rhythm — which days carry the metric |
| `raw` | The numbers, unstyled | Debugging an adapter |
| `funnel` | Routed multi-page funnel view (below) | Step-by-step conversion analysis |
| `app` | Routed, multi-page, full-screen-capable view the SCRIPT builds itself (below) | Dimensional/drill-down data, or any multi-screen interactive story — without writing a component |

**`size: s\|m\|l`, `width`, `height`** (optional legacy manifest fields) only shape the card a DERIVED board gives the insight (width 1/2/3 → 4/8/12 grid columns, height s/m/l/xl → 3/4/6/8 rows; absent, the render decides: `table` and `funnel` take two thirds). Once boards are saved, a card's place and size live in the board file (`at: {x, y, w, h}`) and are changed by dragging in Edit mode or with `lab board set`.

**Well-known tweaks — `range`, `from`, `to`.** The engine derives a time window for EVERY insight (a relative `range` like `last_30_days`, or an explicit `from`/`to` pair that out-ranks it), so those three keys are writable on any insight whether or not its manifest declares them — via `lab tweak` or the dashboard's date-range control, which is why every card and the funnel pages offer a window even when the author never declared one. A manifest that DOES declare `range` keeps its curated options (and still rejects outsiders); an undeclared one accepts the relative-range grammar and gains an implicit declaration on first write. Setting `range` clears any stored `from`/`to` — otherwise the explicit window would silently pin every later preset to the old dates. Any other knob (`country`, `cohort`, …) still has to be declared in the manifest to be settable. **Shared windows (`tweaks_from`).** An insight derived from another (a stat card beside its funnel, a per-step bar off the same source) declares `tweaks_from: <source-slug>` in its frontmatter: a window change on ANY member of that group (source or follower; `lab tweak`, a card's Range menu, a whiteboard window chip) is written to all of them, with the written insight's window declarations, so derived cards never show different windows. The dashboard re-syncs the others after the one touched; `lab tweak` names them for you to sync. One hop: a follower names the source, never another follower; a self-reference is ignored. Before deriving a second insight just to show a funnel's steps or a segment's rate, put the funnel itself on the surface (a whiteboard `insight` widget at L/XL draws the funnel explorer; a `lab-card` widget draws any board card).

**Adapters:** `http` — declarative JSON API (endpoint/headers/body templates with `{{tweak:key}}` and `{{cred:key}}` placeholders, JSON-path `extract`, multi-series split via `seriesKey`); `script` — escape hatch, `lab/scripts/<slug>.mjs` exporting a default async function. `lab create` scaffolds the manifest; edit it to set the real endpoint/extract config, then run the first sync.

**Key-Result binding (insight → objective):** a manifest `binding: {objective: <slug>, value: latest}` makes every successful sync write the objective's KR `metric.current` automatically — upgrading the roadmap from PO-asserted numbers to measured ones. Offer this whenever an insight measures an existing objective's outcome. Set it via `lab bind` (or the dashboard's objective create modal / detail panel, which search insights by name); binding is ONE feeder per objective — connecting a new insight unbinds the previous one loudly, and connecting immediately seeds `metric.current` from the cached latest.

**Sync semantics — sync only pays for change.** Three strengths:

| Run | Who asks | TTL | Freshness probe |
|---|---|---|---|
| automatic (no force) | a board opening, the page's 60 s re-check, a tab becoming visible | respected | consulted when past TTL |
| `user` (`--force`, ↻, Sync board, a tweak save) | a person or agent on purpose | skipped | consulted |
| `hard` (`--force-hard`, card menu "Force full refresh") | on purpose, distrusting the probe | skipped | skipped: always a full fetch |

TTL staleness defaults to 1440 min; age counts from the later of the last real fetch and this machine's last unchanged probe. **The freshness probe** is optional: an `http` manifest may declare `refresh.freshness: {url, method?, headers?, body?, extract: {marker, asOf?, note?}}` (resolved through the same `{{tweak:*}}`/`{{cred:*}}` placeholders as the source; credentials go ONLY to the source's own origin, compared after placeholder resolution, so a cross-origin probe carrying one is refused), and a script may `export async function freshness(ctx)` beside its default export or return `{data, freshness: {marker, asOf?, note?}}` from a normal run. A sync skips the fetch as **upstream unchanged** only when the probe's marker AND the request fingerprint (`queryKey`: resolved tweaks, window, source/script hash) both match the last real fetch; a changed tweak always fetches, a probe that throws, times out (5 s) or returns garbage falls back to a full fetch, and a real fetch is forced once the last one is older than max(24 h, 10 × TTL). The skip reason (`ttl` or `upstream unchanged`) is printed by the CLI and shown on the card; a source's `note` renders as plain text. **Freshness checks are per machine**: the time of the last unchanged probe lives in the gitignored `state/.lab-freshness.json`, so an unchanged probe never dirties the brain-synced cache. Automatic runs leave a slug alone for max(TTL, 15 min) after it failed (no retry pass); `user`/`hard` runs retry. **A slow or paid source** (a warehouse query, a metered API) can opt out with `refresh: {ttl_minutes: …, auto: false}`: an open board never syncs it on its own (the client skips it and the sync-jobs route drops it from any automatic job), only ↻, Sync board or `lab sync --force` do; raise `ttl_minutes` instead when the source is merely slow. The card's freshness tooltip says when the next automatic check is (or that it is off). Opening an all-fresh board starts **zero** sync jobs; a request the running job does not cover queues ONE follow-up job (the card says queued). On failure the prior series is KEPT and the error is loud (never a silent half-sync). **Sleep does NOT run lab sync** — refresh is always an explicit user/agent action, or an automation's.

### Funnel insights (`render: funnel` — the first multi-page insight)

For funnel analysis (comparative across funnels + sequential across steps), an insight can render as a **routed multi-page view** instead of a card+slide-over: the Lab card shows a top-N mini-table and opens `/lab/<slug>` (all-funnels comparison table: metric columns from the payload, sort/search, date-range presets via the `range` tweak, Δ-vs-previous-period chips, low-sample de-emphasis, multi-select→compare) and `/lab/<slug>/f/<funnelId>` (the step lane: rounded nodes left→right, drop badges, a two-click A→B conversion-arrow gesture, dimension filters, one-dimension breakdown as stacked bands or small-multiple lanes, an accessible step-table twin). Long funnels (real quiz funnels run 40-60 steps) get horizontal scroll + zoom-to-fit plus a **significant-change collapse mode** (toolbar `Collapse` + user-set threshold %, URL `clt`): runs of steps whose adjacent change is below the threshold fold into one node showing start → end users + a step-count chip — cumulative drops stay visible, never hidden. Filters, breakdown, compare set, pinned arcs, collapse threshold, and sort all live in the URL — a copied link reproduces the exact view.

**Columns are the reader's choice.** The overview table's **Columns** popover lists every available column as a checkbox, grouped and scrolled: the payload's *Metrics*, plus **derived step columns computed client-side** from `steps` — *Step conversion* (one per adjacent pair of the union step order, "A → B %") and *% of top* (one per step). Derived columns align by step KEY across funnels, so a funnel missing that step renders "—" rather than a fabricated 0, a zero denominator is "—" rather than ∞, the low-sample rule de-emphasizes derived rates exactly as it does payload ones, and a Δ chip appears only where the previous period has BOTH of the rate's steps. They cost nothing to add — the `funnel-set/v1` contract is unchanged. Defaults are exactly the payload's metric columns (every derived column starts off); sort and copy-as-Markdown follow whatever is visible; **Reset** returns to the default set. The selection rides the URL `cols` param **and** writes through to per-machine lab prefs keyed by insight slug — a shared link shows the sender's columns (URL wins), your own machine remembers yours otherwise, and keys naming columns the payload no longer has are dropped silently.

**Payload contract (`funnel-set/v1`):** instead of `Series[]`, the adapter (script or HTTP) returns ONE object:

```jsonc
{ "kind": "funnel-set/v1",
  "primary": "users",                    // metric driving the card value + default sort (optional)
  "low_sample_threshold": 30,            // rows under this top-step n render de-emphasized (optional)
  "benchmarks": { "finish_rate": { "floor": 1, "target": 3 } },   // cell tinting, off when absent (optional)
  "dimensions": [                        // filter/breakdown declarations
    { "key": "language", "label": "Language", "mode": "client" },            // segments below carry the data
    { "key": "country",  "label": "Country",  "mode": "refetch", "tweak": "country" }  // value → tweak + re-sync
  ],
  "funnels": [{
    "id": "516", "name": "en-start-516",
    "meta": { "url": "…", "hypothesis": "…" },                    // free-form, shown in the detail rail
    "metrics": { "users": { "v": 33, "format": "count", "prev": 40 } },  // format: count|pct|usd|x|seconds|number; prev optional
    "steps": [ { "key": "session_start", "label": "session_start", "users": 33 } ],  // ORDER = step order; key aligns across funnels/periods
    "segments": [ { "dims": { "language": "en" }, "users": 21, "steps": [ { "key": "session_start", "users": 21 } ] } ]  // DISJOINT cells, optional
  }]
}
```

The engine validates + caps the payload (max 40 funnels, 64 steps — over-cap keeps first 63 + the final step, 8 dimensions; per-dimension values beyond the top 8 collapse into "Other"; 64 segment cells; 400 KB — every cap is a loud notice, never silent), synthesizes legacy `series` from step users (so `latest`, KR binding, and the snapshot keep working), and records a bounded per-sync snapshot trail. **Δ vs previous period:** an adapter-provided `prev` wins; otherwise the engine compares against the best equal-length history snapshot ending at/before the current window — and shows NOTHING when no honest comparison exists. `lab create <slug> --render funnel --adapter script` scaffolds the `range` tweak (7d/28d/90d presets) plus a fully documented script template; `lab show <slug>` prints per-funnel step tables with the worst drop highlighted. Legacy `Series[]` payloads under `render: funnel` still render (compact bar list). Data FEEDING stays out of Lab scope — sleep never syncs funnels either. For a ready-made explorer over a funnel set fed from the KB MCP (one card with Daily, Benchmark, Ranking, Flow, Steps, Compare, Payment, Access, axis tables and the comparison Table), use `lab create <slug> --preset funnel-explorer`: § Funnel explorer below. A preset insight's `/lab/<slug>` is that explorer card, not this table page.

### App insights (`render: app` — a script builds its own multi-page, interactive, full-screen body)

> **LEGACY since Insights v2 (2026-09-29).** Existing `app/v1` insights keep working unchanged (they draw through a board's `insight` block, with the `lk-` kit), and `app` stays the answer for a genuinely multi-page, routed, full-screen body. For a one-screen custom view over data you already sync, reach for a board **`html` block** instead (§ Boards): it binds declared inputs, uses the full `dc-` kit, can be saved to the vault library and reused, and needs no script change.

The `funnel` render above is hand-written React — the ONE multi-page view the platform built for a specific analysis shape. `app` generalizes that: **a script author builds a multi-page, interactive, full-screen-capable body itself, with no React component written for them.** If the user wants "the funnel insight's shape, but for my own data", this is the render — never a hand-built dashboard, never a request to platform-engineer a new insight type.

**How it's created, end to end:**

```bash
dreamcontext lab create <slug> --title "…" --render app --adapter script
```

This scaffolds `lab/insights/<slug>.md` (with the `range` tweak pre-declared, same as `funnel`/the old `breakdown`) and a fully documented `lab/scripts/<slug>.mjs` template. Edit the template's real query, then `dreamcontext lab sync <slug>`. The script returns **`{ data, app }`** — two independent halves, never conflated:

- **`data`** — MANDATORY, the queryable numbers. Typically a `dataset/v1` bundle (below); may also be plain `Series[]`, a `funnel-set/v1`, or a `matrix/v1` payload — whatever shape the numbers actually are. Feeds `latest`, KR bindings, `lab show`, `lab query`, and the Rule-13 read ladder exactly like a bare return would. `{ app }` with no `data` fails the sync loudly — a body is never a substitute for the numbers, same rule `html/v1` has always enforced.
- **`app`** — OPTIONAL-shaped-as-mandatory-for-this-render: `{ kind: 'app/v1', entry, pages: [...], card?, shell? }`. `entry` names the page shown at `/lab/<slug>`; `card` (optional) names a different page for the board card preview, defaulting to `entry`; `shell` (optional) is CSS/JS that wraps every page (`shell.style`, `shell.script`). Each page is `{ id, title, html, dataset? }` — `id` is URL-safe (`[a-z0-9][a-z0-9-]*`, unique), `dataset` names which of `data`'s datasets `lab.data()` defaults to on that page. Caps: ≤12 pages, ≤300 KB for the whole spec (host-served data means the html itself should not need to embed numbers) — every violation is a loud sync-time reject, never a silent truncation (a missing/colliding page id would break a real route and every deep link into it, so there is nothing safe to collapse the way a matrix row is).

**`dataset/v1` — the plural successor to `matrix/v1`, for the numbers:**

```jsonc
{ "kind": "dataset/v1",
  "primary": "breakdown",                // the key lab.data()/lab query resolve to with no key given
  "datasets": [{
    "key": "breakdown",
    "dims": [                            // 1-8 dims — SAME grammar as matrix/v1: [0]=rows, [1]=cols, [2]=filter chips, the rest summed/queryable
      { "key": "funnel", "label": "Funnel" },
      { "key": "language" }
    ],
    "rows": [{ "d": { "funnel": "F3000", "language": "TR" }, "v": 119000, "n": 4200 }],
    "total": { "v": 255000, "n": 9100 }  // optional — feeds the card value + KR binding
  }]
}
```

An app can carry several named datasets (≤12), one per page or shared — each validated by the same dimensional grammar `matrix/v1` uses, with looser caps because `data` is the queryable numbers: **up to 8 dims per dataset, every dim value kept** (a 28-day `day` dim stays 28 days; fold at draw time with a block's `topN`), ≤10,000 rows per dataset, and a **400 KB** byte cap on the whole bundle (about 3,000 six-dim rows) — over it the sync is a loud reject, so pre-aggregate or drop a dim no page reads. One table with all the dims a question needs (`day, product, source, country, campaign, plan`) beats several 3-dim tables: `lab query --where/--group-by` slices any combination, separate tables cannot be joined. Notices are loud, never silent. **Never bake dimension values into series names** — the anti-pattern this whole lineage (matrix/v1 → dataset/v1) exists to kill.

**Interactivity already works — it always has.** Every `app/v1` (and `html/v1`) page is drawn in a network-less sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`, srcdoc CSP `default-src 'none'`), and an inline `<script>` tag inside that html **runs**. This has been true since the very first `html/v1` card shipped; it was never written down, so nobody built on it. Write real `<script>` — buttons, `fetch`-free client-side computation, DOM updates — against the page's own data. What the sandbox forbids is reaching the network (fetch/XHR/beacon/remote image all die silently) or the parent page; it does not forbid the page from being alive.

**How it goes multi-page.** Declare more than one entry in `app.pages`; each becomes a route:

- `/lab/<slug>` — the `entry` page.
- `/lab/<slug>/p/<pageId>` — any other declared page, deep-linkable and Back-button-safe (real history entries, same as funnel's `/f/<funnelId>`).

From inside a page's own script, `lab.navigate('otherPageId', { optionalParam: 'value' })` switches pages — the host pushes the new URL, and the previous page's iframe is torn down and a fresh one mounted for the new page (a page never mutates in place; switching pages is always a remount, which is also what keeps the security model in the pattern doc sound). `lab.onRoute(callback)` fires when the CURRENT page's params change without a page switch (in-page navigation).

**How it goes full screen.** Append `?fs=1` to the insight's URL (or click "⛶ Full screen" in the page toolbar) — the whole page becomes the app body, no dashboard chrome. **Escape** exits (there's also a visible "Exit full screen" button, because a sandboxed iframe's own key events never bubble to the host page once focus is inside it — Escape only works when focus is still on the host). This is a URL-driven CSS overlay, not the browser's native Fullscreen API, specifically so it deep-links, survives a reload, and is scriptable/testable.

**The author API — the host injects it, you don't build any of it:**

| Call | Does |
|---|---|
| `lab.page` | This page's own id (string) |
| `lab.params` | This page's current params (object) |
| `lab.navigate(pageId, params?)` | Switch to a declared page, optionally with params |
| `lab.data(datasetKey?)` | `Promise` resolving to the named `Dataset` from `data` — omit the key to get the page's declared `dataset`, else the bundle's `primary`, else the first. Numbers come from the HOST (embedded at sync time) — this is never a network fetch. |
| `lab.onRoute(callback)` | Fires `(pageId, params)` on in-page navigation |

**Height is automatic — the author does nothing.** The page's own content height is measured and reported to the host continuously (a `ResizeObserver` plus a load/click re-check for late-loading fonts or images); the host resizes the card/page/full-screen frame to match. There is no height to set and no height field in the manifest — write the page like a normal document and it fits. **One bound, and it is the BOARD's, not yours: the card preview is clamped to 120–320px** (a taller tile would set its whole grid row's height and strand its neighbours in whitespace), while the page and full-screen frames are effectively unbounded. So put the depth on a page and let the card be a preview — and do NOT shrink type below the kit's scale to squeeze a card: a body over the cap keeps its own scrollbar and reads in full when opened. `size` in the manifest picks the card's COLUMN span (`s`/`m` = 1, `l` = 2), never its height.

**`lab.navigate` params are capped, and a bad value is DROPPED, never truncated.** Params can reach the real, shareable browser URL (Copy-link included), so: ≤8 params, keys matching `[a-z0-9_-]{1,24}`, values ≤64 chars, ≤256 chars total. A value over the cap is **dropped entirely, not cut short** — a truncated value would silently show the wrong view (e.g. a truncated filter id that happens to match some OTHER real value) with no sign anything was wrong; a dropped one is visibly absent. Every drop logs a console warning naming the key. Design params to stay well under these caps — they are for "which tab/filter is open", not for carrying data (`lab.data()` is what carries data).

**Reading a body you did not author, from the terminal:**

```bash
dreamcontext lab show <slug>                  # page list (entry marked) + one pivot per dataset
dreamcontext lab body <slug> [--page <id>] [--format text|md|html]   # what a page actually renders
dreamcontext lab query <slug> [--dataset <key>] [--where k=v] [--group-by <dim>] [--top <n>]  # slice the numbers
```

None of these fetch — all three read the cache. This is how an agent answers "what does this card show?" or debugs/reviews a body written by someone (or something) else, without opening the dashboard. `--json` on all three for machine consumption.

`lab create <slug> --render app --adapter script` scaffolds the `range` tweak + the documented `{ data, app }` template above. Best-practice pattern (the security model, the bridge contract, why it's safe without relaxing the sandbox) → the `sandboxed-app-bridge-pattern` knowledge pattern.

### Breakdown insights (`render: breakdown` — the `matrix/v1` contract, DEPRECATED for new insights)

> **DEPRECATED as an authoring path (2026-08-26).** `lab create --render breakdown` no longer scaffolds a script template, and the render decision table no longer routes new dimensional work here — use `app` + `dataset/v1` instead (above), which carries the identical dims/rows/total grammar in a plural, multi-page-ready shape. **Existing `breakdown` insights are grandfathered: they keep rendering exactly as before, and no migration is forced.** This section is kept for reference against those existing insights, not as a guide for new ones.

For DIMENSIONAL data — a value broken down over 1-3 dimensions (funnel × language, plan × country) — the adapter returns ONE matrix object instead of `Series[]`. **Never bake dimension values into series names** ("F3000 · TR · 119k" is the anti-pattern this contract exists to kill):

```jsonc
{ "kind": "matrix/v1",
  "dims": [                              // 1-3, ORDER MATTERS: [0]=pivot rows, [1]=columns, [2]=filter chips
    { "key": "funnel", "label": "Funnel" },
    { "key": "language" }
  ],
  "rows": [                              // one row per dim-value combination
    { "d": { "funnel": "F3000", "language": "TR" }, "v": 119000, "n": 4200, "prev": 101000 }
  ],                                     // v = the value; n (optional) = sample size (n<30 renders de-emphasized);
                                         // prev (optional) = previous equal-length period — wins over history-derived Δ
  "total": { "v": 286000, "n": 9125 },   // optional grand total — feeds the card value + KR binding (loud warn if bound and absent)
  "unit": "USD"                          // optional unit override
}
```

The engine validates + caps it (≤3 dims; per-dim values beyond the top 8 collapse into "Other"; ≤400 rows, the tail merges into one all-Other row; 200 KB hard reject — every cap is a loud notice, and `doctor` re-flags a stored cache that violates one), synthesizes legacy `series` from the rows, and — the important part — **appends a DATED snapshot to `matrixHistory` on every successful sync** (count cap 60 AND a byte cap together). The matrix itself is a snapshot, not a time series: **the history trail IS the time axis**, so a daily sync cadence is what builds a dated trail. Δ vs previous period: a row's `prev` wins; else the equal-length (±25%) history snapshot; no honest comparison → no Δ shown. `lab create <slug> --render breakdown --adapter script` scaffolds the `range` tweak + a documented script template; `lab show <slug>` prints the pivot; legacy `Series[]` under `render: breakdown` still renders (bar-list fallback).

### HTML card bodies (`html/v1` hybrid — typed renders first, single-page)

> **LEGACY since Insights v2 (2026-09-29).** Existing `html/v1` bodies keep rendering exactly as before through a board's `insight` block (the `lk-` kit stays for them). Do not write NEW script-embedded html bodies: a custom card is a board **`html` block** (§ Boards), which is decoupled from the sync script, bound to data by declared inputs, and reusable from the vault library.

A script may return `{ data, html? }`: **`data` is MANDATORY** (exactly what a bare return would be — the numbers keep feeding `latest`, KR bindings, Δ, board blocks, `lab show` and the Rule-13 read ladder; `{ html }` alone fails the sync loudly), `html` is an OPTIONAL card body, ≤300 KB (over-cap = loud sync failure, never truncated). The dashboard draws it in a **network-less sandboxed iframe** (`sandbox="allow-scripts"` with NO same-origin grant + a `default-src 'none'` CSP — it can animate and compute against the data embedded at sync time, but it cannot fetch, beacon, or touch the parent origin), and the detail panel always shows the typed data TWIN next to it, so a screen reader is never locked to the iframe. **Rule: reach for a typed render first; write `html` only when the render vocabulary cannot express the card in ONE screen — reach for `app` (above) the moment it needs more than one page** — and use the `lab-html-kit.css` classes instead of your own CSS (`lk-title`, `lk-value`, `lk-label`, `lk-muted`, `lk-delta--up/down`, `lk-stat`, `lk-chip`, `lk-table`, `lk-bar`/`lk-bar-fill--N`, `lk-low-sample`, `lk-empty`): the kit ships embedded with the current theme's design tokens, so a kit-classed card looks native dreamcontext in light and dark and repaints on theme change. A run whose script returns no `html` clears any prior body — stale presentation is worse than none. `app/v1` pages draw against the SAME kit and the SAME sandbox/CSP guarantee — `html/v1` is simply the one-page, no-bridge case of it. **Height is automatic here too, on exactly the same terms** (the body measures itself and the host resizes to match; fixed at 232px until 2026-09-08, which quietly pushed authors to shrink type until it fit — the opposite of why the kit exists): the CARD is clamped to 120–320px because that bound belongs to the board grid, and the DETAIL panel is effectively unbounded, so a long body reads in full when opened rather than being written small. There is no height field to set — if the card needs more than one screen of its own, that is the signal to make it an `app`.

### Boards (the Insights page, Beta — `lab/boards/<slug>.md`)

A **board** is a composed page over insights you already track: **cards** on a 12-column grid (a row is 56 px), each card a stack of **blocks**. A board OWNS NO DATA and has no sync path of its own; its blocks read insight caches. Boards replace the old categories, groups and Reports (Reports and their AI commentary were removed; an old `lab/reports/` folder in a vault is left untouched and ignored).

```yaml
# lab/boards/growth.md (frontmatter = the spec, body = optional prose)
title: Growth
order: 1
cards:
  - id: c-signups                  # unique within the board (React key, brain-sync merge key)
    at: {x: 0, y: 0, w: 4, h: 3}   # 12 columns; h in rows
    title: Signups                 # optional; defaults to the primary insight's title
    insight: daily-signups         # optional primary: detail panel, refresh, range, tweaks
    blocks:                        # optional; absent = one `insight` block (the insight drawn exactly as before)
      - stat: {data: daily-signups, delta: prev, spark: true}
      - line: {data: daily-signups, area: true, color: 2}
```

A binding is `data: "<insight>"` or `"<insight>/<datasetKey>"` (a `dataset/v1` key). **The block catalog** (`dreamcontext lab block list [--json]` prints every type, the frames it accepts and its options). Every option lives in ONE place, the engine catalog in `src/lib/lab/blocks.ts` (EN and TR labels); the dashboard inspector is generated from it, `lab board set` validates against it, and the table below is generated from it too (a lockstep test fails when they drift). An unset option takes its default:

<!-- block-catalog:start (generated from dashboard/src/generated/block-catalog.json; see tests/unit/lab-block-catalog-doc.test.ts) -->
| block | option | what it sets | values | default |
|---|---|---|---|---|
| `stat`: One number with its change and a sparkline. | `delta` | Change | `none`, `prev` | `none` |
|  | `spark` | Sparkline | `true`, `false` | `false` |
|  | `unit` | Unit | text | unset |
|  | `format` | Format | `number`, `compact`, `percent`, `currency` | `number` |
|  | `series` | Series | list of names | unset |
|  | `size` | Size | `sm`, `md`, `lg` | `md` |
|  | `goal` | Goal | number | unset |
| `line`: Series over time. | `area` | Fill area | `true`, `false` | `false` |
|  | `color` | Color | number 1 to 8 | `1` |
|  | `series` | Series | list of names | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `curve` | Curve | `linear`, `smooth`, `step` | `linear` |
|  | `points` | Points | `auto`, `always`, `never` | `auto` |
|  | `yMin` | Y axis starts at | `auto`, `zero` | `auto` |
|  | `reference` | Reference line | number | unset |
|  | `referenceLabel` | Reference label | text | unset |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `bar`: Values side by side. | `orientation` | Orientation | `h`, `v` | `h` |
|  | `color` | Color | number 1 to 8 | `1` |
|  | `comparePrev` | Compare with previous period | `true`, `false` | `false` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `series` | Series | list of names | unset |
|  | `valueLabels` | Value labels | `true`, `false` | `true` |
|  | `topN` | Top N, rest as Other | number 1 to 50 | unset |
|  | `group` | Several series | `grouped`, `stacked` | `grouped` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
| `stacked`: Parts of a whole over time. | `color` | Color | number 1 to 8 | `1` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `series` | Series | list of names | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `mode` | Shape | `bar`, `area` | `bar` |
|  | `normalize` | Show as 100% | `true`, `false` | `false` |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
| `pie`: Shares of a total. Seven or more slices draw as bars. | `donut` | Donut | `true`, `false` | `false` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `centerTotal` | Total in the center | `true`, `false` | `false` |
|  | `labels` | Slice labels | `legend`, `outside`, `inside`, `none` | `legend` |
|  | `topN` | Top N, rest as Other | number 1 to 50 | unset |
|  | `color` | Color | number 1 to 8 | `1` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `table`: Rows and columns of numbers. | `columns` | Columns | list of names | unset |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `density` | Density | `compact`, `comfortable` | `compact` |
|  | `bars` | Data bars | `true`, `false` | `false` |
|  | `deltaColor` | Color the change | `true`, `false` | `true` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `heatmap`: Intensity across two axes. | `color` | Color | number 1 to 8 | `1` |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
|  | `scale` | Color scale | `sequential`, `diverging` | `sequential` |
|  | `cellLabels` | Values in cells | `true`, `false` | `false` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
| `funnel`: Step by step conversion. | `compact` | Compact | `true`, `false` | `false` |
|  | `showConversion` | Conversion rates | `true`, `false` | `true` |
|  | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `layout` | Layout | `bars`, `flow`, `table` | `bars` |
|  | `markWorst` | Mark the biggest drop | `true`, `false` | `false` |
|  | `compare` | Lanes | `auto`, `lanes`, `off` | `auto` |
|  | `table` | Table | `true`, `false` | `false` |
| `pivot`: One dimension down, another across. | `rows` | Rows | text | unset |
|  | `cols` | Columns | text | unset |
|  | `where` | Only rows where | `{dim: [values]}` | unset |
| `text`: Markdown notes and headings. | `markdown` | Text | markdown | unset |
| `callout`: A highlighted note. | `tone` | Tone | `info`, `success`, `warning`, `danger` | `info` |
|  | `markdown` | Text | markdown | unset |
| `tabs`: Panels of blocks, one visible at a time. Tabs do not nest. | `tabs` | Tabs | `[{label, blocks: [...]}]` | unset |
| `filter`: Chips that filter the blocks bound to the same dataset. | `dim` | Dimension | text | unset |
| `html`: Your own markup in a sandbox, fed only the inputs it declares. | `html` | HTML | inline HTML | unset |
|  | `ref` | Library block | text | unset |
|  | `inputs` | Inputs | `{name: <binding>}` | unset |
| `insight`: The insight exactly as it renders on its own. | `page` | Page | one name (pick: app-pages) | unset |
|  | `nav` | Page tabs | `true`, `false` | `false` |
| `breakdown`: Chips per dimension that select one measured path for the funnel blocks in the card, and pin paths as compare lanes. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `dims` | Breakdowns | list of names (pick: dims) | unset |
|  | `counts` | User counts | `true`, `false` | `false` |
|  | `lanes` | Compare lanes | `true`, `false` | `true` |
|  | `picker` | Funnel picker | `true`, `false` | `false` |
|  | `locale` | Language | `en`, `tr` | `en` |
| `trend`: The selected path's metrics day by day. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `metrics` | Metrics | list of names (pick: metrics) | unset |
|  | `chart` | Chart | `line`, `bar` | `line` |
|  | `switch` | Metric switch | `true`, `false` | `true` |
|  | `legend` | Legend | `top`, `bottom`, `right`, `none` | `bottom` |
|  | `axes` | Axes | `both`, `x`, `y`, `none` | `both` |
|  | `grid` | Gridlines | `true`, `false` | `true` |
|  | `format` | Format | `auto`, `number`, `compact`, `percent`, `currency` | `auto` |
|  | `table` | Table | `true`, `false` | `false` |
| `benchmark`: Each metric against its floor and target on one ruler. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `metrics` | Metrics | list of names (pick: metrics) | unset |
|  | `comparePrev` | Compare with previous period | `true`, `false` | `true` |
|  | `sources` | Band sources | `true`, `false` | `true` |
| `segments`: One row per value of a dimension, under the current selection. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `by` | Split by | one name (pick: dims) | unset |
|  | `metrics` | Metrics | list of names (pick: metrics) | unset |
|  | `bands` | Band colors | `true`, `false` | `true` |
|  | `sort` | Sort by | `desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}` | unset |
|  | `limit` | Row limit | number 1 to 400 | unset |
|  | `density` | Density | `compact`, `comfortable` | `compact` |
| `ranking`: Each funnel's best breakdown on one metric. | `metrics` | Metrics | list of names (pick: metrics) | unset |
|  | `density` | Density | `compact`, `comfortable` | `compact` |
| `payment`: Payment attempts, decline rate and decline reasons for the selected path. | `funnel` | Funnel | one name (pick: funnels) | unset |
|  | `density` | Density | `compact`, `comfortable` | `compact` |
| `access`: Whether payers reached the product, stage by stage. Hidden when there is no data. | `density` | Density | `compact`, `comfortable` | `compact` |
<!-- block-catalog:end -->

How the chart options read. `format`: `auto` groups digits below 10,000 and turns compact above (12.4K), `percent` expects a fraction (0.25 shows 25%), `currency` uses the unit when it is a 3-letter code. `color` is the first palette slot (1 to 8); colours follow the entity, never its rank, so a filter, a legend toggle or a series pick never repaints a survivor, and a 9th series or an Other bucket is grey. `topN` keeps the N largest and folds the rest into one Other row (grey, always last); `normalize` shows each x as 100%; `sort`, `topN` and `normalize` change the VALUES, so `lab board show` prints them too. `legend` places the series legend (a single series never gets one); clicking a legend item hides that series. `axes` and `grid` only change chrome. A pie with 7 or more slices kept draws as bars. `filter` narrows every sibling block bound to the same dataset, client-side, with zero sync requests; `tabs` never nest; `text` and `callout` markdown is sanitized with remote images stripped; `insight` is the whole insight exactly as its render draws it (the migration path; html/v1 and app/v1 bodies keep the `lk-` kit there).

Static options run in ONE fixed order, `where` → interactive filter → `sort` → `limit`, and a table's total is computed after filtering and before the limit, so a filtered board never shows the total of a pre-cut list. `lab board show` and the dashboard run the same code and print the same values.

**Opening a legacy vault writes nothing.** With no `lab/boards/` the boards are DERIVED: one per manifest `category` (uncategorized → "Other"), in the saved tab order from `state/.lab-prefs.json` (prefs that only ever lived in one browser's storage are invisible to the server, so cards then fall back to manifest order), each `group` a full-width heading, legacy width/height mapped onto the grid. The **first edit** (UI or CLI) materializes ALL boards at once, atomically, into `lab/boards/`; after that an insight on no board is **unplaced** (the Add card menu lists it first). `lab create` places a new insight on the board titled like its `--category`, else the first board (`--board <slug>` picks one, `--no-board` opts out).

**Editing.** In the dashboard, Edit mode drags and resizes cards on the grid (below 720 px the board is one read-only column), the card menu edits blocks in the **inspector** (type, data, options, all generated from the catalog; ⌘Z undoes), and **Add card** offers an insight, a catalog block, or custom HTML. Saves are rev-checked: a board changed elsewhere (a teammate, an agent, a sync) reloads with a notice instead of being overwritten, and a failed save keeps the edit pending with a Retry. Agents edit the same files through the CLI (`lab board create|add-card|set|validate|remove-card|delete`), which validates strictly: every problem names the card id, the block path and the fix.

**Custom HTML blocks and the vault library.** An `html` block runs its markup in the same network-less sandbox Chat uses (no network, no same-origin, `default-src 'none'`) with the full **`dc-` kit** (the Chat kit's classes, tabs and diagrams), fills its grid cell (a tall body scrolls inside it) and repaints on theme change. It gets data ONLY through the inputs it declares: `inputs: {revenue: mrr-by-plan/plans}` makes `lab.data('revenue')` resolve to that input's frame (`lab.inputs` lists the declared names); any other name is refused. Save a block to the vault library with the inspector's "Save to library" or `dreamcontext lab block save <slug> --file block.html --inputs revenue:table`; it lands in `lab/blocks/<slug>.md` (frontmatter `title`, `description`, `inputs: [{name, kind}]`, body = the HTML) and any card reuses it with `- html: {ref: <slug>, inputs: {revenue: <binding>}}`.

**Trust statement (what an HTML block can and cannot see).** Caches already sync with the brain, so a declared input exposes nothing a teammate does not already have. The allow-list separates a library body's author from the card's author: the body can only read the names the card binds. Local-only material (credentials, `state/.secrets*`, anything outside `lab/cache/`) never reaches a frame: every read goes through the hardened cache reader, so a symlinked cache, a `../` or a `%2F` in a binding yields no data. HTML blocks carry no script-hash tripwire (they render the moment a board opens), which is exactly why they only ever get declared, already-synced data. App shortcuts do not reach into a focused HTML block (no shortcut bridge; click outside first).

**Brain sync.** Board files merge semantically (`lab-board` class): cards union by `id`, a card changed on both sides keeps ours, a card deleted on one side and changed on the other is kept and reported, overlaps are resolved on the grid. A board file left with conflict markers opens as an error board (read-only, "Open file") until fixed. Library blocks (`lab/blocks/*.md`) merge as prose. Per-machine state stays local: `state/.lab-prefs.json` (active board, legacy tab order, funnel columns) and `state/.lab-freshness.json` are never synced.

### Funnel explorer (a snapshot-fed insight drawn as one interactive card)

A funnel explorer is ONE insight whose pages are board blocks over one synced `funnel-set/v1`. The ready-made form is one 12x18 card with a funnel picker and tabs: **Daily, Benchmark, Ranking, Flow, Steps, Compare, Payment, Access**, then one table per axis (Platform, Country, Language, ...), then **Table** (every funnel as one row: the comparison table with column choice, search and Copy MD; a row click picks that funnel; a funnel block's `layout: table`). Every page reads the same synced payload, so a chip click, a funnel pick or a pinned lane changes every tab at once and sends zero sync requests. Pick-type options (`funnel`, `dims`, `metrics`, `by`, `page`) take names from the synced data; a name that is not in the data renders a visible note, never a silent fallback.

The insight's detail page (`/lab/<slug>`, and `/lab/<slug>/f/<funnelId>` with that funnel picked) draws the same card full page, from the same preset blocks (`GET /api/lab/explorer/:slug`), in the insight's `locale`, and keeps its view in the same `v.<cardId>` URL param as the board, so a link moves between the two. It has **no range control**: the window is the snapshot's, named in the card header. A `render: funnel` insight without the preset keeps the comparison table page and its range control.

**Where the numbers come from.** The data never comes from the network inside dreamcontext. The agent pulls it through the KB MCP (`kb_charts` → `kb_chart_schema` → `kb_chart_query`), writes ONE snapshot file `lab/data/<slug>.json` shaped `{source, data}`, and the insight's script only reads that file: no fetch, no key, no `lab credentials`. `source` carries what was asked (charts, applied filters, freshness, `pulled_at`); `data` is the `funnel-set/v1` below.

**Agent flow, end to end:**

```bash
dreamcontext lab create acme-storefront-funnels --preset funnel-explorer --title "Acme storefront funnels" --category "Acme Funnel" [--locale tr]
# pull the queries below through the KB MCP, build the snapshot file, then:
dreamcontext lab data check acme-storefront-funnels --file /tmp/acme-snapshot.json   # validate, writes nothing
dreamcontext lab data write acme-storefront-funnels --file /tmp/acme-snapshot.json   # validate again, replace atomically, hard-sync
dreamcontext lab board show acme-funnel --select "country=TR" [--funnel <id>]        # the numbers the card draws
```

- `--preset funnel-explorer` makes a `render: funnel`, `adapter: script` insight with `preset: funnel-explorer` in the manifest, NO `range` tweak (the window comes from the snapshot, never from a range control), a Meaning skeleton (Source and filters, Window, Steps, Reading traps, Refresh) and `lab/scripts/<slug>.mjs` that reads only the snapshot. It never writes `lab/data/<slug>.json`. `--render <other>` or `--adapter http` with it is refused.
- `--locale en|tr` writes `locale` into the manifest. The explorer card speaks that language whatever the dashboard's own language is: the picker `breakdown` carries `options.locale`, the card renders inside its own language scope, and the tab labels and every explorer string follow it. `lab board add-card --preset` defaults to the manifest locale.
- Before the snapshot exists, a sync fails loudly ("No snapshot yet at lab/data/<slug>.json ...") and keeps the prior cache.
- **Placement.** On a vault whose boards are still derived from categories, a preset insight derives as a 12x18 explorer card on its category board (its axis tabs come from the cached dims, so they appear after the first sync). On a materialized vault `lab create` places nothing and prints the `lab board add-card <board> --insight <slug> --preset funnel-explorer` command to run after the first sync.
- Fill the Meaning: charts and filters, the window and the previous window, which steps are derived, and the reading traps (the same lines go into the snapshot's `notes`).

**The snapshot gate.** `lab data write` is the ONLY write path. It validates first and leaves the file byte-identical (or absent) when it refuses; on success it replaces the file atomically and runs a hard sync. `lab data check` runs the same validation without writing and prints the summary (funnels, axes with value counts, paths and intersections, daily coverage, payment and access presence, ladder stages, window, `pulled_at`, stored bytes against the 400,000-byte cap, every parse notice). A snapshot is refused when:

- `source.pulled_at` is missing or not a time;
- no applied filters are recorded (`source.applied_filters`, or `source.queries[].applied_filters`);
- no filter is an explicit date window (`op: "between"` with two `YYYY-MM-DD` days);
- `data.window` matches no query's date filter;
- `data` fails its parser, or (for a funnel explorer) is not a funnel set (a `dataset/v1` bundle with a `funnel` member also passes);
- the file is over 2,000,000 bytes.

A missing product filter is a notice, not a refusal. Aim for zero byte-cap notices: a stored set over 400 KB loses segment daily, then funnel daily, then segments (largest funnel first), so budget the snapshot below the cap instead of letting the trim choose.

**Contract (`funnel-set/v1`, every field below optional; old payloads parse unchanged).** The base contract is § Funnel insights. The explorer adds:

| field | where | what it carries |
|---|---|---|
| `window: {from, to, prev_from?, prev_to?}` | set | The window the numbers describe (shown in the header). With a window the cached range is the window, and Δ uses only the payload's own `prev` (never an older sync of the same window). |
| `provenance: {source, pulled_at?, freshness?, filters?[]}` | set | The header's source line; the template script derives it from `source` when absent. |
| `notes: [{text, code?, level?: trap\|info, keys?[]}]` | set, funnel | Reading traps, one line each (8 per level, 200 chars). `keys` (step, metric or `dim:<key>`) put a marker on those cells. |
| `hints: {<part>: "how to fill it"}` | set | Shown in that part's empty state. Part keys: `daily`, `weekly`, `segments`, `intersections`, `payment`, `access`, `dim:<key>`, `metric:<key>`. |
| `unmeasured: {<part>: "why this funnel lacks it"}` | funnel | Replaces the generic "not measured" text for that funnel. |
| `steps[].basis: measured\|derived`, `steps[].measured`, `steps[].reason` | funnel | A derived count (rate × first-step users) is labelled; an unmeasured step reads "not measured: reason", never 0, and drop math skips it. |
| `rates: {<metric>: {num, den}}` | set | Two step keys per rate metric: with a denominator under 100 the page shows `k/n` instead of a rate. |
| `intersections: [{dims[], min_users?}]` | set | Which axis combinations were pulled and at what floor: a missing path then says "not pulled" or "under N users, or not pulled". |
| `ladder: {stages: [{metric, book_floor?, book_target?, book_source?}], min_weeks?, min_week_users?, max_weeks?}` | set | Benchmark inputs (below). |
| `weekly: [{t, users, m}]` | set, funnel | Full weeks before the window: the "own" history. INPUT ONLY: consumed at sync, never stored. |
| `benchmarks` | funnel | Per-funnel bands (the ladder writes them; an explicit one wins with a notice). |
| `payment: {cells: [{dims, cohort?: first\|renewal\|all, attempts, declines, reasons?}], measured?, reason?}` | set, funnel | Attempts and declines per cell; `dims: {}` is the total. The set-level one stands for every funnel. |
| `payment_reasons: [{key, label, note?}]` | set | Labels for the reason keys. |
| `access: {stages: [{key, label}], rows: [{funnel?, dims?, counts}], as_of?}` | set | Did payers reach the product, stage by stage (`stages[0]` is the base). |

Kept from before: `segment_mode` (`cells`, the default, sums disjoint cells and carries no rates; `lookup` makes each segment its own measured path for an exact selection, one axis or an intersection, looked up and never summed), per-segment `measured`/`reason`/`metrics`/`benchmarks`/`daily`, per-metric `measured`/`reason`, per-benchmark `floor_source`/`target_source`/`better`. Caps: notes 8 × 200 chars, hints 24, filters 8, intersections 16, rates 32, ladder stages 16, weeks 52 per level, payment cells 64 and reasons 12, access 8 stages and 64 rows; every cap is a notice.

**The benchmark band (hybrid ladder).** For each ladder stage the engine computes `floor = max(book, own p25)` and `target = max(book, own p75)`. "Own" percentiles come from the level's own `weekly`: weeks before `window.from` with at least `min_week_users` (300) users and a value, the last `max_weeks` (12), at least `min_weeks` (4) of them; linear interpolation, 4 decimals. Each bound records which source won (`book` or `own`) and the week count, and the page says so ("floor: book · target: own p75 · 8 weeks"). A funnel without enough own weeks inherits the set's band, and the row says "band from the total"; a path inherits its funnel's band, then the set's. The ladder is higher-is-better only: a lower-is-better metric uses an explicit `benchmarks` entry with `better: lower`. With a ladder and no `metrics` option, the Benchmark page rows are the ladder stages in ladder order (CLI and dashboard alike).

**Pages.** The preset card is a `breakdown` block (`picker: true`, `counts: true`, `locale`) above a `tabs` block:

| tab | block | what it draws |
|---|---|---|
| header | `breakdown` with `picker` | in a board cell: one row with the funnel picker, the window and the source line, ONE strip of headline figures, and only the current funnel's own traps (at most 2) with everything else behind a "Reading traps (N)" disclosure; fullscreen shows the full header (equal-height headline cards, all notes in order funnel traps, then set traps, then info, the first 4 visible, the rest behind "+N"); then the chips and the compare lanes |
| Daily | `trend` (`chart: bar`, `table: true`) | the selected path's metrics day by day, with a day table |
| Benchmark | `benchmark` | floor, current and target on one ruler, Δ vs the previous window, which source won each bound |
| Ranking | `ranking` | each funnel's best breakdown on one metric, a 30/100/300 user floor, duplicates (an intersection that is its one-axis parent) removed, funnels without a path listed; a row opens that funnel and path |
| Flow | `funnel` (`layout: flow`, `compare: off`) | the path as a flow; runs over 16 steps collapse |
| Steps | `funnel` (`table: true`, `markWorst`) | step table: users, share of the first and the previous step (or k/n), drop, the worst drop marked, derived and unmeasured marks |
| Compare | `funnel` (`compare: lanes`) | up to 4 pinned breakdowns side by side on one step spine, each with its own rates |
| Payment | `payment` | decline rate (k/n under 100 attempts), reason shares with an "other" residual, cohorts one at a time, a per-axis table; the total row is the `{}` cell only |
| Access | `access` | share of the base per stage; the tab is HIDDEN when the set carries no access data |
| one per axis | `segments` with `by: <dim>` | one row per value under the selection on the other axes, a tone dot per band (never a tinted cell), k/n cells, faded low-sample rows |

**Reading it.** The explorer card draws its own source line (where and when the numbers were pulled, and how old the data was), so it hides the card's usual freshness subtitle. Every number follows ONE formatter in the card's language: Turkish writes `%21,8` and `1.234`, English `21.8%` and `1,234`; a change in a rate is shown in points (`puan` in Turkish, `pp` in English), never as a percent of a percent; a money figure of 0 means no spend was attributed and reads as a dash, never `$0`. The tab labels follow the card's language (the Benchmark tab is "Benchmark" in both languages).

Lanes are selections, so switching the funnel re-applies them to the new funnel. The funnel pick, the selection, the lanes and the open tab live in the URL (`v.<cardId>`), so a copied link, a reload and a reload in fullscreen (`?card=<id>`) restore the same view. They are not re-applied on browser Back/Forward, so closing fullscreen goes Back without undoing what you changed inside it. A card without a funnel picker behaves as before: one-funnel blocks draw their `funnel` option, else the first funnel.

**Honesty rules (all on screen, CLI included).**

- Not measured is not zero: an unmeasured metric, step, path or payment reads "not measured: reason" and no 0 or 0% is drawn.
- Rows under `low_sample_threshold` users are faded.
- A rate whose denominator is under 100 shows `k/n` instead.
- Rates are never summed across cells (`cells` mode carries step users only; payment totals come only from the `{}` cell).
- Derived step counts are labelled.
- Every empty state names what is missing and how to fill it (the snapshot's `hints`): no daily series, daily for the funnel level only, no payment, a column no row carries, no ranking path over the floor, no pinned lane.
- An axis whose every chip is unmeasured collapses into one line with the reason.

**The KB recipe: which query fills which field.** Always send the product filter AND an explicit `between` date filter on every query; read values by `columns[].key` (a requested name may come back prefixed, e.g. `total_spend_usd` → `sum_total_spend_usd`); never write 0 for a missing value (omit it, or mark it `measured: false` with a reason); save each response to a file by piping, not by hand-copying; copy each response's header (applied filters, freshness) into `source.queries[]`. Field names are what the chart schema says: confirm them with `kb_chart_schema` before the first query.

| contract field | chart | dims | notes |
|---|---|---|---|
| `metrics` + `prev` | Funnel Analysis | `funnel_id_calc` | once for the window, once for the previous window |
| `steps` | Funnel Analysis | same rows | count metrics are counted steps; a rate × users is `basis: derived` (Funnel Steps gives event-level counts when needed) |
| one-axis paths | Funnel Analysis | `funnel_id_calc` + `country_name`, `language_upper` or `campaign_source` | `campaign_source` is the platform; keep its null as a named value (e.g. "Atfedilmemiş"), never drop it; repeat for the previous window for Δ |
| intersections | Funnel Analysis | `funnel_id_calc, campaign_source, country_name` / `..., language_upper` | keep rows with at least 300 users, at most 14 per funnel; declare them in `intersections` |
| `daily` | Funnel Analysis | `event_date_parsed, funnel_id_calc` | granularity `day`, the window |
| `weekly` + `ladder` | Funnel Analysis | `event_date_parsed` (set) and `event_date_parsed, funnel_id_calc` | granularity `week`, the 12 full weeks before the window |
| `payment` | Acceptance Report | `funnel_id` (+ `country`, ISO-2) | attempts = `total_transaction_attempt_count`; declines = the same with `failure_message is_not_null`; one reason = `failure_message contains "<text>"`; `is_renewal` works only as a filter, so renewal attempts = `total_transaction_attempt_count` − `d0_transaction_count` |
| `access` | the product's own source | | not a NeonBI chart |

A metric that returns the same value for two different windows ignores the date filter: leave it out.

**Refresh.** `lab sync` alone brings no new data (the script reads a file). Refresh = pull the queries again → build the snapshot → `lab data check` → `lab data write`. A scheduled refresh is an automation (`dreamcontext automations create`) whose prompt follows this contract:

1. Record the current `pulled_at` (`dreamcontext lab data check <slug> --json`).
2. If `kb_chart_query` is not among your tools, make the FIRST line of your final message `RUN FAILED: KB tools missing (kb_chart_query)` and write nothing.
3. Pull every query with the product and `between` date filters, build the snapshot, write it only with `dreamcontext lab data write <slug> --file <path>` (never edit `lab/data/<slug>.json` by hand). A refused write: `RUN FAILED: snapshot refused: <first problem>`.
4. End with `dreamcontext lab data check <slug>`; if `pulled_at` did not advance, `RUN FAILED: snapshot not refreshed`.

The runner marks a run whose final message carries a `RUN FAILED: <why>` line among its first five lines as **failed** with that reason, publishes nothing and notifies like any failed run. "Never touch the snapshot" is guaranteed by `lab data write` validating before it writes; "fail loudly" depends on the prompt following this contract, and step 4 catches a run that silently did nothing.

**Gates before you call it done:** `lab data check` shows no problem and no byte-cap notice; `lab board show <board> --select "<dim>=<value>" [--funnel <id>]` prints the numbers you expect from the snapshot (the same numbers the card draws); the Meaning names the source, window and traps.

**Building your own layout.** Every page is a catalog block (table above), so a board can hold one card per page instead of the preset: `lab board add-card <board> --block '{"ranking": {"data": "<slug>"}}'`. The explorer blocks share a card's selection: a chip click narrows every funnel-frame block in the same card (tabs included) and filters same-insight tables by the dims they carry ("Not split by X" when they lack one). Cards do not share a selection.

**CLI parity.** `dreamcontext lab board show <board> --select "platform=Web,language=EN" [--funnel <id>] [--json]` adds an `explorer` field to every explorer block (breakdown, trend, benchmark, ranking, segments, payment, access, and a funnel block in explorer mode), computed by the same functions the dashboard blocks call: header (window, source, notes in on-screen order), series, benchmark rows with band sources, ranking rows, step drops with derived and not-measured marks and the worst drop, payment rows and reasons, access or `hidden (no data)`, segment rows with k/n.

**A v1 app insight on a board.** The `insight` block takes `page` (pin any app page) and `nav: true` (page pills in the card; a pill click and an in-frame `lab.navigate` both switch pages with a fresh frame). `nav: false` keeps the plain card preview. `app/v1` explorers keep working unchanged.

**Migrating a hand-built v1 app explorer.** A hand-built `app/v1` funnel explorer has no funnel member, so `--preset funnel-explorer` refuses it ("an app insight with no funnel data"). Migrate in steps, never by hand-writing a card, and keep the old pages until the owner compared:

1. Map its payload onto the contract: per-funnel rows → `funnels[].metrics` and `steps` (derived counts → `basis: derived`); per-axis step tables → one-axis `segments` (`segment_mode: lookup`); axis combinations → intersection segments plus `intersections`; band history → `weekly` plus `ladder.stages` with the book values; day cuts → `daily`; decline cells and reasons → `payment` plus `payment_reasons`; access counts → `access`; long notes → one-line `notes`. Ranking and cross-axis tables need no field: the engine computes them.
2. Return that set as `data.funnel` next to the existing datasets (the app pages keep working), `lab sync`, then `lab board add-card <board> --preset funnel-explorer --insight <slug>` and compare with `lab board show --select`.
3. If the script calls an analytics API with a token, move to the snapshot flow: the agent pulls through the KB MCP, `lab data write` stores it, and the script becomes the template reader (`lab create --preset funnel-explorer` in a scratch vault shows it). Add `preset: funnel-explorer` (and `locale`) to the manifest.
4. Drop `app` from the script and the old card only after the owner approves.

**Synthetic names only.** Fixtures, presets, docs and screenshots use a fictional vocabulary (e.g. "Acme Storefront", "Quiz checkout (v2)", "Activation ladder"), never a registered vault or real product name.

### Insight capture (in-session — ASK, never auto-create)

Mirrors proactive objective capture. When the user states or implies a recurring metric need ("I keep checking MRR by hand", "we should watch signups", "create an insight for DAU"):

1. **Dedup first.** `dreamcontext memory recall "<metric>" --types insight` and `dreamcontext lab list`. If one covers it, offer to update/re-sync it instead.
2. **Offer it.** *"Want me to track this as a Lab insight so every session sees the current value?"* Never create without a yes.
3. **Agree the shape.** Slug, title, render (the table above), the board it lands on (`--board <slug>`, or `--category` to land on the board with that title), unit — and write a real `## Meaning` section (it powers recall).
4. **Pick the source.** HTTP endpoint (+ extract path) or a custom script. Secrets go in via `dreamcontext lab credentials set <key>` — never inline in the manifest.
5. **Declare tweaks** the user will want to adjust (typed `enum`/`date`/`string`). Declare `range` only to CURATE its presets — the window keys work without a declaration (see well-known tweaks above).
6. **Scaffold + first sync.** `lab create`, edit the manifest, `lab sync <slug>`, confirm the value looks right.
7. **Offer KR binding** if an existing roadmap objective tracks the same outcome: `dreamcontext lab bind <insight> <objective>` — connecting seeds the objective's `metric.current` from the cached latest immediately, and every future sync keeps it measured. One feeder per objective (binding a new insight unbinds the previous one loudly); disconnect with `lab bind <insight> --clear`.

Every write waits for a yes.

**Security (plain language, tell the user when relevant):** lab scripts execute **locally, in a short-lived child process, with your credentials passed in over stdin** — anyone who can push to a shared brain repo can change what runs on your machine at the next sync. The child process is an isolation boundary (a hung or crashing script cannot take the host down, and every run re-reads the whole import graph so an edited shared lib is never stale), NOT a sandbox — the script still has your filesystem and network access. Review a script before its first sync and heed the loud "script changed since last run" tripwire notice. Credentials are written ONLY via `lab credentials set` (gitignore-first, file mode 0600, never printed back, redacted from every error/log).

---

## The Workflow flowchart (keep it in sync)

Every task file has a `## Workflow` mermaid block near the top: one node per acceptance criterion, grouped under milestone subgraphs, with status classes `done` / `active` / `todo` / `blocked`. It is the load-bearing summary of the task — drift makes future sessions misread progress.

**Whenever** you check off a criterion, start one, add/remove one, or hit a blocker → update that node's `:::class`. Then verify:
```bash
dreamcontext tasks doctor <name>     # checks flowchart ⇄ acceptance-criteria sync (all tasks if omitted)
```
And tick the matching criterion immediately with its evidence (`dreamcontext tasks check <name> <n> --run "<cmd>"`) — don't wait for sleep.

---

## Task file schema (reference)
```yaml
---
id: "task_abc123"
name: "Implement auth middleware"
description: "Add JWT validation to protected routes"
status: "todo"            # todo | in_progress | in_review | completed — or any key declared in overrides/task.md
created_at: "2026-02-25"
updated_at: "2026-02-25"
tags: []                  # includes person:<slug> for assignees
cycle: "cy_Ab3x9Qzk"       # the cycle it is planned into (or null); `queue: next|later` when in none
rank: 20                  # order inside its cycle / queue (tasks rank)
parent_task: null
related_feature: null     # feature slug for cross-link
product: null             # multi-product scoping (optional)
start_date: null          # YYYY-MM-DD or null — planned start (range start)
due_date: null            # YYYY-MM-DD or null — due / planned end (range end)
objectives: []            # roadmap objective slugs this task serves (many-to-many, LOCAL-ONLY — never synced)
rice: { reach: 5, impact: 3, confidence: 75, effort: 2, score: 5.625 }
custom_fields: {}         # project-declared fields (only when overrides/task.md exists)
---
```
Files live at `_dream_context/state/<slug>.md`. Lookup is fuzzy: exact slug → prefix → substring.

---

## Task format, custom-field & status overrides (optional)

A project can override the default task shape, declare its own custom fields AND declare its own task statuses by adding **`_dream_context/overrides/task.md`**. Absent this file, everything behaves exactly as the defaults above (zero regression).

The file carries three things:

- **Frontmatter `statuses:`** — extra task statuses, each living **under one of the shipped four**. Each entry: `name` (label), `key` (stable frontmatter value — ALWAYS write it explicitly; defaults to the snake_cased name), `kind` (`open | active | review | cancelled` — `done` is reserved for `completed`, exactly one done-kind status ever), `parent` (which of `todo`/`in_progress`/`in_review`/`completed` it rides under; defaults from the kind — `cancelled` → `completed`), `order` (pipeline position; the shipped four sit at 0 / 10 / 20 / 30, so `5` slots between `todo` and `in_progress`), optional `color` (6-hex — the GitHub label colour and the dashboard swatch) and optional `clickup` (list-status name aliases). The **kind drives everything**: `active` stamps the start date and counts as "being worked"; `review` triggers the required-field gate; `cancelled` is terminal — hidden by default, never overdue / at-risk / on the board, out of roadmap progress on both sides, and never the task a bookmark hint offers. The shipped four can be relabelled / reordered / recoloured but never removed or re-kinded. Every invalid entry (bad kind, non-hex colour, duplicate or reserved key, a collision with a custom-field key, a second done-kind) is dropped with a warning `doctor` shows — never fatal.
  - **THE PARENT IS THE WIRE.** A cloud backend only ever sees the parent — one of the four it already understands — so **a declared status needs nothing created on the provider**. The child's identity rides beside it as a `dc:<key>` marker and round-trips.
  - **GitHub**: the parent gives the open/closed state (parent `completed` → closed + `state_reason: completed`), and the `dc:<key>` label is auto-provisioned in the declared colour. `not_planned` stays EXCLUSIVELY the soft-delete signal (see integrations.md). A status key the local set does not know never reopens or closes an issue and never strips another machine's label.
  - **ClickUp**: the API cannot create list statuses, and it never has to. A declared status tries its own names first (so a list that really carries "Cancelled" gets the honest value — declare a `clickup:` alias when the list spells it differently), then falls back to the parent's status, with the `dc:<key>` **tag** carrying the child. On pull the tag wins only while it still agrees with the list status, so **a human moving the task in ClickUp always beats a stale tag**. `doctor` reports which declared statuses ride as a tag and flags any list status whose meaning your declaration changes.
  - The set travels with the brain by **git only**; a teammate who has not pulled the override sees the status downgraded (closed → `completed`, open → `todo`), never deleted, with a warning in the sync report — it self-corrects on their next pull.

- **Frontmatter `custom_fields:`** — a user-defined field schema. Each field: `name`, `type` (`text` | `number` | `select` | `date`), optional `key` (the stable field id / `custom_fields:` map key — defaults to the snake_cased `name`, so a rename keeps the same id), `required` (`true` ⇒ the agent MUST set it on every task; default optional), `ask` (`true` ⇒ the field is a HUMAN judgment the agent must NOT guess — it asks you for the value at task-creation time; default false), `options` (for `select`), `sync` (`[clickup, github]`, default both), and optional `prompt` (a system instruction telling the agent HOW to fill the field — surfaced in your snapshot + every sub-agent briefing).
- **Body** — the task TEMPLATE the CLI scaffolds from, plus an optional `## Agent Instructions` section that sub-agents read at runtime (it is stripped from scaffolded tasks).

```markdown
---
statuses:
  - { name: Planned, key: planned, kind: open, order: 5, color: c5def5 }
  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99, color: cfd3d7, clickup: [cancelled, canceled, "won't do"] }
custom_fields:
  - { name: "Team", type: select, required: true, options: [platform, growth, infra], sync: [clickup, github], prompt: "The squad that owns the touched files." }
  - { name: "Story Points", key: story_points, type: number, sync: [clickup, github] }
  - { name: "Time estimate", key: time_estimate, type: text, required: true, ask: true, prompt: "How long will this take? Answer in ClickUp shorthand, e.g. 45m, 2h 30m, 1w 2d." }
  - { name: "Sprint", type: text }
---
## Why
{{WHY}}

## Acceptance Criteria
- [ ] First criterion

## Agent Instructions
Set Team to the owning squad before starting work.
```

When an override is active its briefing (the field list, each field's `required` + `ask` flags + `prompt`, and the Agent Instructions) is injected into your SessionStart snapshot and into every sub-agent. **Each active task's custom-field VALUES are also surfaced inline** — in the snapshot's Active Tasks block and in `dreamcontext tasks list --long` — with any unset **required** field flagged `⚠ UNSET (required)`. So you always see a task's fields without opening it: follow `overrides/task.md`'s layout and **set every declared custom field** when you create or reconcile a task — REQUIRED fields are mandatory, so never create or complete a task with a required field left empty. As a hard backstop, `dreamcontext tasks create` / `complete` / `status … completed|in_review` **fail (non-zero exit) and refuse the action** when a required field is unset — naming the field plus the exact fix command. Pass `--allow-missing-required` (or set `DREAMCONTEXT_ALLOW_MISSING_REQUIRED=1`) only for an intentional draft, which downgrades the failure to a warning.

**`ask: true` fields — don't fabricate, ask.** Some fields capture a judgment only the user can make (a time estimate, a business-impact call). A field marked `ask` is flagged **[ASK THE USER]** in the briefing: when you create a task on the user's request, **ask the user for that value first** — one concise question per field, using the field's `prompt` as the framing (the `AskUserQuestion` tool if you have it, else just ask in chat) — and wait for the answer **before** creating the task. Never invent the value to satisfy a `required` gate. The one exception is a no-user context (an autonomous reconcile or a sleep cycle): there, leave the field unset and note it rather than guessing.

**Setting values:** `dreamcontext tasks create … --field team=platform --field story_points=8`, or on an existing task `dreamcontext tasks field <slug> team platform` (`clear`/omit value to clear). Values are validated against the schema (select options, number coercion) and stored under a `custom_fields:` map in the task frontmatter.

**Sync — values flow to both backends, reusing remote fields that already exist:**

| Field type | ClickUp | GitHub |
|---|---|---|
| `select` | native list custom field (drop_down) | `<key>:<value>` **label** |
| `text` / `number` / `date` | native list custom field | `<!-- dc:fields -->` **body block** in the issue |

`dreamcontext tasks provision` creates any missing custom fields/labels on the remote and **reuses (never duplicates) ones that already exist by name**. `dreamcontext doctor` validates the override and warns (never silently ignores) on a malformed one.

---

## Features (PRDs)

Features are **typed knowledge** — a feature PRD is a `knowledge/features/<name>.md` file with
frontmatter `type: feature` (plus `name`/`description`/`pinned:false`/`date` for knowledge-index
display). Retrospective product documentation, **created and updated exclusively by the sleep
agent**. During active work, everything goes in the task; sleep consolidates task content into
the matching feature. `dreamcontext features …` is a **deprecated compat alias** (prints a
deprecation notice on every call) that reads/writes `knowledge/features/` — it is not a separate
entity from knowledge.

```bash
dreamcontext features create <name> -w "Why" -d "One-line description" -t backend,api -s planning --related-tasks a,b
dreamcontext features set <name> status active
dreamcontext features set <name> tags backend,api,topic:recall
dreamcontext features insert <name> acceptance_criteria "..."   # auto-formats as - [ ]
dreamcontext features doctor                                    # staleness / orphans / dangling refs
```
Status values: `planning | in_progress | in_review | active | shipped | deprecated`. Sections: `changelog`, `notes`, `technical_details`, `constraints`, `user_stories`, `acceptance_criteria`, `why`. PRDs live in `knowledge/features/<name>.md` (flat directory under `knowledge/`; may carry `product:`); the generic knowledge index/recall channel excludes `knowledge/features/**` to avoid double-listing — features stay a distinct surface (snapshot Features section, dashboard Features tab, `--types feature` recall).

---

## Cycles, the queue, releases

Three separate things (older cards may still hold `priority`, `urgency`, `version`: read, never written by these paths).

- **Cycle** (`core/CYCLES.json`, git-tracked): a date range plus a one-sentence goal. Random stable id `cy_<nanoid8>`; the number you see is derived from start-date order and never stored or sent anywhere. One is active at a time. A team merge that leaves two active keeps the one that started first and says so (the CYCLES.json merge driver, and every read).
- **Queue**: `Now` = the active cycle, `Next`, `Later`. Importance is the `rank` inside a cycle or queue, not a priority.
- **Release** (`RELEASES.json`): an outcome, compiled from what closed since the previous release, with the cycles that work came from. Planning releases are no longer created.

```bash
dreamcontext cycle new --goal "Ship the card standard" [--weeks 2 | --end 2026-11-02]   # default: last cycle's length, else tasks.cycleDefaultWeeks (1)
dreamcontext cycle start <n>                   # refused while another is active
dreamcontext tasks plan <task> now|next|later|<n>   # a parent brings its open sub-tasks (journaled per child)
dreamcontext tasks rank <task> --before|--after <task>
dreamcontext cycle show [<n>]                  # goal, days left, done/total LEAVES, work grouped under parents
dreamcontext cycle close [<n>] --carry a,b --back c --cancel d   # or --all carry|back|cancel; interactive on a TTY
dreamcontext cycle list
dreamcontext core releases add --ver 1.4.0 --summary "..." -y
```

- **Leaves only.** Capacity and progress count tasks without children; a parent is counted through its children, and its own place is derived from them (a lone child in a cycle shows its parent as the header).
- **The close is a ritual.** Every unfinished leaf is carried into the next planned cycle, sent back to Next, or cancelled; nothing closes undecided. Each carry is recorded on the closed cycle, so a task's carry count is visible (`cycle show`: `carried 2×`). An empty cycle closes as 0/0.
- **On a remote.** GitHub carries the cycle as the label `cycle:cy_<id>`; GitHub labels and ClickUp's native priority carry the order: a task in any cycle (active or planned) → high, Next → normal, Later → low. Any cycle, not only the active one, on purpose: which cycle is active is read from each machine's own `core/CYCLES.json`, so a machine whose copy is behind must never send normal for a task that is in a cycle. Coming back it is lossy on purpose: urgent / critical / high → Now only if the task is already in the active cycle (else Next), normal → Next, low → Later. A remote cannot put a task into a cycle. A cycle id this machine does not have yet is kept on the card and shown as "cycle not yet synced" until `core/CYCLES.json` arrives; a push never drops it; `version:` labels are never removed. A card that only holds a legacy priority syncs as before.
- **Sleep never plans.** It files and reconciles tasks; putting work into a cycle is the owner's call.

---

## The dashboard's task screens

The same model, seen by the owner. Every task-authored string (a section, a criterion, a journal body, a proposal, a learned quote, an audit note) renders as plain text or through one sanitizing markdown renderer (`marked` + DOMPurify), so a payload pulled from a remote or written by an agent never runs. Every screen speaks English and Turkish.

- **The board** (Tasks) groups cards by **Now / Next / Later** by default, ordered by rank, with the active cycle in a strip above it (number, dates, goal, done/total leaves, days left, a link to Planning). One click regroups by status; version and assignee are in the Group menu. A finished card shows in Now only while it is in the active cycle; every other finished card waits in a **Done** lane that stays closed until opened, and a cancelled card is not on the board. A parent card shows `n/m` of its sub-tasks and opens them in place. A sub-task whose parent sits in another column shows under its parent's name. Dragging a card to another column plans it (`tasks plan`), and dropping it on a card of the same column ranks it (`tasks rank`). Right-click → **Move to Later** plans it into Later. **List** and **Timeline** show the same cards. On a phone it shows one column at a time. Saved views keep their own filter, sort and grouping. A view saved before 0.33.0 that named a retired layout opens on the Board. One grouped or sorted by priority or urgency opens on Now / Next / Later and rank. Its priority, urgency and RICE filters are dropped.
- **The task page** (a card click, ⌘K, the Brain map) shows:
  - the name as written, back to the board, status, and the place on the axis (Now / Next / Later or a cycle);
  - the parent path, and the door to an agent;
  - the criteria, each with what proves it (`cmd`, `commit`, `shot`, `owner`, `legacy`) and the observed tag (a tick there is the owner's `owner:` approval);
  - Why, Constraints & Decisions and the other sections, each collapsible;
  - the sub-tasks with `n/m`;
  - the journal, five entries at a time with "Show older";
  - the properties (dates, people, the agent, feature, roadmap, tags, custom fields).
  A card's old in-card `## Changelog` renders only when opened, and a diagram loads only when the card has one. While the task is in review, the header carries the verdict: **Approve**, or **Send back** with a required note (the same call as `tasks approve` / `tasks send-back <name> --note "…"`).
- **The Inbox** is what waits for the owner, and it carries the sidebar badge:
  - **Reviews**: approve or send back in place. A review with an unticked criterion says "evidence incomplete": it is listed, but not counted in the badge.
  - **Proposals and change cards**: sleep's proposals and the migration's uncertain changes, accept or reject as before.
  - **Held open**: parents a sync kept open, each with Seen.
  - **What sleep learned**: a rule from the owner's repeated corrections or a filing-rule change, with the quotes and their dates, and **Revert**.
  - **Records**: every owner override (approval, send-back, accept, apply, force, exemption) with who, through what (`cli`, `dashboard`, `phone`, `no-origin`) and when. A `no-origin` record sits on a warning tint: a write with no browser Origin is the shape a scripted call has.
- **Planning** lists the cycles (start a planned one; close the active one) and creates one (goal, start, weeks; the default is the project's). Its board puts the Next queue beside a cycle: drag or "Move to" plans, ↑ / ↓ ranks, and the capacity line compares the leaves planned with what the last three closed cycles finished.
- **The Close deck** (Close on the active cycle) is `cycle close` with buttons. Each unfinished leaf, grouped under its parent with its carry count, gets **Carry**, **Back to Next** or **Cancel**, and **Apply to the rest** fills the undecided ones. Close stays disabled until every leaf is decided, and a close that cancels anything asks once. An interrupted close resumes with what it recorded.
- **Releases** shows what is done but in no release yet, and the releases themselves. It is read-only; releases change through `dreamcontext core releases`.
- **"Give to an agent"** is the one door on the task surfaces: the task page's button, a card's context menu and the toolbar's "Write it with an agent". It reads the task by slug and offers four choices:
  - **Develop**: readiness first (`tasks ready`: gaps shown, Start disabled until ready), then the same Develop session the Plan chat hands over to;
  - **A named agent**: the Assign-to-agent composer;
  - **Custom prompt**: the Delegate composer with its four modes, carrying the task's Why and criteria;
  - **Write a new task**: the authoring composer.
  Develop, the custom prompt and authoring need the in-app agent (the desktop app, Agents on). The Plan chat's own Develop button is unchanged.
- **Retired in 0.33.0**: the Eisenhower matrix, the RICE scatter, Calendar and Activity heatmap views, the Versions popover, the task detail drawer, and the board's "Send to backlog". Priority, urgency, version and RICE stay readable on the card and in the CLI; the dashboard no longer edits them (decisions 3 and 10).

---

## Multi-product (monorepos)

`dreamcontext init` asks whether the project is a monorepo with multiple products and records the list in `state/.config.json` under `multiProduct: string[] | false`. When products are configured:

- **Per-product data structures**: `knowledge/data-structures/<product>.md` (single-product → `default.md`). Body format is a single ` ```sql ` fenced block with `-- ...` comments (the dashboard highlights it). Recall-indexed, owned by `sleep-product`.
- **Per-product knowledge**: `knowledge/products/<product>.md`. Cross-cutting knowledge stays at top-level `knowledge/`.
- **Tasks** may carry `product: <name>` in frontmatter; CLI/dashboard surface a product filter.
- **Feature PRDs** may carry `product: <name>` (still in the flat `knowledge/features/` directory).
- **Auto-injection**: the SessionStart hook resolves the active task (override `state/.active-task`, else most-recently-modified `in_progress` task). If its `product:` is in `multiProduct`, the hook injects `knowledge/products/<name>.md` into the snapshot under `## Active Product Knowledge: <name>` (capped ~200 lines). You don't load it manually — it's already in context.

If `multiProduct` is `false`/absent, treat the project as single-product and use `data-structures/default.md`.

## Detail behind the SKILL.md summaries

SKILL.md keeps one line per capability and one home per rule. This is the fuller text those lines summarize, kept here so nothing an agent needs is lost.

### Capability summaries: tasks, roadmap, Lab, people

- **Tasks**: a card plus its journal, evidence-gated status, RICE, status lifecycle, start/due date ranges, resolved assignees, and project-declared custom fields (`overrides/task.md`)
- **Roadmap / Objectives**: PO-authored OKR board: objectives in `core/objectives/`, many-to-many task links (`objectives:` frontmatter), dependency DAG with full forecast cascade, target vs forecast slip detection, `dreamcontext roadmap` (+ `--json`)
- **Lab / Insights**: Curated analytics **metrics** ("insights") synced from HTTP APIs or local scripts into the brain: manifests in `lab/insights/`, cached series every session, roadmap Key-Result binding (`lab bind` / the dashboard's objective dialogs — one feeder per objective, seeds `metric.current` on connect), dashboard Lab page. **Funnel analytics**: `--render funnel` + a `funnel-set/v1` payload gives a routed multi-page view — all-funnels comparison table + per-funnel step lane with drop badges, arc gesture, filters, breakdowns, compare (`/lab/<slug>`). **App insights (`--render app`)**: a script builds a multi-page, interactive, full-screen-capable body itself — `{ data, app }`, where `data` is a `dataset/v1` bundle and `app` declares an ordered list of sandboxed html pages wired to the host over a postMessage bridge (`lab.navigate`/`lab.data`/`lab.onRoute`) — no React component required. Routes to `/lab/<slug>` and `/lab/<slug>/p/<pageId>`, full screen via `?fs=1`. An agent reads a body it did not author with `lab body <slug> [--page]` and slices its numbers with `lab query <slug> [--where]`. `matrix/v1` (`--render breakdown`) is DEPRECATED for new insights — existing ones keep rendering, no migration forced. **An insight is NOT a knowledge file** — create with `dreamcontext lab create`, never `knowledge create`
- **People (constitutions + roster)**: One constitution file per person (`people/<slug>.md`), a structural roster (`people/people.json`), machine-local active-person resolution, `person:<slug>` tags → ClickUp/GitHub assignees

### Entity routing detail: insight, report, person

- **Insight** — `lab/insights/<slug>.md`. Triggers: "create an insight", "track MRR / WAU / signups", "add a metric", "I want to see X every session", "funnel analizi / funnel analysis", "which funnel is underperforming", "where does my funnel leak", "I want a multi-page dashboard for this metric", "make this insight interactive / full-screen", "let the script build its own UI, don't write me a component", **or the problem-shape:** "a chart/number that refreshes itself from Notion/Stripe/an API", "I don't want to ask you to re-fetch it every time", "same data, different views/date ranges", "a live funnel dashboard over GA4/BigQuery data", "a drill-down view with several screens over one metric". A curated analytics **metric backed by an external source** (HTTP API or script) — a number/series that re-syncs. Has a manifest, cache, TTL, adapters, tweaks, dashboard renders with a refresh button, optional KR binding (`lab bind <insight> <objective>`). **Funnel analysis is an insight too** — `--render funnel` + a `funnel-set/v1` payload gives the routed table + step-lane pages; never hand-build a funnel dashboard or a static board for live funnel data. **A multi-page/interactive request is an insight too** — `--render app` + `{ data, app }` gives a script author a routed, full-screen-capable, bridge-driven body with zero platform React work; never hand-write a component for what a script can build itself. Create with: `dreamcontext lab create <slug> --title "…"` (offer-and-confirm protocol → [tasks-and-features.md](references/tasks-and-features.md))
- **Report** — `lab/reports/<slug>.md`. Triggers: "günlük ürün raporu / daily product report", "a report I can walk back through by date", "put these insights on one page", **or the problem-shape:** "one composed view over metrics we already track, navigable by day". A **composed, date-navigable document over EXISTING insights** — it owns no data and never fetches; it reads insight caches + their dated snapshots ("as of" honesty, no interpolation). NOT a new insight (nothing to sync) and NOT knowledge (it renders live numbers). Needs the insights first — and a daily-navigable report needs a daily sync cadence (an **automation** is the scheduler; sleep never syncs lab). Create with: `dreamcontext lab report create <slug> --title "…" --insights a,b,c` (contract → [tasks-and-features.md](references/tasks-and-features.md) § Reports)
- **Person** — `people/<slug>.md` (constitution) + a row in `people/people.json` (roster). Triggers: "add a teammate", "who am I", "kim çalışıyor", "add me to the project", **or the problem-shape:** "the agent should know who is at the keyboard". A **human who works in this vault**. Their constitution (`## Identity` / `## Preferences` / `## Communication Style`) renders verbatim in the snapshot when they are the ACTIVE person on this machine; the roster row is structural (`name`, `emails`, optional `role`) and is what `person:<slug>` assignee tags resolve against. **Not knowledge, and not recall-indexed**. Create with: `dreamcontext people add "<Name>" --email <address>` (`--role <label>` optional); `dreamcontext people whoami [--set <slug>]` binds THIS machine
**The router governs READING too, not only creating.** *"What's our MRR?"*, *"kaç aktif öğretmen var?"*, *"how did revenue move last month?"* — a metric question routes to the insight that already measures it, before any external call: snapshot **Lab** section → `dreamcontext lab show <slug>` (full cached series, **no fetch**) → `dreamcontext lab list` / `memory recall "<phrase>" --types insight`; `lab sync <slug>` only when TTL-stale. Reaching for an MCP tool, an API request, or a one-off script while `lab/insights/` already holds that metric is the read-side twin of the creation mistake above — full ladder in Operational Rule 13.
**Don't rebuild what the brain already has.** Before proposing to scaffold ANY new app, script, page, or external service for the user's need, check whether a dreamcontext subsystem already covers it: a self-refreshing metric/chart → **Lab insight** (the dashboard's Lab page IS the refreshable view — adapters, tweaks, renders included); OKR/goal tracking → **roadmap objectives**; "remind me when…" → **triggers**; a recurring job that must run unattended on a schedule → **automations** (`automations create`, never an external cron/Zapier-style scheduler); kanban/board views → the **dashboard**. The second canonical mistake (a real past failure): the user described "a debt number that refreshes from Notion, with tweakable views" and the agent designed a brand-new Vercel dashboard — when `lab create` + a script adapter was the whole answer. Propose external builds only when no subsystem fits, and say why it doesn't.

### Rule 13 in full: insights before external fetch

13. **Insights before external fetch — the READ path, not just the create path.** When the user asks for a metric (MRR, WAU, signups, churn, revenue, conversion, "kaç aktif kullanıcı var?"), the answer comes from the brain FIRST, in this order: the snapshot's **Lab** section (latest value + staleness, zero tool calls) → `dreamcontext lab show <slug>` (**the full cached series — never fetches**; this is the call for a breakdown, a trend, or "how did it move last month?") → `dreamcontext lab list` / `memory recall "<phrase>" --types insight` when you don't know the slug. Only when the cache is TTL-stale: `dreamcontext lab sync <slug>`. **An MCP tool, a raw API request, or a hand-written script is the LAST resort** — and when you take it, say why the insight didn't cover it. **A `render: app` insight's script-authored body is readable too, not just its numbers** — `dreamcontext lab query <slug> [--dataset][--where k=v][--group-by][--top]` slices the cached `dataset/v1` numbers (never fetches), and `dreamcontext lab body <slug> [--page <id>] [--format text|md|html]` reads what a page actually renders — as text, as markdown, or as its raw html — so you can answer "what does this card show?" or review/debug a body you did not author, entirely from the terminal. A real past failure: asked for revenue, an agent reached for a billing MCP while `lab/insights/` already held the synced series; the project had to hand-write a memory note to stop it recurring. Fetching a metric that already has a manifest bypasses its cache, tweaks and KR binding, and returns a number the next session cannot reproduce. **The hook tells you when this applies** — a recall hit of type `insight` arrives with `→ ALREADY TRACKED as an insight` and the exact `lab show` call; that line is authoritative, and it fires on every prompt whether or not this skill body is loaded. (A federated peer's insight can't be read with `lab show` — open that vault's `lab/cache/<slug>.json`, as the directive says.)

### Rules 4 and 5 in full: single source of truth, and tasks

   - **Know feature vs knowledge.** A **feature** (`knowledge/features/<name>.md` — typed knowledge, `type: feature`; the `dreamcontext features` CLI is a deprecated compat alias) is product documentation — what a capability *is*, its user stories + acceptance criteria — updated only at sleep. **Knowledge** (`knowledge/…`) is other durable material: research, decisions, rationale, domain/technical context. In-progress work lives in a **task**, never in a feature or knowledge file.
   - **Never create a knowledge file for something that is a feature**, and never keep a knowledge copy of content that already lives in a feature (or vice-versa). If a topic is a feature, the feature is its home — knowledge may *reference* it, not duplicate it. Don't have both a feature and a knowledge doc covering the same thing.
   - **Never duplicate knowledge.** If two docs overlap, merge into one and point the other at it. Fragmented near-duplicate knowledge and duplicate tasks are the top failure modes — `sleep-product` dedupes, but don't create the mess.
5. **Work over ~5 minutes needs a task — but don't fork tasks.** If a piece of work will take more than ~5 minutes, it needs a task. FIRST check the auto-loaded snapshot (and `dreamcontext memory recall "<keywords>" --types task`) for one that already covers it: if found, **extend it** — broaden its scope, add an acceptance criterion or a sub-step — rather than creating a near-duplicate. Create a new task only for a genuinely separate concern. In a terminal session, after a plan is approved (ExitPlanMode), offer to save it as — or fold it into — a task; that is the terminal case. In Chat, planning is dreamcontext's Plan mode, which ends by creating the task. The sleep agent flags untracked work and merges duplicates.
   **When the user drops, cancels or says no to a piece of work that has NO task yet, record it:** `dreamcontext tasks decline "<topic>" --reason "<why not>"` — otherwise the next sleep cycle only sees that it was *discussed* and may file it as a task. Work that DID become a task is cancelled or deleted instead (that already leaves a tombstone). Details → [tasks-and-features.md](references/tasks-and-features.md).

### Naming, scaffolding, statuses, custom fields and objectives

**Naming: a task name is a short plain sentence saying what the task does** — "Fix the login redirect loop", "Dashboard renders the summary as a paragraph". Never a type-prefixed slug (`feat-x-y`, `fix-login-redirect`) — the slug is derived automatically from the name; you never write slug-style names yourself.

**`-w/--why` is mandatory** — creation fails without it. A new card has only `## Why` (history goes to its journal); every other section appears when you first `tasks insert` into it. Never insert placeholder content to "fill out" a task — a section with nothing to say shouldn't exist.

Status: `todo → in_progress → in_review → completed` by default. A project may **declare more** in `_dream_context/overrides/task.md` (`statuses:` frontmatter — e.g. `planned`, `cancelled`), each living **under one of the four** and carrying a semantic `kind` (`open | active | review | done | cancelled`) that drives every derived behaviour. A cloud backend only ever sees the PARENT (so nothing has to be created on GitHub/ClickUp); the child rides beside it as a `dc:<key>` marker. `dreamcontext tasks statuses` lists the set with its parent and remote mapping. When a **cancelled-kind** status exists, abandoned / superseded / obsoleted work goes THERE (it leaves progress counts, is never overdue, closes the GitHub issue) — not to `in_review "confirm close"`. Your SessionStart briefing names the declared keys. Sections: `why`, `user_stories`, `acceptance_criteria`, `workflow`, `constraints`, `technical_details`, `notes` — created on first insert; `changelog` writes a journal entry.
**Custom fields (if this project declares them).** When `_dream_context/overrides/task.md` exists, every task carries project-defined custom fields. Their **values are surfaced to you inline** — in the snapshot's Active Tasks block and in `dreamcontext tasks list --long` — so you can see them without opening the file; unset **required** fields show as `⚠ UNSET (required)`. When you create or reconcile a task, **set every declared field** (`dreamcontext tasks field <slug> <key> <value>` or `tasks create --field key=value`). **REQUIRED fields are mandatory — never create or complete a task with a required field left empty.** Fields marked **[ASK THE USER]** (`ask: true`) capture a human judgment (e.g. a time estimate) — **ask the user for the value when creating the task instead of guessing it.** The full schema + sync behavior → [tasks-and-features.md](references/tasks-and-features.md).
**Objectives (roadmap links).** When the project has objectives (`core/objectives/` non-empty — they're in your snapshot), every task should declare which it serves: `objectives: [slug-a, slug-b]` in frontmatter (many-to-many — one task often lifts several outcomes). Set at creation (`tasks create --objectives a,b`) or later (`dreamcontext tasks objectives <task> a,b`). **Propose objective links for tasks you create; never overwrite a non-empty `objectives:` list — an existing value is a PO decision that sticks.** The field is local-only (never synced to a cloud backend). Rollups, forecasts, and slip detection are computed — `dreamcontext roadmap` / `--json`. Full model → [tasks-and-features.md](references/tasks-and-features.md).

## Context handoff (ECO mode)

When a vault or pane has this on, a long session gets an injected `[context handoff]` note,
then again every ~100k. **The decision is always yours — but the note gets louder, in two
steps that are the same edges the composer's context rings are drawn on:**

| reading | register | what it asks of you |
|---|---|---|
| **300k–650k** | firm | Hand off *unless* the task is nearly done or the state genuinely cannot be written down. "I'm mid-task" is **not** a reason — that is what the `log` is for. |
| **650k+** | severe | Finish the turn you are in, then hand off before starting anything new. If you decide to keep going anyway, **say so to the user and say why** — do not continue silently. |

Measured over 120 real sessions: `cache_read` is 97.4% of billed input and every further
turn re-reads the whole window, so the same remaining work costs ~2–3× more from here than
in a fresh session. Crossing into the severe band always earns its own note, even if the
last one was recent.

If you do hand off, it is ONE command, and every part is required:

```bash
dreamcontext tasks handoff <slug> \
  --done "<finished, with evidence>" --next "<the exact next step, what remains>" \
  --decisions "<choices + why, or none>" --learned "<traps, dead ends, or none>" \
  --style "<how you are working, or none>" --files "<files in flight + line anchors, or none>"
```

That entry is the whole handoff: a fresh session is told to read the task's **newest
journal entry** before anything else, so write it for someone who was not here. The
command **refuses** — and writes nothing — while any part is missing or `--done`/`--next`
is under a sentence; fix what it names and re-run. On success it writes the entry, sets the
task `in_progress`, records the request, and writes a partial session digest.
**In Chat a fresh session opens automatically after this turn — finish your sentence and
stop.** In a terminal nothing rotates for you: the human runs `/clear`.

At the other end you will see a `>> HANDOFF:` banner above the snapshot naming the task —
read that task file first. Switch the feature on per vault with
`dreamcontext config context-handoff on [--nudge-at N] [--hard-at N] [--remind-every N]`, or
per pane from the composer's ECO lamp in the usage popover. The pane owns the **switch**; the
vault owns the **thresholds**. Default is OFF.
