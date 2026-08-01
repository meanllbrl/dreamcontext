---
id: know_7dSXMSGM
name: codex-cli-integration-feasibility
description: >-
  Codex CLI 0.139 platform audit (2026-08-01): it now ships all 7 hooks
  dreamcontext uses with a near-identical wire contract, plus subagents,
  SKILL.md skills, app-server JSON-RPC and a session index — revising the
  integration cost from 'blocked on missing primitives' to a config-emitter job.
  Not greenfield — commit 58f5910 (2026-07-07) removed a working multi-platform
  installer plus a full .codex/agents TOML roster, so that is the revert base.
  Hook-trust re-approval and the ~/.dreamcontext sandbox boundary are the real
  remaining risks
tags:
  - 'topic:agents'
  - 'domain:infrastructure'
  - 'kind:architecture'
  - 'topic:codex'
pinned: false
date: '2026-08-01'
---

# Codex CLI Integration Feasibility

Platform audit run 2026-08-01 against **`codex-cli 0.139.0`** installed locally (npm latest at audit time: `0.146.0`), verified from the shipped binary + `~/.codex` state + official docs. Supersedes the soul's standing line "Supports Claude Code only; Codex CLI deprecated" as a *capability* claim — that line reflected a Codex that no longer exists.

**This surface moves weekly. Re-verify before acting on any specific key name below.**

## Headline

The two primitives whose absence made Codex support look structurally expensive — **lifecycle hooks** and **subagents** — both shipped. Codex's hook contract is close enough to Claude Code's that `src/cli/commands/hook.ts` is largely reusable as-is. The cost moved from "rewrite the product for a weaker host" to "emit a second config shape and translate the agent roster."

| Layer | Prior assumption | Verified 2026-08-01 |
|---|---|---|
| Hooks | None — the blocker | All 7 dreamcontext uses exist, near-identical wire contract |
| Subagents | No primitive; sleep fan-out impossible | `.codex/agents/*.toml`, parallel, concurrency-capped |
| Skills | No skill system; corpus needs rewriting | `SKILL.md` + YAML frontmatter + `references/`/`scripts/`/`assets/`, progressive disclosure |
| Headless | `codex exec` roughly maps | Confirmed: `--json`, `--output-schema`, `-o`, `--dangerously-bypass-approvals-and-sandbox` |
| Transcripts | Different schema, ~1.2k lines of new parsing | Different schema, but ships a session **index** Claude does not |
| Desktop chat | Reverse-engineer a second stream-json | `codex app-server` — schema'd JSON-RPC v2, written against a spec |

Revised estimate: **CLI + brain parity ≈ 3–5 days.** Desktop chat parity still ≈ 3–4 weeks and still a permanent two-vendor maintenance tax — now an independent decision, not a prerequisite.

## 1. Hooks

Events supported (docs): `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `SessionStart`, `SubagentStart`, `SessionEnd`. **All seven dreamcontext registers are present.**

Registration is `config.toml`, project-scoped at `<projectRoot>/.codex/config.toml`:

```toml
[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = '/usr/bin/python3 "~/.codex/hooks/session_start.py"'
additionalContextLimit = 5000
statusMessage = "Loading session notes"
```

`SessionStart` stdin payload: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` (`startup|resume|clear|compact`), `permission_mode`, `model`.

Return contract — **the load-bearing finding**, because context injection is the whole product:

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }
```

`PreToolUse` blocks via `"permissionDecision": "deny"` + `permissionDecisionReason`, or exit code 2. This is the same shape `hook.ts` already emits for Claude Code, so the snapshot/gating logic transfers; what differs is *registration*, not payload.

Note `additionalContextLimit` — Codex caps injected context per hook entry. Snapshot budgeting (`snapshot-budget.ts` / `snapshot-caps.ts`) needs a Codex-aware ceiling.

## 2. Subagents

Personal `~/.codex/agents/`, project `.codex/agents/`. One TOML file per agent. Required: `name` (identity source of truth, matched on spawn), `description`, `developer_instructions`. Optional: any `config.toml` setting — `model`, `model_reasoning_effort` (`ultra|max|xhigh|high|medium|low`), `sandbox_mode`, `mcp_servers`, `skills.config`.

```toml
name = "reviewer"
description = "PR reviewer focused on correctness, security, and missing tests."
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
Review code like an owner.
…
"""
```

Concurrency under `[agents]`: `agents.enabled` (default true), `agents.max_concurrent_threads_per_session`. Spawning is prompt-driven (via `AGENTS.md` or skill instructions), not a fixed tool name — which matches how dreamcontext already fans out: the main agent dispatches per SKILL.md, no standalone orchestrator.

Mapping: the 7 files in `agents/` translate near-mechanically — frontmatter → TOML keys, body → `developer_instructions`. The `tools:` restriction has no direct equivalent; the closest lever is `sandbox_mode` per agent.

## 3. Skills

`~/.codex/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`, `metadata.short-description`), siblings `references/`, `scripts/`, `assets/`, and an `agents/` subfolder *inside* a skill. Same progressive-disclosure philosophy, verbatim down to the framing ("The context window is a public good" in the shipped `skill-creator`).

Consequence: `skill/` + the eight `skill-*` dirs are an adaptation job, not a rewrite. The Claude-specific idioms that do need translating are the Task-tool dispatch language, `/slash` command references, and the hook-contract prose.

## 4. Headless / automations

`codex exec [PROMPT]` with `--json` (JSONL events), `--output-schema <FILE>`, `-o/--output-last-message <FILE>`, `-C/--cd`, `--add-dir`, `-m/--model`, `-s/--sandbox {read-only|workspace-write|danger-full-access}`, `--dangerously-bypass-approvals-and-sandbox`, `--ephemeral`, `--skip-git-repo-check`.

Maps almost 1:1 onto `src/lib/automations/runner.ts` (`claude -p --permission-mode bypassPermissions --output-format json`). `--output-schema` is strictly better than what Claude offers here. Cost accounting (`automations/consumption.ts`) parses Claude's result JSON and needs a Codex-side equivalent.

## 5. Sessions / transcripts

Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`.
Line shape: `{ timestamp, type, payload }` where `type` ∈ `session_meta | event_msg | response_item`.

Plus `~/.codex/session_index.jsonl`: `{"id","thread_name","updated_at"}` per session.

That index is a genuine advantage over Claude Code. `transcript-locate.ts` currently *scans* `~/.claude/projects/<cwd-slug>/` looking for `<uuid>.jsonl` because Claude publishes no index; on Codex the lookup is a single indexed read. `codex resume` / `codex fork` / `codex archive` exist as first-class subcommands.

## 6. Desktop chat surface

`codex app-server` exposes a versioned JSON-RPC protocol with published schemas (`codex_app_server_protocol.v2.schemas.json`): `thread/started`, `thread/resume`, `thread/fork`, `thread/read`, `item/started`, `item/completed`, `AgentMessageDeltaNotification`, `ReasoningTextDeltaNotification`, approval requests (`item/commandExecution/requestApproval`, `FileChangeRequestApprovalParams`), `HookStartedNotification` / `HookCompletedNotification`, and subagent-aware thread metadata (`parent thread id`, `agent_role`).

This is a better integration target than the current Claude path: `dashboard/src/lib/chatProtocol.ts` already normalizes into an internal `ChatEvent` union, so an app-server adapter has a natural home — and unlike `--output-format stream-json`, it is written against a published schema rather than reverse-engineered.

Also available: `codex mcp-server` (Codex as an MCP server, stdio), `codex plugin` + marketplaces, `codex remote-control`.

## Real risks

1. **Hook trust model.** Codex persists a `trusted_hash` per hook entry, keyed by config path + event + index:
   `[hooks.state."<abs>/.codex/config.toml:session_start:0:0"] trusted_hash = "sha256:…"`.
   Any change to a hook command invalidates trust and forces re-approval. `dreamcontext update` rewrites hooks routinely — this is a UX flow that has no Claude Code analogue and must be designed, not discovered. `--dangerously-bypass-hook-trust` exists and must never ship enabled.

2. **Sandbox — the most concrete unknown.** Codex sandboxes by default (`read-only` / `workspace-write`). `_dream_context/` sits inside the workspace and is fine. **`~/.dreamcontext` global state (vault registry, config) does not** — every read/write to it from a hook or a sleep agent is a candidate denial. `--add-dir` and per-agent `sandbox_mode` are the levers. Enumerate the call sites before estimating anything further.

3. **Codex now ships its own memory layer** — `~/.codex/memories`, `memories_1.sqlite`, `MemoryCitation` items, `/goal`. Direct overlap with dreamcontext's core claim; relevant to [[competitive-landscape]] and [[positioning]], not just to integration.

4. **Version velocity.** Local 0.139.0 vs npm 0.146.0 at audit time. Hooks are not in the public `docs/` tree of the repo (only on `learn.chatgpt.com`), which signals the surface is still moving.

## Prior art in this repo — it already shipped once

**dreamcontext had working Codex support and deliberately removed it.**

`58f5910` — `refactor(platform)!: remove Codex/OpenCode support — Claude Code sole platform`, **2026-07-07**, 56 files, **2,185 deletions**.

What that commit deleted is almost exactly what a re-integration needs:

- `.codex/agents/*.toml` — a full agent roster already in Codex TOML form (council-persona, council-synthesizer, discover-brand, dreamcontext-explore, goal-*, review-*, sleep-*)
- `.codex/agents/prompts/*.md` — the mirrored prompt bodies
- The multi-platform layer in `src/lib/platforms.ts`, `catalog.ts`, `manifest.ts`, `install-packs.ts`, `install-claude-md.ts`, `install-skill.ts`, `update.ts`, `init.ts`, `server/routes/launcher.ts`
- The matching tests (`platforms.test.ts`, `platform-defaults.test.ts`, `setup-drift-update.test.ts`, `packs-install-route.test.ts`)

`platforms.ts` still carries the seam the removal left behind — `SUPPORTED_PLATFORMS` is a one-element const tuple, not a hardcoded string. The archived soul (`knowledge/archive/0.soul-2026-h2.md`) records the shipped state: *"v0.4.0 adds multi-platform installer (claude + codex) … All agent files are mirrored to both `agents/` and `.codex/agents/prompts/`."*

Separately, `~/.codex/config.toml` carries trusted hook hashes for `<repo>/.codex/config.toml` at `session_start`, `user_prompt_submit`, `stop`, `post_tool_use` — so a hook set was installed and approved under Codex at some point after that removal too.

**Consequence for cost:** this is not greenfield. The base is `git show 58f5910` (revert or cherry-pick the platform layer), then bring it forward to the Codex surface as it exists now — which since July gained the hook system, the skills system, and the current agent-TOML schema. That is the actual work.

## Recommended next step

A one-day spike answers everything still open:

1. `git show 58f5910` — recover the platform layer + `.codex/agents/*.toml` roster; audit the TOML against today's required keys (`name`, `description`, `developer_instructions`).
2. Emit `.codex/config.toml` hook blocks from the (restored) manifest/install path.
3. Copy `skill/` → `.codex/skills/dreamcontext/`.
4. Run `codex` in a scratch vault; confirm the snapshot reaches the model context.
5. Watch for sandbox denials on `~/.dreamcontext`.

Related: [[competitive-landscape]], [[positioning]], [[macos-launchd-scheduler-constraints]]

### Verification commands

```bash
codex --version && codex --help
codex exec --help
cat ~/.codex/config.toml                       # hooks.state trust hashes
ls ~/.codex/skills ~/.codex/agents ~/.codex/sessions
head -3 ~/.codex/session_index.jsonl
gh api repos/openai/codex/contents/docs        # note: hooks.md is NOT here
```

Docs: `learn.chatgpt.com/docs/hooks`, `learn.chatgpt.com/docs/agent-configuration/subagents`, `developers.openai.com/codex/config-reference`.
