---
id: budget-demotion-floor-prevents-blinding
name: "Budget Demotion Floor Prevents Blinding"
description: "Decides how deep a bounded context surface may collapse. A bare count is blinding ONLY when the item NAME is the routing key (metric slugs, objective titles, exceptional task states) — there, set a maxDemotionLevel floor. When the name has no session-start consumer, a count plus the exact search/browse command beats listing the names."
tags: ["architecture", "decisions", "domain:knowledge", "topic:cli"]
pinned: false
date: "2026-07-28"
updated: "2026-07-30"
---

## Why This Exists

The snapshot budget ladder demotes sections progressively under token pressure: full content → summaries → one-liners → bare count. The deepest rung is often `- N item(s) — dreamcontext <command> for details`, which saves ~1KB by collapsing the entire section to a single line.

This is blinding, not a cheaper render. When the section carries identifying information the agent needs to route (metric names for Lab insights, objective titles for roadmap, task slugs for work queue), a bare count leaves the agent unable to answer "what's our MRR?" or "which tasks serve objective X?" The names are gone, so the agent either guesses, asks the user, or fetches from an external source the brain already holds.

The demotion floor pattern prevents this: set `maxDemotionLevel` to stop one rung above the bare-count collapse, keeping names + key identifying fields in context.

> **Read the 2026-07-30 refinement below before applying this.** The rule is NOT "never collapse to a count". It is "never collapse to a count *when the name is the routing key*". Applied without that qualifier, this pattern turns every section into an unbounded roster and the snapshot busts the harness limit — which is the failure it was written next to.

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

## The 2026-07-30 refinement — the other half of the rule

Applying "keep the names" everywhere made the *default* render the worst case: on a mature vault the level-0 snapshot ran 21K+ chars, over the harness limit, so the harness cut it positionally — the exact failure the ladder exists to prevent. The owner-approved judge verdict (Fable, 2026-07-30) split the question properly:

**A name earns its place only if it has a session-start CONSUMER.**

Ask: *what does the agent do differently at second zero because this name is on screen?* If the answer is "nothing — it would search for it anyway", the name is inventory, not context.

| Test | Verdict | Shipped render |
|---|---|---|
| Name is the routing key (`lab show <slug>`, weighing a decision against an objective, resuming a blocked/in_review task) | **Floor it** | Lab is rung-less; objectives floored at level 2; tasks name every *exceptional* status |
| Name is a rule the agent is bound by | **Floor it, loudly** | Patterns keep their own block + hard banner at every rung, never folded into folder inventory |
| Name has no session-start consumer, and a taught command recovers it | **Count + teach** | Non-pinned knowledge = one count + `memory recall` / `knowledge index`; features = name+status+path; the routine todo/planned queue = per-status counts |

Two conditions make "count + teach" safe, and both are load-bearing:

1. **The count must be honest and complete.** The contract shipped for tasks is *every item accounted for*: `detailed + named-as-exception + counted` sums to the true total, asserted on a 60-task and a 200-task fixture. A count that silently omits is worse than no count.
2. **The recovery command must be printed, at every rung including the floor.** A standing footer per section (`memory recall --types <t>` + the browse/filter command). The changelog floor had zero recovery pointer and that is what made this visible. If the command does not exist yet, **build it** — `dreamcontext changelog list` and `tasks list --since/--until` were written precisely so the new footers pointed at something real.

Measured: the mature vault went 21,470 → 16,320 chars, fully inline with no banner, while keeping every metric name, every objective, every rule and every exceptional task state.

## Resolved audit item (flagged 2026-07-28, fixed 2026-07-29)

**Objectives** no longer has a bare-count deepest rung. `renderObjectivesSection` is floored at level 2 — a compact line per active objective packed into `OBJECTIVES_L2_CHARS` with a named tail — and the count line breaks down `N active + M done — K SLIPPING` so a shorter list never reads as a silent drop.

## When NOT to use this pattern

- The name has no session-start consumer and a taught command recovers it — use count + teach instead (see the refinement above). This is the common case for large inventories.
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

The trade is almost always worth it **for a routing-key name** — saving 170 chars by blinding the agent to metric names is a false economy when the next `lab show` call is 1000+ tokens. It is a bad trade for a name the agent would never have used: there, the same 170 chars are better spent on a rule, an exception, or a taught command.

## Related

- `hook-delivered-must-not-miss-rules.md` — pairs with this pattern (Lab's insight directive lives in the hook too)
- `context-snapshot` feature PRD — documents `maxDemotionLevel` in the budget architecture
- `lab-analytics-insights` feature PRD — carries the Lab floor decision and the general lesson
