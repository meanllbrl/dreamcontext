<p align="center">
  <img src="public/image/agentcontext.png" alt="agentcontext" width="120" />
</p>

<h1 align="center">agentcontext</h1>

<p align="center">
  Structured, persistent context for AI coding agents.<br/>
  Pre-loaded via hooks. Zero tool calls to get started.
</p>

<p align="center">
  <a href="#why">Why</a> &nbsp;&middot;&nbsp;
  <a href="#how-it-works">How It Works</a> &nbsp;&middot;&nbsp;
  <a href="#quick-start">Quick Start</a> &nbsp;&middot;&nbsp;
  <a href="#dashboard">Dashboard</a> &nbsp;&middot;&nbsp;
  <a href="#commands">Commands</a> &nbsp;&middot;&nbsp;
  <a href="DEEP-DIVE.md">Deep Dive</a>
</p>

> **Under active development.** APIs and commands may change before v1.0.

---

## Why

AI coding agents are powerful, but they make real mistakes. They fetch entire collections instead of filtering at the query level. They write serverless functions with infinite loop potential. They optimize for making the test pass, not making the system correct.

A human needs to be steering. But steering only works when both you and the agent are looking at the same context: what decisions were made, what is in progress, what rules to follow.

And every session starts from scratch. Your agent greps for a decision it already made yesterday. Reads a few files. Searches again. Pieces together context it already had. By the time it says "Ok, I understand the codebase," you haven't started working yet. This happens every session, and it gets worse as your project grows.

`agentcontext` fixes both problems. It gives your agent structured, pre-loaded context before the first message, and gives you readable files you can open, audit, and correct. **Context that both you and your agent can act on.**

<table>
<tr>
<td width="50%" align="center">
<img src="public/image/agentcontext_disabled.png" alt="Without agentcontext" width="100%" /><br/>
<em><strong>Without agentcontext</strong><br/>Search, read, search again.<br/>Tokens burned on re-discovery.</em>
</td>
<td width="50%" align="center">
<img src="public/image/agentcontext_enabled.png" alt="With agentcontext" width="100%" /><br/>
<em><strong>With agentcontext</strong><br/>Context pre-loaded via hook.<br/>Zero tool calls. Straight to work.</em>
</td>
</tr>
</table>

> **Want the full story?** Philosophy, architecture, and every design tradeoff explained. **[Read the deep dive &rarr;](DEEP-DIVE.md)**

## How It Works

```mermaid
flowchart LR
    subgraph capture ["Capture"]
        STOP["Stop Hook\n(session ends)"]
        POSTTOOL["PostToolUse Hook\n(auto-format + tsc)"]
        BOOKMARK["Bookmarks\n(awake ripples)"]
        SLEEP["RemSleep Agent\n(consolidates)"]
        HUMAN["You\n(edit files or dashboard)"]
    end

    subgraph store ["_agent_context/"]
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

- **Seven hooks capture context automatically.** Stop hook records what happened. SessionStart injects everything before the first message. SubagentStart briefs sub-agents. PreToolUse blocks blind exploration when curated context exists. UserPromptSubmit reminds about sleep debt on every user message. PostToolUse auto-formats and type-checks edited files. PreCompact saves state before context compaction.
- **Bookmarks tag important moments.** During active work, the agent bookmarks decisions, constraints, and discoveries with salience levels. Critical bookmarks trigger immediate consolidation advisories.
- **Files are structured by purpose.** Identity, preferences, decisions, knowledge, and active work each live in their own file with their own format.
- **Sleep cycles consolidate knowledge.** A RemSleep agent reads bookmarks first, distills transcripts for high-signal content, extracts recurring patterns, promotes learnings, creates contextual triggers, cleans stale entries, and resets debt.
- **Everything is local markdown and JSON.** Readable, editable, git-tracked, owned by you.

## Quick Start

```bash
npm install -g agentcontext
```

> Requires **Node.js >= 18**. Currently supports **Claude Code**.

```bash
# 1. Initialize the context structure
agentcontext init

# 2. Install the Claude Code integration (skill, agents, hooks)
agentcontext install-skill
```

Two commands. Next session, the hook fires, context loads, and the agent is ready.

### Interactive mode

Run `agentcontext` with no arguments to enter interactive mode with a visual menu for all commands.

### What gets created

```
your-project/
├── _agent_context/              # Structured context (git-tracked)
│   ├── core/
│   │   ├── 0.soul.md           # Identity, principles, rules
│   │   ├── 1.user.md           # Your preferences, project details
│   │   ├── 2.memory.md         # Decisions, issues, learnings
│   │   ├── 3.style_guide.md    # Style & branding
│   │   ├── 4.tech_stack.md     # Tech decisions
│   │   ├── 5.data_structures.sql
│   │   ├── 6.system_flow.md    # Session lifecycle, data flows
│   │   ├── CHANGELOG.json
│   │   ├── RELEASES.json
│   │   └── features/           # Feature PRDs
│   ├── knowledge/              # Tagged docs (index in snapshot)
│   │   └── *.md                # pinned: true → auto-loaded in full
│   └── state/                  # Active tasks, sleep state
│       └── .sleep.json
│
├── .claude/
│   ├── skills/agentcontext/
│   │   └── SKILL.md            # Teaches the agent the system
│   ├── agents/
│   │   ├── agentcontext-initializer.md
│   │   ├── agentcontext-explore.md
│   │   └── agentcontext-rem-sleep.md
│   └── settings.json           # 7 hooks (see below)
```

## Dashboard

```bash
agentcontext dashboard                   # Open at localhost:4173
agentcontext dashboard --port 8080       # Custom port
agentcontext dashboard --no-open         # Start without opening browser
```

A local web UI for managing agent context visually. Built with React 19, served by a zero-dependency Node HTTP server. Ships in the npm package.

<table>
<tr>
<td width="50%">

**Kanban board** with drag-and-drop, filtering by priority/tags, sorting, and grouping. Create tasks, update status, add changelog entries from a detail panel.

</td>
<td width="50%">

**Core editor** with split-pane markdown editing and live preview. Knowledge manager with search and pin/unpin. Feature PRD viewer. SQL ER diagram preview.

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
</table>

Light and dark mode with system preference detection. Brand palette: purple-to-magenta gradient. Visby CF font with system font fallback.

## Commands

### Core

```bash
agentcontext core changelog add           # Add changelog entry
agentcontext core releases add            # Create release with auto-discovery
agentcontext core releases add --yes      # Non-interactive, include all unreleased items
agentcontext core releases list           # List recent releases
agentcontext core releases show <version> # Show release details
```

Release creation auto-discovers unreleased tasks, features, and changelog entries. Back-populates `released_version` on included features.

### Tasks

```bash
agentcontext tasks list                   # List active tasks (excludes completed)
agentcontext tasks list --all             # List all tasks
agentcontext tasks list --status in_progress  # Filter by status
agentcontext tasks create <name>          # Create a task
agentcontext tasks create <name> --priority high --status in_progress --tags "api,auth"
agentcontext tasks log <name> <content>   # Log progress (newest first)
agentcontext tasks insert <name> <section> <content>  # Insert into a named section
agentcontext tasks complete <name>        # Mark completed
```

All flags (`--description`, `--priority`, `--status`, `--tags`, `--why`) are optional. Defaults to medium priority and todo status, so the command works non-interactively for agent use.

### Features

```bash
agentcontext features create <name>       # Create a feature PRD
agentcontext features insert <name> <section> <content>
```

### Knowledge

```bash
agentcontext knowledge create <name>      # Create a knowledge doc
agentcontext knowledge index              # List all with descriptions + tags
agentcontext knowledge index --tag api    # Filter by tag
agentcontext knowledge tags               # List standard tags
agentcontext knowledge touch <slug>       # Record access (staleness tracking)
```

Set `pinned: true` in frontmatter to auto-load a knowledge file in every snapshot. Knowledge files not accessed in 30+ days are flagged as stale. Recently accessed files appear in a "warm knowledge" tier with first-paragraph previews.

### Bookmarks

Tag important moments during active work. Inspired by the brain's awake sharp-wave ripples that bookmark memories for consolidation during sleep.

```bash
agentcontext bookmark add "<message>" -s 2    # Bookmark with salience (1-3)
agentcontext bookmark list                     # Show all bookmarks
agentcontext bookmark clear                    # Clear all bookmarks
```

Salience levels: 1 = notable, 2 = significant, 3 = critical. Critical bookmarks trigger immediate consolidation advisories regardless of debt level.

### Triggers

Contextual reminders that fire when matching tasks are active. The brain's prospective memory: "remind me about X when working on Y."

```bash
agentcontext trigger add "<when>" "<remind>"   # Create a trigger
agentcontext trigger list                       # Show active triggers
agentcontext trigger remove <id>                # Remove a trigger
```

Triggers match against active task names, tags, and bookmark text. Auto-expire after a configurable number of fires (default 3).

### Sleep

Sleep debt is tracked automatically via hooks. The UserPromptSubmit hook reminds about debt on every user message, so the agent cannot dismiss the reminder. Consolidation rhythm advisory fires after 3+ sessions since last sleep, even at low debt.

```bash
agentcontext sleep status                # Debt level, sessions, last sleep
agentcontext sleep history               # Consolidation log
agentcontext sleep add <score> <desc>    # Add debt manually
agentcontext sleep start                 # Mark consolidation epoch
agentcontext sleep done <summary>        # Complete consolidation, reset
agentcontext sleep debt                  # Raw number (for scripts)
```

### Transcript

```bash
agentcontext transcript distill <session_id>   # Structural filter of session transcript
```

Extracts high-signal content from raw JSONL transcripts: user messages, agent decisions, code changes, errors, bookmarks. Discards noise (Read results, Glob output, tool metadata). Pure Node.js, no AI. Used by the RemSleep agent for selective deep analysis of important sessions.

### Dashboard

```bash
agentcontext dashboard                   # Start the web dashboard
```

### System

```bash
agentcontext hook session-start          # SessionStart hook output
agentcontext hook stop                   # Stop hook: capture + score
agentcontext hook subagent-start         # SubagentStart hook output
agentcontext hook pre-tool-use           # PreToolUse hook: block default Explorer
agentcontext hook user-prompt-submit     # UserPromptSubmit hook: sleep debt reminder
agentcontext hook post-tool-use          # PostToolUse hook: auto-format + tsc check
agentcontext hook pre-compact            # PreCompact hook: save state before compaction
agentcontext snapshot                    # Snapshot only (no hook processing)
agentcontext snapshot --tokens           # Estimated token count
agentcontext doctor                      # Validate structure
agentcontext install-skill               # Install Claude Code integration
```

## Design Principles

- **Structure over volume** -- organized context beats more context
- **Pre-loaded, not searched** -- memory injected before the first message
- **Consolidation built in** -- sleep cycles keep context sharp, not bloated
- **Agent-native** -- designed for how LLMs consume context
- **Owned by you** -- plain markdown and JSON in your repo

## Works With

- **Claude Code**: full support via skill, 3 sub-agents, and 7 hooks
- **Web Dashboard**: local UI for visual context management (ships in the package)

More agents coming soon.

## License

MIT

## Acknowledgements

The memory system draws partial inspiration from [OpenClaw](https://github.com/openclaw/openclaw)'s approach to agent memory. The neuroscience-inspired two-stage memory model (bookmarks during waking, selective consolidation during sleep) is based on findings from Joo & Frank 2025 (Science) on hippocampal awake sharp-wave ripples. The brain-region architecture, sleep consolidation cycle, and CLI-first design are my own, built from months of working with AI coding agents on real projects.
