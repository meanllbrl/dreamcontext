---
id: project-origin-and-prd
name: "Project Origin & PRD Knowledge"
description: "Preserved knowledge from the original PRD.md (now deleted). Covers the project's evolution, original vision, and key design rationales."
tags: ["prd", "origin", "design-rationale", "history", "cli-philosophy", "skill"]
date: "2026-02-25"
---

## Origin: The Pre-dreamcontext System

The project evolved from an earlier, semi-structured `_dream_context/` directory system used in personal coding workflows. That original system had:

```
_dream_context/
├── Core/
│   ├── 0 - MEMORY & PREFERENCES.md
│   ├── 1 - ROADMAP.md
│   ├── ... (2-10 + project-specific 11+)
│   ├── Feature Set/
│   └── Indexes/
├── Knowledge Space/
├── State/
│   ├── [task-name].md
│   ├── Task Pool/
│   └── Finished/
└── Inbox/    ← User's temporary storage (do NOT read)
```

The old system had **personality and identity mixed into the context management** files. The dreamcontext project decoupled these: soul/user/memory are separate concerns. The personality and identity parts were left behind.

There was also a `Context/` directory that contained a `claude.md` — this became the inspiration for the modern `SKILL.md`.

## The Sub-Agent Decision

The original PRD note said: "no .claude or any agent configuration file, sub agents etc." — the intent was to make dreamcontext installable by any AI agent without vendor-specific files.

This was later **refined**: the final decision was to allow sub-agents (initializer and rem-sleep) but ship them as distributable files in `agents/` that consumers install via `dreamcontext install-skill`. The constraint evolved to: **no nested .claude configs in this repo's own context** (only in skill/ and agents/ for distribution).

## CLI-First Philosophy: The Core Rationale

The PRD captured the exact reasoning:

> "Making the agent edit a file means they must read the whole or a big piece to actually edit it. So all the commands should support that."

This is why every structural operation (changelog, tasks, features, knowledge) goes through the CLI. The agent should never need to read an entire file just to append one entry.

## code_registry.json Rationale (Historical, Feature Removed)

The original PRD framing:

> "We need a map to find our way, should not read the darkness but have a flashlight."

The code registry was designed for reusable code components. However, it was **removed before v0.1.0** because it went stale immediately when methods were renamed, moved, or deleted. Manual maintenance could not keep up. The agent's native tools (Grep, Glob) serve the component discovery use case better than a static registry.

## Interactive Mode Requirement

The PRD specified: "All text input areas must be multiline, and the program should stay open until the user closes it himself."

This drove the readline REPL in interactive mode — when `dreamcontext` is run with no arguments, it stays open. The `@inquirer/prompts` package handles multiline inputs for commands that require them.

## Skill Design: alwaysApply from the Start

The SKILL.md was intended as `alwaysApply: true` from the beginning. This was not a retrofit — it was the core delivery mechanism. Every project using dreamcontext gets the full skill injected into every Claude Code session automatically.

## Knowledge Search: Semantic Intent, Keyword Reality

The PRD specified: "Knowledge files should be able to be searched semantically like `dreamcontext knowledge search`."

The v0.1.0 implementation uses keyword-based search (tokenize + substring match with score weighting) instead of true semantic search. This was a deliberate tradeoff: zero dependencies, simpler implementation, sufficient for the use case. Semantic search (embeddings, vector store) remains a future goal.

## The npm CLI + Skill Package Model

The PRD framed this clearly: dreamcontext is a TypeScript CLI published to npm. When installed globally, it becomes available in any project. The `dreamcontext install-skill` command then installs the Claude Code integration (skill, agents, hook) into the consuming project's `.claude/` directory.

The skill itself handles the agent behaviors: SessionStart hook, sleep cycle triggering, command guidance. The CLI handles the data operations. The two halves are designed to work together but stay decoupled.
