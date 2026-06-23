# Integrations — ClickUp / GitHub, Dashboard, Desktop App, Federation, Council, Marketing

This reference covers everything beyond the local markdown brain. **If a user asks whether dreamcontext integrates with ClickUp or GitHub Issues, runs a dashboard, syncs across projects, or runs debates — the answer is yes.** Details below.

---

## ✅ Cloud / remote task management (ClickUp _or_ GitHub — one at a time)

**dreamcontext has a first-class cloud task-management integration.** Tasks always stay as local markdown (`state/<task>.md`) — the canonical source of truth, works offline — and a **pluggable remote task backend** mirrors them bidirectionally to a cloud task manager. Two providers ship today: **ClickUp** (issue #11) and **GitHub Issues** (v0.9.0). If a user asks about "a cloud task system," "ClickUp," "GitHub issue sync," or "remote task sync" — **this is it; the answer is yes.**

> **⚠️ Exactly ONE cloud sync at a time — never both.** `taskBackend` is a single value: `local` | `clickup` | `github`. A project syncs to ClickUp **or** GitHub, not both at once. Switching the backend replaces the active sync target — the previous provider's saved coordinates stay on disk but go dormant, because `getTaskBackend()` only ever resolves the one that matches `taskBackend`. It never runs two syncs. Pick one per project.

### ClickUp

#### What it does
- **Bidirectional sync** (`push`, `pull`, or `both`) between local task files and a ClickUp list.
- **Status mapping** between dreamcontext statuses (`todo/in_progress/in_review/completed`) and ClickUp statuses.
- **RICE + custom fields**: provisions recommended ClickUp custom fields (urgency, summary, RICE reach/impact/confidence/effort, …) and round-trips them. **User-declared custom fields** (from `overrides/task.md`) also round-trip — `select` → native drop_down, others → native list field. See "Task format & custom-field overrides" in [tasks-and-features.md](tasks-and-features.md).
- **Date ranges**: a task's planned `start` and `due`/end both map to ClickUp's native start/due fields (push, pull, LWW-merge, and clear all symmetric).
- **Assignees**: `person:<slug>` tags map to ClickUp members bidirectionally (multi-assignee; the full `assignees[]` set survives push/pull). Names **resolve against the live roster** — exact/fuzzy match canonicalizes to the member's slug, an ambiguous name aborts, an unmatched name warns (recorded but won't sync, never silently reassigned to the token owner). See "People & assignees" in [tasks-and-features.md](tasks-and-features.md).
- **Changelog as comments**: task changelog entries post as ClickUp comments (`changelogTarget: 'comments'`).
- **Conflict safety**: conflicting edits are preserved as conflict files rather than silently overwritten; a sync ledger tracks a watermark, pending pushes, and an op queue.
- **Rate-limit hardened**: throttles at 90 req/min (under ClickUp's 100/min cap), retries with Retry-After backoff, and a partial push can never look like success — `sleep done` auto-retries once on failed pushes, then errors loudly with the failed slugs.
- **Git triggers**: best-effort `post-commit` / `pre-push` hooks sync automatically (they never block or fail git).

#### Enabling it (guided)
```bash
dreamcontext config task-backend clickup
```
Interactively this: gitignores the derived mirror/sync state → prompts for the API key (stored in the gitignored `state/.secrets.json`, mode 0600 — never `.config.json`) → tests the connection → lets you **pick the list from the API** (no URL hunting) → offers to provision custom fields → runs the first sync. Non-interactively it prints the next steps.

#### Manual / scripted configuration
```bash
# Store the API key out of shell history (preferred): pipe it
echo "$CLICKUP_TOKEN" | dreamcontext config clickup-token
dreamcontext config clickup-token                  # or prompt interactively
dreamcontext config clickup-token --user <person>  # scope a token to one person

# Set the sync target explicitly
dreamcontext config clickup-list <teamId> <spaceId> <listId>
#   --migrate : changing lists → next sync recreates every task in the NEW list
#   --keep    : tasks were moved within ClickUp itself; keep existing mappings

# Map a roster person to a ClickUp member (assignee round-trip)
dreamcontext config clickup-member <person> <memberId> [--token-env <ENV>]

# Back to local-only
dreamcontext config task-backend local
```

#### Day-to-day sync commands
```bash
dreamcontext tasks sync [push|pull|both]   # default: both; no-op on the local backend
dreamcontext tasks sync --hook             # best-effort mode for git hooks (never fails, exit 0)
dreamcontext tasks sync --json             # machine-readable sync report
dreamcontext tasks members [--json]        # people with access to the remote list (assignee candidates)
dreamcontext tasks provision               # create recommended + override-declared custom fields (reuses existing ones by name)
dreamcontext tasks sync-hooks install|uninstall   # manage the git sync triggers
```

#### Inspecting state
```bash
dreamcontext config show        # shows task backend, ClickUp token presence (masked), and list id
```
The mirror, sync ledger, and conflict files are derived and gitignored — never commit them, never hand-edit them.

### GitHub Issues

The same backend interface, talking **plain GitHub Issues over REST** (no GraphQL). Tasks map ~1:1 onto issues — the **issue body is the task markdown** — and the four-state status is carried by issue `state`/`state_reason` plus `dc:*` labels.

#### What it does
- **Bidirectional sync** (`push`/`pull`/`both`) between local task files and a repo's Issues.
- **Status mapping:** `completed` → issue **closed** `state_reason: completed`; `todo`/`in_progress`/`in_review` → **open** + a `dc:*` sub-status label (`dc:in-progress`, `dc:in-review`; `todo` = no label); reopen → **open** `state_reason: reopened`.
- **Soft-delete (the one divergence from ClickUp):** `tasks delete` **closes** the issue as `state_reason: not_planned` — it NEVER hard-deletes (GitHub REST can't, and issue history is preserved). Inbound, a `not_planned` close removes the local mirror (any unsaved local edits are preserved to `.conflicts/` first).
- **Fields as labels:** priority/urgency/tags/version ride as labels (`priority:*`, `urgency:*`, `version:*`, plus your plain tags). RICE stays local-only (no native custom fields on plain issues — see Tier-2).
- **User custom fields + dates in the body:** override-declared `select` fields become `<key>:<value>` labels; other custom fields land in a `<!-- dc:fields -->` block, and a task's start/due dates in a `<!-- dc:dates -->` block — both composed above the prose and stripped before the 3-way merge so they never pollute the body diff.
- **Assignees:** `person:<slug>` tags ↔ issue assignees (must be repo collaborators); a non-collaborator assignee is skipped gracefully, never a 4xx that aborts the sync. Names **resolve against the live roster** (same matcher as ClickUp: exact/fuzzy → canonical slug, ambiguous → abort, unmatched → warn, never silently dropped). See "People & assignees" in [tasks-and-features.md](tasks-and-features.md).
- **Changelog as comments:** task changelog entries post as issue comments (union-merged, deduped — same pattern as ClickUp).
- **Conflict safety + watermark:** reuses the SAME generic sync engine (ledger / watermark / op-queue / 3-way merge) as ClickUp, unchanged. Watermark is the issue `updated_at` (server time). Delta fetch is `GET /repos/{o}/{r}/issues?state=all&since=<ISO>` with **page-number pagination** (pull-requests filtered out).
- **Rate-limit hardened:** paces under GitHub's 5000 req/hr cap with Retry-After backoff; a partial push can never look like success.

#### Enabling it (guided)
```bash
dreamcontext config task-backend github
```
Interactively this: gitignores the derived mirror/sync state → prompts for a token (stored in the gitignored `state/.secrets.json`, mode 0600 — never `.config.json`) → tests the connection (`GET /user`) → lets you **pick the repo from the API** → offers to provision the recommended `dc:*` labels → runs the first sync.

#### Manual / scripted configuration
```bash
echo "$GITHUB_TOKEN" | dreamcontext config github-token   # also reads GITHUB_TOKEN / GH_TOKEN from the env
dreamcontext config github-token                          # or prompt interactively
dreamcontext config github-repo <owner> <repo>            # set the sync target explicitly
dreamcontext config task-backend local                    # back to local-only
```
Token scope: a classic PAT needs `repo`; a fine-grained token needs **Issues** (read/write) + **Metadata**. The day-to-day sync commands (`tasks sync`, `tasks members`, `tasks provision`, `sync-hooks`) and `config show` work identically to ClickUp — they're backend-generic.

#### Deferred — Tier-2 (GitHub Projects v2)
Priority/urgency/status as first-class **board fields** would need GitHub **Projects v2**, which is GraphQL-only and doesn't fit the REST adapter cleanly. It's a documented Tier-2 follow-up; this backend ships **plain Issues only**.

**Key mental model:** local markdown is canonical; the cloud provider is a sync *target*, and only ONE is ever active. A user on the local backend has both ClickUp **and** GitHub *available*, just not *enabled* — point them to `dreamcontext config task-backend <clickup|github>`.

---

## Web Dashboard

A local React 19 web UI served by a zero-dependency Node HTTP server (ships in the npm package).

```bash
dreamcontext dashboard                 # open at http://localhost:4173
dreamcontext dashboard --port 8080     # custom port (or DREAMCONTEXT_DASHBOARD_PORT)
dreamcontext dashboard --no-open       # start without opening the browser
dreamcontext dashboard --host 0.0.0.0  # expose on your network (default: loopback only)
dreamcontext dashboard --vault <name>  # open a specific registered vault
dreamcontext dashboard --launcher      # vault-agnostic launcher mode (resolves vault per request)
```
A SessionStart hook auto-opens it when a session starts and no server is running (opt out with `DREAMCONTEXT_AUTO_DASHBOARD=0`).

**What's in it:**
- **Kanban board** — drag-and-drop, multi-select filters (status/priority/urgency/tags/version, +assignee on a cloud backend) with type-ahead, sorting, grouping; Notion-style task detail panel to create tasks, change status, edit start/due dates and custom fields, add changelog entries. The **version filter is sprint-aware** — current / planning / released sprints with set-current + mark-complete actions (backed by `state/.active-version.json`).
- **Eisenhower matrix** — priority×urgency quadrant planning; **Scatter view** uses RICE scores.
- **Core editor** — split-pane markdown editing + live preview for soul/user/memory/etc.
- **Knowledge manager** — search, pin/unpin; **Feature PRD viewer**; **SQL ER diagram** preview for data-structures.
- **Version manager** — plan and release versions.
- **Settings — cloud tasks** — enter the ClickUp/GitHub API token from the UI (written to gitignored `state/.secrets.json`, masked, never echoed), Test Connection, and **preview-then-provision** custom fields (a dry run lists what would be created vs. already exists); plus a **Task Format & Custom Fields** editor for `overrides/task.md` (raw template + structured field schema).
- **Sleep tracker** — debt gauge, session-history timeline, and a list of every manual change made through the dashboard (recorded to `.sleep.json` so the agent consolidates your edits during sleep).
- **Brain graph** — interactive network of memory/knowledge/features/decisions with explicit + inferred edges.
- **Council Hall** — every debate as a searchable card grid; detail view with Overview / Agents / Matrix tabs.
- **"What is this?"** explainer page with live faculty diagrams.

Light/dark with system detection.

---

## Desktop App (macOS beta)

A native **Tauri 2** app that wraps the same dashboard server so you manage every project from one window. Ships via the desktop release + macOS one-line installer (not the npm package). On macOS, `dreamcontext setup` offers to install it, and `dreamcontext upgrade` updates it automatically when installed — so you rarely run these by hand.

```bash
dreamcontext app install     # install to ~/Applications (no admin, no quarantine prompt)
dreamcontext app update      # update to the latest release
dreamcontext app status      # show installed version and state
#   --from <path>  : install/update from a local .app/.tar.gz/.zip instead of GitHub Releases
#   --dir <dir>    : install directory (default ~/Applications)
```

- **Multi-vault launcher** — lists every registered vault; opens each project in its own window (pinned via a request header); per-project status dot (green up-to-date / yellow needs-update / red folder-gone) with an in-UI `update`.
- **Federation board** — projects rendered as Excalidraw-style cards; click source→target to wire a live "reads" relationship (violet wire = one project reads another's canonical memory live during recall; never a copy), gated by the target being shareable.
- **In-app onboarding** — quiz-style wizard creates or initializes a project, scaffolds `_dream_context/`, runs `setup`, installs the global CLI; deterministic, LLM-free.
- **Sleepy — notch quick-capture (beta)** — a global-hotkey transparent notch panel with a mascot whose mood follows sleep debt. Pick a vault, type a thought, choose: **Learn** (save to memory + enrich), **Ask** (one-shot Q&A, nothing saved), **Sleep** (trigger a full consolidation for that vault).
- Delivery is CLI/curl-driven (no Apple notarization); prefers your auto-upgrading global CLI over its bundled copy. First launch may need right-click → Open.

---

## Federation (cross-project recall)

Most people end up with more than one dreamcontext project. Federation lets projects discover each other and **recall across each other live** — read-only, local-only, no server, and **nothing is ever copied between vaults**. Each vault stays the single source of truth for its own knowledge.

### Vault registry
```bash
dreamcontext vaults add <name> <path>            # register a project directory as a vault
dreamcontext vaults list                         # list registered vaults
dreamcontext vaults discover [root] [--register] # find every _dream_context/ under a tree (and register)
dreamcontext vaults remove <name>
```

### Connections (read edges)
```bash
dreamcontext connect <vault> --direction out [--topics a,b]   # out = a read edge (you read the peer)
dreamcontext connections list                                 # who this vault reads
dreamcontext disconnect <vault>
dreamcontext config shareable on|off    # opt THIS project IN/OUT of being recalled by peers (default off/private)
```

### PULL — recall already spans peers
Plain `memory recall` automatically searches eligible readable peers alongside the current vault. Hits are namespaced `<vault>::<type>/<slug>` so provenance is always visible.
```bash
dreamcontext memory recall "<query>"                 # current vault + eligible readable peers (default)
dreamcontext memory recall "<query>" --vault <name>  # current + one named peer (repeatable)
dreamcontext memory recall "<query>" --connected     # current + out/both connections
dreamcontext memory recall "<query>" --all-vaults    # current + every shareable vault
```
Eligible = direction `out`/`both`, not stale, AND the peer is `shareable: true`. Non-shareable peers are silently excluded. If no eligible connections exist, recall is local-only.

### Reading a specific peer (beyond recall)

Recall is the cheap first pass. When you recognize a **specific** connected project actually holds what you need — its code, a decision, a schema — go straight to it instead of guessing or re-deriving:

```bash
dreamcontext snapshot --vault <name>     # print that peer's full context snapshot (orient fast)
dreamcontext federation peers            # one-line summary of each readable peer + its active work
```
- **Read its files directly.** A peer is a normal directory on disk — resolve its path (from `vaults list` / the snapshot's Connected projects) and `Read`/`Grep` inside its `_dream_context/` or source tree.
- **Dispatch an explorer scoped to it.** For anything non-trivial, send `dreamcontext-explore` with the peer's path in the prompt ("explore `<peer-path>` for …") so it searches there with context-first discipline.
- A connection is a standing "may read" agreement — there is no per-situation rule to wait for. If your memory says a sibling project is relevant, read it.

### Ambient awareness
The session snapshot includes a `## Connected projects` section. For a live summary: `dreamcontext federation peers`. Inspect / clean up: `dreamcontext federation status`.

### Copy-based sync is DISABLED (parked on the roadmap)
Earlier builds pushed a lossy digest into peers at sleep (`federation sync` / `federation drain`) and ingested `federated: true` copies. That broke single-source-of-truth (stale copies, false conflicts) and is now **inert no-ops**; the `sleep-federation` specialist is **not** dispatched. **Do NOT fire `sleep-federation`** during sleep. To remove leftover copies from the old path:
```bash
dreamcontext federation purge --all                # remove every federated:true copy here
dreamcontext federation purge --vault <name>       # remove only copies from one peer
dreamcontext federation purge --dry-run            # preview
```

---

## Council (multi-persona debates)

Structured debates for load-bearing decisions (architecture, migrations, hiring, brand critiques). N personas × N rounds, each persona its own sub-agent with a scoped prompt, model, and aspects; a synthesizer writes the verdict. Also available as the `council` skill pack + `/council` skill.

```bash
dreamcontext council create "Should we migrate Postgres → Firestore?" --rounds 2
dreamcontext council agent create migration-risk-auditor --model sonnet --aspects operational-risk,rollback
dreamcontext council agent create dx-champion --model opus --aspects developer-experience
dreamcontext council round start 1
dreamcontext council round end 1        # injects cross-context for round 2+
dreamcontext council round start 2
dreamcontext council round end 2
dreamcontext council synthesize         # prints the manifest the synthesizer reads
dreamcontext council complete
dreamcontext council promote <id>       # copy the verdict into knowledge/decision-<slug>.md
dreamcontext council list [--unpromoted|--all]
dreamcontext council show <id>
```
State lives in `_dream_context/council/<id>/` (`debate.md`, `round-log.md`, `final-report.md`, per-persona folders). During sleep, check `council list --unpromoted` and promote if the user engaged positively. Ships `council-persona` + `council-synthesizer` sub-agents. Rendered in the dashboard's Council Hall.

---

## Marketing (`mk`)

The Meta marketing skill surface (cohorts, campaigns, competitor ingest, learnings), paired with the `meta-marketing` + `growth` skill packs.

```bash
dreamcontext marketing   # alias: dreamcontext mk
dreamcontext mk --help   # subcommands (cohort, campaign, competitor, learnings, rem-sleep, …)
```
If `_dream_context/marketing/` exists, run `dreamcontext mk rem-sleep` as part of the sleep cycle (see [sleep.md](sleep.md)). PreToolUse gates protect `marketing/.env`.
