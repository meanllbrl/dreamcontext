---
title: "Meta Platform State"
purpose: "Time-stamped Meta UI and algorithm facts that change over time. Separate from operator rules — these describe what Meta's platform looks like RIGHT NOW, not how to use it. Update this file when Meta changes a default, removes a feature, or shifts algorithm behavior."
last_verified: "2026-04-25"
---

# Meta Platform State (as of 2026-04-25)

These are facts about Meta's current platform behavior — UI defaults, algorithm changes, and known shifts. They are distinct from operator rules (which are in `account-ops.md`) and creative rules (which are in `copy-formulas.md`).

**When reading this file:** Check `last_verified` date. If it is more than 60 days ago, treat entries as potentially stale and verify in Ads Manager before relying on them.

---

## Current Defaults (may differ from what operators remember)

| Setting | Current default | Changed from | Date confirmed | Source |
|---|---|---|---|---|
| Attribution window | **1-day view** | Previously 7-day click + 1-day view | 2026 | mistakes-report-2026 |
| Campaign type recommendation | Advantage+ campaigns | Manual campaigns (ABO/CBO) | 2025 | Ben Heath (`dAJyqo6wnq4`), mistakes-report-2026 |
| Targeting | Advantage+ Audience (suggestions, not hard constraints) | Interest targeting as hard filters | 2024–2025 | Ben Heath (`JLlcwojiVtw`), mistakes-report-2026 |
| Placements | Advantage+ placements (all placements auto-selected) | Manual placement selection | 2024 | Ben Heath (`JLlcwojiVtw`), Moonlighters (`FYUR8ZL4_xY`) |

**Operator implication — attribution window:** Meta now reports on a shorter window by default. Your reported ROAS may appear lower than before even if real performance is unchanged. Always compare apples-to-apples when benchmarking: same attribution window, same date ranges.

---

## Known Algorithm Behavior (current)

| Behavior | Detail | Date confirmed | Source |
|---|---|---|---|
| Meta uses ads within one adset in funnel sequences | Meta may show ad A first (top-funnel), then ad B (conversion). Ad A will have low ROAS but is doing real work. | 2026-04-25 | Ben Heath (`13s-G9Uj51A`, `kuSq-pmNfnM`) |
| Targeting inputs are suggestions, not constraints | Even if you set interests or custom audience targeting, Meta may deliver outside those boundaries unless you explicitly force hard constraints via hidden settings. | 2025–2026 | Ben Heath, Charlie, Moonlighters (all 3 speakers) |
| Advantage+ Shopping YoY improvement | Meta reported ~70% YoY improvement in Advantage+ Shopping campaign performance in Q4 2024 | Q4 2024 | mistakes-report-2026 |
| Andromeda algorithm rollout | Meta's new AI delivery system (Andromeda) rolled out broadly. Affects targeting, delivery sequencing, and optimization. Heavily favors broad signals over narrow ones. | 2025-12 | mistakes-report-2026 |

---

## Known UI Changes

| Change | Detail | Date | Source |
|---|---|---|---|
| Exclude custom audiences is now a hard exclusion | Previously "exclude" was treated as a soft signal; Meta could override it. As of 2026, exclusions are enforced as hard boundaries. | 2026-04-25 | Ben Heath (`13s-G9Uj51A` §1) |
| Learning phase threshold | ~50 conversions/week per adset to exit learning phase. This number has been consistent since 2023 but worth verifying if Meta updates guidance. | 2023–2026 | mistakes-report-2026, Ben Heath |

---

## Deprecations / Removed Features

| Feature | Status | Last seen | Notes |
|---|---|---|---|
| Interest-based targeting as primary strategy | Effectively deprecated — Meta ignores or overrides in most cases | 2023 | Still available in UI but corpus consensus is it no longer performs |
| Manual bidding as default approach | Still available but not recommended for most accounts | 2024 | Use auto-bid unless you have a specific bid strategy rationale |

---

## What to check when this file feels stale

1. Open Ads Manager → any campaign → verify the attribution window shown in column settings
2. Check Meta's "What's New" in Business Help Center for algorithm updates
3. Run a test campaign and check whether interest targeting is being overridden in Delivery Insights
4. Update `last_verified` date after verification
