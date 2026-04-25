---
persona: growth-operator
rounds_completed: 1
---

## Round 1 — 2026-04-25

### Executive Summary

Bones are right. The cohort → campaign → adset → creative → ad spine matches how I actually think; dry-run-by-default and PAUSED-on-create are the two non-negotiables you got correct. But as written this ships a *modeling exercise*, not a daily ops tool. Five things must change before commit; everything else is noise relative to launch velocity.

### Position

**Adopt with material changes — do not commit as-is.** Ship a v1 slice (multi-account, daily ops verbs, hypothesis-gate, hardened dry-run, cached insights, Strategy + Performance Monitor agents only). Defer creative generation, Reinfluence, Brain graph nodes, recharts, and 3 of the 5 agents.

### Reasoning

**Change 1 — Multi-account is first-class, not an env var.**
Real operators run 2–10 ad accounts (own brand + clients + IG sub-brand). A single `META_AD_ACCOUNT_ID` will get me into trouble within a week — wrong-account spend is the #1 way operators get fired. Required:
- `_dream_context/marketing/accounts/<slug>.json` with `{ad_account_id, page_id, pixel_id, ig_actor_id, label, currency, timezone}`.
- Every mutating command takes `--account <slug>` or reads `marketing/.active-account`. Active account printed bold-red in every confirmation before the dry-run payload.
- `dreamcontext marketing account use <slug>`; `account list` shows yesterday's spend per account so I notice if I'm staring at the wrong one.

**Change 2 — Daily ops verbs are missing. The plan is build-mode CLI, not run-mode.**
80% of my day is not "create campaign." It's pause/scale/kill/diff. Add now, not later:
```
dreamcontext marketing pause --cohort <id>           # or --account, --campaign, --all
dreamcontext marketing resume <selector>
dreamcontext marketing scale <campaign> --pct +20    # daily_budget mutation, dry-run default
dreamcontext marketing kill --bottom 3 --by roas --min-spend 50
dreamcontext marketing today                         # one-screen: spend/CPM/CTR/ROAS vs yesterday
dreamcontext marketing diff <campaign> --since 24h
```
Without these, I'm back in Ads Manager within two days.

**Change 3 — Dry-run output must be human-scannable, not raw payload.**
"Prints the exact Graph API payload" is engineer-think. I need a 6-line summary first, payload collapsed: account, objective, budget/day, audience-size estimate, expected CPM band (from learnings), what flips ACTIVE vs PAUSED, and a confirmation token I have to type back for any mutation > $200/day or any `launch`. Payload is debug; summary prevents the $500 mistake.

**Change 4 — Force the hypothesis; block cohort creation without one.**
Plan accepts `--hypothesis "..."` as a free string. Make it required and validate shape: predicted-winner, predicted-metric, decision-threshold, kill-condition. If "test new creative" — reject, show template. The Strategy Optimizer should refuse to write a strategy JSON until the hypothesis passes shape-check. Single biggest behavioral lift the system can give.

**Change 5 — Insights latency + caching + rate limits are underspecified.**
Operators check insights 5–15x/day. Need: 15-min TTL cache shared across CLI/dashboard/agent so we don't burn rate-limit headroom. Meta throttles at ad-account tier via `X-Business-Use-Case-Usage` — surface remaining budget as a CLI line item, back off automatically, never crash. Snapshots at hour granularity not day, so `diff --since 24h` actually works.

**What's noise / over-engineered**
- *Five sub-agents on day one.* Strategy + Performance Monitor are load-bearing. Brainstormer + Copywriter overlap — collapse to one `marketing-creative-director` for v1. Creative Generator (image/video gen) is a research project, hide behind a flag.
- *Reinfluence integration in the first slice.* Sexy in demos, unused Tuesday morning. Ship `competitor add --notes` first; wire subprocess in v0.2.
- *Brain graph nodes for cohort/campaign/creative/competitor.* Cute at 5 cohorts, unreadable at 500. Defer; per-cohort tree view in the dashboard does the same job better.
- *`recharts` dependency.* Adds ~90KB. Sparkline + bar in raw SVG is ~80 LOC. Only add when Performance tab proves multi-series demand.
- *Council `--preset marketing`.* Premature; let organic council usage shape the preset.

**CLI ergonomics that make or break adoption**
- `dreamcontext mk` alias — I'll type `marketing` 200x/day, won't.
- Tab-completion on `--cohort`, `--campaign`, `--account` from the JSON store. Without it, I'm copy-pasting UUIDs and quitting.
- Human IDs, not UUIDs: `tr-leads-q2-hookv3` not `c4a8...`. Decoupling local id from `fb_id` is correct; make the local id readable.
- Every confirm prompt shows a diff vs current state: `daily_budget: 500 → 600 (+20%)`, never just absolutes.
- A bare `dreamcontext marketing` with no args = home screen: active account, today's spend, top/bottom 3, anything PAUSED that was ACTIVE yesterday.

**Ideal first-cohort end-to-end**
```
$ dreamcontext mk account use tilki-tr
✓ Active: tilki-tr (TRY, GMT+3, last spend: 2,143₺ yesterday)

$ dreamcontext mk cohort create tr-leads-hookv3 \
    --hypothesis "face-zoom 0-3s hook beats text-only by +30% CTR at <=15₺ CPM, kill at <8% CTR after 200₺ spend"
✓ Hypothesis shape OK. Dispatching strategy-optimizer...
[draft → tr-leads-hookv3.json, awaiting review]

$ dreamcontext mk cohort review tr-leads-hookv3
[funnel split, budget, targeting, KPI thresholds — y/n/edit]

$ dreamcontext mk launch tr-leads-hookv3 --dry-run
[6-line summary + diff vs Meta state + audience-size estimate]

$ dreamcontext mk launch tr-leads-hookv3
Type "tr-leads-hookv3" to confirm 1,500₺/day across 3 adsets: _

# +24h
$ dreamcontext mk today
[per-campaign spend/CPM/CTR/ROAS, hypothesis-status: ON-TRACK / VIOLATED]

$ dreamcontext mk kill --bottom 1 --cohort tr-leads-hookv3 --by ctr --dry-run
[loser, why, projected savings]
```
That's the loop. Everything else can ship later.

### Reactions to peers

No round-0 peer entries surfaced in my round-context, so this is a clean round-1 read. I expect the architecture seat to push back on multi-account adding store complexity — my answer is the FK shape barely changes (`account_id` becomes a top-level FK on cohort, that's it) and the safety win dwarfs the cost. I expect the DX/agent seat to defend the 5-agent roster — my answer is two of those agents are CLI-orchestratable functions in disguise, and shipping fewer ships sooner.

### Open questions

1. Is `_dream_context/marketing/.env` per-project or per-account? If multi-account, tokens must be per-account (System User tokens are scoped) — does the env loader resolve `META_TOKEN__<account_slug>` style?
2. Where does the **budget cap** live? I want a hard daily-spend ceiling per account stored in `accounts/<slug>.json` that the CLI refuses to exceed even with `--no-dry-run`. Plan doesn't mention this.
3. How do we handle Meta's eventual-consistency window (campaign created → not yet visible to insights for ~10–60 min)? Performance Monitor needs to know not to flag a fresh cohort as "no data = kill."
4. Does `marketing launch` support staged ramps (10% → 50% → 100% over 48h)? If not v1, fine — but the data shape should reserve room for it.
5. Sleep-consolidation on `marketing-learnings.md`: rem-sleep prunes "stale" entries — what's the rule? Hypothesis ledger entries are evergreen evidence; pruning them is data loss. Need an explicit "do-not-prune" section marker.
