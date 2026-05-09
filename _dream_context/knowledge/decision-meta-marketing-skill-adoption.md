---
id: know_yRDTyFdE
name: "Decision: Meta-Marketing Skill Adoption"
description: "Council decision on whether to adopt the meta-marketing skill plan as-is. Covers DX, edge cases, dreamcontext architectural fit, dashboard visibility, and implementation sequencing."
type: decision
source_debate: council_7_ForDfS
topic: >-
  Should we adopt the meta-marketing skill plan as-is, or what must change before commit?
  Critique covers: (1) DX across CLI + agent chat, (2) edge cases (auth, rate limits, env,
  multi-account, asset binaries, dry-run safety), (3) dreamcontext architectural fit (folder
  convention, JSON-vs-MD, council reuse, sleep consolidation, hooks), (4) dashboard visibility
  (Brain graph nodes, read-only chat-back UX, perf charts, recharts dep), (5) implementation
  sequencing (ship-first slice, risky bits, what to defer).
personas:
  - growth-operator
  - dreamcontext-architect
  - staff-ts-engineer
  - dashboard-lead
  - risk-skeptic
rounds: 2
created_at: '2026-05-02'
updated_at: '2026-05-02'
tags:
  - decisions
  - domain
pinned: false
---

## Why This Exists

Council debate that evaluated the meta-marketing skill plan before committing to implementation. Decision: adopt with modifications (the plan shipped as meta-marketing skill, PRs 5 and 8).

## The Decision

The council reached consensus to adopt the meta-marketing skill with targeted changes rather than wholesale rejection or full as-is adoption. Key gate items were: binary asset hook guard (shipped in PR 8a), council wrapper with marketing personas (PR 8b), and vision-pass on hook frames (PR 5).

## Sources

- Full debate and final report: `_dream_context/council/council_7_ForDfS/`
- Task that closed this work: `_dream_context/state/meta-marketing-skill.md`

## Last Verified

2026-05-09 — confirmed PRs 5 and 8 shipped; task marked closed in memory.
