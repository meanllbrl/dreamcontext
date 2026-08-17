---
id: graphify-coexistence-decision
name: "Graphify Coexistence Decision"
description: "Decision: how dreamcontext coexists with graphify (code-graph tools). Read-only hasCodeGraph() detection + snapshot nudge + explore-agent routing + doctor info line. Explicitly out of scope: building/refreshing graphs, mixing into BM25 corpus."
tags: ["architecture", "decisions"]
pinned: false
date: "2026-06-10"
---

> **RETIRED — 2026-08-17. Nothing below was ever built.**
>
> The task carrying this decision was deleted as stale in the backlog grooming pass: filed 2026-06-10, never picked up, zero code in the tree, no objective, and dependent on a third-party tool outside our control. `hasCodeGraph()`, the snapshot nudge, the explore-agent routing hint and the doctor info line **do not exist** — read the sections below as a design that was chosen and then dropped, not as behaviour to expect.
>
> What survives is the reasoning, which is still load-bearing and applies to any future code-graph tool: **detect, never build; route, never merge.** The "Explicit Out of Scope" section in particular is the durable part — mixing structurally dense graph nodes into the BM25 corpus would hub-hijack topical queries (the mem0 lesson), and that stays true no matter which graph tool asks next.

## Why This Exists

In session 5517892f, the question arose: should dreamcontext integrate with code-graph tools (graphify and similar) that build structural call-graph / symbol-graph indexes of a codebase? The mem0 lesson applies here — mixing a structural graph corpus into BM25 recall risks hub-doc hijacking (a single highly-connected graph node would dominate every query). This file captures the coexistence decision and its explicit scope boundaries.

## The Decision

**Approach: read-only detection + routing nudges. Build nothing.**

1. **`hasCodeGraph()` detection**: dreamcontext detects whether a graphify-style index exists in the repo (pattern scan for known graph artifact paths). This is read-only — dreamcontext never builds, refreshes, or modifies the graph.

2. **Snapshot nudge**: when `hasCodeGraph()` returns true, the SessionStart snapshot appends a contextual note: "A code graph is available. For structural codebase navigation, consider the explore-agent's graph-aware path." No graph content is injected into the snapshot itself.

3. **Explore-agent routing**: the `dreamcontext-explore` sub-agent's pre-tool briefing gains a routing hint — when a query is about call graphs, symbol relationships, or "what calls what", it can steer toward graph-aware tooling rather than grep/glob.

4. **`dreamcontext doctor` info line**: the doctor command reports whether a code graph is detected, so the user knows the feature is live.

## Explicit Out of Scope

- Building or refreshing a code graph (dreamcontext is not a graph builder).
- Mixing graph nodes into the BM25 recall corpus. The mem0 lesson: graph nodes are structurally dense, highly interconnected, and would act as hub docs, hijacking topical queries unrelated to them. BM25F + stemming + synonyms handles text recall; graph tools handle structural navigation. These are complementary, not competing, systems with different query semantics.
- Any write path into graph artifacts.
- Graph visualization in the dashboard (separate concern; not scoped).

## Rationale

Graphify/code-graph tools answer "what is the structure of this codebase?" — call trees, symbol tables, dependency graphs. dreamcontext answers "what did we decide and why?" — decisions, knowledge, task history. They solve different questions and should coexist as separate, non-interfering systems. The key insight from the mem0 evaluation applies: LLM-extracted / graph-extracted data is not the same as curated human-authored context, and mixing the two corpora degrades retrieval precision.

Issue #19 (`feat(interop): graphify coexistence`) tracks the implementation. The acceptance spec is in `tests/unit/graphify-coexistence.test.ts` (12 `it.todo` entries as of 2026-06-10).

## Sources

- Session 5517892f-0355-48b6-914d-df3716e376a8 (graphify research + issue #19 decision).
- GitHub issue #19: `feat(interop): graphify coexistence`.
- Related: `decision-mem0-vs-bm25-recall.md` (the structural argument against mixing external-extracted data into BM25).

## Last Verified

2026-06-10.
