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

An alternate, settings-gated renderer for the SAME embedded agent: instead of xterm.js drawing Claude Code's raw TUI, a headless `claude -p --output-format stream-json` conversation is rendered as native app UI — streaming markdown bubbles, collapsible tool cards with status/duration, and Claude's permission prompts / `AskUserQuestion` as clickable cards (options + multiSelect) instead of a numbered-list readline prompt. It is the **same engine, different renderer** — same `claude` binary, same permission model (no-bypass → Auto/`acceptEdits`, bypass → `bypassPermissions`), same per-vault agent-session-map identity registry, same SessionStart/Stop hooks (brain preload, sleep debt all fire normally).

- **Discovery:** Settings → Agents → **"Agent screen"** picker — **Terminal** (default) or **Chat (BETA)** (`chatView` in `agent-ui.json`). A mutually-exclusive SWAP, not a superset: the chosen surface takes over every Claude entry point (＋ New, ⌘T/⌘D, empty state, reopened/resumed tabs, Sleep / brain-resolve / delegate spawns) — chat mode never opens a terminal Claude and vice versa. Plain shells (⌃`) stay available in both modes; already-running sessions keep their surface; a tab saved under one surface resumes the same conversation in the other (shared transcript + conversation UUID).
- **Resume interop:** a chat and a terminal session both pin/resume by the SAME Claude conversation UUID, so either surface can pick up a conversation the other started — a chat pane offers "Continue in Terminal view" (e.g. if question-routing isn't available), and a terminal tab offers "Open in Chat (BETA)" to reopen its conversation natively.
- **Interrupt:** a Stop button sends the CLI's `interrupt_receipt_v1` control request; a short watchdog escalates to SIGINT→kill if the turn doesn't wind down.
- **Live model/effort switch:** the composer's pickers switch a RUNNING chat — model via the CLI's `set_model` control request, effort via a headless `/effort <level>` command frame (both apply from the next turn; the CLI confirms with a re-emitted init / a synthetic "Set effort level to …" bubble).
- **Transcript replay on resume:** resuming a conversation (chat→chat across launches, or terminal→"Open in Chat") replays its on-disk transcript (`GET /api/agent/chat-history`) above an "earlier conversation" divider — a resumed chat never opens blank.
- **Rewind:** hovering any of your messages offers **↺ Rewind** — a confirm card, then the CLI's `rewind_conversation` control request rewinds the conversation to just before that message and prefills it in the composer for re-editing. Conversation-only: files are NOT reverted (checkpoint code-restore remains a Terminal-view feature).
- **Slash menu:** typing `/` at the start of a chat draft opens the SAME skill picker the terminal composer uses (the shared `SkillPickerPopover`), so skills/commands are discoverable in chat instead of having to be remembered — picking one prepends `/name` to the send.
- **Message queue — ⏎ while it works.** Pressing ⏎ during a turn QUEUES the message instead of doing nothing (the terminal gets this from the CLI's own readline; the headless engine has no such buffer, so the queue is client-side, on the conversation model). Queued messages dock as a strip **above the composer** — numbered, each **editable in place** (⏎ saves, ⇧⏎ newlines, Esc cancels, saving an empty row deletes it) and removable, with **Clear** for the lot. They go out **one per turn**, in order, as each turn settles: each queued message is its own instruction and gets its own turn, never a concatenated batch. Two rules keep it honest — **Stop PAUSES the queue** (an interrupt's own `result` frame is a busy→idle edge like any other, so without this, pressing Stop would fire the next queued message in the same breath as the interrupt; the strip says *paused* and offers **Send now** / **Clear**), and a **dead session keeps its rows** rather than spending them (they are the only copy of that text — Resume, then Send now). While a turn runs the send button becomes an accent-outlined **queue** button beside Stop, so the mouse path reaches the feature too. The drain decision and the row algebra are pure and tested (`chat/chatQueue.ts`, `tests/unit/chat-queue.test.ts`).
- **Prompt history (↑/↓):** ↑ in the composer walks back through THIS conversation's own past prompts — including the replayed transcript of a **resumed** one, since re-running an earlier turn is half the point of resuming — and ↓ walks forward, restoring the draft that was displaced when the walk began. Consecutive duplicates collapse to one entry. It never eats what you are typing: with a non-empty draft ↑ only recalls from caret position 0 with nothing selected, ↓ is a history key only mid-walk, the slash menu keeps ↑/↓ while open, and a recalled prompt starting with `/` does NOT spring the command menu (⏎ would complete instead of re-sending). Pure + tested in `chatEntities.ts` (`promptHistory`, `canRecallHistory`, `stepHistory`).
- **Inline media:** an image the transcript references renders inline in the bubble (click → lightbox); video/audio referenced from inside the project stream with seek support. A media file OUTSIDE the project root can't be drawn by the page at all, so it renders as an **open ↗** chip that hands the real file to the OS viewer (`POST /api/agent/reveal`, below) instead of a dead path.
- **Rich output — the agent KNOWS it is in Chat.** A chat-spawned `claude` is byte-identical to a terminal-spawned one, so by default it writes for a TTY: it finishes a board, says "done", and names the file. Every chat spawn therefore appends a short surface briefing (`src/server/chat-surface.ts`, handed over as `--append-system-prompt-file` so the login-shell argv stays free of prose; a failed write degrades to the un-briefed agent, never to a failed spawn) telling the agent what its markdown becomes here. Four shapes, all ordinary markdown so a terminal or a raw transcript still reads fine:
  - `![caption](docs/shot.png)` / `[demo](tmp/clip.mp4)` — drawn and played in place (video/audio must be a LINK; markdown has no video syntax).
  - `![board](path/to/x.excalidraw.md)` — the **actual board**, on the same live pan/zoom `ExcalidrawPreview` canvas the Knowledge page uses, in the transcript. A tool call that wrote a board renders the same way once it finishes, so "I drew this" and "I edited this" look alike. Backed by `GET /api/agent/board-assets` (below) — without it every embedded screenshot renders blank.
  - **a path in backticks** — `src/server/routes/agent-chat.ts` becomes a chip that opens that file's preview. Free: it is already how paths get written. Deliberately narrow (needs a separator plus an extension or a trailing `/`), because a false positive is a button that opens nothing.
  - **a fenced ```dream-actions block** (JSON array) — a row of real buttons under the message; the block itself is stripped from the prose, and a fence still mid-stream is hidden rather than flashed as raw JSON. `{"label","action","id"|"path"|"text"}`, max 6, entries with no target dropped. Actions: `task`/`knowledge`/`core` (navigate the app by slug), `file`/`board` (open the preview panel), `reveal` (hand to the OS), `ask` (LOAD the composer — the agent proposes the follow-up, the user still sends it). Every action lands on a surface `ChatPane` already owns, so a button can never reach further than the user could by clicking around the same view.
  The briefing adds ONLY this surface knowledge — no persona, no workflow, no rules about the work itself — and is pinned in lockstep with the client parser by `tests/unit/agent-board-assets.test.ts`.
- **Interactive views — inline charts, comparison pageviews, and a pinned checklist window.** A fenced ```dream-view``` block — one JSON object, `"type":"chart"|"page"|"checklist"` — becomes a real object under the prose instead of something the agent can only describe; the block is stripped from the visible text, and one still mid-stream is hidden behind a "Building a view…" pill rather than flashing half-written JSON (mirrors the `dream-actions` open-fence rule). Schema, caps and the pure validator live in `dashboard/src/lib/chatViewSpec.ts` (`parseViewBlock`); the fence is found and stripped by `chatActions.ts` (the same file that owns `dream-actions`); rendering is `chat/ChatViews.tsx` dispatching to `ChartView.tsx` / `PageView.tsx` / an inline `ChecklistCard`. Max 4 view blocks per message. Pinned in lockstep with `src/server/chat-surface.ts`'s briefing by `tests/unit/chat-surface-lockstep.test.ts`.
  - **`chart`** — `render:"line"|"pie"|"number"|"funnel"|"table"` maps 1:1 onto the same Lab chart components (`components/lab/*`, `Series[]` in, SVG out). **`render:"table"` is the raw values behind the series — a fixed `Series | Time | Value` header (`RawDataView`) — never an arbitrary comparison grid.** An early draft of this feature claimed it could do N-column comparisons; it can't. That capability is the page `table` widget below, and the two are easy to conflate. Caps: 8 series, 365 points/series, 2000 points total. Opens full screen from its own ⛶ button — a separate portaled mount, so closing it leaves the inline card untouched.
  - **`page`** — a widget layout for a research/comparison answer instead of a wall of prose. Two containers — `stack` (vertical, the transcript's own scroller carries overflow) and `rail` (horizontal, scroll-snapped, keyboard-operable, **leaf widgets only, no nested `stack`/`rail`**, depth ≤ 2) — around six leaves: `card` (the one widget that carries an owner's whole named list — title/subtitle/image/price/badges/specs/body/`actions`), `table` (the REAL N-column comparison grid: `headers`+`rows`, short rows padded, long rows truncated, its own horizontal scroller), `text` (through the same `MarkdownPreview` every other bubble uses), `stat`, `image`, `divider`. Card `actions` accept every `dream-actions` kind plus a new **`url`** kind (`https:` only, opens the OS browser via `openExternalUrl`, never the webview). A remote image's query string and fragment are stripped at validation time and it renders with `referrerPolicy="no-referrer" loading="lazy" decoding="async"` — a mitigation for prompt-injected exfiltration via an agent-chosen image host, not a fix (residual risk, named below). Caps: 60 widgets total (nesting counts), 20 items/rail, 4 badges / 8 specs / 3 actions per card, 8 cols / 50 rows / 120 chars-per-cell for `table`.
  - **`checklist`** — not a chat card but a small **always-on-top OS window** (a real Tauri `WebviewWindow`, so it survives switching to another app): the user ticks steps, writes a note under each, attaches a file, fills a masked secret field, then Submit sends the whole filled-in list back as one message. **A dedicated, narrow Tauri capability** (`desktop/src-tauri/capabilities/checklist.json`, identifier `checklist-window`) grants only window chrome, targeted events and the file-attach dialog — deliberately **no `shell:*` and no `global-shortcut:*`**, since this is the one window that both renders agent-authored markdown and holds a pasted secret. `default.json` was **not edited**: `checklist-*` never joins its `windows` array, and the ack event's permission (`core:event:allow-emit-to`) was already granted transitively through `core:default` → `core:event:default`, so nothing needed adding there — the plan going in expected a one-line `default.json` edit; the real ACL manifest made it unnecessary. This is a new occurrence of the narrow-allowlist containment pattern in the `dashboard-server-security` knowledge file (whose prior occurrence is Agent Chat's `/api/agent/file`+`grant`+`reveal` gate, above). **Vault- and conversation-scoped end to end**: every storage key and the window label itself run through `labelPart()` (`checklistStore.ts`), a byte-for-byte hex encoder — every project window shares one origin and one `localStorage`, so an unscoped key would let one project's checklist state (and a pasted secret) collide with another's; hex-encoding makes that collision provably impossible, not merely unlikely. Submit travels window→window over a **targeted `emitTo`** (never a broadcast), so no other open vault's Chat surface ever receives the payload; no ack within 2s and the window stays open with a "couldn't reach the chat" strip plus a copy-to-clipboard fallback — nothing is silently lost. **Secrets, stated plainly:** a `wants:"secret"` value lives in React state only and is never written to `localStorage`; the value the user submits DOES land in the CLI's on-disk conversation transcript once sent — that's the feature working as designed, not a leak, and the field says so. Caps: 40 items, 4000 chars/note, 32KB submit payload (truncated with a visible marker past that).
  - **Degradation is loud, never silent** — the standing rule this whole fence follows. The prose above a view always survives: a `notices[]` strip renders under the view(s) and is strictly additive, never a substitute for it. Every drop — an unknown `type`, a cap breach, a bad URL, an oversized block — gets its own human-readable line, and nothing in the pipeline ever throws, including mid-stream.
  - **Boards are now genuinely full screen from every entry point.** A clicked backticked board path, a `{"action":"board"}` / `{"action":"file"}` button pointing at a board, and the embed's own head button all converge on one `BoardFullscreen` overlay — `ChatPane`-owned, portaled to `document.body`, the same technique `ChartFullscreen` uses. `SlideOver`'s old board branch and `BoardCanvas` are gone (see the correction above); a board never lands in a cramped side panel again.
- **Signing in from Chat.** An unauthenticated CLI answers a headless turn with an `authentication_failed` frame whose stated remedy (`/login`) is the one command this surface cannot run — the OAuth flow exists only in the interactive TUI. So the frame is parsed as its own `auth-required` event (never as an assistant bubble) and the composer is replaced by a **sign-in banner**, which opens a shell tab that types and submits the sign-in command; "Signed in — retry" then respawns the same conversation with `--resume`. Typing `/login` into the composer lands on the same flow instead of spending a turn. The command is never a literal: the server probes it (`claude auth status --json` → `claudeAuth.loginCommand` on `GET /api/agent/capabilities`, `src/lib/claude-auth.ts`), so a CLI too old for the `auth` subcommand is offered the TUI instead. That same probe backs **Settings → System → Claude Code sign-in**, which reports who is signed in (or that nobody is) BEFORE a surface is attempted — "installed" and "usable" are different facts. It is advisory only and never gates a spawn: a Bedrock/Vertex or `apiKeyHelper` machine probes as *unknown*, which is reported quietly and never as "signed out".
- **Installed, but invisible to the shell.** The third prerequisite state, and the one that used to read as "not installed at all": `npm install -g @anthropic-ai/claude-code` (like the CLI's own `install.sh`) puts the binary in `~/.local/bin`, which is on no default PATH — so an install that skipped the closing `export PATH="$HOME/.local/bin:$PATH"` echo leaves `claude` on disk while every `$SHELL -ilc 'exec claude …'` spawn 127s. Two halves fix it (`src/lib/claude-path.ts`): every spawn we own — terminal PTY, chat, sleepy chat/capture, tab titling, hook recall — gets `claudeAwarePath()`, which APPENDS the discovered install directory (never prepends, so a `claude` the user's rc already resolves is never redirected), and the installer performs the missing echo itself, idempotently under a `# dreamcontext:` marker, into the rc that shell actually reads (zsh → `~/.zshrc`, bash → `~/.bashrc` plus `~/.bash_profile` only if it exists, fish → `config.fish` with `set -gx`, else `~/.profile`). `GET /api/agent/capabilities` reports it as `claudePathBroken`, so **Settings → System** shows an amber *"Installed, not on your PATH"* with a one-click **Fix PATH** (`POST /api/agent/install {target:'claude-path'}`) instead of a false "Missing" — the in-app surfaces already work, but the user's own terminal can't run `claude` until the rc line lands.
- **Background shells — visible, readable, stoppable.** When the agent runs a command with `run_in_background` (a dev server, a long build, a watch), a **tray docks above the composer** listing every background shell with its status and a live elapsed clock. It sits outside the transcript scroller on purpose: a background shell outlives the turn that started it, so an inline card would scroll away while the process kept running. Each row does the two things that surface needs, and **both cost zero model tokens**:
  - **Output** opens the shell's live stdout/stderr in the slide-over, polled while it runs. The CLI streams a backgrounded command to a file on disk, and the server reads that file directly (`GET /api/agent/bg-output`, below) — so reading a background shell never spends a turn asking the agent to run `TaskOutput`, and works while the conversation is mid-turn.
  - **Stop** kills it through the CLI's own `stop_task` control request. The CLI acks `success` even for a task id that never existed, so the ack is ignored as evidence: the tray only marks a shell stopped when the CLI's `background_tasks_changed` / `task_updated{status:'killed'}` frames say so.
  A finished shell keeps its row for **two minutes** and then leaves the tray — long enough to read what it just did, short enough that a session which backgrounds dozens of commands doesn't grow a pinned wall over the conversation (the tray is docked furniture: every row it holds is height the transcript does not get, and rows past its cap scroll inside the tray rather than growing it). The command's own tool card stays in the transcript as the durable record. A stopped shell reports **stopped**, not "completed" or "failed" — a run the user killed neither finished nor errored. The roster itself comes from the CLI's `system:background_tasks_changed` push, which lists only what is STILL running, so it is used to adopt shells whose start we missed and to reconcile one that vanished without a terminal frame — never as the whole list, which would delete every finished shell.
- **Live rail (goal-skill + council):** a run of either orchestration skill reports live progress above the transcript — goal-skill's phase bar (phase chips with loop heat, implementer fork dots, wave counter; click for the phase graph) and council's chamber strip (round dots, persona stance dots, convergence meter; click for the per-persona chamber table). Both are the SAME components the Terminal view shows above its composer, and both feeds (`GET /api/agent/goal-live`, `GET /api/agent/council-live`) are scoped by conversation id, so a pane only ever shows the run ITS conversation is driving. The rail also holds the linked-task chip, and collapses entirely when nothing is live.
- **Beta limitations** (by design, not oversights): the chat WS route tracks its own live-conversation set separate from the terminal route's — a chat and a terminal resuming the exact same conversation concurrently is a known (rare) double-writer edge, not guarded against; the live rail's linked-task chip only renders when a task slug is supplied, which no entry point does yet (Task-Manager-launches-chat is deferred).

**12-state redesign (component tree).** The renderer is a `chat/` subfolder under `dashboard/src/components/sleepy/`, with `ChatPane.tsx` as a thin orchestrator (view-only state: which slide-over/lightbox/quote is open) and one component per card family: `TranscriptItem` (user/assistant messages — no avatars, ever; hover bar: copy, edit=rewind, quote; assistant adds retry), `ToolCard` (collapsible — **only an Edit/Write opens by default**, because what changed in your files is the one body you always want to see; everything else, Bash above all, stays a one-line receipt you can open, since a turn is mostly shell calls and their expanded output pushed the answer off screen), `SurveyCard` (AskUserQuestion — large select rows, `k/n` progress), `PermissionCard` (Allow/Deny + an "always allow this session" checkbox that auto-answers future prompts for that tool, client-side only), `SubAgentCard` (grouped sub-agent runs), `SlideOver` (a right panel for file/media preview and sub-agent drill-in — text, media and directory listings only; a board is never drawn here, see "Boards are now genuinely full screen" below), `Lightbox` (images), `BoardEmbed` (an Excalidraw board drawn in the transcript; exports `BoardFullscreen`, the portaled overlay every board-opening entry point converges on), `ActionRow` + `chatActions.ts` (the `dream-actions` buttons and the pure parser that lifts them, plus board references, out of the prose), `PermissionModeMenu` (see below), `Banners` (empty state, **working indicator** — dots + elapsed clock, shown whenever the turn is in flight with nothing on screen yet: before the CLI's first frame, or in a gap between a tool result and the next block — stream error + retry, reconnecting, session-ended + resume), `QueuedMessages` (the docked message-queue strip — see "Message queue" above; rendered by `ChatPane` OUTSIDE the composer/banner branch so the rows survive the session ending), and `Composer` (resizable, attachments row, quoted-reply chip, skill chip, ↑/↓ prompt history). The terminal's skill picker (`Popover` + `SkillBrowser`) was extracted into a shared `SkillPickerPopover.tsx` so both surfaces render the literal same picker — the terminal composer's behavior/markup is unchanged.

**Sub-agents (Task/Agent tool).** Dispatched sub-agents do NOT stream their inner assistant text/thinking to the parent conversation — the parser instead tracks the `system:task_started` / `task_progress` / `task_updated` / `task_notification` lifecycle frames the CLI emits around a sub-agent run (description, `subagent_type`, status, elapsed, final summary + usage), reduced into one `SubAgentCard` group; the spawning tool's own raw tool card is suppressed so it isn't shown twice. Each row carries a **live meta readout** — duration, model, tokens, tool uses — assembled by `runMetaChips` from what the CLI actually reported, and nothing else: `task_progress` (emitted once per tool use) supplies the current step plus running duration/token/tool totals, while the model arrives on a different channel entirely — `resolvedModel` on the `tool_use_result` sibling of the Agent tool's own result frame, since no `task_*` frame carries it. **Reasoning effort is on no channel** (verified against CLI 2.1.220's zod schemas), so no chip ever claims one. `local_bash` tasks — a shell command the CLI backgrounded — ride these exact same frames (`task_type` is the ONLY discriminator), but they are NOT sub-agents and no longer appear in this card at all: they have their own surface (**Background shells**, below), because the affordances are opposite — an agent run has a sidechain transcript to drill into and no lifecycle you control, a shell has no transcript but does have live output and a stop button. Clicking a run opens a slide-over that renders the sub-agent's REAL transcript — the CLI writes it to a sidechain JSONL whose path is **derived server-side** from the parent conversation UUID + the task id (never a client-supplied path, and the `task_notification`'s `output_file` symlink is never trusted/read directly); if the sidechain hasn't flushed yet, the drill-in degrades to a static summary (prompt + result + usage) instead of erroring.

**New server surfaces:**
- `GET /api/agent/file?vault=&path=[&raw=1]` — the one read surface behind every path a transcript names, under the **active vault's project root** (not `_dream_context/` — that stays `graph/content`'s job). Three answers, by what the path is: a **text/markdown preview** (`{path,type:'markdown'|'text',content}`, 512 KB cap — the whole body goes into JSON); a **directory listing** (`type:'dir'`, folders first, 300 entries then `truncated`), because a folder named in a transcript is something to look inside, not an error; or **raw media bytes** with `?raw=1` — images (PNG/JPEG/GIF/WebP), video (mp4/m4v/webm/mov/ogv) and audio (mp3/m4a/wav/oga/ogg/flac), streamed with `Accept-Ranges` + correct `206` so `<video>`/`<audio>` can seek (a 200-with-everything makes a clip unseekable in Safari) and capped at 2 GB. Security posture: desktop-gated + loopback-only (same trust model as the WS routes), a traversal guard that refuses any resolved path outside the project root, `X-Content-Type-Options: nosniff` on every response, and — because SVG can embed `<script>`/`foreignObject` — SVG is always returned as a text preview, never as `image/svg+xml`.
- `POST /api/agent/grant` — the answer to "the file is real but it's outside the project". Rather than a dead refusal, `/agent/file` returns **403 `needs_grant`** for an outside path and the card offers *Allow access*; that click records THAT ONE absolute file path for the vault in `state/.file-grants.json` (max 500, files only — never a directory, never a pattern), after which the read succeeds. The consent is always a real user click on a named file: the agent cannot grant on its own behalf, and one grant never widens to a folder.
- `POST /api/agent/reveal` — hands a path to the OS, and the two modes ARE the safety story: a folder, a media file, or an inert document type (`.pdf .txt .md .markdown .json .yaml .yml .toml .csv .tsv .log .rtf .html .htm .xml .svg`) opens in the **default app**; anything else is **revealed in the file manager** (`open -R` / `explorer /select,` / `xdg-open <dir>`) rather than launched — so a `.sh`, `.command`, `.pkg` or `.app` named in a transcript can never be executed by a click in a chat bubble, while the user still gets to it in one step. Deliberately an allowlist of what's inert to view, not a denylist of what's dangerous (a denylist is one unknown installer format away from launching something). Desktop-gated, argv form (no shell), and the file must already exist.
- `GET /api/agent/board-assets?path=<board>` — the images an Excalidraw board embeds, so the transcript can DRAW the board instead of linking to it. An Obsidian board stores its screenshots as `## Embedded Files` wikilinks rather than base64 in the scene, so the board comes down as markdown through `/agent/file` but its pictures do not. `/api/knowledge-assets` already did this job for boards under `knowledge/`; this covers a board anywhere in the project (a board beside its generator, a board committed next to the code it documents), sharing one `resolveBoardAssets()` so both surfaces resolve, compress, cap and cache identically. Two independent containment layers: the same `resolveServablePath` that gates `/agent/file` decides whether the BOARD may be read (project root, or a path the user granted), and the roots handed to the resolver decide where its wikilinks may point (project root, context root, the board's own folder + its `assets/`/`Attachments/` subfolders — never a parent of either). Images only, by extension; a link that escapes is skipped, not followed.
- `GET /api/agent/bg-output?claudeId=<uuid>&taskId=<id>` — the tail of a background shell's live output, so the Chat view can show what a backgrounded command is doing **without spending a model turn**. The CLI streams each backgrounded command to `/tmp/claude-<uid>/<cwd-slug>/<conversation-uuid>/tasks/<taskId>.output`, and that path is **derived server-side** from the vault, the conversation uuid and a strictly-gated task id (`^[a-z0-9]{1,32}$` — no dot, slash or dash, so traversal is unrepresentable rather than filtered); the absolute `output_file` the stream hands the client is never trusted or read, the same rule the sub-agent sidechain follows. Returns the last 256 KB with `truncated`, and answers **200 with `exists:false`** rather than 404 when nothing has been written yet — a shell that has produced no output is a normal state, not an error. Two path details are empirically pinned and easy to get wrong: the base is a hardcoded `/tmp/claude-<uid>`, **not** `$TMPDIR`/`os.tmpdir()` (macOS sets a custom `TMPDIR` that the CLI ignores for these files), and the directory segment slugs the **realpath** of cwd.
- `GET /api/agent/chat-history?claudeId=<uuid>&subagent=<taskId>` — an optional param on the existing transcript-replay route: when present, the server derives the sub-agent's sidechain transcript path from the parent transcript's own location + the (sanitized) task id, parses it with the same `parseTranscriptHistory` used for normal resume, and returns `{items:[]}` if it isn't there yet (the client's degrade path, above).

**One chat, one scroll.** Each pane's stick-to-bottom state belongs to its OWN session: the auto-scroll keys on that session's conversation-model identity (not "every render"), so activity in one chat can never move a split neighbour's transcript. Sending re-arms sticking; while unstuck, a *↓ Latest* pill floats over the transcript's bottom edge.

Unsticking takes an upward gesture the user actually made — a wheel/touch/key UP or a scrollbar drag. Direction is load-bearing, not decoration: when a block shrinks under a pinned view (a running tool card collapsing at turn end) the browser clamps `scrollTop`, and if the next block renders before that scroll event dispatches, the handler sees a position both far from the bottom and lower than last time — indistinguishable from a scroll up. Tracking only "a gesture happened" meant flicking DOWN to follow the answer held the window open (trackpad momentum) for exactly that moment, so the view unpinned and stranded mid-transcript. A downward gesture now CLOSES the window instead of refreshing it.

Three mechanisms keep the view pinned, and they cover different failures — none is redundant. (1) The conversation-model re-pin is a LAYOUT effect: scroll events fire before `ResizeObserver` callbacks, so a post-paint re-pin could only ever clean up after a wrong decision, never prevent one. (2) A `ResizeObserver` on the scroller and its content wrapper catches height changes React never rendered — an image finishing its load, the composer growing a line, a split/resize. (3) `ChatSession.setTranscriptRepin`, called from `fitAndResize`, catches the one case an observer structurally cannot: re-homing the session container into another pane's slot zeroes `scrollTop` on every scroller inside it, and when the new slot measures the same as the old one NO box changed, so nothing fires. AgentSurface already calls `fitAndResize` on every foreground session after each layout move — the same hook a terminal uses to refit its grid.

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
