<p align="center">
  <img src="public/image/dreamcontext.png" alt="dreamcontext" width="120" />
</p>

<h1 align="center">dreamcontext</h1>

<p align="center">
  dreamcontext is the persistent brain for your AI agents — and for you.<br/>
  It remembers every decision you made, knows how your project is structured,<br/>
  and is learning to act on that knowledge so that every session starts ready instead of blind.<br/>
  Built for founders and builders, technical or not, who are tired of watching their agent<br/>
  re-discover context it already had.
</p>

<p align="center">
  <a href="#why">Why</a> &nbsp;&middot;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&middot;&nbsp;
  <a href="#quick-start">Quick Start</a> &nbsp;&middot;&nbsp;
  <a href="#skills">Skills</a> &nbsp;&middot;&nbsp;
  <a href="#staying-up-to-date">Updating</a> &nbsp;&middot;&nbsp;
  <a href="#dashboard">Dashboard</a> &nbsp;&middot;&nbsp;
  <a href="#desktop-app">Desktop App</a> &nbsp;&middot;&nbsp;
  <a href="#council">Council</a> &nbsp;&middot;&nbsp;
  <a href="#memory-recall">Memory Recall</a> &nbsp;&middot;&nbsp;
  <a href="#federation">Federation</a> &nbsp;&middot;&nbsp;
  <a href="#commands">Commands</a> &nbsp;&middot;&nbsp;
  <a href="DEEP-DIVE.md">Deep Dive</a>
</p>

<p align="center">
  <img src="public/image/landing-hero.png" alt="dreamcontext — the persistent brain for your AI agents" width="860" />
</p>

<p align="center">
  <sub>The built-in <strong>“What is this?”</strong> page, served live by <code>dreamcontext dashboard</code>.</sub>
</p>

> **Under active development.** APIs and commands may change before v1.0.

---

## Why

AI coding agents are powerful, but they make real mistakes. They fetch entire collections instead of filtering at the query level. They write serverless functions with infinite loop potential. They optimize for making the test pass, not making the system correct.

A human needs to be steering. But steering only works when both you and the agent are looking at the same context: what decisions were made, what is in progress, what rules to follow.

And every session starts from scratch. Your agent greps for a decision it already made yesterday. Reads a few files. Searches again. Pieces together context it already had. By the time it says "Ok, I understand the codebase," you haven't started working yet. This happens every session, and it gets worse as your project grows.

`dreamcontext` fixes both problems. It gives your agent structured, pre-loaded context before the first message, and gives you readable files you can open, audit, and correct. **Context that both you and your agent can act on.**

<table>
<tr>
<td width="50%" align="center">
<img src="public/image/dreamcontext_disabled.png" alt="Without dreamcontext" width="100%" /><br/>
<em><strong>Without dreamcontext</strong><br/>Search, read, search again.<br/>Tokens burned on re-discovery.</em>
</td>
<td width="50%" align="center">
<img src="public/image/dreamcontext_enabled.png" alt="With dreamcontext" width="100%" /><br/>
<em><strong>With dreamcontext</strong><br/>Context pre-loaded via hook.<br/>Zero tool calls. Straight to work.</em>
</td>
</tr>
</table>

> **Want the full story?** Philosophy, architecture, and every design tradeoff explained. **[Read the deep dive &rarr;](DEEP-DIVE.md)**

## How It Works

Every session, a hook pre-loads your project's whole brain — identity, decisions, active work, the knowledge index — into the agent with **zero tool calls**. It works with the full picture instead of re-discovering it; a multi-agent **RemSleep** cycle then consolidates what changed and feeds it back. (This is the same diagram the built-in **“What is this?”** page animates live.)

<p align="center">
  <img src="public/image/diagram-howitworks.png" alt="A SessionStart hook fans out into eight context categories — soul, user, memory, knowledge, state, data-structures, skills, sub-agents — that converge into the agent; RemSleep parallel specialists consolidate and feed back" width="820" />
</p>

<details>
<summary><strong>Full data-flow diagram</strong> — capture &rarr; store &rarr; inject</summary>

```mermaid
flowchart LR
    subgraph capture ["Capture"]
        STOP["Stop Hook\n(session ends)"]
        POSTTOOL["PostToolUse Hook\n(auto-format + tsc)"]
        BOOKMARK["Bookmarks\n(awake ripples)"]
        SLEEP["RemSleep cycle\n(3 specialists)"]
        HUMAN["You\n(edit files or dashboard)"]
    end

    subgraph store ["_dream_context/"]
        CORE["core/\nsoul · user · memory\nstyle · tech · features\nchangelog · releases\nsystem flow"]
        KNOWLEDGE["knowledge/\ntagged deep docs"]
        STATE["state/\ntasks · sleep debt\nbookmarks · triggers"]
    end

    subgraph inject ["Inject"]
        SESSION["SessionStart Hook"]
        PROMPT["UserPromptSubmit\n(persistent reminders)"]
        PRETOOL["PreToolUse Hook\n(context-first exploration)"]
        PRECOMPACT["PreCompact Hook\n(save state)"]
        SNAPSHOT["Compiled Snapshot\n+ warm knowledge\n+ contextual reminders"]
        AGENT["Agent starts with\nfull context loaded"]
    end

    BOOKMARK --> STATE
    STOP --> STATE
    POSTTOOL -.->|"feedback"| AGENT
    SLEEP --> CORE
    SLEEP --> KNOWLEDGE
    HUMAN --> CORE
    HUMAN --> KNOWLEDGE
    HUMAN --> STATE

    CORE --> SESSION
    KNOWLEDGE --> SESSION
    STATE --> SESSION
    STATE --> PROMPT
    SESSION --> SNAPSHOT
    PROMPT --> AGENT
    PRETOOL --> AGENT
    PRECOMPACT --> STATE
    SNAPSHOT --> AGENT
```

</details>

- **Seven hooks capture context automatically.** Stop hook records what happened. SessionStart injects everything before the first message. SubagentStart briefs sub-agents. PreToolUse blocks blind exploration when curated context exists. UserPromptSubmit reminds about sleep debt on every user message. PostToolUse auto-formats and type-checks edited files. PreCompact saves state before context compaction.
- **Bookmarks tag important moments.** During active work, the agent bookmarks decisions, constraints, and discoveries with salience levels. Critical bookmarks trigger immediate consolidation advisories.
- **Files are structured by purpose.** Identity, preferences, decisions, knowledge, and active work each live in their own file with their own format.
- **Sleep cycles consolidate knowledge.** A RemSleep cycle — the agent fanning out to three specialist sub-agents in parallel — reads bookmarks first, distills transcripts for high-signal content, extracts recurring patterns, promotes learnings, creates contextual triggers, cleans stale entries, and resets debt.
- **Everything is local markdown and JSON.** Readable, editable, git-tracked, owned by you.

<p align="center">
  <img src="public/image/diagram-sleep.png" alt="Sleep consolidation: accumulated debt triggers sleep start, which fans out to three parallel specialists — sleep-tasks, sleep-state, sleep-product — whose reports converge into one updated summary, then sleep done resets the debt" width="660" />
</p>
<p align="center">
  <sub><strong>Sleep consolidation</strong> — when debt crosses a threshold, three specialists fold what changed back into the brain in parallel, then the meter resets.</sub>
</p>

## Quick Start

```bash
curl -fsSL https://cdn.jsdelivr.net/npm/dreamcontext/install.sh | sh
```

> Served from the published npm package via CDN — works with a private repo, no GitHub access needed. On macOS this also installs the optional [desktop app](#desktop-app) into `~/Applications` (skip with `DREAMCONTEXT_INSTALL_NO_APP=1`).

**Manual install (npm):**

```bash
npm install -g dreamcontext
```

> Requires **Node.js >= 18**. Currently supports **Claude Code** and **Codex**.

```bash
# One-shot setup — scaffolds _dream_context/, installs the skill, agents,
# hooks, and root instructions, and prompts for optional skill packs.
dreamcontext setup

# Scriptable / non-interactive (explicit platforms, skip all prompts)
dreamcontext setup --platforms claude,codex --defaults
```

One command. Next session, the hook fires, context loads, and the agent is ready.

> **`setup` is the front door** — it runs init + install-skill + install-instructions in one step and tracks every file it writes in a manifest. The individual commands below still exist for advanced/scripted use, but `setup` is what you want on a new project.

<details>
<summary>Advanced: run the steps individually</summary>

```bash
# Scaffold the context structure only (does NOT install the agent integration)
dreamcontext init

# Install platform integration (multi-select prompt; defaults to Claude)
dreamcontext install-skill
dreamcontext install-skill --platforms claude,codex
```

`dreamcontext init` on its own leaves you without `.claude/` skills, agents, and hooks — your agent won't load the context until you also run `install-skill` (or just use `setup`). When run interactively, `init` now offers to finish the install for you.

</details>

### Interactive mode

Run `dreamcontext` with no arguments to enter interactive mode with a visual menu for all commands.

### What gets created

```
your-project/
├── _dream_context/              # Structured context (git-tracked)
│   ├── core/
│   │   ├── 0.soul.md                    # Identity, principles, rules
│   │   ├── 1.user.md                    # Your preferences, project details
│   │   ├── 2.memory.md                  # Decisions & known issues
│   │   ├── 3.style_guide_and_branding.md
│   │   ├── 4.tech_stack.md              # Tech decisions
│   │   ├── 6.system_flow.md             # Session lifecycle, data flows
│   │   ├── CHANGELOG.json
│   │   ├── RELEASES.json
│   │   └── features/                    # Feature PRDs
│   ├── knowledge/                       # Tagged docs (index in snapshot)
│   │   ├── data-structures/             # Schema files (SQL-fenced, highlighted)
│   │   │   └── default.md              # single-product; one per product if monorepo
│   │   └── *.md                         # pinned: true → auto-loaded in full
│   └── state/                           # Active tasks + working state
│       ├── *.md                         # Active task files
│       ├── .sleep.json                  # Sleep debt, session history
│       └── .version-check.json          # Cached update check (24h)
│
├── .claude/
│   ├── skills/dreamcontext/
│   │   └── SKILL.md            # Teaches the agent the system
│   ├── agents/
│   │   ├── dreamcontext-initializer.md
│   │   ├── dreamcontext-explore.md
│   │   ├── sleep-tasks.md       # RemSleep specialists —
│   │   ├── sleep-state.md       #   the agent fans out to
│   │   ├── sleep-product.md     #   these three in parallel
│   │   ├── sleep-federation.md  # disabled (read-only federation; copy-sync parked on roadmap)
│   │   └── sleep-migration.md   # conditional: when a migration is pending
│   └── settings.json           # 7 hooks (see Commands → System)
```

### Opening the context directory in Obsidian

`dreamcontext init` scaffolds an `_dream_context/.obsidian/` vault config with curated graph, appearance, and app settings so you can open the directory directly in Obsidian and navigate the context as a knowledge graph. Links between files (tasks → features → knowledge → memory) render natively, and the Obsidian graph view works out of the box.

### Root instruction files without full skill install

For projects that want managed root instruction files without installing the full skill + agent bundle:

```bash
dreamcontext install-instructions --platforms claude,codex
```

This writes managed fenced blocks into `CLAUDE.md` and/or `AGENTS.md` at the project root, preserving existing non-managed content.

## Skills

The core `dreamcontext` skill (installed by `install-skill`) teaches your agent the context system itself. On top of that, dreamcontext ships **curated skill packs and standalone skills** that give your agent domain expertise — loaded on demand, only when the work calls for it, so they cost nothing the rest of the time.

```bash
# Browse and install interactively (terminal checkbox UI)
dreamcontext install-skill --packs

# Install specific packs directly
dreamcontext install-skill --packs engineering design

# Install one orchestration pack (council, multi-review, goal-skill)
dreamcontext install-skill --packs goal-skill

# Install a single sub-skill or standalone skill
dreamcontext install-skill --skill firebase-firestore
dreamcontext install-skill --skill system-prompts

# See everything available
dreamcontext install-skill --list
```

**Skill packs** (a base skill + on-demand sub-skills or sub-agents):

| Pack | What it covers | Inside |
|------|---------------|--------|
| **engineering** _(always-on)_ | Coding standards, security, testing, architecture | backend-principles, web-app-frontend, firebase-cloud-functions, firebase-firestore |
| **design** _(always-on)_ | Design systems, typography, color, accessibility | frontend-principles, design-web, design-mobile, onboarding-design |
| **growth** | Retention, distribution, monetization, analytics | performance-marketing, lean-analytics-experiments, lean-analytics-metrics |
| **brand-voice** | Brand enforcement, discovery, guideline generation | discover-brand, guideline-generation |
| **council** | Multi-persona debate for hard decisions | `council-persona`, `council-synthesizer` agents |
| **multi-review** | Multi-agent code review (router + niche specialists) | `review-router` + security / cloud-functions / frontend / edge-cases agents |
| **goal-skill** | Sub-agent-orchestrated execution: plan → review → implement → validate | `goal-planner`, `goal-plan-reviewer`, `goal-implementer`, `goal-validator` agents |

**Standalone skills** (install individually with `--skill <name>`):

| Skill | What it covers |
|-------|----------------|
| **business-idea-discovery** | Market selection, trend validation, competitor intel, pain-point mining, MVP scoping |
| **business-idea-validation** | Demand testing via landing page + waitlist, quick validation loops |
| **meta-marketing** | Meta / Facebook / Instagram ad campaigns end to end |
| **system-prompts** | Prompt engineering, cognitive architecture, agent design |
| **excalidraw** | Lay out images, labels, shapes, arrows, frames, and lanes on an Obsidian Excalidraw board from a small JSON spec — renders deterministically at near-zero token cost |
| **video-watching** | Turn a video into a time-mapped transcript with on-screen visuals described inline (whisper.cpp + ffmpeg), then reason about it |

_Always-on_ packs apply their base principles to every relevant task; the rest load only when the work matches. Packs install to platform-specific paths — Claude: `.claude/skills/{pack}/` (+ agents in `.claude/agents/`); Codex: `.agents/skills/{pack}/` (+ agents in `.codex/agents/`). Cross-pack dependencies are warned at install time.

## Staying Up to Date

dreamcontext tells you when a new version ships, and updating is one command. There are two distinct things to update: the **CLI** (the `dreamcontext` binary) and your **project's installed files** (the skill, agents, and hooks copied into `.claude/` or `.agents/`).

```bash
dreamcontext upgrade            # Upgrade the CLI to the latest published version
dreamcontext upgrade --check    # Just print "current: X  latest: Y" and exit
dreamcontext update             # Refresh this project's skill/agent/hook files to match the CLI
```

Or re-run the one-command installer — it detects an existing `_dream_context/` and updates in place:

```bash
curl -fsSL https://cdn.jsdelivr.net/npm/dreamcontext/install.sh | sh
```

**In-session update nudge.** When a newer version is published, your agent sees a single-line nudge at the top of its loaded context — so you find out while you're working, not months later. The version check is deliberately unobtrusive: it runs **at most once every 24 hours**, never during the context-loading hot path (so session start is never slowed or blocked), and fails silent if npm is unreachable. Opt out entirely with `DREAMCONTEXT_VERSION_CHECK=0`.

## Dashboard

```bash
dreamcontext dashboard                   # Open at localhost:4173
dreamcontext dashboard --port 8080       # Custom port
dreamcontext dashboard --no-open         # Start without opening browser
```

A local web UI for managing agent context visually. Built with React 19, served by a zero-dependency Node HTTP server. Ships in the npm package.

It also ships a built-in **“What is this?”** explainer page — a full landing experience with a spotlight that reveals each faculty's live diagram, and a layered map of how the brain is organized:

<p align="center">
  <img src="public/image/landing-spotlight.png" alt="Feature spotlight — pick a faculty to see its live diagram" width="840" />
</p>
<p align="center">
  <img src="public/image/landing-architecture.png" alt="Memory, organized like a mind — the layered brain-region map" width="840" />
</p>

<table>
<tr>
<td width="50%">

**Kanban board** with drag-and-drop, multi-select filters (status, priority, urgency, tags, version) with type-ahead search, sorting, and grouping by any field. **Eisenhower matrix** view for priority-urgency quadrant planning. Create tasks, update status, add changelog entries from a Notion-style detail panel.

</td>
<td width="50%">

**Core editor** with split-pane markdown editing and live preview. Knowledge manager with search and pin/unpin. Feature PRD viewer. SQL ER diagram preview. **Version manager** for planning and releasing versions.

</td>
</tr>
<tr>
<td width="50%">

**Sleep tracker** showing debt gauge, session history timeline, and a list of every manual change made through the dashboard.

</td>
<td width="50%">

**Change tracking** records every dashboard action to `.sleep.json` so the agent knows what you changed between sessions and consolidates it during sleep.

</td>
</tr>
<tr>
<td width="50%">

**Brain graph** visualizes your knowledge as an interactive network. Nodes are memory, knowledge, features, and decisions; edges are explicit and inferred links. Node drawer for full content, settings panel for layout and filters.

</td>
<td width="50%">

**Council Hall** shows every multi-persona debate as a searchable card grid. Open a debate into a full-page detail view with three tabs: **Overview** (problem + synthesized final report + citation chips), **Agents** (per-persona transcripts with search), **Matrix** (persona × round grid with inline cell expansion).

</td>
</tr>
</table>

Light and dark mode with system preference detection. Brand palette: purple-to-magenta gradient. Visby CF font with system font fallback.

## Desktop App

> **macOS beta.** A native **Tauri 2** app that wraps the same dashboard server, so you manage every project from one window instead of a localhost tab per repo. Ships via the desktop release (and the macOS one-line installer), not the npm package.

```bash
dreamcontext app install      # Install to ~/Applications (no admin, no quarantine prompt)
dreamcontext app update       # Update the installed app to the latest release
dreamcontext app status       # Show installed app version and state
```

- **Multi-vault launcher.** The app lists every registered [vault](#federation) and opens each project in its **own window** — multi-vault is multi-window over one shared Node server, with each window pinned to its vault via a request header. A per-project status dot (green up-to-date / yellow needs-update / red folder-gone) lets you run `update` from the UI.
- **Federation network view.** The launcher also renders your projects as an interactive board (Excalidraw-style cards) where you wire a **reads** relationship by clicking source → target: a violet wire means one project reads another's canonical memory **live** during recall (a reference, never a copy), gated by the target being Readable. A node panel and an always-on "Connections" list spell out in plain language who reads whom, each removable with one click. (Copy-based "sync" is parked on the roadmap — federation only reads, live.)
- **In-app onboarding, no terminal.** A quiz-style wizard creates a brand-new project (native folder picker) or initializes an existing folder, scaffolds `_dream_context/`, runs `setup`, and best-effort installs the global CLI. It's deterministic and LLM-free; the success screen hands you a prompt to paste into Claude Code for the rich enrichment pass.
- **Sleepy — notch quick-capture _(beta)_.** A global-hotkey companion that drops a transparent notch panel over whatever you're doing, with an animated mascot whose mood follows your sleep debt. Pick a vault, type a thought, and choose a mode:
  - **Learn** — saves the note to project memory, then enriches it.
  - **Ask** — one-shot Q&A about the project; nothing is saved.
  - **Sleep** — triggers a full consolidation cycle for that vault from the notch.
- **Continuous updates without Apple notarization.** The whole delivery path is CLI/curl-driven, so Gatekeeper's notarization check never fires (ad-hoc signing satisfies Apple Silicon). The app prefers your globally-installed, auto-upgrading CLI over its bundled copy, so ~95% of changes ride the normal CLI upgrade with no app rebuild. Downloaded artifacts require a matching `.sha256` or the install refuses.

> The desktop app is a working local beta — not yet Apple-signed/notarized, so first launch may need a right-click → Open. Windows/Linux are nice-to-have for later.

## Council

**Multi-persona debates for hard decisions.** When a question is too load-bearing for a single model pass — architecture calls, hiring reviews, risk-heavy migrations, brand critiques — a council lets you convene N personas, run them through N rounds of structured deliberation, and synthesize a verdict that cites the contributing voices.

Each persona gets its own sub-agent with a scoped prompt, model choice, and aspects it advocates for. Between rounds, personas see a cross-context panel summarizing what everyone else said, so responses sharpen rather than repeat. A synthesizer produces the final report.

```bash
# Start a debate
dreamcontext council create "Should we migrate from Postgres to Firestore?" \
  --rounds 2

# Add personas (each gets a sub-agent and persona file)
dreamcontext council agent create migration-risk-auditor --model sonnet \
  --aspects operational-risk,rollback-readiness,team-readiness
dreamcontext council agent create dx-champion --model opus \
  --aspects developer-experience,feature-velocity
dreamcontext council agent create user-advocate --model haiku \
  --aspects end-user-impact,reliability-perception

# Drive rounds (the CLI orchestrates sub-agent dispatch; reports append as they return)
dreamcontext council round start 1
dreamcontext council round end 1              # Injects cross-context for R2+
dreamcontext council round start 2
dreamcontext council round end 2

# Synthesize the final report
dreamcontext council synthesize
dreamcontext council complete

# Optionally promote the verdict into knowledge
dreamcontext council promote --to knowledge/migration-decision
```

Each debate stores its state in `_dream_context/council/<id>/` with `debate.md`, `round-log.md`, `final-report.md`, and per-persona folders containing `context-and-persona.md`, `report.md`, and `researches/`. The dashboard's **Council Hall** page renders this data as a searchable grid and full-page detail view.

Ships with two sub-agents (`council-persona`, `council-synthesizer`) and a dedicated skill pack at `skill-packs/council/`.

## Memory Recall

Recall and remember across your project's curated context. BM25 ranking over knowledge files, feature PRDs, task files, `2.memory.md` sections, and `CHANGELOG.json` entries — deterministic, instant, no setup.

<p align="center">
  <img src="public/image/diagram-recall.png" alt="Memory recall pipeline: your prompt → BM25F keyword match (field-weighted, stemming, synonyms) → Haiku recall (smallest cloud agent, 0-3 docs, BM25 fallback) → SessionStart snapshot (warm + cold knowledge, features, index, pinned)" width="860" />
</p>

```bash
# Ask a question, get top-5 hits with snippets
dreamcontext memory recall "how did we decide on the sleep fan-out"

# Filter by corpus type (knowledge | feature | task | memory | changelog)
dreamcontext memory recall "auth flow" --types knowledge,feature
dreamcontext memory recall "deprecated" --types changelog

# Machine-readable output for scripts
dreamcontext memory recall "rice prioritization" --json --top 3

# Quick-capture a decision or note — writes a CHANGELOG entry (type=note, scope=quick)
dreamcontext memory remember "Chose BM25 over mem0 after 3-reviewer review"

# Inspect the corpus
dreamcontext memory status
```

**Why not a vector DB or mem0.** dreamcontext content is already curated atomic facts — knowledge docs, feature PRDs, closed tasks, memory entries, CHANGELOG entries. The LLM-extraction step a mem0-style stack provides solves a problem this system already solved. BM25 over the live corpus gives ~80% of the value at 1% of the complexity: zero new npm dependencies, no Python, no Ollama, no API keys, no embeddings to invalidate, version-controllable. Cold start is under 100ms on a 40-doc corpus; the index is rebuilt in memory on every call.

Hook injection is **ON by default**: top hits are auto-surfaced to the agent on every non-trivial user prompt via the UserPromptSubmit hook. Opt out with `DREAMCONTEXT_MEMORY_HOOK=0` if you want raw prompts without context augmentation.

**Recent CHANGELOG in the snapshot is tiered**: top 3 entries detailed (summary + ~300 char body), next 10 titles-only under an "Older" subheading. Everything older still lives in `CHANGELOG.json` and is reachable through `memory recall --types changelog`.

## Federation

Most people end up with more than one dreamcontext project. **Federation** lets those projects discover each other and recall across each other **live** — each vault stays the single source of truth for its own knowledge, and sees its peers' canonical knowledge by reference at query time. All opt-in, all local, no server in the middle, and **nothing is ever copied between vaults**.

It starts with a **global vault registry** — every project you register is a *vault* the CLI (and the [desktop app](#desktop-app)) can address by name.

```bash
dreamcontext vaults add <name> <path>     # Register a project directory as a vault
dreamcontext vaults discover [root]        # Find every _dream_context/ project under a tree
dreamcontext vaults discover ~/projects --register  # …and register the new ones (idempotent)
dreamcontext vaults list                   # List all registered vaults
dreamcontext vaults remove <name>          # Unregister a vault
```

**Cross-vault recall.** Point a recall at other vaults and it spans them, returning hits tagged with their source vault. Only vaults you've marked shareable are reachable.

```bash
dreamcontext config shareable on                      # Allow this vault to be recalled by peers
dreamcontext memory recall "<query>" --vault other-project   # Also search a named vault (repeatable)
dreamcontext memory recall "<query>" --connected             # Span this vault + its out/both connections
dreamcontext memory recall "<query>" --all-vaults            # Span this vault + every shareable vault
```

**Connections = a live read edge.** Connect to a peer and your recall (and the per-prompt recall hook) surfaces that peer's **canonical** docs live — a reference, never a copy. A decision made in one repo shows up in a sibling repo's recall *as it is in the source*, always current, with no stale duplicate left behind.

```bash
dreamcontext connect <vault> --direction out --topics api,auth   # Connect to read a peer (out = read)
dreamcontext connections                  # Inspect this vault's federation connections
dreamcontext disconnect <vault>           # Remove a connection
dreamcontext federation peers             # Compact summary of readable peers (ambient awareness)
dreamcontext federation status            # Connections + any leftover federated copies
dreamcontext federation purge --all       # Remove leftover federated:true copies from the old sync path
```

A peer is readable when your connection to it is `out`/`both`, it isn't stale, **and** it has opted in with `config shareable on`. Reads happen live at recall time; the transitive-leak guard keeps a third vault from seeing what merely passed through this one.

> **Note — copy-based sync is parked on the roadmap.** Earlier builds pushed a lossy, truncated *digest* into peers at sleep (`federation sync`) and ingested it as `federated: true` copies (`federation drain`). That broke single-source-of-truth: copies went stale the moment the source changed and re-edits bred duplicates. Those verbs are now **inert no-ops** and the `sleep-federation` specialist is no longer dispatched. If a vault still holds old copies, clear them with `federation purge`. A redesigned opt-in offline-mirror mode may return later — its one genuine advantage is surviving a peer going offline, which live read can't.

## Commands

### Core

```bash
dreamcontext core changelog add           # Add changelog entry
dreamcontext core releases add            # Create release with auto-discovery
dreamcontext core releases add --yes      # Non-interactive, include all unreleased items
dreamcontext core releases add --ver v0.2.0 --summary "..." --status planning  # Planning version
dreamcontext core releases list           # List recent releases
dreamcontext core releases show <version> # Show release details
```

Release creation auto-discovers unreleased tasks, features, and changelog entries. Back-populates `released_version` on included features. Use `--status planning` to create a version placeholder without auto-discovery. Tasks can be assigned to planning versions, and the version manager in the dashboard provides a "Release" action to transition from planning to released.

### Tasks

```bash
dreamcontext tasks list                   # List active tasks (excludes completed)
dreamcontext tasks list --all             # List all tasks
dreamcontext tasks list --status in_progress  # Filter by status
dreamcontext tasks create <name>          # Create a task
dreamcontext tasks create <name> --priority high --status in_progress --tags "api,auth" --urgency high --version v0.2.0
dreamcontext tasks log <name> <content>   # Log progress (newest first)
dreamcontext tasks insert <name> <section> <content>  # Insert into a named section
dreamcontext tasks complete <name>        # Mark completed
```

All flags (`--description`, `--priority`, `--status`, `--tags`, `--why`, `--urgency`, `--version`) are optional. Defaults to medium priority/urgency and todo status, so the command works non-interactively for agent use.

#### Cloud Task Management (ClickUp backend)

Tasks default to local markdown files. Optionally they can live in a ClickUp
list instead — same CLI verbs, same dashboard, same recall/snapshot behavior,
backed by a gitignored local mirror:

```bash
dreamcontext config task-backend clickup            # switch backend (gitignores mirror/sync files, installs git triggers)
dreamcontext config clickup-list <teamId> <spaceId> <listId>
dreamcontext config clickup-token [--user <name>]   # stored in a gitignored secrets file (0600), never in .config.json
dreamcontext tasks sync [push|pull|both]            # manual two-way sync
dreamcontext tasks sync-hooks install               # best-effort post-commit/pre-push triggers (can never fail git)
```

- Talks to the ClickUp REST API directly (no MCP) — works headless in git
  hooks, post-sleep consolidation, and cron.
- Sync is watermark-based on ClickUp **server time**: one field-level `PUT`
  per task under the ~100 req/min rate limit, changelog entries become
  comments (union-merged), prose merges 3-way against the last synced base.
- Conflicts are never silently lost: when ClickUp wins, the local copy is
  preserved under `state/.conflicts/` and surfaced in the sync report and
  dashboard.
- Offline edits queue in `state/.tasks-queue.json` and replay idempotently.
- Tokens resolve env (`CLICKUP_TOKEN`, or a per-person `tokenEnv`) → secrets
  file; `config show` only ever prints a masked token.
- **Assignees need no manual mapping**: each sync caches the list's members;
  `dreamcontext tasks members` shows them with their slugs. Tag a task
  `person:<slug>` (or set the `assignee` field) and the push assigns the
  ClickUp member; a remote assignment pulls back as both the field and the
  tag. `config clickup-member` stays available as an explicit override.
- **Tags edit anywhere**: `dreamcontext tasks tag <name> <tags…> [--remove]`
  edits tags on existing tasks; changed tags push through ClickUp's per-tag
  endpoints (its PUT carries none), and assignee handovers/removals push as
  add/rem deltas.
- **Due dates**: `tasks create --due 2026-07-01` / `tasks due <name> <date|clear>`
  — synced natively in both directions.
- **Custom-field bridge**: create list fields named Urgency / Summary / Reach /
  Impact / Confidence / Effort / Score / Feature / Version and sync writes and
  reads them automatically.
- **Docs**: illustrated user guide → [docs/clickup.md](docs/clickup.md);
  technical reference → [docs/remote-task-setup.md](docs/remote-task-setup.md).

### Features

```bash
dreamcontext features create <name>       # Create a feature PRD
dreamcontext features insert <name> <section> <content>
dreamcontext features doctor              # Audit PRD freshness (stale / orphaned / dangling refs)
```

Feature PRDs track freshness the same way knowledge does. `features doctor` reports which PRDs have gone stale, which have no linked task or release, and which reference things that no longer exist — so the sleep cycle (and you) can keep them in step with the code.

### Knowledge

```bash
dreamcontext knowledge create <name>      # Create a knowledge doc
dreamcontext knowledge index              # List all with descriptions + tags
dreamcontext knowledge index --tag api    # Filter by tag
dreamcontext knowledge tags               # List standard tags
dreamcontext knowledge touch <slug>       # Record access (staleness tracking)
```

Set `pinned: true` in frontmatter to auto-load a knowledge file in every snapshot. Knowledge files not accessed in 30+ days are flagged as stale. Recently accessed files appear in a "warm knowledge" tier with first-paragraph previews.

### Memory

```bash
dreamcontext memory recall <query...>                # BM25 search over knowledge + features + tasks + memory + changelog
dreamcontext memory recall <query...> --top 10       # Number of hits (1-50, default 5)
dreamcontext memory recall <query...> --types knowledge,task,changelog
dreamcontext memory recall <query...> --vault other    # Also search a named vault (repeatable)
dreamcontext memory recall <query...> --connected      # Span this vault + its connected peers
dreamcontext memory recall <query...> --all-vaults     # Span every shareable registered vault
dreamcontext memory recall <query...> --json         # Machine-readable
dreamcontext memory recall <query...> --plain        # No ANSI colors
dreamcontext memory remember "<text>"                # Writes a CHANGELOG entry (type=note, scope=quick by default)
dreamcontext memory remember "<text>" --type fix --scope api --summary "..." --references commit:abc,task:auth-refactor
dreamcontext memory update <slug> --description "..." --tags a,b --append "..."
dreamcontext memory update <slug> --pin              # or --unpin
dreamcontext memory delete <slug> --force
dreamcontext memory list                              # List indexed docs
dreamcontext memory list --types feature,task
dreamcontext memory status                           # Corpus stats by type
```

`memory remember` writes a CHANGELOG entry instead of appending to a LIFO section in `2.memory.md` (the LIFO section was removed in 2026-05-23 — `2.memory.md` now holds Decisions + Known Issues only). The new CHANGELOG schema supports optional `summary` (≤200 char soft cap), `references[]` (prefixed: `commit:|file:|knowledge:|feature:|task:|url:`), and `supersedes` (entry-id pointer).

Recall has no setup step — no init, no daemon, no API keys. The corpus is rebuilt in memory on every call (under 100ms on a 40-doc corpus). UserPromptSubmit hook injection of top hits is **ON by default**; set `DREAMCONTEXT_MEMORY_HOOK=0` to opt out.

### Bookmarks

Tag important moments during active work. Inspired by the brain's awake sharp-wave ripples that bookmark memories for consolidation during sleep.

```bash
dreamcontext bookmark add "<message>" -s 2    # Bookmark with salience (1-3)
dreamcontext bookmark list                     # Show all bookmarks
dreamcontext bookmark clear                    # Clear all bookmarks
```

Salience levels: 1 = notable, 2 = significant, 3 = critical. Critical bookmarks trigger immediate consolidation advisories regardless of debt level.

### Triggers

Contextual reminders that fire when matching tasks are active. The brain's prospective memory: "remind me about X when working on Y."

```bash
dreamcontext trigger add "<when>" "<remind>"   # Create a trigger
dreamcontext trigger list                       # Show active triggers
dreamcontext trigger remove <id>                # Remove a trigger
```

Triggers match against active task names, tags, and bookmark text. Auto-expire after a configurable number of fires (default 3).

### Sleep

Sleep debt is tracked automatically via hooks. The UserPromptSubmit hook reminds about debt on every user message, so the agent cannot dismiss the reminder. Consolidation rhythm advisory fires after 3+ sessions since last sleep, even at low debt.

```bash
dreamcontext sleep status                # Debt level, sessions, last sleep
dreamcontext sleep history               # Consolidation log
dreamcontext sleep add <score> <desc>    # Add debt manually
dreamcontext sleep start                 # Mark consolidation epoch
dreamcontext sleep done <summary>        # Complete consolidation, reset
dreamcontext sleep debt                  # Raw number (for scripts)
```

### Transcript

```bash
dreamcontext transcript distill <session_id>   # Structural filter of session transcript
```

Extracts high-signal content from raw JSONL transcripts: user messages, agent decisions, code changes, errors, bookmarks. Discards noise (Read results, Glob output, tool metadata). Pure Node.js, no AI. Used by the RemSleep specialists for selective deep analysis of important sessions.

### Council

```bash
dreamcontext council create <topic> [--rounds N]     # Open a new debate
dreamcontext council list                             # List all debates
dreamcontext council show <id>                        # Show a debate's current state
dreamcontext council agent create <slug> --model <m> --aspects a,b,c
dreamcontext council round start <n>                  # Dispatch round n to all personas
dreamcontext council round end <n>                    # Close round n, inject cross-context for n+1
dreamcontext council round round-context <n>          # Preview what personas will see at round n
dreamcontext council report append <slug> <n> <path>  # Append a persona report from file
dreamcontext council report summaries <n>             # Summaries of all reports in round n
dreamcontext council research add <slug> <topic> <path>  # Persist a persona's research note
dreamcontext council research list <slug>
dreamcontext council synthesize                       # Produce the final synthesized report
dreamcontext council complete                         # Mark the debate complete
dreamcontext council promote --to <knowledge-slug>    # Promote verdict to knowledge
```

See the [Council](#council) section above for the full workflow.

### Vaults & Federation

```bash
dreamcontext vaults add <name> <path>    # Register a project as a vault
dreamcontext vaults discover [root]      # Find every _dream_context/ project under a tree
dreamcontext vaults discover [root] --register  # …and register the new ones
dreamcontext vaults list                 # List registered vaults
dreamcontext vaults remove <name>        # Unregister a vault
dreamcontext config shareable <on|off>   # Allow/deny this vault being recalled by peers
dreamcontext connect <vault> [--direction out|in|both] [--topics a,b]  # Connect to read a peer (out = read)
dreamcontext connections                 # Inspect federation connections
dreamcontext disconnect <vault>          # Remove a connection
dreamcontext federation peers            # Compact summary of readable peers
dreamcontext federation status           # Connections + any leftover federated copies
dreamcontext federation purge --all      # Remove leftover federated:true copies (old sync path)
# federation sync / drain are inert no-ops — copy-based sync is parked on the roadmap
```

See the [Federation](#federation) section above for the full workflow.

### Desktop App (macOS)

```bash
dreamcontext app install                 # Install the desktop app to ~/Applications
dreamcontext app update                  # Update the installed app
dreamcontext app status                  # Show installed app version and state
```

### Dashboard

```bash
dreamcontext dashboard                   # Start the web dashboard
```

### System

```bash
dreamcontext hook session-start          # SessionStart hook output
dreamcontext hook stop                   # Stop hook: capture + score
dreamcontext hook subagent-start         # SubagentStart hook output
dreamcontext hook pre-tool-use           # PreToolUse hook: block default Explorer
dreamcontext hook user-prompt-submit     # UserPromptSubmit hook: sleep debt reminder
dreamcontext hook post-tool-use          # PostToolUse hook: auto-format + tsc check
dreamcontext hook pre-compact            # PreCompact hook: save state before compaction
dreamcontext snapshot                    # Snapshot only (no hook processing)
dreamcontext snapshot --tokens           # Estimated token count
dreamcontext doctor                      # Validate structure
dreamcontext upgrade                     # Upgrade the CLI to the latest published version
dreamcontext upgrade --check             # Print current vs latest version, no install
dreamcontext update                      # Refresh installed skill/agent/hook files to match the CLI
dreamcontext install-skill               # Install core integration for selected platforms
dreamcontext install-skill --platforms claude,codex  # Explicit platform selection
dreamcontext install-skill --packs       # Interactive skill pack browser
dreamcontext install-skill --packs engineering design  # Install specific packs
dreamcontext install-skill --skill <name>  # Install a single sub-skill
dreamcontext install-skill --list        # Show available skill packs
dreamcontext install-instructions --platforms claude,codex  # Write managed root instruction blocks
dreamcontext install-claude-md           # Legacy alias: CLAUDE.md only
```

## Design Principles

- **Structure over volume** -- organized context beats more context
- **Pre-loaded, not searched** -- memory injected before the first message
- **Consolidation built in** -- sleep cycles keep context sharp, not bloated
- **Agent-native** -- designed for how LLMs consume context
- **Owned by you** -- plain markdown and JSON in your repo

## Works With

- **Claude Code**: full support via skill, core sub-agents (initializer, explore, the three primary RemSleep specialists — sleep-tasks, sleep-state, sleep-product — plus conditional sleep-federation and sleep-migration specialists), 7 hooks, plus optional pack sub-agents (council persona/synthesizer, multi-review specialists, goal-skill orchestrators)
- **Codex**: project-level skills (`.agents/skills`), managed `AGENTS.md`, native `.codex/agents/*.toml`, and managed `.codex/config.toml` hooks (best-effort parity where event semantics differ)
- **Desktop app (macOS beta)**: native Tauri 2 multi-vault launcher with in-app onboarding and the Sleepy notch quick-capture companion — wraps the same dashboard server (`dreamcontext app install`)
- **Web Dashboard**: local UI with Kanban, Core editor, Knowledge, Features, Brain graph, Sleep tracker, and Council Hall (ships in the package)
- **Obsidian**: `_dream_context/` can be opened as an Obsidian vault; the directory is scaffolded with curated vault settings at `dreamcontext init` time

More agents coming soon.

## License

[Apache License 2.0](./LICENSE) — a permissive open-source license. You may use,
modify, distribute, and sell the code, and build commercial products on it.
Apache 2.0 also grants an explicit patent license and protects the project's
trademarks (the **dreamcontext** name and brand are *not* part of the code grant
— see [TRADEMARK.md](./TRADEMARK.md): fork freely, but ship it under your own
name). Contributions are accepted under Apache 2.0 with a DCO sign-off — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Acknowledgements

The memory system draws partial inspiration from [OpenClaw](https://github.com/openclaw/openclaw)'s approach to agent memory. The neuroscience-inspired two-stage memory model (bookmarks during waking, selective consolidation during sleep) is based on findings from Joo & Frank 2025 (Science) on hippocampal awake sharp-wave ripples. The brain-region architecture, sleep consolidation cycle, and CLI-first design are my own, built from months of working with AI coding agents on real projects.
