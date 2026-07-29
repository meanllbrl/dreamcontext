---
id: hook-delivered-must-not-miss-rules
name: "Hook-Delivered Must-Not-Miss Rules"
description: "Put the load-bearing half of a must-not-miss rule in the hook, not the skill prose. When a rule is truly critical (e.g., 'insights before external fetch'), the directive lives in the hook that always fires (UserPromptSubmit, SessionStart), not only in skill documentation which is conditional on the skill loading and the snapshot surviving budget pressure."
tags: ["architecture", "decisions", "topic:agents", "topic:skills"]
pinned: false
date: "2026-07-28"
---

## Why This Exists

Skill documentation is conditional. The skill body loads only when (a) the skill is installed, (b) the skill name appears in the available-skills list, and (c) the agent invokes `Skill` or the skill matches a load trigger. The SessionStart snapshot is also conditional: under budget pressure, sections demote, and on over-budget vaults the harness may persist only a 2KB preview.

When a rule is truly must-not-miss — a directive that MUST fire to prevent a recurring failure mode — skill prose alone is insufficient. The rule needs to live in a hook that fires unconditionally on every session or every prompt.

## The Pattern

### 1. Identify must-not-miss vs nice-to-have

**Must-not-miss** = a rule whose violation causes:
- A recurring high-cost failure (e.g., re-fetching data the brain already holds)
- A safety violation (e.g., bypassing a security check)
- A structural invariant breakage (e.g., skipping a required approval)

**Nice-to-have** = guidance that improves quality but doesn't prevent breakage if missed.

If the rule is nice-to-have, skill documentation is fine. If it's must-not-miss, route to a hook.

### 2. Split the rule: hook directive + skill explanation

**Hook (the load-bearing half):**
- Fires on every prompt (UserPromptSubmit) or every session (SessionStart)
- Short, actionable, unambiguous
- Never conditional on skill loading or snapshot survival

**Skill (the full explanation):**
- WHY the rule exists
- HOW to apply it in edge cases
- Links to examples, related patterns, reference docs

Example split (Operational Rule 13: insights before external fetch):

**UserPromptSubmit hook directive** (always fires):
```
When a recall hit is type `insight`:
→ ALREADY TRACKED as an insight — use `dreamcontext lab show <slug>` to see the full cached series.
   Do NOT fetch this metric from an external API, MCP tool, or script while the insight already holds it.
   `dreamcontext lab sync <slug>` is the only legitimate fetch path (and only when TTL-stale).
```

**SKILL.md Operational Rule 13** (full explanation):
- Lists the insight-before-fetch ladder (snapshot Lab section → `lab show` → `lab list` / recall)
- Explains WHY (cache, tweaks, KR binding)
- Names the exception (TTL-stale)
- Links to tasks-and-features.md § Insights

### 3. Pin the hook in code, not just docs

```typescript
// src/cli/commands/hook.ts — handleUserPromptSubmit()
if (hit.type === 'insight') {
  const directive = renderInsightDirective(hit);  // the must-not-miss instruction
  output.push(directive);
}
```

The directive text is code, not a markdown snippet in a doc file. It cannot drift from the implementation.

## Applications (≥2 occurrences = pattern)

| Rule | Hook | Skill |
|---|---|---|
| **Insights before external fetch** (2026-07-28) | UserPromptSubmit renders `lab show` directive on insight recall hits | SKILL.md Operational Rule 13 explains the full ladder + cache semantics |
| **Update on drift** (manifest-based-install-update) | SessionStart snapshot never-evict tier carries the drift directive when `setupVersion < CLI` | SKILL.md § Setup & Maintenance explains `update` is content-safe |
| **Consolidate on high debt** (sleep-consolidation) | SessionStart prepends multi-line consolidation directive when debt ≥ 20; UserPromptSubmit appends one-liner when debt ≥ 14 | SKILL.md § Sleep / Consolidation explains debt scoring + specialist roster |

## When NOT to use this pattern

- The rule is nice-to-have guidance, not a must-not-miss directive
- The rule is task-specific or one-off (doesn't recur across sessions)
- The hook would need to carry significant context-building logic (hooks should be cheap; complex checks belong in the snapshot or a skill)

## Related

- `surface-briefing-pattern.md` — another hook-delivered directive (surface capabilities)
- `feature-integration-pattern.md` — wiring features into surfaces (includes hook integration as one step)
