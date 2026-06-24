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
| `doctor` | Validate `_dream_context/` structure and report issues. |
| `config show` | Print project config (platforms, packs, products, people, native-memory, shareable, task backend). |
| `config native-memory enable\|disable` | Toggle Claude Code's native auto-memory (disabled by default so dreamcontext owns memory). |
| `config shareable on\|off` | Toggle whether peer vaults may recall this project (default off/private). |
| `config people [names...]` | Set the people roster; syncs the `## People` block in `1.user.md`. `--clear` for single-person. |
| `config task-backend local\|clickup\|github` | **[Advanced]** Switch the task backend — one cloud sync at a time (see [integrations.md](integrations.md)). |
| `config clickup-token [token]` | Store a ClickUp API key in the gitignored secrets file. `--user <name>` to scope it. |
| `config clickup-list <teamId> <spaceId> <listId>` | Set the ClickUp sync target. `--migrate` / `--keep` when changing lists. |
| `config clickup-member <person> <memberId>` | Map a roster person to a ClickUp member id. `--token-env <ENV>`. |
| `config github-token [token]` | Store a GitHub token in the gitignored secrets file (also reads `GITHUB_TOKEN`/`GH_TOKEN`). `--user <name>` to scope it. |
| `config github-repo <owner> <repo>` | Set the GitHub sync target (`owner`/`repo`). |

---

## Tasks

| Command | Description |
|---|---|
| `tasks list` | List/filter/group tasks (excludes completed by default). Flags: `-s/--status`, `-a/--all`, `--tag <t>` (repeatable, AND), `--any-tag <t>` (repeatable, OR), `--version <id>`, `--priority <level>`, `--feature <slug>`, `-g/--group-by tag\|version\|priority\|status`, `--long`, `--tags`, `--json`. Filters compose (AND), case-insensitive. |
| `tasks tags` | Distinct task tags with counts. `-a/--all`, `--json`. |
| `tasks create <name>` | Create a task. Flags: `-d/--description`, `-p/--priority critical\|high\|medium\|low`, `-u/--urgency …`, `-s/--status`, `-t/--tags <csv>`, `-w/--why`, `-v/--version`, `--person <name>`, `--reach <1-10>`, `--impact <1-5>`, `--confidence 25\|50\|75\|100`, `--effort <weeks>`, `--start YYYY-MM-DD`, `--due YYYY-MM-DD`, `--field <key=value>` (repeatable; sets declared custom fields), `--allow-missing-required` (create a draft even when a required custom field is unset). **Fails** if a required custom field is unset and `--allow-missing-required` is not given. |
| `tasks rice <name>` | Print or update RICE values. `--reach`/`--impact`/`--confidence`/`--effort`, `--clear`. |
| `tasks start <name> <YYYY-MM-DD\|clear>` | Set or clear a planned start date (range start). Must be ≤ the due date; setting it removes the `backlog` tag. |
| `tasks due <name> <YYYY-MM-DD\|clear>` | Set or clear a due/end date (range end). |
| `tasks tag <name> <tags...>` | Add (or `--remove`) tags. `person:<slug>` assigns a person. |
| `tasks field <name> <key> [value\|clear]` | Set or clear a user-defined custom field declared in `overrides/task.md` (synced to ClickUp/GitHub). Validates select options + number types. |
| `tasks insert <name> <section> <content...>` | Insert into a section: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`. |
| `tasks log <name> [content...]` | Add a changelog entry (cross-session continuity). **Use every session.** |
| `tasks status <name> <todo\|in_progress\|in_review\|completed> [reason...]` | Change status (logs to changelog). On the first move to `in_progress`, stamps `start_date` with today if it is unset (a planned start is never overwritten). |
| `tasks complete <name> [summary...]` | Mark completed (convenience). |
| `tasks delete <name>` | Delete a task (propagates to remote backend on sync). `--yes`. |
| `tasks rename <name> <new-name>` | Rename a task: rewrites the name, moves the file to the new slug, and re-keys the sync mapping by the stable dcId so the **same** remote task/issue is updated on next sync — never duplicated. Use this instead of hand-editing `name:` + renaming the file. |
| `tasks doctor [name]` | Validate the Workflow flowchart is in sync with Acceptance Criteria (all tasks if name omitted). `--remote` also checks the remote backend for assignee drift (needs a token). |
| `tasks sync [push\|pull\|both]` | Sync with the remote backend (no-op on local). `--hook`, `--reconcile` (heal pre-existing assignee drift below the watermark — #78), `--json`. |
| `tasks members` | People with access to the remote list (assignee candidates). `--json`. |
| `tasks provision` | Create recommended + override-declared custom fields on the remote backend (ClickUp list fields / GitHub labels). Reuses any that already exist by name. |
| `tasks sync-hooks install\|uninstall` | Manage best-effort git sync triggers (post-commit, pre-push). |

Sections for `tasks insert`: `why`, `user_stories`, `acceptance_criteria`, `constraints`, `technical_details`, `notes`, `changelog`. See [tasks-and-features.md](tasks-and-features.md) for the full protocol.

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
| `memory recall <query...>` | Search the corpus (knowledge + features + tasks + memory + changelog). `-t/--top <n>`, `--types <csv>`, `--json`, `--plain`, `--vault <name>` (repeatable), `--connected`, `--all-vaults`. |
| `memory remember <text...>` | Quick-append a CHANGELOG entry (`type=note`, `scope=quick`). `--summary`, `--type`, `--scope`, `--references <csv>`, `--person <csv>`. |
| `memory update <slug>` | Update a knowledge file. `-d/--description`, `-t/--tags`, `-c/--content`, `--append <text>`, `--pin`, `--unpin`. |
| `memory delete <slug>` | Delete a knowledge file (irreversible; recover via git). `-f/--force`. |
| `memory list` | List the corpus by type. `--types <csv>`, `--plain`. |
| `memory status` | Corpus size + breakdown by type. |
| `recall status\|on\|off\|raw` | Control recall mode: `on`=haiku (default, LLM picks docs), `raw`=BM25 only, `off`=disabled. |

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
| `bookmark add <message...>` | Tag an important moment. `-s/--salience 1\|2\|3` (default 2), `-t/--task <slug>`. |
| `bookmark list` / `bookmark clear` | Show / remove all bookmarks. |
| `trigger add <when> <remind...>` | Create a contextual reminder. `-m/--max-fires` (default 3), `-s/--source`. |
| `trigger list` / `trigger remove <id>` | Show / remove triggers. |

---

## Taxonomy

| Command | Description |
|---|---|
| `taxonomy vocab` | Show the resolved vocabulary (defaults + `core/taxonomy.json`). `--json`, `--facet <facet>`. |
| `taxonomy audit` | Audit corpus tags against the vocabulary (read-only). `--json`. |
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

## Council (see [integrations.md](integrations.md))

`council create`, `council agent create`, `council round start\|end`, `council synthesize`, `council complete`, `council promote`, `council list`, `council show`. Plus sub-agent helpers (`round-context`, `report append`, `summaries`, `research add\|list`).

---

## Other

| Command | Description |
|---|---|
| `dashboard` | Open the web UI. `-p/--port`, `--host`, `--no-open`, `--vault`, `--launcher`. |
| `app install\|update\|status` | Manage the macOS desktop app. `--from <path>`, `--dir <dir>`. |
| `marketing` / `mk` | Meta marketing skill surface. |
| `transcript distill <session_id>` | Extract high-signal content from a transcript. `--since <ts>`, `--full`. |
| `reflect` | Surface recurring cross-session terms as candidates. `--min-sessions`, `--max`, `--write`. |
| `snapshot` | Output the context snapshot (used by SessionStart). `--tokens`, `--vault <name>`. |
| `migrations pending\|apply-diagrams\|record` | Inspect/apply brain-structure migrations. `record --files --summary`. |
| `feedback` | File a gap/bug upstream as a GitHub issue. See [improving-dreamcontext.md](improving-dreamcontext.md). |
| `hook <name>` | Hook handlers (called by the platform, not you): `session-start`, `stop`, `subagent-start`, `pre-tool-use`, `user-prompt-submit`, `post-tool-use`, `pre-compact`, `ensure-dashboard`, `refresh-asset-drift`. |

---

## Environment variables

| Var | Effect |
|---|---|
| `DREAMCONTEXT_MEMORY_HOOK=0` | Disable auto-injected recall on prompts. |
| `DREAMCONTEXT_RECALL_MODE=haiku\|raw\|off` | Override recall mode for the session (else uses `recall` setting; default `haiku`). |
| `DREAMCONTEXT_AUTO_DASHBOARD=0` | Don't auto-open the dashboard on session start. |
| `DREAMCONTEXT_DASHBOARD_PORT` | Default dashboard port (else 4173). |
| `DREAMCONTEXT_AUTO_UPGRADE=0` | Disable automatic CLI self-upgrade. |
| `DREAMCONTEXT_VERSION_CHECK=0` | Disable the version-check nag. |
| `DREAMCONTEXT_PERSON` | Current person for attribution (wins over the roster default). |
| `DREAMCONTEXT_SNAPSHOT_BUDGET` | Token budget cap for the SessionStart snapshot. |
| `DREAMCONTEXT_SKILLS_HOOK=0` | Disable skill-suggestion injection on prompts. |
| `DREAMCONTEXT_DRIFT_CHECK` / `DREAMCONTEXT_APP_AUTO_UPDATE` | Asset-drift check / desktop app auto-update toggles. |
| `DREAMCONTEXT_DEBUG` | Verbose diagnostics (e.g. recall decisions to stderr). |
