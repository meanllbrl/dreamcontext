---
id: know_ntdUC4C2
name: patterns/ask-the-subject-not-its-configuration
description: >-
  A surface that reports on a running thing must ask THAT THING, not the
  configuration it was built from. The two answers drift, and the drift is
  invisible — it reads as a working feature.
tags:
  - 'kind:pattern'
  - architecture
  - 'topic:agents'
  - 'domain:correctness'
pinned: false
date: '2026-09-20'
---

## The rule

When a surface answers "what does X have right now?", the source must be **X itself**, not the configuration X was assembled from. A config file describes an intention; the running thing knows what actually happened to that intention. Ask the wrong one and you ship a screen that is confidently, silently wrong.

## What it cost here (2026-09-18/20, three cuts)

The Chat surface's `/mcp` panel answers "which MCP servers does this conversation have?". Two cuts in a row answered it with `claude mcp list`, which describes a CONFIG DIRECTORY.

- **Cut 1** listed only the session's account directory. Every machine-local server vanished — the owner reported it with a screenshot: *"sadece claude ai ile ilgili olan mcp'ler geldi lokaller gelmedi"*.
- **Cut 2** merged a second listing to recover them. It shipped, and it was worse: the added rows carried the REAL HOME's health, so five servers this session could not use were drawn as `Connected`. A panel whose one job is "never claim a tool the agent lacks" was claiming five.
- **Cut 3** asked the session: its own `system/init` frame carries `mcp_servers: [{name, status, source}]`. Measured against the same machine, the config answer and the session answer **disagreed about 26 of 32 servers**. The session's answer matched the agent's own startup notice exactly, server for server.

## Why the wrong source is so convincing

It is never empty. A configuration listing always returns something plausible, in the right shape, with the right names — so every smoke test passes and every screenshot looks right. Nothing fails; the numbers are just not about the thing you asked about. That is why this survived a 26-assertion runtime verification: the harness asserted the panel faithfully reported what the CLI said, and it did.

## How to tell which source you have

Ask what would have to be true for the two to differ, and then check whether it IS true:

- **Credentials scoped per consumer.** Here an OAuth token lives per config directory, so the same server is authorized for one account and not another. The config file cannot know which.
- **Runtime-injected inputs.** Here a sandboxed session receives servers via `--mcp-config` at spawn; they exist for the process and in no file the listing reads.
- **Scope resolved from context.** Here project-scoped servers resolve from the working directory, so a probe run from `$HOME` cannot see them at all.

Each of those is a way the running thing knows something the configuration does not.

## The shape of the fix

Prefer a channel where the subject reports itself. It is often cheaper than the config route, not dearer: this probe is `claude -p "/mcp"`, which the engine answers as a local command — `num_turns: 0`, `total_cost_usd: 0` — while the config listing health-checked every server over the network and took ninety seconds.

Carry the subject's own vocabulary through. The frame's `source` field is what made the panel able to say which button can work at all; a status word we do not recognise is shown verbatim as `unknown` rather than rounded to the nearest one we do.

## The sibling rule

A measurement taken from inside the thing being measured is not neutral. While diagnosing cut 1, a shell probe "from the real home" inherited the agent session's own `CLAUDE_CONFIG_DIR` and reported that sandbox and home saw identical servers. They did not; `env -u CLAUDE_CONFIG_DIR` showed an eight-server gap. **An agent's own shell is inside the agent's environment** — strip what you are trying to vary.
