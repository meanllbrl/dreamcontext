# Changelog

All notable changes to dreamcontext will be documented in this file.

## [Unreleased]

### A permission switch changes one conversation, and your pane layout comes back (2026-09-20)

Flipping **Auto → Bypass** in one chat composer stopped and respawned **every open chat in the
project**, and the panes came back **blank** — the whole conversation gone, not hidden. Separately,
the mode you picked was forgotten every launch, and five side-by-side panes reopened as one pane
with one chat visible.

The first three were **one modelling error with a five-link tail**, and no link is obvious alone.
The mode was stored as a single project-wide setting, so the switch looped the entire roster
pushing `set_permission_mode`. CLI 2.1.220+ **refuses** every live switch into `bypassPermissions`
for a process that did not boot with the flag, so *apply to all* is literally *restart all*. N
simultaneous restarts block the event loop on N synchronous `claude` spawns, which starves the
server's resume hand-off wait — its budget was **wall-clock**, and nothing polls while the loop is
blocked, so all 1.5s could be spent inside one block. The resuming session then found the
conversation still held, skipped `--resume` (held) *and* `--session-id` (a transcript exists), and
started a **brand-new, unpinned conversation**. Its SessionStart hook rewrote the tab→session map,
so the transcript replay resolved the tab's pinned id to the new empty file. A blank pane, an
orphaned pin, permanently.

- **One click, one conversation.** The permission segment now switches the chat it belongs to.
  The *reading* was already per-session — the indicator has to show what the running process is
  under, because a Plan → Develop hand-off runs `auto` inside a `bypass` project — so this only
  made the write agree. The choice is still remembered as the default for the next chat.
- **A resume that cannot take its conversation refuses instead of forking.** The pane raises
  *"Session ended · Resume"* carrying a sentence that says nothing was lost, and the button works
  the moment the other holder lets go. A visible, recoverable failure beats an invisible permanent
  one. The hand-off wait now counts **polls, not milliseconds**, so a blocked event loop cannot
  spend the budget without ever looking.
- **Your arrangement is remembered.** Which pane each tab sat in, which tab was in front of each,
  and which pane had focus now travel in the same per-vault, machine-local, gitignored file as the
  tab names. It could not live in the browser's storage for the same reason the permission mode
  could not: the desktop app picks a **fresh loopback port every launch**, so the origin is new and
  the store is empty, every time.
- **Each chat reopens under its own permission answer**, not the project default — the same
  exemption Resume already took, and what makes *"remember my choice"* true per conversation.

Corrected along the way: this codebase asserted in two places that Claude Code ≥2.1.x flushes a
transcript only on exit. Measured on 2.1.276 — it is written **live**, within ~2s. The loss was
never a flush race.

Proof: a new `npm run verify:pane-layout-restore` (16/16 — isolated HOME, real server, real
Chromium) rebuilds three panes with the right tabs, the right tab in front of each and the right
pane focused, then checks every restored tab's WebSocket upgrade carries **its own** permission
next to its conversation id — the fixture is adversarial, storing `bypass` as the default while one
tab was saved on `auto`. `verify:chat-composer` gains a section proving a click in one pane leaves
the other where it was, driven in the `→auto` direction because that one lands on every process and
would have moved every indicator. Every assertion was **mutation-tested**: with the fixes reverted,
the restore harness fails 9 checks and the composer harness reports `paneA=auto`. Plus 8 new unit
tests pinning both server guards, 18 on the stored layout, and 9787 green overall.

### `/mcp` in Chat is a working panel, and MCP servers can finally be shared with a team (2026-09-20)

Typing `/mcp` in the Chat window used to cost a turn and return a dead end. The headless
engine does not refuse the command, it **answers** it: a result frame carrying
`local_command: "mcp"` and the text *"24 MCP server(s): … Use `/mcp` in the terminal for
details."* (measured against CLI 2.1.276). The user typed exactly the right thing and was
sent to another application — while, on the machine this was found on, **26 of 32 servers
were unauthenticated**: the tools the agent believed it had were dead, and nothing in the
window could show that or fix it.

- **`/mcp` opens a panel showing what THIS CONVERSATION has.** The composer intercepts the
  command (narrowly — *"what does /mcp do?"* still reaches the model) and the panel lists
  every server with its live status, its scope, and a **Sign in** / **Sign out** where an
  action can actually work.
- **The source is the session, not a config file — the correction that took three cuts.**
  `claude mcp list` describes a config DIRECTORY, and on the owner's machine it and the
  session disagreed about **26 of 32 servers**: machine-local ones missing entirely, and a
  dozen connectors reported "Connected" that the session could not use, because an OAuth
  credential is stored per config directory. The panel now reads the session's own
  `system/init` frame, which carries `mcp_servers: [{name, status, source}]`. The probe is
  `claude -p "/mcp"`, which the engine answers as a local command — `num_turns: 0`,
  `total_cost_usd: 0` — so the truthful reading is also the free one, and it replaced a
  90-second health-check listing. The generalised lesson is written down as
  *Ask the subject, not its configuration*.
- **No button is drawn where none can work.** The frame says where each server came from. A
  server handed to a sandboxed session by reference is invisible to `claude mcp login` ("No
  MCP server named …", measured), so those rows get an explanation and a pointer to the fix
  instead of a sign-in that would fail.
- **The verdict after a sign-in is a re-read of the session, never the exit code.** An OAuth
  abandoned in the browser exits 0. And the login child's output is discarded at the spawn,
  because an interactive OAuth's stdout can carry a callback URL bearing an authorization
  code. Nothing is displayed, stored, logged or pasted.
- **Settings → MCP servers: the scope a team can share.** A colleague who opens dreamcontext
  could never reach your MCP servers, because a server in your `~/.claude.json` is yours
  alone and a claude.ai connector belongs to your account. The repo's `.mcp.json` is the one
  scope that travels: measured, an account that had never opened the repo saw a server there
  `connected` on its first run, with no approval step and nothing copied. The new Settings
  section shares one on a click — and **refuses to publish a secret**, rewriting every
  `env`/`headers` literal into a `${VAR}` reference and naming the variables the team must
  set, because that file is committed and a brain repo is synced across a team. A server
  whose URL carries its own token is refused outright.

Proof: 41 unit tests and 40 real-app assertions (`npm run verify:chat-mcp` — isolated HOME, a
scripted `claude` that reproduces the config-vs-session gap, real server, real Chromium),
including a leak canary printed by the login child that must appear in no response and no
pixel of the DOM, an abandoned login that must leave its row saying "Needs sign-in", and a
shared server whose secret must reach neither the repo file nor the API response. Against the
live CLI on this machine the panel now reports all 32 of the session's servers with the same
6 live / 26 needing sign-in that the agent's own startup notice reports.

### ECO speaks in two registers — firm from 300k, severe from 650k (2026-09-14)

The handoff nudge shipped with one register and it ended on *"keep going and ignore this.
It is a nudge, not an instruction."* Measured against six real sessions of this vault that
were nudged between 204k and 458k: **zero handoffs were requested.** The mechanism was
never the problem — hook, threshold, ladder, rotation and banner all fired correctly and
were re-verified against a 25MB transcript — it simply was never reached, because
declining was written as the cheap default.

- **Two registers, on the two edges the context rings are already drawn on.** FIRM from
  `nudgeAt`: hand off *unless* the task is nearly done or the state genuinely cannot be
  written down, with "I am in the middle of something" disqualified by name — it is what
  the `log` is for, and it was true of every session that ignored the old note. SEVERE from
  the new `hardAt`: imperative, and the decline clause grows the only tooth that does not
  break *agent-decided, never forced* — **if you keep going anyway you must tell the user
  and say why.** A silent default becomes a visible choice.
- **The nudge and the gauge can no longer disagree.** `CONTEXT_BAND_EDGES` moves to
  `src/lib/setup-config.ts` and IS the shipped ladder (300k / 650k); the dashboard mirrors
  it under a drift test. Previously the ring said "calm" to 350k while the nudge pushed
  from 200k. The default threshold now falls exactly on a band seam, so the ring's marker
  tick correctly draws nothing — the seam is the mark.
- **The first edge is 300k, not 350k — measured, not chosen.** Three readings, all from
  real transcripts (434 sessions across this vault and Tilki; the billing replay uses the
  120-session stream in `_dream_context/inbox/context-ceiling-research/`):
  1. **The optimum is below both.** Re-running the research simulator over a 4.85M-token
     task: the cost-minimising reset cap is 200–250k. A 300k cap sits 5% above it, 350k
     sits 10% above.
  2. **The lag decides it.** A nudge is not a cap — the agent finishes what it is doing,
     and the firm register explicitly permits "the task is nearly done". So the effective
     cap is `threshold + lag`. At a realistic +50k lag, 300k costs +10% over optimum and
     350k costs +18%; *300k with lag is 350k without it*.
  3. **Moving up does not buy quiet.** Counting sessions where a handoff would actually
     have paid for its ~30k re-orientation: 300k fires on 127 sessions (90 worth it, 29%
     noise), 350k on 95 (69 worth it, 27% noise). The noise rate is flat — going to 350k
     silences 32 sessions of which **21 were the useful ones**.
  The original reason for a 350k edge ("a normal working session runs the whole first
  band") survives intact: real sessions peak at a median of 153k and a p75 of 319k, so a
  300k edge still leaves 71% of sessions entirely inside the calm band. `hardAt` stays at
  650k — only 3% of sessions ever reach it, and those still carry a median 126k above it.
- **Crossing into the severe band always earns its own note**, even mid-cadence: a session
  nudged at 640k would otherwise not hear the new advice until 740k, missing the one moment
  the message is actually new. `NudgeState.lastTone` distinguishes an escalation from a
  repeat; state written by the previous build reads as `firm`, so an in-flight session still
  hears it. The repeat cadence is deliberately NOT shortened — a message that doubles in
  frequency reads as broken rather than urgent.
- **A pane owns the switch; the vault owns the thresholds.** Nothing in the UI ever set a
  per-pane threshold, yet every `tab-<pane>.json` had one baked in at write time — ten live
  panes were pinned to a 200k ladder nobody chose. `resolveHandoffFor` now takes only
  `enabled` from the tab file, which re-points every existing pane with no migration, and
  the server re-resolves before echoing the toggle so a tuned vault can't show one number
  and nudge on another.
- `dreamcontext config context-handoff on [--hard-at N]`; `config show` prints both
  thresholds. `hardAt` is clamped `>= nudgeAt`, so an inverted hand-edit cannot make every
  nudge severe, and raising `nudgeAt` past 650k carries the severe edge up with it.
- **The ECO lamp stops promising.** It read "hands off at 200k" — a statement of fact about
  something the agent may decline. It now reads `asks at 300k · insists at 650k` (measured
  at 220.6px in 260px of room, one line, in the real bundled Inter/JetBrains Mono).

### Opt-in context handoff — the agent is told at ~200k that it may continue in a fresh session (2026-09-13)

Measured on 120 real sessions of this vault (10,917 API calls): `cache_read` is 97.4% of
billed input tokens, and replaying the same work under a 200k reset bills **2.2–2.6× fewer
input tokens** than letting the window grow to 1M. The threshold dominates (150–250k is a
flat optimum); compact-vs-restart at an equal threshold is only a ~20% effect. Nothing told
the agent it was past the knee, so a long build session silently paid 2–3× for the same
task. Research artifacts: `_dream_context/inbox/context-ceiling-research/`.

- **Agent-decided, never forced.** Past `nudgeAt` the agent is handed a note with its own
  numbers, the two commands, and an explicit clause saying it may ignore them. No hard
  ceiling, no server-forced compaction, no change to Claude Code's own auto-compact.
- **Default OFF.** `dreamcontext config context-handoff on|off [--nudge-at N]
  [--remind-every N]` sets the vault default (defaults 200k / 100k); `config show` prints it.
  Invalid values fall back to the defaults; the CLI refuses a ladder below 20k / 10k.
- **`dreamcontext tasks handoff <slug> [note]`** logs the note to the task changelog, sets
  the task `in_progress`, records the request, writes a partial session digest, and appends
  a `CompactionRecord {trigger:'handoff', context_tokens}`. It does **not** write a global
  active-task pointer (removed in review: it raced across tabs).
- **Desktop Chat rotates itself.** At the next turn boundary after a handoff, the server
  sends `/clear` plus a continue prompt as user frames — verified on CLI 2.1.261 to rotate
  the conversation in-process and fire SessionStart with `source=clear`. The next session
  opens with a `>> HANDOFF:` banner above the snapshot naming the task. Terminal/PTY is
  instruction + banner only.
- **A `dream-html` diagram is sized to the pane it lands in.** The layout engine drew every
  diagram at the natural size of its type, so the same ten-node ladder measured 303px wide in
  a phone-width card and in a 1600px deck — 81% of the deck empty and the text at its
  smallest in both. The laid geometry is now the SHAPE and a resting scale decides how big it
  is drawn: it grows until the pane's width or a height budget stops it (the window itself in
  the fullscreen deck), and shrinks when the shape is wider than the pane. Height only ever
  limits the growth, so a narrow pane is left exactly as it was. Nodes and edge labels also
  got their own air.
- **The window is read as bands, not a percentage.** Both the composer ring and the usage
  popover split the window at **350k** and **650k** — a normal session, the region where a
  handoff is worth considering, and the region where every turn re-reads a very large
  transcript. The ring draws one arc per band (Apple Health style), the popover lays the
  same bands flat, and the edges are clamped to the real limit so a 200k-window model
  collapses to a single band instead of drawing dead rings. The handoff switch is an ECO
  pill that names the count it hands off at.
- **Per pane, remembered per vault per machine.** The composer's usage popover gains a
  "Hand off at 200k" switch; the context bar draws a marker tick at the threshold, a lighter
  track beyond it and a warning-tone fill past it, and the composer ring gets a matching
  notch. The last toggle seeds every new pane via `BrainLocalState.contextHandoffDefault`
  (gitignored, vault-scoped) — never app-global, which would have leaked the setting into
  every vault on the machine.
- **Never fires inside a sub-agent** (`agent_id`/`agent_type` on the hook payload, pinned
  against a real captured payload, plus `/subagents/` and sidechain-tail fallbacks), and
  never on a headless automation run (a tab-less session can claim a pending handoff only on
  `source=clear`).
- No new hook registration: `npx dreamcontext` costs ~1.0s per hook call, so the nudge rides
  the existing PostToolUse / UserPromptSubmit / SessionStart / PreCompact hooks.
- `contextTokensFromUsage` is now the single context formula (`computeSessionStats` imports
  it) and `liveTranscriptPath` moved to `src/lib/transcript-locate.ts` so the CLI can share
  it. `CompactionRecord.context_tokens` is optional — existing sleep states read unchanged.

### Memory Recall: CHANGELOG corpus + tiered display + hook default-on (2026-05-23)

- `dreamcontext memory` CLI namespace: `recall` / `remember` / `update` / `delete` / `list` / `status`.
- `memory remember` writes a CHANGELOG entry (`type=note`, `scope=quick` by default; override via `--type`/`--scope`). The LIFO marker in `2.memory.md` is gone — `2.memory.md` now contains Decisions + Known Issues only.
- UserPromptSubmit memory-recall hook is **ON by default**. Opt out with `DREAMCONTEXT_MEMORY_HOOK=0`.
- CHANGELOG schema gained optional `summary` (≤200 char soft cap), `references[]` (prefixed: `commit:|file:|knowledge:|feature:|task:|url:`), and `supersedes` (entry-id pointer). All backwards-compatible.
- CHANGELOG entries indexed in the recall corpus as their own `changelog` type. `recall --types changelog` is now valid; `CorpusType` in `recall.ts` extended.
- Snapshot's Recent CHANGELOG section is **tiered**: top 3 detailed (summary + ~300 char body), next 10 titles-only under `### Older`. Tier sizes configurable via constants at the top of `src/cli/commands/snapshot.ts`.
- Snapshot **Sleep State block removed** — consolidation pressure surfaces via the SessionStart consolidation directive prepend and the persistent UserPromptSubmit hook one-liner.
- Snapshot **Pinned Knowledge body inlining removed** — pinned files surface at the top of the Knowledge Index with a prominent warning; agent loads bodies on demand via the surfaced path.
- Snapshot active-task / feature `Why:` excerpt cap raised 100 → 250 chars. HTML template comments stripped from excerpts.
- Anti-bloat cap on core files tightened from 300 → 150 lines. Sleep specialists enforce during consolidation (promote / archive / condense rather than append).

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
