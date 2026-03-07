---
id: competitive-analysis-ecc
name: "Competitive Analysis: everything-claude-code (ECC)"
description: "Deep analysis of affaan-m/everything-claude-code (55K stars, Anthropic hackathon winner). Covers architecture differences, their advantages, our advantages, and actionable insights for agentcontext improvement."
tags: ["competitive-analysis", "ecc", "hooks", "continuous-learning", "architecture", "roadmap"]
date: "2026-03-01"
---

## What ECC Is

A Claude Code plugin (not an npm CLI) that provides 56 skills, 14 agents, 33 slash commands, 13+ hooks, and 30 rules. Supports 5 platforms (Claude Code, Cursor, Codex, OpenCode, OpenAI Agents). 992 tests, zero external test deps. Content-heavy configuration package with thin JS runtime.

Repo: https://github.com/affaan-m/everything-claude-code

## Fundamental Architecture Difference

**ECC = horizontal tool kit.** Lots of skills, agents, commands. Shallow memory (session .tmp files). No structural context, no consolidation, no task management.

**agentcontext = vertical memory system.** Fewer pieces, each deeply integrated. Brain-region architecture (soul/user/memory/knowledge/state), sleep consolidation, scored debt, bookmark salience, transcript distillation. Structured context injection via snapshot.

These are complementary philosophies. ECC optimizes the agent's current-session behavior (code quality gates, workflow enforcement). agentcontext optimizes cross-session continuity (what does the agent remember, how stale is context).

## Their Advantages Over Us

### Post-Edit Code Quality Gates (HIGH IMPACT)
PostToolUse hooks that fire after every Edit:
- **Auto-format**: Walks up directory tree to find Biome config (7 variants) or Prettier config (11 variants). Runs detected formatter via npx.
- **TypeScript check**: Finds nearest tsconfig.json (max 20 levels up), runs `tsc --noEmit --pretty false`, filters output to ONLY errors in the edited file (triple-path matching: relative, absolute, original).
- **console.log warning**: Scans edited JS/TS files for console.log, reports first 5 line numbers.

These create an immediate feedback loop. Errors caught at edit-time, not test-time.

### Continuous Learning / Instinct System (HIGH IMPACT)
Their most innovative subsystem:
- SessionEnd hook evaluates sessions with 10+ user messages for "extractable patterns"
- v2 uses hooks (100% deterministic) instead of skills (50-80% probabilistic) for observation
- Atomic "instincts": one trigger + one action + confidence score (0.3-0.9)
- Confidence decay (-0.02/week without observation), growth (+0.05 per confirming observation)
- `/evolve` command clusters related instincts into skills/commands/agents
- Export/import for team sharing with duplicate detection

Our equivalent: Bookmark + rem-sleep manual consolidation. No automated pattern extraction.

### PreCompact Hook (MEDIUM IMPACT)
Saves state before Claude Code compacts context:
- Logs compaction timestamp
- Marks session files with "compaction happened here"
- Creates audit trail of context loss

We have no PreCompact awareness. Context compaction can silently lose sleep state or bookmarks.

### Strategic Compact Suggestion (MEDIUM IMPACT)
PreToolUse hook with Edit|Write matcher:
- Per-session tool call counter (temp file at /tmp/claude-tool-count-{sessionId})
- At threshold (default 50), suggests `/compact`
- Re-suggests every 25 calls after threshold
- Recognizes that WHEN you compact matters as much as WHETHER you compact

### Security Hooks (MEDIUM IMPACT)
- User prompt secret scanning: OpenAI API keys (sk-...), GitHub PATs (ghp_...), AWS keys (AKIA...), Slack tokens (xox[bpsa]-...), private keys
- Sensitive file read warning: .env, .key, .pem, credentials patterns
- AgentShield integration: 102 rules, 1280 tests

We have zero security hooks.

### Cross-Platform Support (LOW PRIORITY FOR US)
5 platforms via adapter pattern. Cursor adapter transforms stdin JSON format. Codex via AGENTS.md + TOML. OpenCode via TypeScript plugin with 20+ events.

Not relevant now. Claude Code is our only target. Cursor auto-detects Claude Code configs anyway.

### Agent Variety (LOW PRIORITY FOR US)
14 specialized agents with model tiering (opus for strategic, sonnet for technical, haiku for mechanical). User already has their own skill ecosystem outside agentcontext.

## Our Advantages Over Them

### Structural Memory (They Have Nothing)
Brain-region architecture with YAML frontmatter, LIFO ordering, pinned vs warm knowledge, core file aliases, ~200 line limits with auto-extraction to knowledge. They have flat markdown rules and session .tmp files.

### Sleep/Consolidation (They Have Nothing)
Scored debt (0-10+), graduated directives, bookmark salience, transcript distillation, sleep history with consolidated_at, rhythm advisory. They just count messages (>10 = evaluate).

### Snapshot Context Injection (Theirs is Minimal)
Our snapshot: soul, features, knowledge index, warm knowledge, active tasks, sleep state, changelog, releases, triggers. Zero tool calls.
Their SessionStart: previous session summary + learned skill count. No project structure, features, or tasks.

### Task Management (They Have Nothing)
Full lifecycle (new -> in_progress -> completed), feature PRDs with acceptance criteria, CLI commands, Kanban dashboard. They have zero task management.

### Web Dashboard (They Have Nothing)
React 19 + Vite 6: Kanban, sleep state, core editor, knowledge manager, features viewer, ER diagram.

### Explorer Gating (They Have Nothing)
PreToolUse blocks default Explorer, redirects to context-aware version. 100K-150K token savings.

### SubagentStart Context Briefing (Theirs is Logging Only)
We inject feature list, knowledge index, task awareness. They just log agent name.

## Key Insights for Adaptation

1. **Hooks over prompts for reliability**: ECC's core insight. Hooks fire 100% deterministically, skill/rule instructions fire 50-80%. For code quality gates, this is critical.

2. **Instinct confidence scoring is clever but heavyweight**: Full implementation needs observer agent, observation hooks, Python CLI, JSONL storage. Our rem-sleep agent already does most of this work during consolidation. Lighter approach: add "pattern extraction" step to rem-sleep that looks for repeated tool sequences and writes them to knowledge.

3. **Phase-aware compaction**: Knowing WHEN to compact (after research, before execution) is more valuable than just knowing context is growing. Tool call counter is a good proxy.

4. **Auto-format after edit is table stakes**: Every serious dev setup has this. Not having it in agentcontext makes the agent experience worse for no reason.

5. **Their testing approach**: Zero external test deps (custom runner on Node assert). Impressive for portability but fragile for TypeScript projects. Our vitest approach is better for our use case.

6. **Their distribution model** (plugin marketplace, 4 channels) optimizes for adoption breadth. Ours (npm package, single CLI) optimizes for depth. Both are valid strategies for different goals.
