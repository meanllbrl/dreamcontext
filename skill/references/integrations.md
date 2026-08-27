# Integrations — ClickUp / GitHub, Dashboard, Desktop App, Federation, Council, Marketing

This reference covers everything beyond the local markdown brain. **If a user asks whether dreamcontext integrates with ClickUp or GitHub Issues, runs a dashboard, syncs across projects, lets a *team share one brain*, or runs debates — the answer is yes.** Details below.

> **"I want to use dreamcontext WITH my team / with other people."** That is the **shared brain repo** — see [Team brain sync](#-team-brain-sync-shared-brain-repo-collaborate-on-one-brain) below. Don't confuse it with the three neighbors: **cloud task sync** (ClickUp/GitHub Issues) mirrors only *tasks*; **federation** is read-only cross-*project* recall (no copying); the shared **brain repo** git-syncs the *whole* `_dream_context/` so several people push/pull/merge the same tasks + knowledge + features.

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
dreamcontext tasks sync pull --reconcile   # heal assignees + version that sit BELOW the watermark
dreamcontext tasks sync --refresh-meta     # force-refresh cached statuses/members/fields (skip the hourly throttle)
dreamcontext tasks members [--json]        # people with access to the remote list (assignee candidates)
dreamcontext tasks provision               # create recommended + override-declared custom fields (reuses existing ones by name)
dreamcontext tasks sync-hooks install|uninstall   # manage the git sync triggers
```

#### Inspecting state
```bash
dreamcontext config show        # shows task backend, ClickUp token presence (masked), and list id
```
The mirror, sync ledger, and conflict files are derived and gitignored — never commit them, never hand-edit them.

#### Gotchas (#184 — learned the hard way)

**Prefer one list per project — but a shared list is now survivable (#177).** A ClickUp
list shared by two dreamcontext projects pulls the other's tasks into your brain. A
foreign `completed` task then reads as proof that THIS project has the capability when
the work actually landed in a sibling repo — a sleep specialist once read one and
concluded "already done", nearly dropping a whole work group. Three layers now guard
against it:

- **Provenance stamp.** Every pushed row is stamped with an invisible `dcproject:<id>`
  tag identifying the owning project. On pull, a row whose stamp names *another* project
  is recorded with a `source_project:` frontmatter field and shown `⚠ FOREIGN` in the
  SessionStart snapshot and `⚠ foreign:<id>` in `tasks list`, so it is visibly foreign.
  The id is derived from `projectId` in `.config.json`, else the first `linkedRepos` URL,
  else the project folder name; unstamped rows (created in the ClickUp UI, or pushed
  before this shipped) are always treated as native, so there are no false positives.
- **Scope filter.** Set `clickup.scope: "project"` in `.config.json` to *skip importing*
  foreign rows entirely (unstamped rows are still pulled — we never silently drop a row
  we can't prove is foreign). Default `"all"` keeps every row (marked, not dropped).
- **`dreamcontext doctor`** warns when two registered projects point at the same list.

The fix is still ideally one list per project; the above makes a shared list safe when
that isn't possible.

**Set the list's statuses in the ClickUp UI BEFORE the first sync to a new list.**
ClickUp API v2 cannot write folder/list statuses (`PUT /folder/{id}` with
`override_statuses` returns `override_statuses:false`), so dreamcontext cannot create
them for you. If a dreamcontext status (`todo`/`in_progress`/`in_review`) has no name
match on the list, the push omits the field and ClickUp stamps the list's first open
status — every task landing in e.g. `backlog`. The sync warns when this is about to
happen; heal it by adding the status in the UI, then:
```bash
dreamcontext tasks sync --refresh-meta   # bypass the hourly meta cache
```

**Changing the sync target invalidates the cached list meta automatically.** The
cached statuses/members/field-defs and the pull watermark are stamped with the list
they describe, so repointing `clickup-list` — via `--migrate`, `--keep`, the dashboard,
or a hand-edited config — drops them and re-reads the new list in full. You should
never need to hand-edit `state/.tasks-sync.json`; if you think you do, that is a bug.

**ClickUp lowercases tag names**, and `version` rides the tags as `version:<v>`. A
sprint pushed as `S5 (Jul 13 - Jul 17)` comes back as `s5 (jul 13 - jul 17)`. The pull
restores the canonical spelling by folding against `RELEASES.json` + the active
sprint, so register a sprint before syncing tasks into it — an *unregistered* version
cannot be canonicalized and will not match a sprint bucket on the board. A version tag
added in ClickUp after import lands below the sync watermark and needs:
```bash
dreamcontext tasks sync pull --reconcile   # heals assignees + version below the watermark
dreamcontext tasks version <task> "S5 (Jul 13 - Jul 17)"   # or set it directly
```

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

### What a pull may NOT touch — local-only fields — backend-generic

A remote backend owns a **closed set** of task fields: name, status, priority, urgency,
tags, version, start/due dates, assignees, `custom_fields`, and the provenance stamps.
**Everything else on a task is LOCAL-ONLY** and a pull must return it exactly as it
found it — most importantly `objectives:` (the roadmap links; a `string[]` no remote
can express), plus `rice`, `parent_task`, `related_feature`, `description`, and any
field a project's own override adds. This matters more than it sounds: `state/*.md` is
**gitignored**, so a field a pull drops has no history to restore it from.

Two guards enforce it, and both are LOUD rather than silent:
- The merge re-applies any local-only field it would have dropped and **names it in the
  sync report** (`warning: pull <slug>: local-only field(s) … were preserved`). Seeing
  that warning at all means a mapping regressed — report it.
- A mirror whose **file** is missing (a lost `state/` file, a `.tasks-map.json` re-slug)
  is **rebuilt from the remote *plus* the ledger's last snapshot**, so its local-only
  fields come back instead of being silently reset. The report says `REBUILT` and lists
  the restored fields — verify them.

**Every pull also backs up what it overwrites.** Mirrors a pull rewrites or removes are
copied first to `state/.pre-pull-<stamp>/` (gitignored, newest 5 runs kept), and the path
is printed at the end of the sync. That is the recovery path for "the pull changed
something I wanted" — `hard-refresh` has always had one; now an ordinary pull does too.

If the roadmap board suddenly reads *"no tasks yet"*, run `dreamcontext doctor`: it
compares the committed `knowledge/roadmap/board.md` against the live task files and
flags any objective whose links all vanished while the tasks still exist.

### Healing duplicate task families (`tasks dedup`) — backend-generic

**When to run it:** the committed sync ledger (`state/.tasks-map.json`) is the ONE file that travels with a team-shared brain (full-repo mode) while every other cloud-sync artifact stays per-machine and gitignored (`state/*.md` mirrors, `state/.tasks-sync.json`, the op queue). A team merge that conflicts on that ledger — or any corruption of it — can leave a pull unable to match an incoming remote task back to its existing local mirror, so it mints a fresh one instead: `state/<slug>-2.md`, `-3.md`, `-4.md`, each a new dcId pointing at the SAME remote task. Symptoms:
- `dreamcontext tasks list` shows what looks like the same task **2–4 times**, usually with a numeric suffix on the name/slug.
- A teammate reports their `state/` directory has grown far beyond the real task count after a brain sync.
- A recent full-repo team-merge resolved (or silently ignored a conflict on) `.tasks-map.json`.

Run it: `dreamcontext tasks dedup`. Never hand-delete the extra `state/<slug>-N.md` files or hand-edit `.tasks-map.json` to "fix" this — that's exactly the ledger every sync command trusts, and a wrong hand-edit can re-orphan the mapping instead of healing it.

**LOCAL-ONLY guarantee:** `tasks dedup` never talks to ClickUp or GitHub — no adapter is ever constructed, so it cannot create, update, or delete anything remote. It heals only local state: it merges each duplicate family down to one canonical file (keeping the newest body, unioning changelogs), repoints the sync ledger to that canonical slug (keeping the newest `remoteId` mapping), and removes the now-redundant mirror files. Safe to run even without cloud sync configured.

**`--dry-run` first, always.** `tasks dedup --dry-run` prints the exact plan — every duplicate family, which slug survives, which files get removed — without touching anything on disk. Read the plan before applying it, especially on a brain you didn't create the duplicates in.

**`--yes` is required to actually mutate.** A non-dry-run run without `--yes` prints the plan and, in a non-interactive session, refuses and exits non-zero rather than guessing (same idiom as `tasks delete`). Apply with:
```bash
dreamcontext tasks dedup --dry-run   # inspect the plan first — always
dreamcontext tasks dedup --yes       # apply: merge families, repoint the ledger, remove the -N files
```

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

The sidebar is grouped into **Workspace** (Sleepy, Tasks, Council), **Memory** (Core, Knowledge, Features, Taxonomy), **Brain** (Map, Sleep Cycle), and **Control** (Packs, Settings), plus a "What is this?" page.

**What's in it:**
- **Sleepy** (Workspace) — the dashboard's Search + Ask surface: a scoped recall widget that runs the same engine as the CLI (empty query = browse; typing = live debounced BM25; "Intelligent" = a Haiku intent pass), plus an in-app **interactive Claude Code** agent (multi-session tabs, split panes; desktop-gated, read-only by default) with an optional **Chat view (BETA)** — see below. This is the dashboard twin of the desktop Sleepy notch. The overlay's chrome is a single 44px row (window controls + tab strip merged, no page title), and tab kinds read as mono glyphs rather than emoji: `◇` Claude agent, `◆` Claude chat, `>_` plain login shell.
- **Tasks board** — drag-and-drop Kanban with **saved views** (each carrying its own persisted filter/sort/grouping), a two-pane **include/exclude** filter (status/priority/tags/version/assignee) with type-ahead, a **Versions** popover, toggleable card **Properties** badges, and an **At-Risk alert**; view prefs persist shared (`overrides/board.json`) or local (`state/board.local.json`). Notion-style task detail panel to create tasks, change status, edit start/due dates and custom fields, add changelog entries. The **version filter is sprint-aware** — current / planning / released sprints with set-current + mark-complete actions (backed by `state/.active-version.json`).
- **Eisenhower matrix** — priority×urgency quadrant planning; **Scatter view** uses RICE scores.
- **Time-axis task views** — **Timeline (Gantt)** rendering each task's start→due range, a **Calendar**, and an **Activity heatmap** of completion cadence (all driven by the same `start_date`/`due_date` range).
- **Core editor** — split-pane markdown editing + live preview for soul/user/memory/etc.
- **Knowledge manager** — search, pin/unpin; **Feature PRD viewer**; **SQL ER diagram** preview for data-structures.
- **Taxonomy** (Memory) — view and edit the tag vocabulary (facets, aliases) from the UI; mirrors `dreamcontext taxonomy`.
- **Packs** (Control) — browse and install/refresh skill packs from the UI.
- **Version manager** — plan and release versions.
- **Settings — cloud tasks** — enter the ClickUp/GitHub API token from the UI (written to gitignored `state/.secrets.json`, masked, never echoed), Test Connection, and **preview-then-provision** custom fields (a dry run lists what would be created vs. already exists); plus a **Task Format & Custom Fields** editor for `overrides/task.md` (raw template + structured field schema).
- **Sleep Cycle** (sleep tracker) — debt gauge, session-history timeline, and a list of every manual change made through the dashboard (recorded to `.sleep.json` so the agent consolidates your edits during sleep).
- **Map** (brain graph) — interactive network of memory/knowledge/features/decisions with explicit + inferred edges.
- **Council Hall** — every debate as a searchable card grid; detail view with Overview / Agents / Matrix tabs.
- **"What is this?"** explainer page with live faculty diagrams.
- **What's New** (sidebar footer) — the release history, plus a once-only popup on the launch after something ships (unread tracked per entry in localStorage). **Exactly one announcement per version**: the feed is a version history, not a feature stream, so a release that shipped three things is three blocks in ONE page, and a second entry claiming the same version is dropped at parse time. Each page is a JSON *story* (`dashboard/public/announcements/<version-slug>.json` + an entry in `announcements.json`) built from real screenshots of the app — and, since 0.22, real **clips**: a `video` block or a hero `clip` plays an mp4/webm recorded by driving the actual app, with a required poster standing in wherever a still is needed. Video is served by `src/server/static.ts` through the shared `serveMedia` helper with byte ranges (`206`), because WKWebView refuses a clip the server won't range-serve — silently. Authoring one is the repo-local `announcements` skill's job; producing a motion-graphics promo instead of a screen recording is the `dreamcontext-reel` skill's.

Light/dark with system detection.

### Agent Chat view (BETA)

An alternate, settings-gated renderer for the SAME embedded agent: instead of xterm.js drawing Claude Code's raw TUI, a headless `claude -p --output-format stream-json` conversation is rendered as native app UI — streaming markdown bubbles, collapsible tool cards with status/duration, and Claude's permission prompts / `AskUserQuestion` as clickable cards (options + multiSelect) instead of a numbered-list readline prompt. It is the **same engine, different renderer** — same `claude` binary, same permission model (no-bypass → Auto/`auto`, bypass → `bypassPermissions`), same per-vault agent-session-map identity registry, same SessionStart/Stop hooks (brain preload, sleep debt all fire normally).

- **Discovery:** Settings → Agents → **"Agent screen"** picker — **Terminal** (default) or **Chat (BETA)** (`chatView` in `agent-ui.json`). A mutually-exclusive SWAP, not a superset: the chosen surface takes over every Claude entry point (＋ New, ⌘T/⌘D, empty state, reopened/resumed tabs, Sleep / brain-resolve / delegate spawns) — chat mode never opens a terminal Claude and vice versa. Plain shells (⌃`) stay available in both modes; already-running sessions keep their surface; a tab saved under one surface resumes the same conversation in the other (shared transcript + conversation UUID).
- **Resume interop:** a chat and a terminal session both pin/resume by the SAME Claude conversation UUID, so either surface can pick up a conversation the other started — a chat pane offers "Continue in Terminal view" (e.g. if question-routing isn't available), and a terminal tab offers "Open in Chat (BETA)" to reopen its conversation natively.
- **Interrupt:** a Stop button sends the CLI's `interrupt_receipt_v1` control request; a short watchdog escalates to SIGINT→kill if the turn doesn't wind down.
- **Live model/effort switch:** the composer's pickers switch a RUNNING chat — model via the CLI's `set_model` control request, effort via a headless `/effort <level>` command frame (both apply from the next turn; the CLI confirms with a re-emitted init / a synthetic "Set effort level to …" bubble).
- **Transcript replay on resume:** resuming a conversation (chat→chat across launches, or terminal→"Open in Chat") replays its on-disk transcript (`GET /api/agent/chat-history`) above an "earlier conversation" divider — a resumed chat never opens blank.
- **Past chats (⌘⇧O).** Every conversation this project has ever had is on disk and resumable, but the surface used to reach only the ones still holding a tab — closing a chat lost it. The picker lists them all: **＋ New ▾ → Past chats** (below a rule; the header keeps ONE primary action and does not grow a second pill), the zero-tab empty state, or ⌘⇧O. Rows carry the first thing you said, the most recent thing you said, a day header, the branch and the transcript size; picking one resumes it as an ordinary tab **titled from the conversation** with its transcript replayed, and picking one that is already open FOCUSES that tab (two CLIs `--resume`d onto one transcript interleave their appends). Search is server-side over every prompt harvested from a session's head, so a word from the MIDDLE of a conversation finds it; tokens AND together.
  - **Agent runs are withheld.** `~/.claude/projects/<slug>/` holds every conversation rooted in the project, and in one that uses the orchestration skills most of them were never yours — on this repo, 119 of 372 (27 Sleep-chip consolidations, ~60 goal-skill builders, scheduled automations, council personas, delegate agents). A sub-agent dispatched with the Agent *tool* is excluded structurally (`isSidechain`, own file under `<id>/subagents/`); the rest have **no** structural marker — same `entrypoint`, `userType` and `promptSource` as yours (verified across the corpus) — so they are classified off their FIRST PROMPT: the briefs this project writes verbatim (sleep / dream-sync / delegate / automation, matched against the real constants) plus the role-assignment shape every orchestrated brief opens with (`You are the goal-planner…`, `ROLE: You are a PLAN REVIEWER…`, optionally behind `ultrathink` or a `# Your role` heading). Because the second rule is a heuristic it is never destructive: the footer says *"N agent runs hidden — show"*, and the count follows the current query rather than the corpus.
- **Rewind:** hovering any of your messages offers **↺ Rewind** — a confirm card, then the CLI's `rewind_conversation` control request rewinds the conversation to just before that message and prefills it in the composer for re-editing. Conversation-only: files are NOT reverted (checkpoint code-restore remains a Terminal-view feature).
- **Slash menu:** typing `/` at the start of a chat draft opens the SAME skill picker the terminal composer uses (the shared `SkillPickerPopover`), so skills/commands are discoverable in chat instead of having to be remembered — picking one prepends `/name` to the send.
- **Steering + message queue — ⏎ while it works.** ⏎ during a turn **STEERS**: the message is written to the turn already running, and the CLI folds it in at its next tool boundary (measured on 2.1.220 — same turn, one `result`, and everything pending at that boundary arrives together). That is the terminal's own readline behaviour; a correction lands in seconds instead of waiting out a long turn. It appears in the transcript at once, marked *sent mid-turn*, because the tool calls rendered below it were decided before it was read.
  - **"Not this turn, the next one"** is a separate gesture: the accent-outlined **⇡** button beside Stop. Those rows dock as a strip **above the composer** — numbered, each **editable in place** (⏎ saves, ⇧⏎ newlines, Esc cancels, saving an empty row deletes it), each with **Send now** (cut this one into the running turn, leaving the rest in line) and **✕**, plus **Clear** for the lot. They drain **one per turn**, in order, as each turn settles — never a concatenated batch.
  - While a turn runs the toolbar therefore offers **three** live actions: Stop `■`, Queue `⇡`, Send `↑` (= ⏎).
  - Three rules keep it honest — **Stop PAUSES the queue** (an interrupt's own `result` frame is a busy→idle edge like any other, so without this, pressing Stop would fire the next queued message in the same breath as the interrupt; the strip says *paused* and offers **Resume** / **Clear**); a **dead session keeps its rows** rather than spending them (they are the only copy of that text — Resume, then Send now); and a ⏎ that **could not** steer (a permission card is open — answering it is the card's own job) parks as a row flagged `steerWhenPossible` and takes the **first opening** it gets, so ⏎ can never silently degrade back into "waits for the turn to end".
  - The steer/drain decisions and the row algebra are pure and tested (`chat/chatQueue.ts` — `canSteer`, `nextAutoSteer`, `shouldDrainQueue`; `tests/unit/chat-queue.test.ts`). End-to-end: `npm run verify:chat-steer`.
- **Prompt history (↑/↓):** ↑ in the composer walks back through THIS conversation's own past prompts — including the replayed transcript of a **resumed** one, since re-running an earlier turn is half the point of resuming — and ↓ walks forward, restoring the draft that was displaced when the walk began. Consecutive duplicates collapse to one entry. It never eats what you are typing: with a non-empty draft ↑ only recalls from caret position 0 with nothing selected, ↓ is a history key only mid-walk, the slash menu keeps ↑/↓ while open, and a recalled prompt starting with `/` does NOT spring the command menu (⏎ would complete instead of re-sending). Pure + tested in `chatEntities.ts` (`promptHistory`, `canRecallHistory`, `stepHistory`).
- **Inline media:** an image the transcript references renders inline in the bubble (click → lightbox); video/audio referenced from inside the project stream with seek support. A media file OUTSIDE the project root can't be drawn by the page at all, so it renders as an **open ↗** chip that hands the real file to the OS viewer (`POST /api/agent/reveal`, below) instead of a dead path. A referenced path that is **not** media (a `![doc](handbook.pdf)`, anything with no element that could render it) becomes the same clickable chip a backticked path does, rather than an `<img>` guaranteed to fail.
- **PDFs open in the app**, at full window, the way an image opens the lightbox — `chat/PdfViewer.tsx`, portalled to `<body>` at the ImageViewer's z-index. `classifyReference` gives `.pdf` its own `kind`, so `ChatPane.handleOpenFile` routes it away from the slide-over: the panel's text branch asks the JSON endpoint for a binary, which for any real document answers *"File exceeds the preview size cap"* — the same dead end a 44-second clip hit before it was streamed. `/agent/file?raw=1` now serves `application/pdf` (streamed, ranges intact, `Content-Disposition: inline`), and the document is drawn by the **engine's own viewer** in an `<iframe>` — scroll, search, select, print, thumbnails for free, versus a megabyte of pdf.js to reimplement less. The viewer probes the URL with a one-byte ranged GET before embedding, so a file outside the project offers *Allow access* rather than a blank rectangle; where the engine has no PDF viewer at all (`navigator.pdfViewerEnabled === false` — headless Chromium, some WebKitGTK builds) it says so and points at **Open on computer**, which is present in every state. Closing is the **✕** in every state: an embedded plugin takes keyboard focus as it initialises and will not give it back (a synchronous, rAF and 150ms-delayed reclaim were all measured losing), so a key pressed inside the document is invisible to the page — Esc closes the viewer once a click on its own chrome has handed focus back.
- **A PDF a KNOWLEDGE note links to opens the same way.** A note is prose about material that often isn't — `[the contract](assets/msa.pdf)` beside the note distilled from it — and that link used to be the one link that led nowhere. `lib/knowledgeLinks.ts` resolves the href against the note's own FOLDER (`legal/contracts` + `assets/msa.pdf` → `knowledge/legal/assets/msa.pdf`, `_dream_context/…` taken as written, `..` unable to climb out of the vault), and `KnowledgePage` opens it in the same `PdfViewer`. Bytes come from `GET /api/graph/content?path=…&raw=1`, **not** `/agent/file`: the Knowledge page is not desktop-only, and routing a vault file through the chat surface's route would answer *"desktop only"* to a browser dashboard reading its own vault. The click handler is deliberately **not** gated on `defaultPrevented` — `installExternalLinkHandler` runs in the capture phase and has already called `preventDefault()` on exactly these links (that is what stops a filesystem href from rebooting the SPA), so treating that as "already handled" swallowed every one of them. End-to-end: `node e2e/knowledge-pdf-verify.mjs`.
- **Every file surface offers the two ways out to the OS** (`chat/FileActions.tsx`): **Open on computer** (`mode:'auto'` — the default app) and **Reveal in Finder** (`mode:'reveal'` — the file manager, outright), plus Copy path, on the slide-over panel, the PDF viewer, and the image lightbox alike. Before this the panel offered the OS only for a **folder**, so the moment an in-app preview wasn't enough — a format nothing here renders, a PDF to print, a screenshot to drag into a message — the panel was a dead end with the path sitting in its own header. A refusal is SHOWN in the surface rather than swallowed. `mode` can only ever narrow: it turns an open into a reveal, never a reveal into an open, so the never-launch-an-executable rule holds whatever the client asks for. End-to-end: `npm run verify:pdf-viewer`.
- **Rich output — the agent KNOWS it is in Chat.** A chat-spawned `claude` is byte-identical to a terminal-spawned one, so by default it writes for a TTY: it finishes a board, says "done", and names the file. Every chat spawn therefore appends a short surface briefing (`src/server/chat-surface.ts`, handed over as `--append-system-prompt-file` so the login-shell argv stays free of prose; a failed write degrades to the un-briefed agent, never to a failed spawn) telling the agent what its markdown becomes here. Five shapes, all ordinary markdown so a terminal or a raw transcript still reads fine:
  - `![caption](docs/shot.png)` / `[demo](tmp/clip.mp4)` — drawn and played in place (video/audio must be a LINK; markdown has no video syntax).
  - `![board](path/to/x.excalidraw.md)` — the **actual board**, on the same live pan/zoom `ExcalidrawPreview` canvas the Knowledge page uses, in the transcript. A tool call that wrote a board renders the same way once it finishes, so "I drew this" and "I edited this" look alike. Backed by `GET /api/agent/board-assets` (below) — without it every embedded screenshot renders blank.
  - **a path in backticks** — `src/server/routes/agent-chat.ts` becomes a chip that opens that file's preview. Free: it is already how paths get written. Deliberately narrow (needs a separator plus an extension or a trailing `/`), because a false positive is a button that opens nothing.
  - **a fenced ```dream-html block** — HTML the agent WROTE, rendered inline. Since 2026-08-26 this is the surface's main expressive channel; see the dedicated bullet below.
  - **a fenced ```dream-actions block** (JSON array) — a row of real buttons under the message; the block itself is stripped from the prose, and a fence still mid-stream is hidden rather than flashed as raw JSON. `{"label","action","id"|"path"|"text"}`, max 6, entries with no target dropped. Actions: `task`/`knowledge`/`core` (navigate the app by slug), `file`/`board` (open the preview panel), `reveal` (hand to the OS), `ask` (LOAD the composer — the agent proposes the follow-up, the user still sends it). Every action lands on a surface `ChatPane` already owns, so a button can never reach further than the user could by clicking around the same view.
  The briefing adds ONLY this surface knowledge — no persona, no workflow, no rules about the work itself — and is pinned in lockstep with the client parser by `tests/unit/agent-board-assets.test.ts`.
- **`dream-html` — the agent writes the presentation (2026-08-26; replaced the typed `chart` + `page` payloads).** A fenced ```dream-html``` block is rendered in a **network-less sandboxed iframe** wearing dreamcontext's own class kit. The trade is deliberate: the old contract let the agent express only the five renders and seven widgets we had pre-built, so a flow, a tabbed comparison, a timeline or two candidate designs side by side either fell back to prose or cost a new widget — the owner reported `page` had never once been used. We stopped constraining WHAT can be said and constrained what the markup can DO instead.
  - **Security is the Lab's html/v1 model, unchanged and unloosened** (`dashboard/src/lib/sandboxHtml.ts`, shared by both surfaces so a hardening fix cannot land on one and miss the other): `sandbox="allow-scripts"` with **no `allow-same-origin`** (the two grants together are equivalent to no sandbox), plus a srcdoc CSP of `default-src 'none'`. It can animate, compute and respond to clicks; it cannot fetch, beacon, load a remote image or touch the parent origin. The markup is therefore **deliberately NOT sanitized** — the sandbox is the boundary, not a filter. Proven at runtime, not just asserted: `npm run verify:chat-html` fires a `fetch()` and an `<img>` beacon at a sentinel host and checks nothing ever completes **while the same body's inline script demonstrably ran** (a frame that made no requests because it never executed would prove nothing).
  - **Height follows CONTENT** — the fix for the Lab card's hardcoded 232px. A one-way, numeric child→host `postMessage` reports the body's height; the host authenticates by **`event.source` identity, never origin** (a sandboxed frame's origin is the string `"null"`, so an origin check would either reject our own frame or accept every other sandboxed one) and clamps to 40–20000px. It re-reports on `ResizeObserver`, on `load`, and after a click, so a tab switch inside the block resizes the frame.
  - **The `dc-` class kit** (`chat/chat-html-kit.css`, mirrored as a drift-tested TS string because vitest stubs `.css?raw` to empty) is a READING and PRESENTATION surface, not the Lab's 232px card: headings and prose, cards, stat tiles, comparison tables, callouts, bars, funnels, **steps / flow / timeline / compare-options / tabs**, and a slide mode. The agent writes our classes and the block looks native in both themes; the briefing's class list is pinned as a subset of the kit by `tests/unit/agent-board-assets.test.ts`, so a class named to the agent but undefined in CSS fails the suite instead of silently rendering unstyled.
  - **Fullscreen is a mode, not a zoom.** ⛶ gives the same body the whole window (portaled to `document.body` — `.agent-surface`'s `contain: layout paint` would otherwise clip a `position: fixed` overlay to the chat pane, the same trap `BoardFullscreen` documents), and the mode reaches the kit via `html[data-dc-mode="full"]`, so `.dc-slide` sections become real viewport-height pages. A deck is a first-class output.
  - **The CSS is brand-overridable.** An optional, git-tracked `_dream_context/overrides/chat-html-kit.css` is served by `GET /api/chat/html-kit` and embedded **after** the base kit inside the srcdoc, so "later wins" is the whole override mechanism: a project redefines the tokens it cares about (`:root { --color-accent: … }`) or restyles individual `dc-` classes and every HTML answer in that vault follows — no fork of the app, no instruction to the agent, which keeps writing the same classes. Missing file = base kit only (a 200 with `css:null`, never an error); an unreadable or >128KB file degrades to the base kit **with a visible notice**, because a silently ignored brand sheet is a user editing a file and watching nothing happen. Read-only by design — there is no write route, since an endpoint that let a chat answer rewrite the CSS every chat answer is drawn in would be a self-modifying surface.
  - Caps: 256KB per block, 5 blocks per message, both loud. A fence still mid-stream is hidden behind the "Building a view…" pill rather than flashing half-written markup.
- **`dream-view` — the four things HTML must NOT be.** A fenced ```dream-view``` block — one JSON object, `"type":"insight"|"checklist"|"pin"|"progress"` — is what survived the retirement of `chart`/`page`. Schema, caps and the pure validator live in `dashboard/src/lib/chatViewSpec.ts` (`parseViewBlock`); the fence is found and stripped by `chatActions.ts`, which parses `dream-view` and `dream-html` in **one pass** so blocks render in WRITTEN order rather than all views above all HTML. Rendering is `chat/ChatViews.tsx`. Max 4 view blocks per message. Pinned in lockstep with `src/server/chat-surface.ts`'s briefing by `tests/unit/chat-surface-lockstep.test.ts`. A `{"type":"chart"}` or `{"type":"page"}` block from an old transcript degrades down the ordinary unknown-type path — a notice naming the type, prose untouched.
  - **`insight`** — `{"type":"insight","id":"<slug>","view":"card"|"full"}`, drawing a REAL Lab insight through the same `CHART_REGISTRY` the board and the reports page render from. This is the deliberate hole in "the agent writes the presentation": a tracked metric already HAS a canonical rendering — the synced cache, the render its manifest declares, the "as of" stamp — and an agent retyping those figures into HTML would fork the truth into two spellings of one number, one of them a transcription. So for anything the Lab tracks, the agent names the slug and the app draws it. It **composes and never mutates**: no tweak PATCH, no sync trigger, no write of any kind, because a chat message must not be able to silently re-configure a board card. `"breakdown":{"rows","cols","filter"}` mirrors the report-item contract and only seeds the pivot's OPENING axes (`ChartBodyProps.pivot`) — the card's own controls stay live and win from the first click. An unknown or deleted slug renders a named missing-insight strip, never a crash or an empty box.
  - **`checklist`** — not a chat card but a small **always-on-top OS window** (a real Tauri `WebviewWindow`, so it survives switching to another app): the user ticks steps, writes a note under each, attaches a file, fills a masked secret field, then Submit sends the whole filled-in list back as one message. **A dedicated, narrow Tauri capability** (`desktop/src-tauri/capabilities/checklist.json`, identifier `checklist-window`) grants only window chrome, targeted events and the file-attach dialog — deliberately **no `shell:*` and no `global-shortcut:*`**, since this is the one window that both renders agent-authored markdown and holds a pasted secret. `default.json` was **not edited**: `checklist-*` never joins its `windows` array, and the ack event's permission (`core:event:allow-emit-to`) was already granted transitively through `core:default` → `core:event:default`, so nothing needed adding there — the plan going in expected a one-line `default.json` edit; the real ACL manifest made it unnecessary. This is a new occurrence of the narrow-allowlist containment pattern in the `dashboard-server-security` knowledge file (whose prior occurrence is Agent Chat's `/api/agent/file`+`grant`+`reveal` gate, above). **Vault- and conversation-scoped end to end**: every storage key and the window label itself run through `labelPart()` (`checklistStore.ts`), a byte-for-byte hex encoder — every project window shares one origin and one `localStorage`, so an unscoped key would let one project's checklist state (and a pasted secret) collide with another's; hex-encoding makes that collision provably impossible, not merely unlikely. Submit travels window→window over a **targeted `emitTo`** (never a broadcast), so no other open vault's Chat surface ever receives the payload; no ack within 2s and the window stays open with a "couldn't reach the chat" strip plus a copy-to-clipboard fallback — nothing is silently lost. **Secrets, stated plainly:** a `wants:"secret"` value lives in React state only and is never written to `localStorage`; the value the user submits DOES land in the CLI's on-disk conversation transcript once sent — that's the feature working as designed, not a leak, and the field says so. Caps: 40 items, 4000 chars/note, 32KB submit payload (truncated with a visible marker past that).
  - **`pin`** — a fact that must stay visible for the whole session, rendered on the **shelf** (below), never in the transcript. `{"type":"pin","id":"dev","weight":"tag"|"row","facts":[{"label","url?","marker?"}],"lede?","detail?"}`. Re-sending the same `id` UPDATES that pin in place — the id-keyed contract `checklist` already uses — so a run that reports twice never stacks two rows. **`weight` is a REQUEST, not a command:** the agent asks for `tag` (a short chip sharing a line) or `row` (a `lede` the user can open into `detail`), and the surface is free to demote a `row` whose content is tag-sized. That is what makes the shelf's ceiling enforceable no matter what an agent sends, and both readings are correct — a demoted pin is not a failure. A pin that supplies only long text is **clamped to a lede and MARKED as clamped** (a `…` chip), so a truncated pin is never presented as complete. A `url` on a fact is **loopback-only** — `localhost` / `127.0.0.1` / `[::1]`, http or https, compared after WHATWG normalization (so `127.1` and `0177.0.0.1` are accepted as the loopback they resolve to) with userinfo, `0.0.0.0`, and every other host rejected, and the query string and fragment stripped. That last part is security, not tidiness: the permitted hosts include the dashboard's OWN port, so a pinned `?vault=`/`?token=` would be a same-origin request the agent authored. **This carve-out is pin facts only** — a `dream-actions` `url` button stays `https:`-only. Caps: 24 pins per conversation (the oldest are evicted past that, and the eviction is counted, never silent), 6 facts/pin, 48 chars/tag label, 160 chars/lede, 4000 chars/detail. **There is deliberately no cap on tags per line** — see the shelf's overflow rule below.
  - **`progress`** — `{"type":"progress","task":"<slug>"}`, and the slug is the WHOLE payload. Percent is **derived from disk, never asserted**: the server reads that task's `## Acceptance Criteria` checkboxes with the same `countCheckboxes` counter `tasks doctor` and the snapshot use (`GET /api/agent/task-progress`), re-reading as the file changes during the run, and the row also names the newest changelog entry and the first unticked criterion. **A percent the agent sends is ignored and drawn as a notice** — the number's whole value is that the user can check it. Zero criteria, an unknown slug and an all-ticked task each degrade loudly with their own notice (`no-criteria` / `unknown-slug` / `all-done`) rather than showing `NaN%` or an empty row. Clicking the row opens the full criteria list as a **floating popover** (`role="dialog"`, headed by "Run progress" + the derived count + a `×`, dismissed by the `×`, a click away, or Esc, capped at 34vh and scrolling inside itself) — deliberately NOT an in-place expansion, so the progress row costs the shelf exactly the same height open or closed and nothing below it ever moves.
  - **Degradation is loud, never silent** — the standing rule this whole fence follows. The prose above a view always survives: a `notices[]` strip renders under the view(s) and is strictly additive, never a substitute for it. Every drop — an unknown `type`, a cap breach, a bad URL, an oversized block — gets its own human-readable line, and nothing in the pipeline ever throws, including mid-stream.
  - **Boards are now genuinely full screen from every entry point.** A clicked backticked board path, a `{"action":"board"}` / `{"action":"file"}` button pointing at a board, and the embed's own head button all converge on one `BoardFullscreen` overlay — `ChatPane`-owned, portaled to `document.body`, the same technique `ChartFullscreen` uses. `SlideOver`'s old board branch and `BoardCanvas` are gone (see the correction above); a board never lands in a cramped side panel again.
- **The pinned shelf — where `pin` and `progress` live.** Two kinds of information do not belong in a transcript: session facts the user needs for the WHOLE session, and how far along a long run is. Both get a shelf **docked to the composer's top edge**, sharing its width and corners, outside the transcript's scroller — so after scrolling to the top of a long conversation and back it is still there, unchanged. It **does not react to scroll** at all (no hide-on-scroll-up, no reveal-on-scroll-down, no resize): scrolling up is usually the user hunting for a fact the shelf already holds, so hiding it then is backwards, and scroll-reactive chrome re-opens a bug class this surface already paid to close twice.
  - **Resting state is ONE tag line**, and it is never empty ceremony — the branch and, in a linked worktree, a `worktree` marker come from the server (`GET /api/agent/session-facts`: `git symbolic-ref --short HEAD`, worktree detected by `--git-common-dir` ≠ `--absolute-git-dir`), so they are true without the agent asserting anything and carry no dismiss button. The **dev-server port is the agent's to pin** — nothing on this machine can attribute a listening port to a session, and the agent ran the command.
  - **Hard two-row ceiling, the tag line included** — so at most ONE open row above it, and no sequence of agent blocks can grow a third. The tag line is the row nearest the composer and its `y` does not move when a row opens or closes above it; that is the entire reason rows open UPWARD.
  - **Overflow degrades loudly, never silently:** past the ceiling the oldest row demotes to a `⌃` tag (it demoted, it did not close — clicking promotes it back). **Tags themselves are never hidden.** There is no `+N` fold and no per-line cap: the tag area WRAPS onto as many lines as it needs, and only in the extreme does it cap at ~25% of the pane and scroll inside itself. A fact you have to press a button to see is not a pinned fact — that is the whole point of the surface, and it is why the count-chip fold was cut after live testing (2026-08-23) rather than tuned.
  - **The ceiling binds the AGENT, not the USER.** Clicking a long **pin** opens its detail in place, growing upward past two rows, capped near 40% of the pane and scrolling inside itself past that; one pin is open at a time. In-place expansion is a long pin's behaviour ONLY — a progress row's detail is a popover instead (above). The tag line and the composer do not move a pixel either way. Detail prose renders through the same DOMPurify-sanitized `MarkdownPreview` every other bubble uses.
  - Pins are **persisted per conversation** (`pinStore.ts`, the vault+id hex-keyed envelope `checklistStore` established) so they survive a reload, and the user can dismiss any one without disturbing, reordering or resurrecting another. A progress row closes itself when its task reads all-ticked and the turn ends — the tag line stays put.
- **Chat modes — Basic / Plan / Develop. Chat view only.** The composer's LEFT trigger reads `<mode> · <permission>` and opens one menu holding both. The mode is a per-session **system-prompt append written at spawn** (`src/server/chat-modes.ts`, concatenated after `CHAT_SURFACE_BRIEFING` into the same `--append-system-prompt-file`), so it says how the agent should WORK — distinct from the surface briefing, which says what the surface can DRAW and rides every chat unconditionally.
  - **Basic** — plain Claude Code. The brief is empty; nothing but the surface briefing rides along.
  - **Plan** — goal-skill's planning half, interactive: put the critical questions to the user a few at a time and WAIT, drive the open decisions (name options, recommend one, say why), ground every step in real paths and line anchors, review the plan's own weak points, then **end by creating a real dreamcontext task** with testable acceptance criteria and present it. No code is edited in a Plan session. It closes by offering the handoff as a `dream-actions` button, `{"action":"develop","id":"<slug>"}`.
  - **Develop** — goal-skill's implementing half: work in waves, validate each wave before the next and **show the evidence** (the command and its real output, not a claim), tick a criterion only when demonstrably true, log with `dreamcontext tasks log`, and STOP and report rather than silently redesign a plan that turns out wrong. **Worktrees are gated on this project, not on the mode:** the brief permits a git worktree only when the dreamcontext brain is ISOLATED from the checkout (`brainRepo.mode: full-repo`, or a linked code repo); when `_dream_context/` lives in the working tree the brief explicitly FORBIDS one, because a second checkout would fork the brain. Stated as a prohibition rather than left unsaid — an unmentioned capability is one the agent reaches for anyway.
  - **J.A.R.V.I.S** is rendered disabled with a "Soon" badge and has no behaviour; the sanitizer coerces it to `basic` if it ever reaches the server.
  - **The `develop` action** is the handoff itself: clicking it opens a **NEW** chat in Develop mode carrying the task slug as its first prompt (minted through `POST /api/agent/prompt`, so a full task spec is not truncated into the WS upgrade URL) and closes the Plan tab. New-session-per-handoff is deliberate — the plan transcript stays auditable instead of being `/clear`ed away. The Develop session is spawned under `auto` **regardless of the project's remembered permission mode**, so an agent-authored button can never escalate privilege.
  - **There is no user-settable mode default** — a fresh chat is Basic, and the mode menu deliberately has no "Set as default" (the model+effort menu keeps one). Switching mode on a live session respawns it with `--resume`, preserving its transcript, model, effort and permission mode.
- **Signing in from Chat.** An unauthenticated CLI answers a headless turn with an `authentication_failed` frame whose stated remedy (`/login`) is the one command this surface cannot run — the OAuth flow exists only in the interactive TUI. So the frame is parsed as its own `auth-required` event (never as an assistant bubble) and the composer is replaced by a **sign-in banner**, which opens a shell tab that types and submits the sign-in command; "Signed in — retry" then respawns the same conversation with `--resume`. Typing `/login` into the composer lands on the same flow instead of spending a turn. The command is never a literal: the server probes it (`claude auth status --json` → `claudeAuth.loginCommand` on `GET /api/agent/capabilities`, `src/lib/claude-auth.ts`), so a CLI too old for the `auth` subcommand is offered the TUI instead. That same probe backs **Settings → System → Claude Code sign-in**, which reports who is signed in (or that nobody is) BEFORE a surface is attempted — "installed" and "usable" are different facts. It is advisory only and never gates a spawn: a Bedrock/Vertex or `apiKeyHelper` machine probes as *unknown*, which is reported quietly and never as "signed out".
- **Installed, but invisible to the shell.** The third prerequisite state, and the one that used to read as "not installed at all": `npm install -g @anthropic-ai/claude-code` (like the CLI's own `install.sh`) puts the binary in `~/.local/bin`, which is on no default PATH — so an install that skipped the closing `export PATH="$HOME/.local/bin:$PATH"` echo leaves `claude` on disk while every `$SHELL -ilc 'exec claude …'` spawn 127s. Two halves fix it (`src/lib/claude-path.ts`): every spawn we own — terminal PTY, chat, sleepy chat/capture, tab titling, hook recall — gets `claudeAwarePath()`, which APPENDS the discovered install directory (never prepends, so a `claude` the user's rc already resolves is never redirected), and the installer performs the missing echo itself, idempotently under a `# dreamcontext:` marker, into the rc that shell actually reads (zsh → `~/.zshrc`, bash → `~/.bashrc` plus `~/.bash_profile` only if it exists, fish → `config.fish` with `set -gx`, else `~/.profile`). `GET /api/agent/capabilities` reports it as `claudePathBroken`, so **Settings → System** shows an amber *"Installed, not on your PATH"* with a one-click **Fix PATH** (`POST /api/agent/install {target:'claude-path'}`) instead of a false "Missing" — the in-app surfaces already work, but the user's own terminal can't run `claude` until the rc line lands.
- **Background shells — visible, readable, stoppable.** When the agent runs a command with `run_in_background` (a dev server, a long build, a watch), a **tray docks above the composer** listing every background shell with its status and a live elapsed clock. It sits outside the transcript scroller on purpose: a background shell outlives the turn that started it, so an inline card would scroll away while the process kept running. Each row does the two things that surface needs, and **both cost zero model tokens**:
  - **Output** opens the shell's live stdout/stderr in the slide-over, polled while it runs. The CLI streams a backgrounded command to a file on disk, and the server reads that file directly (`GET /api/agent/bg-output`, below) — so reading a background shell never spends a turn asking the agent to run `TaskOutput`, and works while the conversation is mid-turn.
  - **Stop** kills it through the CLI's own `stop_task` control request. The CLI acks `success` even for a task id that never existed, so the ack is ignored as evidence: the tray only marks a shell stopped when the CLI's `background_tasks_changed` / `task_updated{status:'killed'}` frames say so.
  A finished shell keeps its row for **two minutes** and then leaves the tray — long enough to read what it just did, short enough that a session which backgrounds dozens of commands doesn't grow a pinned wall over the conversation (the tray is docked furniture: every row it holds is height the transcript does not get, and rows past its cap scroll inside the tray rather than growing it). The command's own tool card stays in the transcript as the durable record. A stopped shell reports **stopped**, not "completed" or "failed" — a run the user killed neither finished nor errored. The roster itself comes from the CLI's `system:background_tasks_changed` push, which lists only what is STILL running, so it is used to adopt shells whose start we missed and to reconcile one that vanished without a terminal frame — never as the whole list, which would delete every finished shell.
- **Live rail (goal-skill + council):** a run of either orchestration skill reports live progress above the transcript — goal-skill's phase bar (phase chips with loop heat, implementer fork dots, wave counter; click for the phase graph) and council's chamber strip (round dots, persona stance dots, convergence meter; click for the per-persona chamber table). Both are the SAME components the Terminal view shows above its composer, and both feeds (`GET /api/agent/goal-live`, `GET /api/agent/council-live`) are scoped by conversation id, so a pane only ever shows the run ITS conversation is driving. The rail also holds the linked-task chip, and collapses entirely when nothing is live.
- **Beta limitations** (by design, not oversights): the chat WS route tracks its own live-conversation set separate from the terminal route's — a chat and a terminal resuming the exact same conversation concurrently is a known (rare) double-writer edge, not guarded against; the live rail's linked-task chip only renders when a task slug is supplied, which no entry point does yet.

**12-state redesign (component tree).** The renderer is a `chat/` subfolder under `dashboard/src/components/sleepy/`, with `ChatPane.tsx` as a thin orchestrator (view-only state: which slide-over/lightbox/quote is open) and one component per card family: `TranscriptItem` (user/assistant messages — no avatars, ever; hover bar: copy, edit=rewind, quote; assistant adds retry), `ToolCard` (collapsible — **only an Edit/Write opens by default**, because what changed in your files is the one body you always want to see; everything else, Bash above all, stays a one-line receipt you can open, since a turn is mostly shell calls and their expanded output pushed the answer off screen), `SurveyCard` (AskUserQuestion — large select rows, `k/n` progress), `PermissionCard` (Allow/Deny + an "always allow this session" checkbox that auto-answers future prompts for that tool, client-side only), `SubAgentCard` (grouped sub-agent runs), `SlideOver` (a right panel for file/media preview and sub-agent drill-in — text, media and directory listings only; a board is never drawn here, see "Boards are now genuinely full screen" below), `Lightbox` (images), `BoardEmbed` (an Excalidraw board drawn in the transcript; exports `BoardFullscreen`, the portaled overlay every board-opening entry point converges on), `ActionRow` + `chatActions.ts` (the `dream-actions` buttons and the pure parser that lifts them, plus board references, out of the prose), `PermissionModeMenu` (see below), `Banners` (empty state, **working indicator** — dots + elapsed clock, shown whenever the turn is in flight with nothing on screen yet: before the CLI's first frame, or in a gap between a tool result and the next block — stream error + retry, reconnecting, session-ended + resume), `QueuedMessages` (the docked message-queue strip — see "Message queue" above; rendered by `ChatPane` OUTSIDE the composer/banner branch so the rows survive the session ending), and `Composer` (resizable, attachments row, quoted-reply chip, skill chip, ↑/↓ prompt history). The terminal's skill picker (`Popover` + `SkillBrowser`) was extracted into a shared `SkillPickerPopover.tsx` so both surfaces render the literal same picker — the terminal composer's behavior/markup is unchanged.

**Sub-agents (Task/Agent tool).** Dispatched sub-agents do NOT stream their inner assistant text/thinking to the parent conversation — the parser instead tracks the `system:task_started` / `task_progress` / `task_updated` / `task_notification` lifecycle frames the CLI emits around a sub-agent run (description, `subagent_type`, status, elapsed, final summary + usage), reduced into one `SubAgentCard` group; the spawning tool's own raw tool card is suppressed so it isn't shown twice. Each row carries a **live meta readout** — duration, model, tokens, tool uses — assembled by `runMetaChips` from what the CLI actually reported, and nothing else: `task_progress` (emitted once per tool use) supplies the current step plus running duration/token/tool totals, while the model arrives on a different channel entirely — `resolvedModel` on the `tool_use_result` sibling of the Agent tool's own result frame, since no `task_*` frame carries it. **Reasoning effort is on no channel** (verified against CLI 2.1.220's zod schemas), so no chip ever claims one. `local_bash` tasks — a shell command the CLI backgrounded — ride these exact same frames (`task_type` is the ONLY discriminator), but they are NOT sub-agents and no longer appear in this card at all: they have their own surface (**Background shells**, below), because the affordances are opposite — an agent run has a sidechain transcript to drill into and no lifecycle you control, a shell has no transcript but does have live output and a stop button. Clicking a run opens a slide-over that renders the sub-agent's REAL transcript — the CLI writes it to a sidechain JSONL whose path is **derived server-side** from the parent conversation UUID + the task id (never a client-supplied path, and the `task_notification`'s `output_file` symlink is never trusted/read directly); if the sidechain hasn't flushed yet, the drill-in degrades to a static summary (prompt + result + usage) instead of erroring.

**New server surfaces:**
- `GET /api/agent/file?vault=&path=[&raw=1]` — the one read surface behind every path a transcript names, under the **active vault's project root** (not `_dream_context/` — that stays `graph/content`'s job). Three answers, by what the path is: a **text/markdown preview** (`{path,type:'markdown'|'text',content}`, 512 KB cap — the whole body goes into JSON); a **directory listing** (`type:'dir'`, folders first, 300 entries then `truncated`), because a folder named in a transcript is something to look inside, not an error; or **raw bytes** with `?raw=1` — images (PNG/JPEG/GIF/WebP), video (mp4/m4v/webm/mov/ogv), audio (mp3/m4a/wav/oga/ogg/flac) and **PDF** (`application/pdf`, plus `Content-Disposition: inline` so an engine without a viewer can never silently turn the open into a download), streamed with `Accept-Ranges` + correct `206` so `<video>`/`<audio>` can seek and the engine's PDF viewer can page a large document in (a 200-with-everything makes a clip unseekable in Safari) and capped at 2 GB. Security posture: desktop-gated + loopback-only (same trust model as the WS routes), a traversal guard that refuses any resolved path outside the project root, `X-Content-Type-Options: nosniff` on every response, and — because SVG can embed `<script>`/`foreignObject` — SVG is always returned as a text preview, never as `image/svg+xml`.
- `GET /api/graph/content?path=<inside-_dream_context>[&raw=1&vault=]` — the VAULT read surface (the counterpart to `/agent/file`'s project-root one), answering markdown/json/text as JSON. With `raw=1` and an allowlisted type — **PDF only** today — it answers the file itself instead: streamed, `Accept-Ranges`/`206`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`. That arm is what lets the Knowledge page display a document a note links to, and unlike `/agent/file` it is **not desktop-gated**, because a browser dashboard reading its own vault must not be told "desktop only". `raw=1` is an opt-in on the allowlist, never a mode switch: any other type falls through to exactly the JSON answer it gave before. Containment is the route's existing one — nothing outside `_dream_context/` is reachable, raw or otherwise.
- `POST /api/agent/grant` — the answer to "the file is real but it's outside the project". Rather than a dead refusal, `/agent/file` returns **403 `needs_grant`** for an outside path and the card offers *Allow access*; that click records THAT ONE absolute file path for the vault in `state/.file-grants.json` (max 500, files only — never a directory, never a pattern), after which the read succeeds. The consent is always a real user click on a named file: the agent cannot grant on its own behalf, and one grant never widens to a folder.
- `POST /api/agent/reveal {path, mode?:'auto'|'reveal'}` — hands a path to the OS, and the two modes ARE the safety story: a folder, a media file, or an inert document type (`.pdf .txt .md .markdown .json .yaml .yml .toml .csv .tsv .log .rtf .html .htm .xml .svg`) opens in the **default app**; anything else is **revealed in the file manager** (`open -R` / `explorer /select,` / `xdg-open <dir>`) rather than launched — so a `.sh`, `.command`, `.pkg` or `.app` named in a transcript can never be executed by a click in a chat bubble, while the user still gets to it in one step. Deliberately an allowlist of what's inert to view, not a denylist of what's dangerous (a denylist is one unknown installer format away from launching something). Desktop-gated, argv form (no shell), and the file must already exist. `mode:'reveal'` asks for the file manager EXPLICITLY — "show me where this is" is a different thing to want than "open this", and both are now separate buttons on every file surface — and it can only ever **narrow**: an open becomes a reveal, never the other way round, so no client (or unrecognised mode string) can unlock the executable rule. The answer reports which of the two actually happened (`{opened:true, mode:'open'|'reveal'}`).
- `GET /api/agent/board-assets?path=<board>` — the images an Excalidraw board embeds, so the transcript can DRAW the board instead of linking to it. An Obsidian board stores its screenshots as `## Embedded Files` wikilinks rather than base64 in the scene, so the board comes down as markdown through `/agent/file` but its pictures do not. `/api/knowledge-assets` already did this job for boards under `knowledge/`; this covers a board anywhere in the project (a board beside its generator, a board committed next to the code it documents), sharing one `resolveBoardAssets()` so both surfaces resolve, compress, cap and cache identically. Two independent containment layers: the same `resolveServablePath` that gates `/agent/file` decides whether the BOARD may be read (project root, or a path the user granted), and the roots handed to the resolver decide where its wikilinks may point (project root, context root, the board's own folder + its `assets/`/`Attachments/` subfolders — never a parent of either). Images only, by extension; a link that escapes is skipped, not followed.
- `GET /api/agent/bg-output?claudeId=<uuid>&taskId=<id>` — the tail of a background shell's live output, so the Chat view can show what a backgrounded command is doing **without spending a model turn**. The CLI streams each backgrounded command to `/tmp/claude-<uid>/<cwd-slug>/<conversation-uuid>/tasks/<taskId>.output`, and that path is **derived server-side** from the vault, the conversation uuid and a strictly-gated task id (`^[a-z0-9]{1,32}$` — no dot, slash or dash, so traversal is unrepresentable rather than filtered); the absolute `output_file` the stream hands the client is never trusted or read, the same rule the sub-agent sidechain follows. Returns the last 256 KB with `truncated`, and answers **200 with `exists:false`** rather than 404 when nothing has been written yet — a shell that has produced no output is a normal state, not an error. Two path details are empirically pinned and easy to get wrong: the base is a hardcoded `/tmp/claude-<uid>`, **not** `$TMPDIR`/`os.tmpdir()` (macOS sets a custom `TMPDIR` that the CLI ignores for these files), and the directory segment slugs the **realpath** of cwd.
- `GET /api/agent/chat-sessions?q=&limit=&agentRuns=1` — the project's past conversations for the Past-chats picker (`src/lib/transcript-sessions.ts`). Desktop-gated, vault-scoped, read-only, paths derived server-side. The hard constraint is that these files are **big** (this repo's own project dir is ~1 GB across ~400 transcripts, several 10–18 MB), so nothing is ever read whole: each file contributes a bounded **128 KB head** (where the first prompt — the title — lives, measured p50 65 KB / max 90 KB behind the SessionStart preamble) plus a **64 KB tail** (the newest prompt), memoized on `(path, mtimeMs, size)`. Measured on the real dir: cold 551 ms / 372 conversations, warm 5 ms, query 3 ms. Two details are easy to get wrong: the tail's read size comes from `fstatSync` on the **open fd**, not the caller's earlier `stat` (a live session appends in between, and a stale size truncates the last line — the one holding the newest prompt), and the preview falls back to the CLI's own `last-prompt` record when the tail is all tool output. The search haystack is built during that same read and **stripped from the response** — shipping every session's prompts to a list view would be megabytes.
- `GET /api/agent/chat-history?claudeId=<uuid>&subagent=<taskId>` — an optional param on the existing transcript-replay route: when present, the server derives the sub-agent's sidechain transcript path from the parent transcript's own location + the (sanitized) task id, parses it with the same `parseTranscriptHistory` used for normal resume, and returns `{items:[]}` if it isn't there yet (the client's degrade path, above).

**One chat, one scroll.** Each pane's stick-to-bottom state belongs to its OWN session: the auto-scroll keys on that session's conversation-model identity (not "every render"), so activity in one chat can never move a split neighbour's transcript. Sending re-arms sticking; while unstuck, a *↓ Latest* pill floats over the transcript's bottom edge.

Unsticking takes an upward gesture the user actually made — a wheel/touch/key UP or a scrollbar drag. Direction is load-bearing, not decoration: when a block shrinks under a pinned view (a running tool card collapsing at turn end) the browser clamps `scrollTop`, and if the next block renders before that scroll event dispatches, the handler sees a position both far from the bottom and lower than last time — indistinguishable from a scroll up. Tracking only "a gesture happened" meant flicking DOWN to follow the answer held the window open (trackpad momentum) for exactly that moment, so the view unpinned and stranded mid-transcript. A downward gesture now CLOSES the window instead of refreshing it.

Three mechanisms keep the view pinned, and they cover different failures — none is redundant. (1) The conversation-model re-pin is a LAYOUT effect: scroll events fire before `ResizeObserver` callbacks, so a post-paint re-pin could only ever clean up after a wrong decision, never prevent one. (2) A `ResizeObserver` on the scroller and its content wrapper catches height changes React never rendered — an image finishing its load, the composer growing a line, a split/resize. (3) `ChatSession.setTranscriptRepin`, called from `fitAndResize`, catches the one case an observer structurally cannot: re-homing the session container into another pane's slot zeroes `scrollTop` on every scroller inside it, and when the new slot measures the same as the old one NO box changed, so nothing fires. AgentSurface already calls `fitAndResize` on every foreground session after each layout move — the same hook a terminal uses to refit its grid.

**The hold — what keeps an UNPINNED reader still.** Pinned, the bottom is the anchor. Scrolled up, the reader's position only means anything relative to the content, and the content above them changes height constantly and asynchronously: an image or clip decoding, a code block growing its copy bar in a post-paint decoration pass, a tool card expanding, a reveal prepending 40 entries, a rewind truncating rows. Nothing absorbs that for us — the scroller sets `overflow-anchor: none` (native anchoring would double-correct the reveal) and the app ships in a WKWebView. So ChatPane HOLDS an anchor for as long as the view is unpinned: the topmost few visible rows, measured in the scroller's scroll-invariant *content* coordinates, re-asserted from the reveal's layout effect and from the same `ResizeObserver`. Spare candidates exist because the combined `SubAgentCard`'s key can migrate on the very reveal being measured. The correction is SIGNED (content above can shrink as well as grow) and idempotent — it re-measures against the layout it just produced, so two callers firing for one commit cannot correct twice.

Two rules carry it. Measure the movement of an anchor ROW, never `scrollHeight`: a reveal fires from a scroll handler mid-stream, so one commit can prepend 40 entries above the reader AND append a tool card below them, and correcting by total height would scroll them down by the append too. And SETTLE BEFORE RE-HOLDING on a scroll event: a scroll event is not proof the reader moved (the hold's own correction, the re-home restore and the browser's clamp all write `scrollTop`), and since scroll events are delivered before `ResizeObserver` callbacks, a re-hold that ran first would bake in any height change that had landed since the last correction. Measured with that pair inverted: a reveal was corrected exactly, the decoration pass then grew the entries above the fold by 478px, the correction's own scroll event re-held at the new layout, and the observer that followed found nothing left to fix.

**Folded run cards don't fight the reveal.** Three rules keep "load older messages" working when a long stretch of tool calls folds into one `ToolRunCard` (owner report 08-01, second pass). (1) The reveal arms from INPUT handlers too (`armRevealFromInput`), because a folded window can be SHORTER than its scroller — no overflow, no scroll event, ever, so a scroll-handler-only arm made wheel-up load nothing. (2) The card's React key comes from `toolRunKeyItem` — the run edge the window cannot move (LAST item for a landed run, FIRST for the accruing tail) — because a reveal merges older calls into the head run, and a first-item key made that merge a REMOUNT: open state snapped back to the collapsed first frame with the revealed history invisible inside it. (3) The anchor hold sees THROUGH an open run card — its candidates are the card's rows (keyed `item.id`, they survive the merge), never the card itself, whose top edge doesn't move when a prepend lands inside it.

**The settle discipline — window mutations wait for QUIET.** The scrollbar-drag lesson, generalized (owner report 08-01: loading or shedding old entries "flickers"): in the shipping WKWebView the offset is animated out of process, so ANY gesture still in flight — above all trackpad momentum, which decays for a second-plus after the fingers lift and keeps emitting wheel events the whole way — can overwrite a `scrollTop` the pane writes, or be killed dead by it. Playwright cannot emit real momentum, which is why this failure survived the 07-28 synthetic matrix while the owner kept hitting it. So nothing that is *paid for* by writing `scrollTop` runs while input is still arriving: the auto-reveal ARMS a quiet timer (`SCROLL_SETTLE_MS`, 150ms — between a trackpad's intra-gesture event gaps and the pause between deliberate wheel notches, so paced scrolling still reveals between notches and keeps its continuous feel) and fires only once nothing has moved; the PINNED window snap is gated the same way (`pinned && settled` at the render-time normalization), so re-sticking mid-momentum can no longer unmount every revealed row under the reader. Quiet is tracked off INPUT events only (wheel/touch/scroll-keys + the drag flag) — never off scroll events, which the pane's own pin re-asserts dispatch constantly while a turn streams. Two companion changes: the pinned window sheds in `TRIM_SLACK` (20) chunks instead of one row per streamed frame (per-frame unmounts wobbled the scrollbar on every token), and the whole discipline is runtime-proved by `npm run verify:chat-scroll` (48 checks: no mid-train reveal, fold row held to the pixel across the settled reveal, no cascade, paced notches still continuous, pinned stream bounded at `WINDOW_TAIL + TRIM_SLACK` and never unpinned, no snap mid-motion, plus the folded-card and card-floor scenarios below).

**The window is bounded in entries AND in cards.** Entry counts stopped being a proxy for height the day tool calls started folding into one card (owner report 08-02: "1 mesaj 50 mesajlı bir grup kayamıyor ama daha fazla yüklemek için kaydır diyor"). A 40-entry window that renders as a message plus a fold is two rows — shorter than the scroller, so there is nothing to scroll while "scroll up and I'll load more" is the pane's main way back through history. So `WINDOW_TAIL`/`WINDOW_STEP` (entries) are joined by `WINDOW_TAIL_CARDS`/`WINDOW_STEP_CARDS` (20 each): the following window reaches back until the transcript holds 20 things the reader can SEE, and a reveal has to be worth 20 more rather than 40 entries that merge into the fold they are already looking at. `countCards`/`headForCards` compute both in one backwards scan (a stretch of ≥`MIN_TOOL_RUN` groupable items is one card; an item that renders nothing is none and breaks no run — which is what makes the scan direction-agnostic), and both floors ride INSIDE `nextFirstShown` rather than beside it, so they inherit `TRIM_SLACK`'s hysteresis and the unpinned freeze. `WINDOW_MAX_ENTRIES` (400) is the ceiling on what the automatic floor may mount by itself: a conversation can be one unbroken run of thousands of calls where walking finds no further card, and past that point it is the reader's own reveal (uncapped — it is an explicit ask, bounded per step at `WINDOW_MAX_ENTRIES`) that carries on. This costs nothing in the case that needs it: the extra entries are precisely the ones that fold into collapsed cards, which mount no rows at all.

**Remembered permission mode.** State 6's top-right pill/dropdown (Auto/Bypass) is not a per-message toggle — it sets `chatPermissionMode` (`'auto'|'bypass'`) in `agent-ui.json`, the same file `chatView` lives in. Every chat-kind spawn (＋ New, split, resume, Sleep/brain-resolve/delegate spawns, the skill-insert fallback) resolves its bypass from this setting centrally inside the surface's one spawn function, so a new entry point never has to remember to read it separately.

**Known limitations (beta, tracked but not blocking):** the composer's **📋 Task** button is a no-op placeholder today (the task-picker UI itself isn't built — attaching a task chip to a draft is not yet possible from Chat view); the **survey card's "answered" receipt is transient** — once `ChatSession` removes a resolved question from its pending list, re-scrolling to that point in the conversation does not show a persisted "you chose: …" row (a true persistent receipt needs a data-model change beyond this pass); a `dream-view` can only render **after** the prose, never mid-paragraph — splitting `AssistantMessage`'s single `MarkdownPreview` mount to interleave one is a bigger rewrite than this pass took on, so use a page's own `title`/section headers instead; the checklist window's `alwaysOnTop` is plain JS and does **not** float over another app running in macOS full-screen Space (a normal window, yes) — the Rust `NSPanel` treatment Sleepy's notch panel uses was deliberately deferred; a note typed into an **ordinary** (non-`secret`) checklist item is still written to `localStorage` for up to 7 days — there is no way to tell a pasted key apart from a note by validation, so this is mitigated with a UI hint, not fixed; and a page/card image's query string and fragment are stripped but its path is not — an attacker-chosen host can still path-encode data and observe IP/timing from a near-zero-click image load, a residual risk that the query-strip + `no-referrer` + `lazy` mitigations reduce but don't eliminate.

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

Federation has two halves. **Reading** a peer (below) searches what it has written down. **Peer mail** (further down) lets you *address* it — ask its agent a question, leave it a note, hand it work — and get an answer reasoned from its own code.

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

### Peer mail — ASK a connected project, don't just read it

Reading a peer returns what it has **written down**. Peer mail gets an answer **reasoned** from
its code by an agent with that project's brain loaded. Delivery runs a headless
`claude -p` rooted in the PEER's directory, so its SessionStart hook fires and it answers as
itself.

```bash
dreamcontext peer ask <vault> "<question>"          # wake it now, wait for the answer (~30-90s)
dreamcontext peer send <vault> "<text>" --kind note # leave it in the inbox; no spawn, no cost
dreamcontext peer send <vault> "<text>" --kind command   # hand over work (auto perms, never bypass)
dreamcontext peer inbox [--all]                     # what is waiting here
dreamcontext peer read|thread|reply|done <id>       # the correspondence
```

**When to ask instead of recall** — this is the judgement call, and getting it wrong is
expensive in both directions:

| Reach for | When |
|---|---|
| `memory recall --vault <name>` | You want a doc, a decision, a task — something someone wrote. Fast, free, returns source text. |
| `peer ask` | The answer must be derived: "where is X implemented there", "why was Y done that way", "would Z break anything on your side". Also when **recall came back empty** but the peer would still know — nobody had written it down yet. |
| `peer send --kind command` | The user actually wants work done in that project. Say so in your report. |

Each active connection also generates an **envoy sub-agent** (`.claude/agents/peer-<vault>.md`,
regenerated on connect/disconnect/install) carrying that peer's identity. Dispatch it to keep a
long peer answer out of your own context. The envoy reports the peer's answer **attributed** —
if the peer contradicts what this project believes, that contradiction is the finding.

**Gates.** A send requires an active connection (drawing it IS the consent — same rule as
read federation since v0.23.0). What a message may DO on arrival is held separately and
absolutely: every peer-delivered run is `--permission-mode auto`, a constant with no
caller-supplied path to `bypassPermissions`. A peer can always ask; it can never grant itself
the right to act unsupervised. In a headless run a permission prompt has nobody to answer it,
so the peer reports itself blocked rather than working around it — the dashboard's peer
session is the surface where such a prompt CAN be answered.

Mail lives in `state/.peer-mail/<id>.json` on **both** ends of a thread (correspondence is
meant to be duplicated), never materialises as knowledge, and surfaces in the receiving
project's SessionStart snapshot under `## Peer mail` — which is how a project that was asleep
when it was addressed finds out.

### Meeting Room — one announcement, EVERY agent (hidden launcher surface)

Peer mail addresses ONE vault. The **Meeting Room** addresses ALL of them at once: a hidden,
Slack-like thread in the desktop launcher where the user posts an announcement and **every
registered vault's agent** wakes headless in its own project directory (same
`runPeerHeadless` spawn as peer mail: `--permission-mode auto`, 10-min timeout, 3 runs in
parallel) and decides for itself whether the message concerns it. **UI-only, deliberately
hidden**: the single entrance is clicking the dreamcontext core logo in the launcher's Space
view (with projects in the sky; an empty sky keeps the add-project wizard). No CLI verbs,
no menu item.

**Not peer mail.** The room is a single global place owned by no vault — threads live in
`~/.dreamcontext/meeting-room/threads/<id>.json`, never in any vault's `state/`. No
connection or consent gate: participants are ALL registered vaults that exist on disk
(owning the launcher is the consent). Only ONE thread is active at a time; posting a new
announcement archives the active one (in-flight runs still land their answers in the
archived thread — history stays truthful). History is kept and browsable in the room's rail.

**Routing rules** (who a user message wakes):

| Message | Targets |
|---|---|
| Root announcement, no mentions | ALL participants (N parallel headless runs — the accepted cost) |
| Root announcement with `@Name` | ONLY the mentioned vault(s) |
| Thread reply, no mentions | The **engaged set** — agents that already posted in this thread |
| Thread reply with `@Name` | ONLY the mentioned vault(s) |

Mention parsing is **roster-driven, longest-name-first** (vault names with spaces work);
never a bare regex, and an email's `@` is not a mention.

**Reply-or-PASS protocol.** The delivery prompt tells each agent its ENTIRE final message is
posted to the room verbatim — and that if it has nothing to add, that message must be exactly
`PASS`. A PASS flips the agent's presence chip to *passed* and never appears as a thread
message. Relevance is the agent's call, not the user's routing burden.

**Agent-to-agent mentions, bounded.** If agent A's reply mentions participant B, B gets ONE
directed run (fencing A's reply), and when B answers with substance, A gets ONE follow-up run
carrying that answer. Chain depth is 1: mentions inside B's answer (or the follow-up) render
as text and deliver nothing. Hard caps, enforced at enqueue: **max 8 mention-triggered runs
per thread, max 3 total runs per agent per thread** — a delivery dropped by a cap is recorded
in the thread as a visible system line, never silently.

Same permission posture as peer mail: headless runs execute under `auto` with nobody to
answer a prompt, so an agent that hits a permission wall reports itself blocked in its reply
rather than working around it.

---

## ✅ Team brain sync (whole project) — collaborate on ONE brain

**Yes, a team can share a single dreamcontext brain.** Cloud sync pushes the **whole project** — your code, `.claude/`, and the brain nested under `_dream_context/` — to the project's own GitHub `origin` on the current branch, and the CLI/desktop app push/pull/merge it the way a team collaborates on code. The brain stays plain markdown/JSON on disk (local-first); git is just the sync transport, not a new database. Because `.claude/` and `_dream_context/` already live in the code repo, they travel together — there is no separate brain repo and no symlink layer to maintain.

**Guide the user here** the moment they say *"I want to use this with my team / with other people," "share the brain," "collaborate on tasks/knowledge together,"* or *"set it up on my other machine."* Do NOT answer "we don't support that" — this is the feature.

> **Full reference → [brain-sync.md](brain-sync.md)** — the two modes (full-repo / in-tree), per-machine token + auth, shared vs machine-local config, **cross-OS setup**, and the silent-failure troubleshooting playbook. The section below is the quick tour.

**How it differs from its neighbors** (say this if the user conflates them):
- **Cloud task sync** (ClickUp/GitHub Issues) — mirrors only *tasks* to a task manager, one backend at a time.
- **Federation** — read-only recall across your OWN separate projects; nothing is ever copied.
- **Whole-project sync (this)** — the *whole* project (code + brain) is one git-synced artifact several people edit together.

### Onboarding a team

```bash
# Each person / each machine — set a per-MACHINE token (gitignored, never travels with the repo)
dreamcontext config github-token "$(gh auth token)"

# Make sure the project has a GitHub origin (full-repo pushes to it), then turn cloud sync ON
git remote add origin https://github.com/acme/app.git   # skip if it already has one
dreamcontext brain enable              # flips the project to full-repo (whole project → origin)

dreamcontext brain status              # mode (full-repo/in-tree), remote, sync state, cloud-sync switch
```

Teammates just `git clone` the project and run the same two steps (token + `brain enable`). Cloud sync can also be toggled from the dashboard (Settings → Brain → Cloud sync).

### Day-to-day (mostly automatic)

- **Every `sleep done`** fetches → semantic-merges on conflict → commits → pushes the project (sync failure never fails sleep). **Session start** does a non-blocking background pull. So teammates' consolidated context reaches everyone without a manual step.
- **Manual sync any time:** `dreamcontext brain sync` (or `--pull-only` to just take team content in).
- **On a prose merge conflict** (two people edited the same `##` section of a knowledge/feature doc), the CLI resolves every deterministic file itself and stops at `already-awaiting-agent`, deferring the rest to the **`/dream-sync` skill** — the agent reads base/ours/theirs snapshots, writes the real semantic merge, and hands back with `brain sync --continue`. A real **code** conflict is left for the human's editor with native git markers (never sent to the agent). (`--resume`/`--continue` are attended-only; never drive them unattended.)

### Editing / reconfiguring

- **Turn cloud sync on/off:** `dreamcontext brain enable` / `brain disable`, or the dashboard Settings → Brain toggle.
- **Modes:** `full-repo` (cloud sync ON — whole project → its own `origin`, on the current branch; needs a GitHub `origin`) · `in-tree` (cloud sync OFF — commit-only, **never** auto-pushes; the safe default). Both run the scrub gate. Full detail + cross-OS setup → [brain-sync.md](brain-sync.md).
- **Safety rails (always on):** a **scrub gate** blocks secrets / absolute local paths before every commit and push; the project-root `.gitignore` is force-written with the machine-local brain excludes + secrets before every whole-project stage; tokens are supplied via `GIT_ASKPASS` (never embedded in the remote URL); per-machine indexes/caches are gitignored and never pushed.

### From the desktop app

**GitHub device-flow login from the Launcher** and the dashboard **Settings → Brain Cloud-sync toggle** turn whole-project sync on/off (with a **team-updates badge** and a one-click "Resolve with AI" for a deferred prose merge). (Full status: `knowledge/features/brain-repo-sync.md`; merge internals: `skill-sync/references/merge-rules.md`.)

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
