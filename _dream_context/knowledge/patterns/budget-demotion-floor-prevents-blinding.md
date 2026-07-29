---
id: budget-demotion-floor-prevents-blinding
name: "Budget Demotion Floor Prevents Blinding"
description: "A demotion rung that collapses a section to a bare count is blinding, not a cheaper render. When a snapshot section carries critical identifying information (metric names, objective titles, task slugs), use maxDemotionLevel to prevent the ladder from reaching a count-only rung that strips all names."
tags: ["architecture", "decisions", "domain:knowledge", "topic:cli"]
pinned: false
date: "2026-07-28"
---

## Why This Exists

The snapshot budget ladder demotes sections progressively under token pressure: full content → summaries → one-liners → bare count. The deepest rung is often `- N item(s) — dreamcontext <command> for details`, which saves ~1KB by collapsing the entire section to a single line.

This is blinding, not a cheaper render. When the section carries identifying information the agent needs to route (metric names for Lab insights, objective titles for roadmap, task slugs for work queue), a bare count leaves the agent unable to answer "what's our MRR?" or "which tasks serve objective X?" The names are gone, so the agent either guesses, asks the user, or fetches from an external source the brain already holds.

The demotion floor pattern prevents this: set `maxDemotionLevel` to stop one rung above the bare-count collapse, keeping names + key identifying fields in context.

## The Pattern

### 1. Identify sections where names are load-bearing

A section needs a demotion floor when:
- The items have **stable identifiers** the agent must see to route correctly (slugs, titles, metric names)
- A question about "which X?" or "what's the value of Y?" is answerable FROM the snapshot, not by calling a tool
- The bare-count rung would force re-fetch of data already in the brain

Examples:
- **Lab insights**: metric names + latest values (agent routes via `lab show <slug>`)
- **Roadmap objectives**: objective titles + status (agent weighs decisions against outcomes)
- **Active tasks**: task names + priority (agent picks the right task to continue)

### 2. Set `maxDemotionLevel` to the last informative rung

```typescript
// src/cli/commands/snapshot.ts — renderLabSection()
const demotions: BudgetRung[] = [
  () => renderCompactInsightList(insights),     // level 1: names + latest + staleness
  // level 2 WAS: "- N insight(s) — lab list for details"  ← BLINDING, deleted
];

return demotableSection(
  'lab',
  fullRender,
  demotions,
  1  // maxDemotionLevel: stop at the compact list, never reach the bare count
);
```

The ladder may ASK to demote further (via `demotions[2]`, `demotions[3]`), but `maxDemotionLevel: 1` refuses. Cheaper sections absorb the pressure instead, and the snapshot stays honestly over budget rather than blinding the agent to save ~1KB.

### 3. Document the floor in the section's comment

```typescript
/**
 * The ladder deliberately stops at the one-liners (`maxDemotionLevel: 1` at the
 * demotableSection call) — metric names + latest values stay in context under
 * any budget pressure. A level-2 bare count ("N insight(s)") is blinding: the
 * agent cannot route `lab show <slug>` without seeing the slug.
 */
```

This pins the reasoning so a future refactor doesn't "optimize" the floor away.

## The Lab Case (shipped 2026-07-28, commit a562d1d)

**Problem:** Under budget pressure, `renderLabSection` demoted to `- 21 insight(s) — dreamcontext lab list for details`. The agent could not answer "what's our MRR?" without calling `lab list`, then `lab show mrr`, when the MRR value was already in the brain's cache — it just wasn't in the snapshot.

**Fix:** Deleted the level-2 bare-count rung and added `maxDemotionLevel: 1`. The compact rung (level 1) keeps metric names + latest values + staleness, so the agent sees:
```
- MRR: $856 (fresh, synced 2h ago)
- WAU: 127 (stale, last synced 3d ago)
```

This is ~200 chars vs ~30 chars for the bare count, but it's the difference between answering from memory and re-fetching from Stripe.

**Paired with hook directive:** The UserPromptSubmit hook also renders insight recall hits with an explicit "do NOT fetch, use `lab show`" line, so the rule fires on every prompt regardless of snapshot survival.

## Open Audit Item (flagged 2026-07-28)

**Objectives section** still has a bare-count deepest rung: `- N objective(s) — dreamcontext roadmap for the board`. Under budget pressure the agent cannot see what the project is driving toward, while Operational Rule "weigh decisions against these outcomes" assumes it can. This needs a floor.

## When NOT to use this pattern

- The section is purely informational with no routing decisions (e.g., a "Recent Releases" section that lists version numbers — if the agent needs details it can `Read` the file)
- The items have no stable identifiers (e.g., a list of arbitrary strings)
- The bare count IS the informative answer (e.g., "3 pending migrations" is actionable without seeing migration names)

## Trade-offs

**Pro:**
- Prevents blinding collapse that forces re-fetch of data the brain holds
- Keeps routing-critical identifiers in context
- Snapshot stays honest about being over budget (doesn't claim to fit by hiding names)

**Con:**
- Uses more budget (~200 chars vs ~30 for a bare count)
- May push another section to demote further (but cheaper sections demote first by design)

The trade is almost always worth it — saving 170 chars by blinding the agent to metric names is a false economy when the next `lab show` call is 1000+ tokens.

## Related

- `hook-delivered-must-not-miss-rules.md` — pairs with this pattern (Lab's insight directive lives in the hook too)
- `context-snapshot` feature PRD — documents `maxDemotionLevel` in the budget architecture
- `lab-analytics-insights` feature PRD — carries the Lab floor decision and the general lesson
