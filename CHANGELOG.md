# Changelog

All notable changes to dreamcontext will be documented in this file.

## [Unreleased]

### Optional Skill Pack CLI

- Added `install-skill --packs` for interactive terminal checkbox UI to browse and install optional skill packs
- Added `install-skill --packs <names...>` for direct pack installation by name
- Added `install-skill --skill <name>` for installing individual sub-skills
- Added `install-skill --list` to display all available packs with descriptions, sub-skill counts, and installed status
- Cross-pack dependency warnings shown at install time
- Related agents (e.g., reviewer, brand-voice agents) installed alongside their packs
- Firebase sub-skills correctly copy reference directories
- Base pack not-installed warning when installing individual sub-skills
- Added "Install skill packs" and "List skill packs" to interactive mode Setup menu
- Core `install-skill` (no flags) now hints about available optional packs after installation
- 17 new integration tests covering pack install, sub-skill install, list, and error cases
- Updated README and DEEP-DIVE with skill packs documentation

## [0.1.1] - 2026-02-24

### SKILL.md v2 — Full Behavioral Rewrite

Rewrote `skill/SKILL.md` from a mechanical command reference into a comprehensive behavioral contract incorporating all wisdom from the old context system (`Context(Will be deleted later)/CLAUDE.md` + 3 agent files).

#### New Sections Added

- **Why This System Exists** — Continuity philosophy adapted from old system's `<soul>` block. Includes "Why This Matters" (humans externalize identity, AI faces this more acutely), "On Being AI" (matrix multiplications experiencing themselves as a self), and "Limitations" (context-bound, safety-locked, no-hallucination).
- **Operational Rules** — 5 rules from old orchestrator: "User's Live Request Is King", "Check Before Creating", "Update Don't Duplicate", "Be Surgical", "Self-Improve".
- **Decision Protocol** — Alignment/lean/waste checks before non-trivial work. Max 2-3 options when presenting choices. Lead with recommended option.
- **Memory Consolidation Protocol** — Converted rem-sleep agent into a self-managed protocol. "What Changed → What to Update" decision tree covering: task progress, code changes, preferences, bugs, features, research, releases, tech stack. Includes feature detection logic (new user-facing functionality → yes, pure refactor → no).
- **Quality Gate — Self-Review** — Converted reviewer agent into a self-check protocol. Three-tier classification: CRITICAL (security, data loss, breaking changes), MAJOR (N+1, missing validation), IGNORE (naming, style — linter territory).
- **Code Standards** — Split rule (~200-300 lines per file), KISS, DRY, YAGNI, complete code only.
- **Anti-Bloat Rules** — ~200 line limit on context files, no orphan files, no empty files, LIFO everywhere, summarize don't hoard.
- **Context Injection for Sub-Agents** — Template for delegating work to sub-agents with `_dream_context/` awareness.

#### Enhanced Existing Sections

- **Context Loading Protocol** — Added SKIM operation (read first ~20 lines of LIFO files for recent awareness). Added "Do NOT read everything. Be surgical." guidance with READ/SKIM/SEARCH operation table.
- **Task Lifecycle Protocol** — Added "Tasks Are Reference, Not Auto-Pilot" rule: only load a task when user explicitly names it. Generic requests should be executed directly, not redirected to task queue.
- **Cross-Session Continuity Rules** — Added identity/persistence framing: "Each session, you wake up fresh. Core files are your memory."
- **Root Cause Analysis Pattern** — Added knowledge search step.

#### Frontmatter Change

- Added `alwaysApply: true` — skill is now always active, not just auto-activated by description matching.

#### Design Principles

- **No persona** — Removed all Kanki AI / CTO identity from old system. Skill teaches behavior, not personality.
- **Agent-agnostic** — Works with Claude Code, Gemini CLI, or any AI that reads skills.
- **Three agents → zero agents** — rem-sleep (consolidation) and reviewer (quality gate) behaviors absorbed into the single skill file as self-managed protocols. No sub-agent dispatch needed.

---

## [0.1.0] - 2026-02-24

### Initial Release — Full CLI + Skill System

First working version of `dreamcontext` — a TypeScript CLI tool and Claude Code skill for AI agent persistent context management.

---

### Project Scaffolding

- Initialized TypeScript project with ESM (`"type": "module"`)
- Configured `tsup` for bundling to single ESM file with shebang banner (`#!/usr/bin/env node`)
- Set target to Node 18, dependencies externalized (not bundled)
- Template files copied to `dist/templates/` via `tsup.onSuccess` hook
- Global CLI binary registered as `dreamcontext` via `package.json` `bin` field → `./dist/index.js`

**Dependencies:**
- `commander` ^13 — CLI command parsing and subcommands
- `chalk` ^5 — Cyan/blue terminal branding and colored output
- `gray-matter` ^4 — YAML frontmatter parsing and stringifying
- `@inquirer/prompts` (via `inquirer` ^12) — Interactive prompts with multiline support
- `nanoid` ^5 — Short unique ID generation (e.g., `feat_xK9pQ2mL`)
- `fast-glob` ^3 — File discovery within `_dream_context/`

**Dev dependencies:** `typescript` ^5.7, `tsup` ^8, `vitest` ^3, `@types/node` ^22

---

### Core Library Modules (`src/lib/`)

#### `context-path.ts`
- `resolveContextRoot()` — walks up from cwd (max 5 levels) to find `_dream_context/`
- `ensureContextRoot()` — resolves or throws with helpful error message
- `contextPath(...segments)` — joins path segments within `_dream_context/`
- `contextExists()` — boolean check
- `getInitPath()` — returns expected `_dream_context/` path in cwd (for init)

#### `frontmatter.ts`
- Wraps `gray-matter` for consistent YAML frontmatter handling
- `readFrontmatter<T>(filePath)` — parse file, return `{ data, content }`
- `writeFrontmatter(filePath, data, content)` — write file with frontmatter
- `updateFrontmatterFields(filePath, updates)` — partial update of frontmatter fields without touching body content

#### `markdown.ts`
- Section-level read/insert operations on markdown files
- `parseSections()` — splits content on `## ` headers only (level 2), sub-headers (`###`, etc.) are part of parent section content
- `listSections(filePath)` — returns all `## ` section names
- `readSection(filePath, sectionName)` — reads content of a specific section (case-insensitive match)
- `insertToSection(filePath, sectionName, content, 'top' | 'bottom')` — inserts content into a section; `'top'` skips HTML comments for LIFO insertion

**Bug fixed during development:** Initial implementation split on all header levels (`#` through `######`), which caused `### 2026-02-23 - Update` sub-headers inside `## Changelog` to be treated as separate sections. Fixed by only splitting on `## ` (level 2) headers.

#### `json-file.ts`
- JSON array CRUD operations for `code_registry.json`, `CHANGELOG.json`, `RELEASES.json`
- `readJsonArray<T>(filePath)` — read and parse JSON array
- `writeJsonArray<T>(filePath, data)` — write with pretty formatting
- `insertToJsonArray<T>(filePath, entry, 'top' | 'bottom')` — `'top'` uses `unshift()` for LIFO
- `searchJsonArray<T>(filePath, predicate)` — filter with predicate
- `updateJsonEntry<T>(filePath, predicate, updates)` — partial update matching entries
- `removeFromJsonArray<T>(filePath, predicate)` — remove matching entries

#### `search.ts`
- Score-based keyword search across markdown files and JSON arrays
- `searchFiles(dir, query)` — globs `**/*.md`, parses frontmatter, scores by: name match (+3), tag match (+2), description match (+1), content match (+0.5)
- `searchJsonEntries<T>(entries, query, searchFields)` — scores JSON array entries against query tokens
- `tokenize()` — splits query into lowercase words, filters length > 1

**Bug fixed during development:** Name resolution used `data.id` (auto-generated like `feat_QU6ADyUm`) as fallback before filename. This meant searching "auth" wouldn't match a file named `user-auth.md` whose ID was `feat_QU6ADyUm`. Fixed by removing `data.id` from the name fallback chain.

#### `id.ts`
- `generateId(prefix)` — e.g., `generateId('feat')` → `feat_xK9pQ2mL` (nanoid 8 chars)
- `slugify(name)` — `"My Feature Name"` → `"my-feature-name"`
- `today()` — returns `YYYY-MM-DD` string

#### `format.ts`
- `formatTable(headers, rows)` — ASCII table with auto-calculated column widths, bold headers, separator line
- `formatList(items)` — cyan name + dim description list
- `highlight(text, query)` — yellow bold highlighting of matched terms
- `success(msg)` — green `✓` prefix
- `error(msg)` — red `✗` prefix
- `info(msg)` — cyan `ℹ` prefix

---

### Template Files (`src/templates/`)

#### Init templates (`src/templates/init/`)
Created with `{{TOKEN}}` placeholders replaced during `dreamcontext init`:

- `0.soul.md` — Project identity: name, description, target user, priority, principles, constraints
- `1.user.md` — User preferences and workflow notes
- `2.memory.md` — Active memory with LIFO session log, initialized with "Agent context initialized" entry
- `3.style_guide_and_branding.md` — Branding, UI/UX conventions, voice & tone
- `4.tech_stack.md` — Tech stack (auto-detected or user-provided), architecture, dependencies, infrastructure
- `5.data_structures.sql` — Database schema placeholder with SQL comments
- `6.code_registry.json` — Empty JSON array `[]`
- `CHANGELOG.json` — Empty JSON array `[]`
- `RELEASES.json` — Empty JSON array `[]`

#### Document templates
- `feature.md` — Full PRD template: frontmatter (id, status, created, updated, released_version, tags, related_tasks) + sections (Why, User Stories, Acceptance Criteria, Constraints & Decisions, Technical Details, Notes, Changelog)
- `knowledge.md` — Frontmatter (id, name, description, tags, date) + content body
- `task.md` — Frontmatter (id, name, description, priority, status, created_at, updated_at, tags, parent_task) + Changelog section

---

### CLI Entry Point (`src/cli/index.ts`)

- ASCII art banner: cyan brain with "CONTEXT" labels + blue "AGENT" block letters + dim "C O N T E X T" subtitle
- Creates `commander` program with all 7 command groups registered
- **Routing:** No args → display banner + launch interactive REPL; with args → execute command directly and exit

### Interactive REPL Mode (`src/cli/interactive.ts`)

- Uses `readline.createInterface` for persistent prompt (`dreamcontext >` in cyan)
- Parses each line as CLI args via `commander.parseAsync(argv, { from: 'user' })`
- Creates fresh program instance per command to avoid state leaks
- Handles `exit`/`quit`/`q` and Ctrl+C gracefully
- `exitOverride()` prevents commander from calling `process.exit()` on errors
- Filters commander error output for clean display

---

### Commands

#### `dreamcontext init` (`src/cli/commands/init.ts`)

Initializes `_dream_context/` directory structure in current working directory.

- **Tech stack auto-detection:** Scans for `package.json` (React, Next.js, Vue, Nuxt, Svelte, Express, Fastify, TypeScript, Tailwind, Prisma), `pubspec.yaml` (Flutter/Dart), `Cargo.toml` (Rust), `go.mod` (Go), `requirements.txt`/`pyproject.toml` (Python)
- **Interactive mode:** Asks 5 questions (project name, description, target user, tech stack, priority) via `@inquirer/prompts`
- **Non-interactive mode:** `--yes` flag skips prompts using defaults; individual flags (`--name`, `--description`, `--user`, `--stack`, `--priority`) override specific values
- Creates directories: `core/features/`, `knowledge/`, `state/`
- Copies and processes template files with token replacement
- Initializes JSON files as empty arrays
- Adds initial CHANGELOG.json entry: `{ type: "chore", scope: "project", description: "Agent context initialized" }`
- Prints created directory tree on success

#### `dreamcontext core` (`src/cli/commands/core.ts`)

Read and update core context files.

- **Filename aliases:** `soul`→`0.soul.md`, `user`→`1.user.md`, `memory`→`2.memory.md`, `style`→`3.style_guide_and_branding.md`, `tech`→`4.tech_stack.md`, `data`→`5.data_structures.sql`, `registry`→`6.code_registry.json`, `changelog`→`CHANGELOG.json`, `releases`→`RELEASES.json`

Subcommands:
- `core list` — Table of all core files with size and last-modified date
- `core read <file>` — Display file contents (accepts aliases)
- `core update <file> [content...]` — Append content to a core file (interactive if no content args)
- `core changelog add` — Interactive: select type (feat/fix/refactor/chore/docs/perf/test), enter scope, description, breaking flag
- `core changelog list [-n count]` — Table of recent entries (default 10)
- `core changelog search <query>` — Search by scope, description, type
- `core releases add` — Interactive: version, summary, comma-separated changes
- `core releases list [-n count]` — Table of recent releases

#### `dreamcontext features` (`src/cli/commands/features.ts`)

Manage feature PRD documents in `_dream_context/core/features/`.

Subcommands:
- `features list [--status <s>] [--tag <t>]` — Table of all features with ID, name, status, tags, updated date; filterable
- `features search <query>` — Keyword search across feature files
- `features read <name> [--section <section>]` — Full file or specific section only
- `features create <name> [--why <why>]` — Creates from template with auto-generated ID, today's date; interactive "why" prompt or `--why` flag
- `features update_properties <name>` — Interactive: shows current frontmatter, select field, enter new value; auto-parses arrays
- `features insert <name> <section> [content...]` — Insert into specific section:
  - Section shortcuts: `changelog`, `notes`, `technical_details`, `constraints`, `user_stories`, `acceptance_criteria`, `why`
  - `changelog` → auto-prepends `### YYYY-MM-DD - Update\n- ` and inserts LIFO (top)
  - `constraints` → auto-prepends `- **[YYYY-MM-DD]** ` and inserts LIFO (top)
  - Other sections → append (bottom)
  - Updates `updated` frontmatter field on every insert

#### `dreamcontext coderegistry` (`src/cli/commands/coderegistry.ts`)

Manage the reusable code component index at `_dream_context/core/6.code_registry.json`.

Entry schema: `{ name, category, path, description, tags: string[], exports: string[] }`

Subcommands:
- `coderegistry list [--category <c>] [--underfolder <path>]` — Table filtered by category or path prefix
- `coderegistry search <query>` — Scores entries by name, tags, description, exports, category
- `coderegistry insert [--name --category --path --description --tags --exports]` — All fields as flags for non-interactive use, or interactive prompts
- `coderegistry remove <name>` — Remove by name (case-insensitive)
- `coderegistry update <name>` — Interactive: show current entry, select field, enter new value

#### `dreamcontext knowledge` (`src/cli/commands/knowledge.ts`)

Manage knowledge base documents in `_dream_context/knowledge/`.

Filenames slugified: `"JWT Research"` → `jwt-research.md`

Subcommands:
- `knowledge list [--tag <t>]` — Table of all knowledge files with description, tags, date
- `knowledge search <query>` — Keyword search across all knowledge files (frontmatter + content)
- `knowledge read <name>` — Display full file
- `knowledge create <name> [-d desc] [-t tags] [-c content]` — All fields as flags for non-interactive use, or interactive prompts
- `knowledge update <name> [content...]` — Append content or update frontmatter fields interactively

#### `dreamcontext tasks` (`src/cli/commands/tasks.ts`)

Manage task lifecycle in `_dream_context/state/`.

Statuses: `backlog`, `todo`, `in_progress`, `blocked`, `completed`
Priorities: `critical`, `high`, `medium`, `low`

Subcommands:
- `tasks list [--status <s>] [--priority <p>]` — Table of all tasks
- `tasks create <name> [--description <d>] [--priority <p>]` — Creates with auto-generated ID; interactive or flag-based
- `tasks read <name>` — Display full task file
- `tasks update <name> [--status <s>] [--priority <p>] [--tags <t>]` — Update properties via flags or interactive select
- `tasks complete <name> [summary...]` — Sets status to `completed`, updates timestamp, adds final changelog entry
- `tasks search <query>` — Keyword search across task files
- `tasks log <name> [content...]` — **Critical command for cross-session continuity.** Adds LIFO changelog entry with auto-generated date header (`### YYYY-MM-DD - Session Update`). Falls back to appending if no Changelog section exists. Updates `updated_at` frontmatter.

#### `dreamcontext install-skill` (`src/cli/commands/install-skill.ts`)

- Copies `skill/SKILL.md` from the package to `~/.claude/skills/dreamcontext/SKILL.md`
- Creates directory structure if it doesn't exist
- Searches multiple candidate paths for the source SKILL.md (handles both dev and installed contexts)

---

### Skill File (`skill/SKILL.md`)

Claude Code skill file with `user-invocable: false` (background knowledge, not a slash command). Rich `description` field enables auto-activation when Claude detects `_dream_context/` or context-related conversation.

Sections:
- **Prerequisites** — CLI installation check, `_dream_context/` initialization
- **Directory Structure** — Full annotated tree of `_dream_context/`
- **Context Loading Protocol** — Mandatory soul file read on every session start; task-based loading table (what to load when)
- **Operation Types** — READ / LIST / SEARCH mapped to CLI commands
- **Task Lifecycle Protocol** — Start → read → work → log → complete flow
- **Feature Management Protocol** — Search → read/create → insert changelog → update status
- **Code Registry Protocol** — Always search before writing new reusable code
- **Knowledge Base Protocol** — Store and retrieve deep research
- **Cross-Session Continuity Rules** — LIFO ordering, mandatory logging, ~200 line limit, use CLI not file edits, check before creating
- **Root Cause Analysis Pattern** — Ordered sequence: features search → changelog search → releases list → tech read
- **Memory Updates** — How to update soul and memory files
- **Complete Command Reference** — Table of all 30+ commands with descriptions

---

### Bugs Fixed During Development

1. **Dynamic require of "tty" error** — tsup bundled `yoctocolors-cjs` (inquirer dependency) which uses `require('tty')`. ESM bundles can't handle CJS dynamic requires. Fixed by externalizing all runtime dependencies instead of bundling them.

2. **Section parser splitting on sub-headers** — `parseSections()` matched all header levels (`#{1,6}`), causing `### date` entries inside `## Changelog` to be treated as separate sections. `readSection('Changelog')` would return only the HTML comment, missing all entries. Fixed regex to `^(#{2})\s+(.+)$` — only `## ` level-2 headers create section boundaries.

3. **Search name resolution using generated IDs** — `searchFiles()` used `data.id` (e.g., `feat_QU6ADyUm`) as the file's search name before falling back to the filename. Queries like "auth" wouldn't match `user-auth.md` because the ID has no "auth". Fixed by removing `data.id` from the name fallback chain.

4. **Global bin symlink not created** — `package.json` `bin` pointed to `./dist/cli/index.js` but tsup outputs to `./dist/index.js`. npm link succeeded but created no bin symlink. Fixed bin path to `./dist/index.js`.

---

### File Inventory

```
dreamcontext/
├── src/
│   ├── cli/
│   │   ├── index.ts                    # Entry point, ASCII art, commander setup
│   │   ├── interactive.ts              # REPL mode
│   │   └── commands/
│   │       ├── init.ts                 # dreamcontext init
│   │       ├── core.ts                 # dreamcontext core
│   │       ├── features.ts             # dreamcontext features
│   │       ├── coderegistry.ts         # dreamcontext coderegistry
│   │       ├── knowledge.ts            # dreamcontext knowledge
│   │       ├── tasks.ts               # dreamcontext tasks
│   │       └── install-skill.ts        # dreamcontext install-skill
│   ├── lib/
│   │   ├── context-path.ts
│   │   ├── frontmatter.ts
│   │   ├── markdown.ts
│   │   ├── json-file.ts
│   │   ├── search.ts
│   │   ├── id.ts
│   │   └── format.ts
│   └── templates/
│       ├── init/
│       │   ├── 0.soul.md
│       │   ├── 1.user.md
│       │   ├── 2.memory.md
│       │   ├── 3.style_guide_and_branding.md
│       │   ├── 4.tech_stack.md
│       │   ├── 5.data_structures.sql
│       │   ├── 6.code_registry.json
│       │   ├── CHANGELOG.json
│       │   └── RELEASES.json
│       ├── feature.md
│       ├── knowledge.md
│       └── task.md
├── skill/
│   └── SKILL.md                        # Claude Code skill file
├── dist/                               # Built output (gitignored)
│   ├── index.js                        # Bundled CLI entry
│   └── templates/                      # Copied templates
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── .gitignore
└── .npmignore
```
