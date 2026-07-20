---
id: feature-integration-pattern
name: "Feature Integration Pattern (wire every new feature into the whole system)"
description: "MANDATORY checklist pattern: any feature added to dreamcontext must be wired into every surface the main agent learns the system from — SKILL.md capabilities + Entity Router, a reference-file section, sleep docs when sleep touches it, sub-agent contracts, and a scan of all shipped skill packs for integration points. A feature the skill doesn't describe is invisible: the main agent can't route to it, sleep can't maintain it, and it rots. Apply BEFORE finishing any feature work — awake, without waiting for a sleep cycle. Sleep may also create/update/retire patterns like this one."
tags: ["architecture", "decisions", "onboarding", "topic:agents", "topic:skills"]
pinned: true
date: "2026-07-20"
---

## Why This Exists

Every feature that shipped without skill-doc wiring produced the same failure later: the v0.11.0 Lab incident (insights shipped, Entity Router had no row → agents created knowledge files instead of insights), the `knowledge/patterns/` folder itself (7 pattern docs accumulated ad hoc with no convention — no agent knew when to write one), and repeated "the agent didn't know we had X" corrections. The system's real interface is not the code — it is what the dreamcontext skill TELLS the main agent exists. An unwired feature is functionally absent.

## The Pattern — integration checklist (all items, every feature)

Run this checklist whenever you add, substantially change, or migrate a feature/subsystem. Do it AWAKE, in the same session as the feature work — never defer to sleep.

1. **SKILL.md capabilities row** (`skill/SKILL.md`, NEVER `.claude/skills/` — installed copies are clobbered): one row saying the capability exists + its reference link.
2. **Entity Router row** when the feature introduces a creatable/routable entity: user phrase triggers + problem-shape litmus + exact CLI verb. (This is the v0.11.0 lesson — a capability without a router row gets shadow-built as something else.)
3. **Reference file section** (`skill/references/*.md`): the full protocol — when to use, how to create/update, anti-bloat rules. SKILL.md stays thin; detail lives here.
4. **Sleep wiring** (`skill/references/sleep.md` + `agents/sleep-*.md` contracts): if sleep must create/update/retire/condense the feature's artifacts, name the OWNING specialist explicitly and its dispatch signal. Unowned artifacts accrete forever.
5. **Sub-agent scan** (`agents/*.md`): for EACH agent, decide "does this agent need to know?" — update contracts that touch the feature's files or lifecycle; leave the rest. Record the decision, not just the edits.
6. **Skill-pack scan** (`skill-packs/*` + `.claude/skills/*` catalog): for each shipped pack, decide "would this pack benefit from mentioning/using the feature?" (e.g. goal-skill logging to tasks, multi-review reading engineering rules). Add the cross-reference where the answer is yes; note "considered, not relevant" where no.
7. **Cross-references both ways**: the new reference section links related features/patterns; related docs gain a pointer back. The agent must be able to walk from any surface to the whole.
8. **Marker/regression lock** where the project has one (marker tests pin Entity Router rows and CLI verbs in `skill/`): extend it so drift is caught mechanically.
9. **Propagate**: run `dreamcontext update` so installed `.claude/` copies regenerate from the edited sources.

## Who applies it, when

- **Main agent (awake)**: applies the checklist as PART of the feature work — the feature is not "done" until the checklist passes. No waiting for sleep.
- **Sleep (`sleep-product`)**: owns pattern documents (`knowledge/patterns/*.md`) as part of `knowledge/**` — creates a pattern when repetition warrants one, updates/condenses existing patterns, retires stale ones. `sleep-state` reports recurring-practice signals that seed patterns.
- **Any dreamcontext user/agent**: may create or edit a pattern directly (offer-and-confirm when agent-initiated) — patterns are plain knowledge files and ride recall + brain sync like everything else.

## Litmus — pattern vs knowledge vs workflow

- **Pattern** (`knowledge/patterns/`): a reusable *engineering/design solution shape* ("route by classification, dispatch specialists in parallel"). Describes HOW TO BUILD/DO something well, portable across features.
- **Plain knowledge**: a fact, decision, or research result ("we chose BM25 over embeddings because…").
- **Workflow** (`knowledge/workflows/`, planned — task_QcBUZMU1): a procedure with triggers + steps + RULES that BINDS agent behavior when its trigger fires. Patterns inform; workflows govern.

## Verification (part of the pattern, not optional)

Integration is proven, not assumed: after wiring, verify a fresh agent DISCOVERS the feature organically — recall surfaces the doc for on-topic prompts, and a dispatched sub-agent consults it without being told. If discovery fails, the wiring (triggers, tags, router row) is wrong — fix the wiring, don't blame the agent.

## Anti-bloat

A checklist item can resolve to "considered — not applicable"; record that in the task log, not in the docs. Don't pad every pack/agent with mentions of every feature: wire where there is a real touchpoint, note the rest as considered.
