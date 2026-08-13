# dreamcontext CLI — Complete Command Reference

Every command and flag, grouped. All commands are prefixed with `dreamcontext`. For reading/searching context files use native tools; use the CLI for everything structured. Run `dreamcontext <command> --help` for live details. Running `dreamcontext` with no args opens an interactive menu.

> Conventions: `<required>`, `[optional]`, `a|b` = choices, `…` = repeatable/multi-word.

---

## Setup & maintenance

| Command | Description |
|---|---|
| `setup` | **Front door.** One-shot: init + install-skill + install-instructions, and on macOS offers to install the desktop app. Flags: `--defaults` (claude, no packs, single-product, no prompts), `-y/--yes`, `--platforms <list>`, `--packs <list>`, `--multi-product <list>`, `--keep-native-memory`, `--install-app` (force desktop app), `--skip-app`. (`DREAMCONTEXT_INSTALL_NO_APP=1` also skips the app.) |
| `init` | *(deprecated standalone)* Scaffold `_dream_context/` only. Flags: `-y/--yes`, `--name`, `--description`, `--user`, `--stack`, `--priority`, `--platforms <list>`, `--multi-product <list>`. |
| `install-skill` | *(deprecated standalone)* Install skill + agents + hooks. Flags: `--platforms <list>`, `--packs [names...]` (interactive if none), `--skill <name>` (one sub-skill), `--list`. |
| `install-instructions` | *(deprecated standalone)* Install managed root instructions (CLAUDE.md / AGENTS.md). Flags: `--platforms <list>`, `--mode append\|replace\|skip`. (`install-claude-md` is a legacy alias.) |
| `update` | Refresh THIS project's installed skill, agents, hooks, packs, references, and root instructions to the latest shipped version. Flags: `--packs-only`, `--core-only`, `-y/--yes`. |
| `upgrade` | Upgrade the CLI, then update the desktop app (if installed) and offer to refresh **every registered project** — one command brings the whole machine current. Flags: `--check` (print current vs latest, don't install), `-y/--yes` (refresh app + all projects non-interactively). |
| `doctor` | Validate `_dream_context/` structure and report issues — including two size checks that make an invisible failure visible. **Snapshot size:** `error` when the never-evict tier ALONE exceeds the 20,000-char harness limit (no ladder rung can fix that — the usual cause is an oversized `core/0.soul.md` or `people/<slug>.md`, which both render verbatim and must be slimmed by extraction); `warn` when the rendered snapshot exceeds 20,000 chars (the harness persists it to a file and injects only a 2,000-char blind preview); `warn` when it is past the 18,000-char ladder target (4,500 tok × 4) but still lands inline; `ok` otherwise, printing the size and its % of the limit. Under `DREAMCONTEXT_SNAPSHOT_BUDGET=off` the message names the *disabled ladder* rather than blaming core files. **Core-file size:** one `warn` per `core/[0-9]*.md` **and per `people/<slug>.md`** over the ~4,000-char or ~150-line ceiling, naming chars first (chars are what bind — see [Snapshot budget](#snapshot-budget--the-harness-limit)). **People:** see the check matrix in [People](#people--who-works-in-this-vault). |
| `config show` | Print project config (platforms, packs, products, people, native-memory, shareable, task backend). |
| `config native-memory enable\|disable` | Toggle Claude Code's native auto-memory (disabled by default so dreamcontext owns memory). |
| `config shareable on\|off` | Toggle whether peer vaults may recall this project (default off/private). |
| `config people [names...]` | **[Moved in 0.23.0] The roster now lives in people/people.json — use `dreamcontext people`.** A **redirect, not an alias**: it writes **nothing** under any flag combination (including `--clear`) and exits 1, printing `` `dreamcontext config people` moved in 0.23.0. `` / `The roster now lives in _dream_context/people/people.json.` / `Use: dreamcontext people list \| people add <name> --email <e> \| people rm <slug>`. Forwarding would invert the semantics — the old command was a full-roster REPLACE, `people add` GROWS a roster. See [People](#people--who-works-in-this-vault). |
| `config task-backend local\|clickup\|github` | **[Advanced]** Switch the task backend — one cloud sync at a time (see [integrations.md](integrations.md)). |
| `config clickup-token [token]` | Store a ClickUp API key in the gitignored secrets file. `--user <name>` to scope it. |
| `config clickup-list <teamId> <spaceId> <listId>` | Set the ClickUp sync target. `--migrate` / `--keep` when changing lists. |
| `config clickup-member <person> <memberId>` | Map a roster person to a ClickUp member id. `--token-env <ENV>`. |
| `config github-token [token]` | Store a GitHub token in the gitignored secrets file (also reads `GITHUB_TOKEN`/`GH_TOKEN`). `--user <name>` to scope it. |
| `config github-repo <owner> <repo>` | Set the GitHub sync target (`owner`/`repo`). |

---

## People — who works in this vault

Since **0.23.0** the user model is people-first. `core/1.user.md` is gone; in its place:

- **`_dream_context/people/people.json`** — the structural roster, `{version, people: {<slug>: {name, emails[], role?}}}`. Synced with the brain.
- **`_dream_context/people/<slug>.md`** — one **constitution** per person (`## Identity` / `## Preferences` / `## Communication Style`). The ACTIVE person's file renders **verbatim** in every snapshot. These are constitutions, **not knowledge** — they are not in the recall corpus (see [knowledge-and-recall.md](knowledge-and-recall.md)).
- **`_dream_context/state/.brain-local.json`** — gitignored, machine-local. Holds this machine's person pin and nothing that ever enters the synced brain.

A slug is a filesystem path segment and a dashboard route segment, so the charset is narrow: `/^[a-z0-9][a-z0-9-]{0,63}$/`.

**Never hand-edit `people/people.json`.** Every write goes through a PID lockfile so two concurrent `dreamcontext` processes cannot interleave a read-modify-write and lose a person; a hand-edit bypasses that and a malformed one turns into a `doctor` error. Use the verbs. Editing a `people/<slug>.md` by hand is fine — that is ordinary prose.

| Command | Description |
|---|---|
| `people list` | List this vault's people roster (the **default** verb — bare `dreamcontext people` runs it). Prints `SLUG NAME EMAILS ROLE` plus `← you` on the active person and an `Active: <slug> (source: <source>) — <reason>` footer. `--json` → `{activeSlug, source, people:[{slug,name,emails,role?,active}]}`. |
| `people add <name>` | Add a person to the roster **and scaffold their constitution file**. `--email <email...>` (repeatable — how this person's machine is recognised from git config), `--role <role>` (a structural label like `founder`/`backend`, **never prose**). Re-running on an existing person **merges the new details in**; it never overwrites existing prose. Warns when an email already belongs to someone else (git-email resolution between them is ambiguous). |
| `people show [slug]` | Print a person's constitution. **Defaults to the active person on this machine.** Errors (exit 1) on an unknown slug or a missing `people/<slug>.md`. |
| `people whoami` | Show — or pin — who dreamcontext thinks is at this keyboard. Prints `Person / Name / Source / Why`. `--set <slug>` pins THIS machine (validated against the roster **before** writing, stored in the gitignored `state/.brain-local.json`, never synced); `--clear` unpins. `--set` and `--clear` together is an error. |
| `people rm <slug>` | Remove a person from the roster. **Their `people/<slug>.md` is kept** — a person's prose outlives their roster membership; delete it by hand if you mean to. `--yes` skips the confirm (required non-interactively). |

### Active-person resolution — the 5-rung ladder

`resolveActivePerson` **never guesses and never throws**. It walks these rungs in order and reports the winning `source` plus a `reason` that names every rejected rung verbatim:

| # | Source | Rung |
|---|---|---|
| 1 | `env` | **`DREAMCONTEXT_PERSON`** — the explicit override (headless/CI). An *invalid* value does not void the pin below it: resolution falls through to the next rung and records the rejection. |
| 2 | `pin` | This machine's pin from `dreamcontext people whoami --set <slug>` (`state/.brain-local.json`, gitignored). |
| 3 | `git-email` | This machine's git `user.email`, matched **case-insensitively** against the roster's `emails[]`. |
| 4 | `solo` | A vault with exactly one person trivially implies them. |
| 5 | `none` | **Nothing.** `slug: null` — the snapshot renders `## Person (Active — UNRESOLVED)` and **no constitution at all**. Rendering somebody else's preferences because this machine could not be identified is the one failure mode worse than rendering none. |

**Invariant P:** no slug reaches a filesystem path, the snapshot, or author stamping unless it matches the slug charset **AND** is a key in `people/people.json`. That gate applies to every rung — including the machine-local pin, because `.brain-local.json` is a plain JSON file a hand-edit or a bad merge can corrupt.

### What `doctor` checks

- **error** — neither `people/people.json` nor `core/1.user.md` exists (the vault has no user constitution at all).
- **error** — `people/people.json` exists but lists **zero people** (an empty roster is unrepresentable state, not a solo vault).
- **error** — a roster slug has no `people/<slug>.md`; each missing file is **named**.
- **error** — `people/people.json` could not be read (a corrupt roster is reported as a message, never a stack trace).
- **warn** — `core/1.user.md` is present, with or without `people/`: `core/1.user.md — retired layout — run \`dreamcontext update\` to migrate to people/`. **Exit 0.**
- **warn** (multi-person vaults only) — the active person is unresolved on this machine, printing the resolution `source` and `reason`.

### Two caveats worth stating out loud

- **`people rm` has no tombstone.** The roster merges as a **UNION** across machines, so a teammate who still has this person will **resurrect them on the next brain sync** — remove them there too. `people rm` says this in its own output. Tombstones are deliberate YAGNI for a file that changes a few times a year.
- **The legacy `core/1.user.md` branch is a migration window, and it is marked `SUNSET: remove in 0.24.0`** — along with the deprecated `isMultiPerson` export. Until the 0.23.0 migration runs (at `sleep start` / `update`), a vault whose CLI is ahead of its brain still renders the old `## User (Preferences, Project Details, Rules)` block plus one deprecation line. Do not build on it.

**Migrating from a pre-0.23.0 vault:** `dreamcontext update` runs migration `0.23.0`, whose steps are `rescale-legacy-sleep-debt`, `seed-people-from-config`, `split-user-file`, `retire-config-roster`. `split-user-file` moves Identity / Preferences / Communication Style into the owner's constitution, upserts the `## People` bullets into the roster, and copies **every other section verbatim** into `_dream_context/inbox/1.user-residue.md` for the agent task `distribute-user-md-residue` (`dreamcontext migrations pending` prints the full instruction). Nothing is discarded.

**Dashboard/server routes:** `GET /api/core/people` → `{activeSlug, source, people:[{slug,name,role?,active,chars}]}` · `GET /api/core/people/:slug` → `{slug,name,content}` · `PUT /api/core/people/:slug {content}` → `{ok:true}`. The slug is charset-validated **before** any filesystem access; creating a person is `dreamcontext people add`'s job, not the PUT's.

---

## Tasks

| Command | Description |
|---|---|
| `tasks list` | List/filter/group tasks (excludes completed by default). Flags: `-s/--status`, `-a/--all`, `--tag <t>` (repeatable, AND), `--any-tag <t>` (repeatable, OR), `--version <id>` (sprint/milestone), `--priority <level>`, `--feature <slug>`, `--objective <slug>`, `--since YYYY-MM-DD` / `--until YYYY-MM-DD` (inclusive, on `updated_at`), `-g/--group-by tag\|version\|priority\|status`, `--long`, `--tags`, `--json`. Filters compose (AND), case-insensitive. The snapshot's Active Tasks footer teaches this surface. |
| `tasks tags` | Distinct task tags with counts. `-a/--all`, `--json`. |
| `tasks create <name>` | Create a task. Flags: `-d/--description`, `-p/--priority critical\|high\|medium\|low`, `-u/--urgency …`, `-s/--status`, `-t/--tags <csv>`, `-w/--why`, `-v/--version`, `--person <name>`, `--reach <1-10>`, `--impact <1-5>`, `--confidence 25\|50\|75\|100`, `--effort <weeks>`, `--start YYYY-MM-DD`, `--due YYYY-MM-DD`, `--objectives <csv>` (roadmap objective slugs this task serves; slugs must exist), `--field <key=value>` (repeatable; sets declared custom fields), `--allow-missing-required` (create a draft even when a required custom field is unset). **Fails** if a required custom field is unset and `--allow-missing-required` is not given. |
| `tasks rice <name>` | Print or update RICE values. `--reach`/`--impact`/`--confidence`/`--effort`, `--clear`. |
| `tasks start <name> <YYYY-MM-DD\|clear>` | Set or clear a planned start date (range start). A start past the due date pushes the due date out by just enough to keep the window's length — it is never rejected. Setting it removes the `backlog` tag. |
| `tasks due <name> <YYYY-MM-DD\|clear>` | Set or clear a due/end date (range end). Must be ≥ the start date. |
| `tasks objectives <name> [slugs\|clear]` | Print, set (comma-separated, validated against `core/objectives/`), or clear the roadmap objectives a task serves. LOCAL-ONLY — never synced to a cloud backend. |
| `tasks tag <name> <tags...>` | Add (or `--remove`) tags. `person:<slug>` assigns a person. |
| `tasks field <name> <key> [value\|clear]` | Set or clear a user-defined custom field declared in `overrides/task.md` (synced to ClickUp/GitHub). Validates select options + number types. |
| `tasks insert <name> <section> <content...>` | Insert into a section: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`. |
| `tasks log <name> [content...]` | Add a changelog entry (cross-session continuity). **Use every session.** |
| `tasks status <name> <todo\|in_progress\|in_review\|completed> [reason...]` | Change status (logs to changelog). On the first move to `in_progress`, stamps `start_date` with today if it is unset (a planned start is never overwritten) and pushes an already-passed `due_date` out to stay valid. On `completed`, stamps `due_date` with the real completion date (and `start_date` too when the task was never started — a same-day window). |
| `tasks complete <name> [summary...]` | Mark completed (convenience). |
| `tasks delete <name>` | Delete a task (propagates to remote backend on sync). `--yes`. |
| `tasks rename <name> <new-name>` | Rename a task: rewrites the name, moves the file to the new slug, and re-keys the sync mapping by the stable dcId so the **same** remote task/issue is updated on next sync — never duplicated. Use this instead of hand-editing `name:` + renaming the file. |
| `tasks doctor [name]` | Validate the Workflow flowchart is in sync with Acceptance Criteria (all tasks if name omitted). `--remote` also checks the remote backend for assignee drift (needs a token). |
| `tasks sync [push\|pull\|both]` | Sync with the remote backend (no-op on local). `--hook`, `--reconcile` (heal pre-existing assignee drift below the watermark — #78), `--json`. |
| `tasks members` | People with access to the remote list (assignee candidates). `--json`. |
| `tasks provision` | Create recommended + override-declared custom fields on the remote backend (ClickUp list fields / GitHub labels). Reuses any that already exist by name. |
| `tasks sync-hooks install\|uninstall` | Manage best-effort git sync triggers (post-commit, pre-push). |
| `tasks dedup` | Heal duplicate `-N` task-file families (e.g. `state/<slug>-2.md`) left behind by a corrupted/conflicted sync ledger — merges each family into its canonical slug, repoints `.tasks-map.json`, removes the redundant files. **LOCAL-ONLY**: never calls the remote backend. `--dry-run` prints the plan without mutating; the mutating run **requires `--yes`** (refuses non-interactively without it, like `tasks delete`). See [integrations.md](integrations.md#healing-duplicate-task-families-tasks-dedup--backend-generic). |

Sections for `tasks insert`: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`. See [tasks-and-features.md](tasks-and-features.md) for the full protocol.

---

## Roadmap (objectives — the OKR board)

| Command | Description |
|---|---|
| `roadmap` | Render the objective board (rollups, target vs forecast, slip flags) and regenerate `knowledge/roadmap/board.md`. `--json` emits the typed RoadmapModel instead (no writes). A slipping objective reports the numeric days late (`slip_days`) and the auto-derived cause (`slip_upstream`: the direct dependency slug(s) whose forecast runs past this target, else own member tasks). The SessionStart snapshot renders these (`Nd late (upstream: …)` or `(own tasks)`) plus each objective's impact/effort and a one-line description, and orders active objectives by time-box relevance (this month → this quarter → later). |
| `roadmap objective create <slug>` | Create `core/objectives/<slug>.md`. `--title <str>` (required), `--target YYYY-MM-DD`, `--depends-on <csv>`, `--feature <prd-slug>`, `--why <text>`. |
| `roadmap objective list` | All objectives with progress %, status, forecast. `--json`. |
| `roadmap objective show <slug>` | One objective: member tasks, direct dependents, and the transitive "if this slips, so do" set. `--json`. |
| `roadmap objective edit <slug>` | `--title`, `--target <date\|clear>`, `--feature <slug\|clear>`, `--status not_started\|active\|review\|done\|clear` (manual PO override; `clear` returns to computed). |
| `roadmap objective delete <slug>` | Delete; other objectives' `depends_on` are healed automatically. `--yes`. |
| `roadmap objective depend <A> <B>` | A depends on B — **rejected at write time** if it would create a circular dependency. |
| `roadmap objective undepend <A> <B>` | Remove the dependency edge. |
| `roadmap objective metric <slug>` | Set/update the objective's Key Result metric (outcome-based progress instead of task rollup). `--current <n>` (the common nudge — latest observed value), `--target <n>`, `--baseline <n>`, `--label <text>`, `--unit <text>`, `--clear` (remove the metric, back to task-based progress). Sleep may update `--current` when it observes a new real value; all other objective fields stay PO-owned. **Insight-fed objectives are hands-off:** if a Lab insight binds this objective (`lab list --json` → `binding.objective`), `lab sync` owns `current` — don't hand-write it, suggest a sync instead; and before `--clear`, disconnect the feeder (`lab bind <insight> --clear`) so no binding is left warning on every sync. |

Task-side linkage: `tasks create --objectives a,b` · `tasks objectives <task> a,b|clear` · `tasks list --objective <slug>`. Objectives are recallable: `memory recall "<query>" --types objective`.

---

## Lab (analytics insights — see [tasks-and-features.md](tasks-and-features.md))

Curated metrics synced from HTTP APIs or local scripts into `_dream_context/lab/`. **This — not `knowledge create` — is what "create an insight" means.** The SessionStart snapshot renders a Lab section; insights are recallable via `memory recall "<query>" --types insight`.

| Command | Description |
|---|---|
| `lab create <slug>` | Scaffold `lab/insights/<slug>.md`. `--title <str>` (required), `--category <tab>` (top-level dashboard side-menu tab, e.g. "Marketing"), `--group <section>`, `--render <render>` (default number — the ten below), `--size s\|m\|l` (board footprint: `s`/`m` = one column, `l` = two; omit to let the render decide), `--adapter http\|script` (default http), `--unit <str>`, `--ttl <minutes>` (default 1440). Edit the manifest afterwards to set the real endpoint/extract (or script) config, then sync. `--render funnel --adapter script` also scaffolds the `range` tweak (7d/28d/90d) + a documented `funnel-set/v1` script template (payload contract → tasks-and-features.md § Funnel insights). |
| `lab sync [slug]` | Sync one insight, or every insight with `--all`. `--force` refetches even when the cache is within TTL (fresh insights are otherwise skipped and reported). On failure the prior series is kept, the error is loud, and the exit code is non-zero — never a silent half-sync. A changed custom script prints a loud tripwire notice before executing. |
| `lab list` | All insights with latest value, unit, staleness. `--json`. |
| `lab show <slug>` | Manifest + cached series — **cache only, never fetches**. `--json`. Funnel insights additionally print per-funnel step tables (users, % of top, % of prev, drop) with the worst drop highlighted. |
| `lab tweak <slug> <key> <value>` | Set one tweak value: a **declared** tweak (typed `enum\|date\|string`), or one of the three **well-known** window keys — `range` (a relative range like `last_30_days`), `from`/`to` (`YYYY-MM-DD`) — which are writable on ANY insight whether or not its manifest declares them, because the engine always derives a window anyway. A declared `range` keeps its curated options and still rejects outsiders; an undeclared one accepts the relative-range grammar and the manifest gains an implicit declaration. Setting `range` CLEARS any stored `from`/`to` (an explicit window out-ranks the enum, so a leftover pair would pin every later preset to the old dates). |
| `lab bind <slug> [objective]` | Connect an insight to an objective's Key Result (`--value latest\|series:<name>`; `--clear` disconnects). Enforces ONE feeder per objective (a previous feeder is unbound loudly) and immediately seeds `metric.current` from the cached latest. The dashboard equivalent lives in the objective create modal / detail panel (Key Result section). |
| `lab credentials set <key>` | Store a secret for `{{cred:key}}` placeholders — hidden prompt (`--value` works but is shell-history-risky). Gitignore-first, mode 0600. **The only supported way to create `lab/credentials.json`.** |
| `lab credentials list` | Credential key NAMES only — values are never printed. |

**Renders (`--render`, ten).** All read the same cached `Series[]`; the dashboard resolves each through its chart registry, so the CLI enum, doctor's validation and the board can't drift apart. `number` (latest value + inline sparkline) · `line` (trend over time) · `pie` (share by series — degrades to a bar list at ≥7 slices) · `bar` (latest value per series, horizontal) · `bar_compare` (grouped bars, series × last N buckets) · `stacked` (stacked bars over time) · `table` (series × latest + Δ, sortable) · `heatmap` (daily buckets as a week × weekday grid) · `raw` (the numbers, unstyled) · `funnel` (the one multi-page render — a `funnel-set/v1` payload routes to `/lab/<slug>`). `table` and `funnel` default to a 2-column card; `--size` overrides any of it. An unrecognised render reads back as `number` rather than blanking the board.

**Trust note:** `lab/scripts/*.mjs` run locally with credentials passed in — same trust level as the repo. Review scripts before their first sync. Each run gets a **fresh short-lived Node child process**, so an edit to a script *or to any `lab/scripts/lib-*.mjs` it imports* takes effect on the very next sync, even inside the long-running desktop app. The child is an isolation boundary, not a sandbox: it has your filesystem and network access. A script that hangs is killed at 120s (`DREAMCONTEXT_LAB_SCRIPT_TIMEOUT_MS` raises the ceiling) and reported as a failed sync. **Sleep does NOT run lab sync** — refreshing is always an explicit action. An insight manifest may carry `binding: {objective: <slug>, value: latest}` to auto-write that objective's Key-Result `metric.current` on every successful sync — set it via `lab bind` or the dashboard's objective dialogs, not by hand.

---

## Automations

Scheduled headless `claude` runs, user-authored, ships completely disabled until the dispatcher is installed and each automation is approved on this machine. Full protocol, security stance, and manifest reference: [automations.md](automations.md).

| Command | Description |
|---|---|
| `automations create <slug>` | Scaffold a new automation manifest, private and auto-approved on this machine. `--title <title>` (required), `--days <daily\|mon,wed>` (required, schedule days), `--at <HH:MM>` (required, 24h local), `--model <model>` (default: let claude pick), `--effort <level>` (`low\|medium\|high\|xhigh\|max`, default: let claude pick), `--timeout <minutes>` (1-60, default 15), `--catchup <hours>` (1-168, default 6), `--prompt-file <path>` (read the `## Prompt` body from this file instead of the scaffold stub), `--shared` (publish the manifest, cache, and output immediately instead of staying private), `--no-notify` (stay silent when a scheduled run finishes; notifies on completion by default), `--disabled` (create with `enabled: false`). |
| `automations list` | List automations with schedule, approval, sharing state, and last-run status. `--json`. |
| `automations show <slug>` | Show one automation's manifest, cache, approval, sharing state, and orphan state. `--json`, `--history <n>` (default 5). |
| `automations run <slug>` | Run one automation now. `-f/--force` bypasses dueness and sleep-deference only, never approval and never the orphan guard. |
| `automations tick [slug]` | Simulate a dispatcher tick: evaluate dueness and run whatever is due (never forces). `[slug]` ticks only that automation in the current project; omit for the whole project. `-a/--all` ticks every project registered on this machine. `--json`. |
| `automations enable <slug>` / `automations disable <slug>` | Enable (tick considers it again) or disable (tick skips it; approval untouched) an automation. |
| `automations approve <slug>` | Review and approve an automation to run on this machine. Shows every hashed field — prompt, output instructions, model, effort, timeout, output directory, `learning`, `review`, and the `## Flow` graph. It is a REVIEW, not a diff: the approval record stores only a sha256, never prior field values, so the tripwire proves *that* something changed and never *what*. `-y/--yes` skips the interactive confirmation. |
| `automations flow <slug>` | Print this automation's `## Flow` graph — its own block, or the one implied by its schedule and review mode (it says which). Validates the graph and names unknown node kinds, dangling edges, and cycles concretely. `--json`. |
| `automations questions [slug]` | List questions awaiting a human answer, for one automation or all. Two kinds, answered differently: `flow-hitl` (a run stopped mid-flight to ask) and `approval` (a changed manifest asking whether to trust it as it now stands). |
| `automations answer <id> <answer>` | Answer a question a run is waiting on. Free text for a `flow-hitl` question — it resumes that session. For an `approval` question the answer must be an explicit `approve`/`yes` or `reject`/`no`; free text is refused and decides nothing, so a typed "no, this looks wrong" can never be read as consent. |
| `automations telegram setup <slug>` | Point a Telegram bot at ONE automation, so its questions reach you when you are not at the Mac. Stored at `~/.dreamcontext/telegram/<slug>.json`, mode 0600, machine-local, never synced. `--token <token>`, `--chat <id>` (the only chat allowed to answer). The token is a capability: it can resume a `bypassPermissions` session on this machine, which is exactly why it is not in the brain. |
| `automations telegram test <slug>` / `automations telegram off <slug>` | Post this automation's waiting question now and report what its bot can see / forget this automation's bot token and stop its channel. |
| `automations session <slug>` | Show the claude session a run actually had — its turns, tool calls, and errors. |
| `automations pattern <slug>` / `automations learn <slug>` | Show what this automation has learned (its playbook and lesson ledger) / record a lesson into it. A run calls `learn` on itself; the pattern's CONTENTS are deliberately not approval-hashed, since they change every run by design — the `learning` switch that admits them is. |
| `automations propose <slug>` | Stop and ask a human before acting. A run calls this about itself; it cannot be called by hand (a process-group probe refuses a nested call). |
| `automations share <slug>` | Publish this automation: flips `shared` to `true` and publishes its manifest, cache, and output together. |
| `automations unshare <slug>` | Stop publishing this automation from this machine. Prints a warning that this is not retroactive: anything already committed and pushed stays in git history. `-y/--yes` skips the interactive confirmation. |
| `automations kill <slug>` | Kill a previous run's orphaned process group, read from its recorded sidecar. Never guesses with `pgrep`/`pkill`. `-y/--yes` skips confirmation, `--force` kills even when the sidecar is old enough that its process-group id may have been recycled. |
| `automations remove <slug>` | Delete an automation manifest and its machine-local cache/lock/sidecar (approval revoked, sharing negations removed too). `-y/--yes`, `--purge-output` (also delete this automation's output directory). |
| `automations install` | Install the launchd dispatcher (ticks every 5 minutes). `--check` inspects only and writes nothing. `-f/--force` installs even if the resolved CLI does not match the one running this command. |
| `automations uninstall` | Remove the launchd dispatcher. Registry approvals are left untouched. `-y/--yes`. |
| `automations logs` | Tail the dispatcher log. `-n/--lines <n>` (default 50). |

**Nothing about this feature runs until both an explicit `automations install` and a per-automation approval have happened on this machine.** All job semantics live in the manifest's `## Prompt` prose; the CLI carries only schedule, model, effort, and timeout. Every automation is **private to this machine by default** — sharing is a separate, explicit step. See [automations.md](automations.md) for the capture protocol and the full security stance (what approval covers, sharing and its five states, output scrub coverage, and how to stop a running automation).

---

## Theses (Hypotheses)

Opt-in proactive learning layer (`learning.enabled`, default OFF). Falsifiable claims validated/invalidated across sleep cycles in `_dream_context/theses/`; dashboard label is "Hypotheses", code/CLI say theses throughout. Commands stay callable when the layer is off (a dim hint prints first). See [learning.md](learning.md) for the full lifecycle, derived-confidence formula, and sleep-learn contract.

| Command | Description |
|---|---|
| `theses list` | List theses (excludes retired by default). `--status draft\|open\|validated\|invalidated\|retired`, `--kind observational\|experimental`, `--objective <slug>`, `--blocked` (instrumentation-blocked only), `--all` (include retired), `--json`. |
| `theses show <slug>` | Claim, status, derived confidence, predictions with standings, evidence ledger (oldest first), links, understanding changelog. `--json`. |
| `theses create <claim...>` | Scaffold `theses/<slug>.md` (default status `draft`). `--slug <slug>` (default: derived from claim), `--kind observational\|experimental` (default observational), `--prediction <text>` (repeatable), `--insight <slug>` / `--objective <slug>` / `--task <slug>` (each repeatable, initial links), `--open` (promote straight to open — requires ≥1 `--prediction`), `--by user\|sleep-learn` (default user). |
| `theses predict <slug> <text...>` | Add a pre-registered falsifiable prediction. |
| `theses evidence <slug>` | Append a discrete evidence event (recomputes derived confidence). `--verdict supports\|contradicts\|no-signal` (required), `--source insight\|task\|objective\|changelog\|external` (required), `--ref <slug\|url>`, `--note <text>`, `--cycle <n>`, `--quantitative` (numeric series/metric-delta — feeds the workflow-rule promotion threshold), `--date <YYYY-MM-DD>` (default today). |
| `theses status <slug> <status>` | Flip status. `draft→open` needs ≥1 prediction; a manual flip to `validated`/`invalidated` needs ≥1 `--cite <index>` (repeatable, 0-based evidence index) unless `--force` (the agent/data-driven path). `--prediction <id>=<standing>` (repeatable) records a prediction check in the same call. |
| `theses link <slug>` | Link to exactly one of `--insight <slug>` / `--objective <slug>` / `--task <slug>` per call. |
| `theses unlink <slug>` | Remove a link — same one-of-three flag shape as `link`. |
| `theses changelog <slug> <text...>` | Append a per-cycle understanding-changelog entry (LIFO, newest 10 kept, older condensed). `--cycle <n>` (omit for a manual/awake entry), `--condensed` (rare — normally computed). |
| `theses block <slug> <metric...>` | Mark blocked on instrumentation — needs a metric nobody tracks yet. |
| `theses unblock <slug>` | Clear the instrumentation-blocked flag. |
| `theses promote <slug>` | Record that a validated/invalidated thesis was promoted into a knowledge doc. `--knowledge <path>` (required, relative to context root), `--retire` (also retire, leaving a pointer). |
| `theses retire <slug>` | Retire a thesis (promoted pointer, or kept as anti-knowledge). |
| `theses restore <slug>` | Restore a retired thesis back to `draft`. |
| `theses enable` / `theses disable` | The one-command switch — flips `learning.enabled` in `.config.json`. Gates sleep-learn dispatch, the snapshot section, and the dashboard nav/page; the CLI itself stays callable either way. |
| `theses candidates [file]` | Stage meeting-note candidate claims for the dashboard review flow (`theses/.candidates.json`). `<file>` is JSON `{ note?, items: string[] }`. `--clear` clears staged candidates instead. |

---

## Features

| Command | Description |
|---|---|
| `features create <name>` | Create a feature PRD. `-w/--why`, `-t/--tags <csv>`, `-s/--status planning\|in_progress\|in_review\|active\|shipped\|deprecated`, `--related-tasks <csv>`. |
| `features set <name> <tags\|status\|related_tasks> <value...>` | Set a frontmatter field without hand-editing. |
| `features insert <name> <section> <content...>` | Insert into a section (replaces template placeholders on first write; `user_stories`/`acceptance_criteria` auto-format as `- [ ]`). |
| `features doctor` | Check PRDs for staleness, orphans, dangling task refs (read-only). |

Sections for `features insert`: `changelog`, `notes`, `technical_details`, `constraints`, `user_stories`, `acceptance_criteria`, `why`. **Features are sleep-only — do not update during active work.**

---

## Core (changelog & releases)

| Command | Description |
|---|---|
| `core changelog add` | Add a changelog entry. `--type feat\|fix\|refactor\|chore\|docs\|perf\|test\|change`, `--scope`, `--description`, `--summary` (≤200 char), `--references <csv>` (`commit:`/`file:`/`knowledge:`/`feature:`/`task:`/`url:`), `--authors <csv>`, `--supersedes <key>`, `--breaking`. |
| `core releases add` | Create a release (auto-discovers tasks/features/changelog). `-V/--ver`, `-s/--summary`, `--status planning\|released` (default released), `-y/--yes`. |
| `core releases list` | List recent releases. `-n/--count`. |
| `core releases active [version]` | Get/set the active planning version (default for new tasks' version). `--clear` to unset. |
| `core releases show <version>` | Show a release's details. |

---

## Knowledge

| Command | Description |
|---|---|
| `knowledge create <name>` | Create a knowledge file. `-d/--description`, `-t/--tags <csv>`, `-c/--content`. |
| `knowledge index` | Show the knowledge index. `--tag <tag>`, `--plain`. |
| `knowledge tags` | List standard tags. `--plain`. |
| `knowledge move <slug> <folder>` | Move `knowledge/<slug>.md` → `knowledge/<folder>/<basename>.md` and rewrite inbound `[[wikilinks]]` atomically (target token only; `\|alias`/`#anchor` preserved). Free-form folders — nothing reserved; nested allowed; path traversal + clobber rejected. Use this instead of `mv` + hand-editing links. |
| `knowledge touch <slug>` | Record access (decay/staleness tracking + warm loading). |

> `knowledge/**/*.md` is indexed **recursively**, so knowledge organized into context folders (`knowledge/<context>/…`) stays first-class. Group a flat file into a context folder with `knowledge move <slug> <folder>` (atomic move + wikilink rewrite); `sleep-product` calls this same command during consolidation; legacy flat `knowledge/diagrams/` boards are folded by `migrations apply-diagrams`. Never hand-move + hand-edit links. See [knowledge-and-recall.md](knowledge-and-recall.md).

---

## Memory (recall & corpus)

| Command | Description |
|---|---|
| `memory recall <query...>` | Search all nine channels (knowledge, feature, task, memory, changelog, objective, insight, thesis, automation). `-t/--top <n>`, `--types <csv>`, `--level 1\|2\|3` (min importance ★/★★/★★★), `--json`, `--plain`, `--vault <name>` (repeatable), `--connected`, `--all-vaults`. |
| `changelog list` | Page through `core/CHANGELOG.json` chronologically (newest first) — the "what happened, in order?" counterpart to recall's relevance search. `--page <n>`, `--size <n>` (max 50), `--type <t>`, `--scope <s>`, `--grep <text>` (case-insensitive over summary+description+scope), `--json`. The snapshot's Recent Changelog footer points here at every rung. |
| `memory remember <text...>` | Quick-append a CHANGELOG entry (`type=note`, `scope=quick`). `--summary`, `--type`, `--scope`, `--references <csv>`, `--person <csv>`. |
| `memory update <slug>` | Update a knowledge file. `-d/--description`, `-t/--tags`, `-c/--content`, `--append <text>`, `--pin`, `--unpin`. |
| `memory delete <slug>` | Delete a knowledge file (irreversible; recover via git). `-f/--force`. |
| `memory list` | List the corpus by type. `--types <csv>`, `--level 1\|2\|3`, `--plain`. |
| `memory status` | Corpus size + breakdown by type and importance level. |
| `recall status\|on\|off\|raw\|hybrid` | Control recall mode: `on`=haiku (default, LLM picks docs), `raw`=BM25 only, `hybrid`=experimental BM25+local-embedding fusion (no LLM), `off`=disabled. |
| `embed refresh` | Bring the hybrid-recall embedding index up to date (embeds only changed chunks). `--force` re-chunks everything; `--if-present` no-ops unless a cache already exists (cron/sleep-safe). |
| `embed status` | Embedding cache presence, model, vector count, size. |

---

## Sleep / consolidation

| Command | Description |
|---|---|
| `sleep status` | Current debt level + history. |
| `sleep add <score> <description...>` | Record a debt-accumulating action (non-file work). |
| `sleep start` | Begin consolidation epoch (safe clearing). `--deep` forces deep consolidation (authorizes destructive knowledge ops). |
| `sleep done <summary...>` | Mark consolidation complete, write history, reset debt. |
| `sleep debt` | Output the debt number (programmatic). |
| `sleep history` | Consolidation history log. `-n/--limit`. |

See [sleep.md](sleep.md) for the full flow.

---

## Bookmarks & triggers

| Command | Description |
|---|---|
| `bookmark add <message...>` | Tag an important moment. `-s/--salience 1\|2\|3` (default 2), `-t/--task <slug>`. Omitting `--task` while open tasks exist prints a stderr advisory naming the likeliest 1–3 (never blocks, exit stays 0; silence with `DREAMCONTEXT_BOOKMARK_HINT=0`). With no `--task`, `state/.active-task` is used as an implicit one and said out loud. A `--task` that is a name or prefix resolves like every other task verb. |
| `bookmark list` / `bookmark clear` | Show / remove all bookmarks. `list` marks each one `[slug]` or `[no task]` and prints its id (the `relink` handle). |
| `bookmark relink <id> --task <slug>` | Point an existing bookmark at a task — the repair for one saved without `--task`, no need to rewrite it. Takes a unique id prefix. |
| `trigger add <when> <remind...>` | Create a contextual reminder. `-m/--max-fires` (default 3), `-s/--source`. |
| `trigger list` / `trigger remove <id>` | Show / remove triggers. |

---

## Taxonomy

| Command | Description |
|---|---|
| `taxonomy vocab` | Show the resolved vocabulary (defaults + `core/taxonomy.json`). `--json`, `--facet <facet>`. |
| `taxonomy audit` | Audit corpus tags against the vocabulary (read-only). `--json`. |
| `taxonomy audit --fix` | **Bulk-normalize** alias/normalizable tags → canonical faceted form across every knowledge/feature/task file. Safe + idempotent: already-canonical tags are untouched; orphan tags with no alias/canonical target are reported, never guessed. `--dry-run` previews the rewrite plan and writes nothing; `--json` for automation. Workflow is alias-then-fix: teach a mapping with `taxonomy alias`, then `audit --fix`. |
| `taxonomy init` | Scaffold `core/taxonomy.json` (idempotent). |
| `taxonomy add <tag>` | Add a tag to the vocabulary. |
| `taxonomy alias <alias> <canonical>` | Add an alias→canonical mapping. |
| `taxonomy resolve <tag>` | Show normalized form, classification, canonical resolution. `--json`. |

Never hand-edit `core/taxonomy.json` — mutate via these commands.

---

## Federation / vaults (see [integrations.md](integrations.md))

| Command | Description |
|---|---|
| `vaults add\|list\|discover\|remove` | Manage the global vault registry. `discover [root] [--register]`. |
| `connect <vault>` | Read a peer. `-d/--direction out\|in\|both` (out = read), `--topics <csv>`. |
| `disconnect <vault>` | Remove a connection. |
| `connections list` | List this vault's connections. |
| `federation peers` | Refresh + print readable-peer summaries. |
| `federation status` | Connections + leftover federated copies. |
| `federation purge` | Remove leftover `federated:true` copies. `--vault`, `--all`, `--dry-run`. |
| `federation sync` / `federation drain` | **Disabled no-ops** (copy-based sync is parked). |

---

## Brain — team collaboration / shared brain repo (see [integrations.md](integrations.md))

Sync the WHOLE brain (`_dream_context/`) — tasks, knowledge, features, sleep state — to its own git remote so a **team collaborates on the same brain** the way they collaborate on code. Distinct from federation (which is read-only cross-*project* recall) and from cloud task sync (which mirrors only *tasks* to ClickUp/GitHub Issues). Brain repos default **private**; attaching one is a **trust decision** (a brain repo loads into every future session). Local indexes/caches are per-machine and never pushed. **M1 CLI is shipped; the one-click desktop/Launcher flow (device-flow GitHub login, repo picker, UI attach) is M2 — pending.**

| Command | Description |
|---|---|
| `brain status` | Show sync mode (`full-repo`/`in-tree`), remote, sync state, and whether cloud sync is ON. Reports `mergeInProgress` / `pendingAgentMerge` (the `/dream-sync` handoff signals). |
| `brain enable` | Turn cloud sync ON — sync the WHOLE project (code + `.claude/` + `_dream_context/`) to its GitHub `origin` on the current branch (`full-repo`). Needs a GitHub `origin`. |
| `brain disable` | Turn cloud sync OFF — revert to `in-tree` (the brain is still committed locally, never pushed). |
| `brain sync` | Fetch → semantic-merge-on-conflict → commit → push (or, in `in-tree` mode, commit-only — never auto-pushes). `--pull-only` (take team content in, never push), `--push-only`, `--strict` (WARN scrub hits block too), `--resume` / `--continue` (the attended `/dream-sync` handoff — see below). |
| `brain scrub` | Dry-run the secrets/absolute-path scrub gate against the current staged tree. |

**Automatic sync:** every `dreamcontext sleep done` runs a brain sync (fetch/merge/commit/push); failure never fails sleep. Session-start does a non-blocking background pull. **On an agent-class merge conflict** (two people edited the same prose section) the CLI stops at `already-awaiting-agent` and defers to the **`/dream-sync` skill** — the agent half that reads base/ours/theirs and writes the semantic merge, then `brain sync --continue`. Never drive `--resume`/`--continue` unattended.

---

## Linked repos — the bare code repos a brain governs (see [brain-sync.md](brain-sync.md))

One shared brain can point at the **bare code repos it governs** — products/services in their own GitHub repos, cloned at different local paths on each machine (or absent on some), with **no `_dream_context/` of their own**. Distinct from **brain sync** (syncs the whole project) and **federation** (read-only recall across *brains*): linked repos are **pointers to code, not a sync** — linking never clones, pushes, pulls, or commits the target. Two layers: the **shared** half (`{name, gitRemoteUrl}` in `.config.json`) travels to the team so everyone knows the repo exists; the **machine-local** half (`~/.dreamcontext/linked-repos.json`, keyed by canonical URL → local path) records where it lives on *this* machine and **never leaves it**. GitHub-only for now.

| Command | Description |
|---|---|
| `link add <name> <path>` | Register a local checkout the brain governs. Derives the canonical GitHub URL from the repo's `origin` (or pass `--url`); writes `{name,url}` to `.config.json` + `url→path` to the machine-local registry. Requires `path` to be a git repo whose `origin` matches — **no fetch/clone happens**. |
| `link ls` (alias: `links`) | List governed repos: ✓ present (resolved local path) / ✗ missing on this machine. `--json`. |
| `link clone <name>` | Clone a **missing** repo from its shared URL to this machine — a normal one-way `git clone`, behind a **trust-gate** (the URL is team-writable). `--dir <dir>`, `--yes`. |
| `link rm <name>` (alias: `unlink`) | Drop the repo from `.config.json`; the machine-local `url→path` mapping is intentionally **left** (re-link stays instant; other brains keep resolving it). |

The SessionStart snapshot shows a cheap **Linked repos** glance (present → the resolved path is handed to the agent so it can Grep/Read the governed code; missing → a `link clone` hint). Fully manageable from the dashboard (Settings → Cloud sync → **Linked repos**; desktop-gated, native folder picker).

---

## Council (see [integrations.md](integrations.md))

Orchestrator commands: `council create` (`--rounds N`, `--interrupt`, `--options "A=..,B=.."` to register named decision options), `council agent create`, `council round start|end`, `council board <id>` (`--round N`, `--plain`; chamber board with stances, conviction bars, convergence), `council timeline <id>` (`--json`; per-round stance+conviction table), `council inject <id> <fact...>` (mid-debate fact into Constraints & Known Facts), `council question <id> <slug> <question...>` (queue a directive/cross-examination for one persona), `council synthesize`, `council complete`, `council promote`, `council list`, `council show`, `council live clear` (delete the live panel file), `council demo-live` (`--phase <p>`; fake live state for previewing the app panel).

Persona helpers: `round-context` (now includes verdict landscape + injected facts + pending directives), `council verdict <id> <slug> <round> --stance <s> --conviction <n> --headline "<h>" [--concession "<c>"]` (submit BEFORE `report append`; idempotent per round+slug), `report append` (warns when the round's verdict is missing; accepts an optional `### Cross-examination` subsection), `summaries` (appends per-persona stance/conviction lines), `research add|list`.

The CLI writes `_dream_context/tmp/.council-live.json` automatically on state-changing commands; the app's live chamber panel renders from it, in BOTH agent renderers — above the composer in Terminal view, on the live rail in Chat view (the panel is scoped to the conversation that started the debate, so it only appears in the orchestrator's own pane). No browser viewer.

---

## Other

| Command | Description |
|---|---|
| `dashboard` | Open the web UI. `-p/--port`, `--host`, `--no-open`, `--vault`, `--launcher`. |
| `app install\|update\|status` | Manage the macOS desktop app. `--from <path>`, `--dir <dir>`. |
| `marketing` / `mk` | Meta marketing skill surface. |
| `transcript distill <session_id>` | Extract high-signal content from a transcript. `--since <ts>`, `--full`. |
| `reflect` | Surface recurring cross-session terms as candidates. `--min-sessions`, `--max`, `--write`. |
| `snapshot` | Output the context snapshot (used by SessionStart). `--tokens`, `--vault <name>`. Budget-bounded — see [Snapshot budget](#snapshot-budget--the-harness-limit). |
| `migrations pending\|apply-diagrams\|record` | Inspect/apply brain-structure migrations. `record --files --summary`. |
| `feedback` | File a gap/bug upstream as a GitHub issue. See [improving-dreamcontext.md](improving-dreamcontext.md). |
| `hook <name>` | Hook handlers (called by the platform, not you): `session-start`, `stop`, `subagent-start`, `pre-tool-use`, `user-prompt-submit`, `post-tool-use`, `pre-compact`, `ensure-dashboard`, `refresh-asset-drift`. |

---

## Environment variables

| Var | Effect |
|---|---|
| `DREAMCONTEXT_MEMORY_HOOK=0` | Disable auto-injected recall on prompts. |
| `DREAMCONTEXT_RECALL_MODE=haiku\|raw\|hybrid\|off` | Override recall mode for the session (else uses `recall` setting; default `haiku`). |
| `DREAMCONTEXT_AUTO_DASHBOARD=0` | Don't auto-open the dashboard on session start. |
| `DREAMCONTEXT_DASHBOARD_PORT` | Default dashboard port (else 4173). |
| `DREAMCONTEXT_AUTO_UPGRADE=0` | Disable automatic CLI self-upgrade. |
| `DREAMCONTEXT_VERSION_CHECK=0` | Disable the version-check nag. |
| `DREAMCONTEXT_PERSON` | **Rung 1** of active-person resolution: the person slug for THIS process (constitution rendering + author stamping). Wins over the machine pin and git email. Must be a real roster key — an invalid value is rejected, recorded in the resolution `reason`, and resolution falls through to the next rung. See [People](#people--who-works-in-this-vault). |
| `DREAMCONTEXT_SNAPSHOT_BUDGET` | Token budget cap for the SessionStart snapshot (default 4,500 tok ≈ 18,000 chars; `0`/`off` disables the ladder; clamped to a 2,000-tok floor). See [Snapshot budget](#snapshot-budget--the-harness-limit). |
| `DREAMCONTEXT_SKILLS_HOOK=0` | Disable skill-suggestion injection on prompts. |
| `DREAMCONTEXT_DRIFT_CHECK` / `DREAMCONTEXT_APP_AUTO_UPDATE` | Asset-drift check / desktop app auto-update toggles. |
| `DREAMCONTEXT_DEBUG` | Verbose diagnostics (e.g. recall decisions to stderr). |

---

## Snapshot budget & the harness limit

**The binding constraint is not the token budget — it is the harness.** Claude Code persists any hook output past **20,000 characters** to a file and injects only the first **2,000 chars** as a blind positional preview. That cut is positional and uncurated: it drops warnings, the knowledge index, and everything below wherever it lands. The token budget (`DREAMCONTEXT_SNAPSHOT_BUDGET`, default 4,500 tok ≈ 18,000 chars) exists to keep the render comfortably under that ceiling. **Raising the budget does not buy room — it only moves the failure from a curated demotion to the harness's blind cut.**

**The ladder.** When the full render exceeds the budget, sections demote through progressively cheaper **curated** renders — full body → summaries → titles + paths. Nothing is ever raw-truncated, and no name is ever cut mid-string. Demotion happens in waves and stops the instant the snapshot fits, so a brain that is barely over loses almost nothing.

**The soul and the active person's constitution never demote.** `core/0.soul.md` is the agent's constitution and `people/<slug>.md` is the person's, so both render **verbatim in every snapshot, at every budget** — never-evict, no rungs, no cap. Either one big enough to bust the harness limit is therefore a *content* problem the renderer deliberately will not paper over: it raises the loud banner and a `doctor` **error**, and the fix is to slim the file by extraction — conditional "when X, do Y" rules go to `knowledge/patterns/` (recall fetches them on demand), and anything in a constitution that is not about the *person* goes to `knowledge/` or the right core file.

The never-evict `person` section covers all three shapes that block can take: the resolved constitution, the `## Person (Active — UNRESOLVED)` notice, and the retired `core/1.user.md` legacy render. The **roster of other people** is a different thing entirely and IS demotable (rank 110) — see the floors table below.

**Memory demotes only when it is over the core ceiling.** `core/2.memory.md` is sleep's already-distilled working set: at or under the 4,000-char core ceiling it renders **in full, no rungs**, with one pointer line to the history beyond it (`dreamcontext memory recall`) — a rung there would compress what sleep already compressed. Over the ceiling (an unslept vault) the ladder below applies, and the `doctor` core-size error names the file so the fix lands on sleep, not the renderer. Unlike the constitutions this cut is safe: every demoted entry stays one `memory recall` away.

**Demotion order (cheapest-loss first).** Order is a per-section rank on a 10–140 scale, independent of render order — so `memory` renders near the top but is given up well after the inventory sections below it:

`changelog` → `releases` → `extended-core` → `connected-projects` → `knowledge-index` → `features` → `memory` → `bookmarks` → `tasks` → `people-roster` → `objectives` → `theses`

The chain **ends at `theses`**. Lab has no rungs at all (every insight's name + latest value renders at every budget — Rule 13), and level 0 is itself compact since 2026-07-30: features are name + status + path lines, non-pinned knowledge is grouped folder names (only PINNED entries carry descriptions; every pattern is titled with one short clause), and the old Warm Knowledge preview section is gone. When the ladder is exhausted, anything still over the limit is a constitution that needs slimming, which the banner says out loud.

**Floors — sections that stop early because their remaining content IS the point:**

| Section | Floor | Why |
|---|---|---|
| `lab` | no rungs — never demotes | Metric names + latest values must survive, or you cannot tell a metric question is already answered here and you fetch it from outside (Operational Rule 13). There is no cheaper render at all. |
| `theses` | rung 1 | The top open claims survive; a bare `N open · N flipped` count tells you nothing. |
| `objectives` | rung 2 | One compact line per objective survives; a bare `N objective(s)` count leaves "weigh decisions against these outcomes" unsatisfiable. |
| `bookmarks` | rung 2 | ★★★ bookmarks stay verbatim — they are the primary consolidation signal. With no ★★★ at all, the floor keeps the ★★ tier (first sentence each) instead of a bare count; ★ stays behind an accurate count. |
| `people-roster` | rung 2 | Every OTHER person stays **named** with their `person:<slug>` tag — that tag is what makes them addressable at all. Rung 1 drops the role label; rung 2 collapses to one line of names. Never a bare count. |
| `memory` | no rungs at ≤ core ceiling | Sleep already distilled the working set to the 4,000-char ceiling — a compliant file renders in full with a recall pointer. Only an over-ceiling file walks the rungs. |
| `soul` | never demotes | The constitution renders verbatim at every budget. Rule *titles* are not a constitution — the agent would know a rule exists without knowing what it says, and read as compliant. |
| `person` | never demotes | Same doctrine, for the person at this keyboard (`people/<slug>.md`). A preference reduced to its title is worse than an absent one: the agent sees that a rule about you exists, reads that as knowing it, and never opens the file. |

**Everything demoted stays reachable.** Files keep their paths; in-file items (decisions, issues, bookmarks, changelog entries) keep their containing path plus the recovery command. Where a tail omits items, it names an accurate count and the exact command (`dreamcontext tasks list`, `knowledge index`, `memory recall`) — never an ellipsis through a name.

**Three output bands:**

| Render size | What you see |
|---|---|
| ≤ 18,000 chars | Nothing. Byte-identical to the unbudgeted format — small brains see zero change. |
| Over budget, ≤ 20,000 chars | A loud `_Budget note:` footer naming the demoted sections and the fix. The snapshot is **complete and inline** — no truncation has happened. |
| > 20,000 chars | A `⚠️ CONTEXT IS INCOMPLETE` banner directly under the H1, deliberately **inside the 2,000-char preview window** so it survives the harness cut. It names the never-evict byte count, the sections at their floor, and the oversized core files to trim. |

**When you see the banner:** run `dreamcontext doctor`, then trim the files it flags (extract detail to `knowledge/`, keep a summary + reference) — starting with `core/0.soul.md` and the active `people/<slug>.md`, since those two the ladder cannot help with at all. See [troubleshooting.md](troubleshooting.md).
