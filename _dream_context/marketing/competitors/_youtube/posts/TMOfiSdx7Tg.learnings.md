---
source: _youtube__TMOfiSdx7Tg
url: https://www.youtube.com/watch?v=TMOfiSdx7Tg
speaker: Optimizer (anonymous; runs a paid "school community" + Meta ads course; subscription-business owner who demoes on his own ad account)
runtime: 21:14
type: post-launch optimization decision-process — daily/weekly account management
lane: paid-ad-account-ops
subdomain: post-launch-optimization
foundational_reference: false
delta_extraction: false
status: draft
evidence_strength: single-source · medium-high-credibility-source
source_weight_note: |
  FOURTH distinct speaker in paid-ad-account-ops, AND the corpus's first
  source on a previously-empty sub-domain: post-launch optimization
  decision-making (the daily/weekly question of "what do I turn off and
  when, given live performance data"). Other 7 sources covered structure,
  setup, creative; nobody covered the ongoing decision loop in this depth.

  Anonymous-but-credentialed: walks his own subscription-business ad
  account live, real CPAs visible (190/168/141 across 3 active adsets).
  Less branded jargon than Charlie or Edward; pragmatic media-buyer voice.
  No name surfaced — referred to as "Optimizer" in the corpus.

  Last ~1 minute is school community + course plug. Excluded.
promotion_rule: "Each net-new claim stays as 'observation' until ≥1 more distinct speaker confirms it. The corpus now has 4 distinct speakers in this lane; promotion bar (2 distinct speakers) is easier to clear."
lane_distinction: |
  Same lane as Ben (×3 videos), Charlie (×1), Moonlighters (×1). NEW
  sub-domain: post-launch-optimization. Future playbook structure may want
  to split paid-ad-account-ops into:
    - account-setup       (Ben foundational)
    - campaign-topology   (Ben + Charlie + Moonlighters)
    - creative-strategy   (Ben + Moonlighters)
    - post-launch-optimization (this video — first source)
  Decision deferred until each sub-domain has 2+ sources.
references_back_to:
  - _youtube__dAJyqo6wnq4 (foundational vocabulary + setup flow)
  - _youtube__JLlcwojiVtw (Ben video 1)
  - _youtube__13s-G9Uj51A (Ben video 3 — auction overlap, top-funnel-ad anti-pattern)
  - _youtube__E_wZJhuSK5U (Charlie — campaign topology, profit_volume, don't-touch-when-working)
  - _youtube__FYUR8ZL4_xY (Moonlighters — M4 method, adset min-spend = 1× target CPA)
---

# Learnings — `_youtube__TMOfiSdx7Tg`

> Lane: **paid-ad-account-ops · post-launch-optimization (NEW sub-domain)**. Every claim cites a verbatim transcript quote with timestamp. Single-source for most claims; one important 3-speaker corroboration recorded.

---

## 1. Optimization defined operationally (canonical definition for the sub-domain)

> "Optimizing simply means diverting spend away from things that are giving you bad results and towards things that are giving you good results." `[00:30]`

**Mechanism (verbatim):** *"turning off adsets or ads that are giving you bad results in terms of your ROAS or your CPA or cost per lead… so that we can improve our average results."* `[00:48]`

**Pattern shape extracted:** optimization is fundamentally **subtractive** — you improve the average by removing the bottom, not by adding new winners.

This is the canonical definition the eventual playbook should adopt for the post-launch-optimization sub-domain.

---

## 2. The 7-day average + multi-window context check (decision-window discipline)

The first concrete decision-window discipline in the corpus.

**Verbatim:**
> "We don't make these decisions based on one day worth of data or even three days worth of data. We always look at average time periods like seven days. I usually make my decisions off of 7-day averages." `[01:08]`

**Context-stack to check before any decision (verbatim):**
> "I will look at the maximum time period. I will look at 30 days to kind of see like what's the overall story. 14 days, which is like more recent results. 7 days, which for me is like the best kind of like average results time period to base decisions off of. I'll look at three days, last three days to see like where is this thing heading, what's the trajectory and then I'll look at yesterday to see how it performed most recently and then today to see how is it performing right now and that gives me the full story. I will look at the full story before I make that decision. But ultimately I'm making it on that 7-day average." `[01:24]`

**Three context layers (verbatim):**
> "It's also important looking at the average results in context of your other ads if you're optimizing at the ad level, your other ad sets if you're optimizing within a campaign, and within the average results of your entire ad account. Okay? So, there's three layers of average results that you have to look at to make your decisions. You can't make these decisions in isolation." `[02:04]`

**Pattern shape extracted:**
- **Decision basis:** 7-day average (primary)
- **Context windows:** max-time / 30d / 14d / 7d / 3d / yesterday / today — read in order to construct "the full story" before deciding
- **Three context layers:** account-level average / campaign-level average / item-in-isolation. All three must be considered.

**Status:** single-source. First decision-window framework in the corpus.

---

## 3. 🚨 NEW critical anti-pattern — "the algorithm is always right" is wrong

The corpus's first explicit articulation of when *not* to trust Meta.

**Verbatim:**
> "This thing that I hear online which is the algorithm is always right… I can tell you for certain that the algorithm is not always right. It will skew spend to things that are giving you terrible results. And um maybe it's in the best interest of Meta. Maybe Meta is looking out for itself but it doesn't always have your best interest in mind. Remember, Meta, all they care about is giving a good user experience on the platform and draining the money from advertisers." `[02:36]`

**The actionable implication (verbatim):**
> "Follow the data, follow what works, and don't just like leave things running that are doing terribly because you think at some point they're magically going to do better. It's just not how it works." `[03:15]`

**Cross-source nuance — when does "trust Meta" apply vs not?**

This sounds like it conflicts with the corpus's other "trust Meta" claims (Ben's leave-default-placements, Charlie's don't-interrupt-learning, Ben's trust-creative-enhancements). On close read, **it's not a strict conflict** — different decisions:

| Decision | Trust Meta | Don't trust Meta |
| --- | --- | --- |
| Placement selection | ✅ Ben (`_youtube__dAJyqo6wnq4` §13) | |
| Creative enhancement toggles | ✅ Ben (`_youtube__dAJyqo6wnq4` §20, with named overrides) | |
| Audience targeting (suggestions) | ✅ Ben + Charlie + Moonlighters | |
| Delivery frequency planning | ✅ Ben (auction overlap, `_youtube__13s-G9Uj51A` §1) | |
| Don't fragment campaign structure | ✅ Charlie (`_youtube__E_wZJhuSK5U` §1, §10) | |
| Don't kill load-bearing top-funnel ad | ✅ Ben (`_youtube__13s-G9Uj51A` §2) | |
| **Auto-kill bad-performing ads/adsets** | | ✅ **Optimizer (this video)** |
| **Value-judgment on which of YOUR offers are worth scaling** | | ✅ **Optimizer (this video)** |

**The line the eventual playbook must draw precisely:**
- Trust Meta on **delivery, structure, and audience finding** (where Meta has more data than the operator).
- **Don't** trust Meta on **value judgments about which of your ads/offers actually serve your business** (where the operator has more context — LTV, margin, capacity, brand fit).

**Status:** single-source for the explicit articulation; the *concept* is implicit in Charlie's profit_volume framing (`_youtube__E_wZJhuSK5U` §3 — "the only question we need to ask is did total revenue minus ad spend get better?"). Worth flagging as a 1.5-source claim.

---

## 4. 🆕 The "filter by row selected" trick — preview-before-decide (NEW operational tactic)

A specific Ads Manager UI feature that no other speaker has surfaced.

**Verbatim:**
> "Essentially, you're going to put a check mark next to all of them aside from the one that you plan to turn off. You're going to look at your average results, 190. You're on seven days. You're going to look at your average ROAS, 1.04. And then you're going to click in the search bar, click filter by row selected. And now you're going to look at the change. 144." `[10:11]`

**Pattern shape extracted:**
1. In Ads Manager, check ALL rows EXCEPT the one(s) you'd turn off.
2. Click "filter by row selected" in the search bar.
3. Read the projected post-turn-off averages (CPA, ROAS, etc.).
4. Compare to current averages → projected delta.

**Why this is corpus-novel:**
This is the first preview-before-decide tactic in the corpus. Every other source described the *decision* without describing how to *forecast its effect*. This trick lets the operator test a hypothesis without firing the action.

**Implication for Strategy Optimizer:** when the agent recommends a "pause this ad/adset", it should also surface what the projected post-pause campaign averages would be. If the projected delta is small or negative, the recommendation should be auto-downgraded.

**Status:** single-source. Net-new corpus tactic. Worth promoting on first corroboration.

---

## 5. 🆕 Spend redistribution math — when killing a top spender (NEW operational mechanism)

The math no other speaker has covered.

**The mechanism (verbatim):**
> "When you turn off the top spender within an adset, it's like shuffling the deck or rolling the dice. Like anything can kind of happen here. You also have to look at how much did the top spender spend yesterday. Okay, it spent 96 bucks. Well, if you turn off this top one, that's going to liberate 96 bucks to the remaining six adsets. So, if you divide 96 by six, that's going to give you approximately $16 that each one of these ads is going to absorb when you do that." `[11:14]`

**The hard rule (verbatim):**
> "If that number is really large and you have only a few ads, you could basically scale up the remaining ads if you liberate too much budget from the thing that you turn off. and that could break the whole ad set… if you're turning off several ads and it's liberating a very large amount of budget and you base this off of yesterday's spend, it could throw off the balance of the remaining ads, like it could scale them in a way and throw off their optimization and just ruin the whole thing." `[11:50]`

**Pattern shape extracted:**
```
liberated_budget = item_to_kill.spend_yesterday
per_remaining_item_increase = liberated_budget / count_of_remaining_items
SAFE_IF: per_remaining_item_increase << current_per_item_average_spend
DANGEROUS_IF: per_remaining_item_increase ≈ or > current_per_item_average_spend
```

In his example: $96 / 6 ads = ~$16/ad → manageable. If it had been $96 / 2 ads = $48/ad on adsets currently spending ~$50/day each, that would essentially **double** the remaining adsets overnight — breaking the existing optimization.

**Implication for Strategy Optimizer:** before recommending a kill on a top-spending ad/adset, compute the spend redistribution. If it would meaningfully scale the remaining items, refuse the auto-recommendation; surface the math to the operator and ask for explicit confirmation.

**Status:** single-source. Net-new mechanism. Pairs naturally with §4 (filter-by-row-selected) — the trick previews the *result*; the math predicts the *risk*.

---

## 6. Risk-vs-reward decision frame

> "I ask myself what do I stand to gain and what do I stand to lose." `[12:38]`

**Worked example from his own account (verbatim summary):**
- Current state: top adset at 190 CPA (acceptable) over 7 days, improving over 3 days, OK yesterday/today
- If he kills the top spender: filter-by-row preview = 144 CPA (great)
- But: top spender = top spender → killing it could scale the remainder unpredictably
- Decision: leave it. Current results are good; risk of breaking > reward of marginal improvement.

**Verbatim conclusion:**
> "Since I'm a little bit more conservative and these average results are good, I'm just going to leave it. I'm going to let it keep training my ad account, keep bringing me new members, and just leave it alone." `[14:36]`

**Pattern shape extracted:**
- "Already-good" results are NOT optimization candidates by default.
- Operator's personal risk tolerance is an explicit input to the decision.
- The decision-NOT-to-act is a valid optimization output.

**Implication for Strategy Optimizer:** the agent's action vocabulary must include "no action recommended — current state is acceptable", and that recommendation must be surfaced explicitly when the cost/benefit doesn't justify a move.

---

## 7. 🆕 "Stand by your decision" — over-correction anti-pattern

> "Once you decide on optimizing something, you have to stand by your decision. The worst thing you can do is say turn this thing off and then the next day you see bad results and then panic and then turn it off or lower the budget or something. You need to basically stand by your decision and number one give it a chance to work and number two see how the optimization plays out." `[14:50]`

**Pattern shape extracted:**
- After making an optimization move, **do not reverse course on day-1 data**.
- Give 3-5 days for the next decision cycle.
- If the move broke the system: don't try to *fix* it move-by-move — restart the optimization process from scratch (re-identify bad performers, re-decide).

**Status:** single-source. Strong claim with a clear behavioural rule.

---

## 8. 🔗 Snow globe analogy — algorithm volatility cadence rule (3-SPEAKER CONFIRMATION)

The most important cross-source corroboration in this video.

**Verbatim:**
> "I treat the algorithm like a snow globe or ad account is like a snow globe. Every time you make a move like this — you edit something, you turn something on, you launch something, you close something — it's like you're shaking the snow globe, the snow goes everywhere. That's volatility in your ad account. That is the algorithm going a little crazy right when you leave it alone… when you don't touch it, the snow settles to the bottom… the algorithm performs best in this settled state." `[16:13]`

**The cadence rule (verbatim):**
> "We like to make our move and then let it settle and then see how it plays out, assess the data, and then make our next move and then leave it alone. Meta ads is volatile enough. So, by moving in this methodical, systematic way, you bring a lot more stability into your ad account versus just always touching it once, twice, three times a day or every day or every other day even. It's better to assess all the available options that you have. Weigh out the risk versus reward, make your decision, and then leave it alone for like 3 or 5 days and then do the whole process again." `[17:01]`

**Cross-source corroboration (3 distinct speakers):**

| Source | Articulation | Citation |
| --- | --- | --- |
| Optimizer | Snow globe analogy + "leave it alone for 3 or 5 days" | this video §8 |
| Charlie | "Once Andromeda starts working, the fastest way to destroy it is by touching the budget at the wrong time… If you can increase the budget, don't do anything else." | `_youtube__E_wZJhuSK5U` §11 |
| Ben | "Don't be afraid to deviate but do it intentionally with a known reason" + general "trust Meta to deliver" framing | `_youtube__13s-G9Uj51A` §22 (implicit) + foundational |

**Status:** **3 distinct speakers → STRONG RULE. Promote.** This is now one of the most well-corroborated claims in the corpus.

**Pattern shape extracted (now corpus-canonical):**
- Default cadence between optimization moves: **3-5 days minimum**
- Anti-pattern: touching the account multiple times per day, every day, or every other day
- Exception (Charlie): if the only move is a budget *increase* on a working campaign, that's allowed without waiting

---

## 9. 🆕 Biggest impact, fewest moves

> "When you're optimizing, generally, you're trying to make the biggest impact, positive impact, for the least amount of moves." `[14:08]`

**Pattern shape extracted:**
- Prefer 1 high-leverage decision per cycle over 5 small decisions.
- Aligned with §8 (snow globe) — fewer moves = less account volatility.
- Implication: the Strategy Optimizer should rank candidate moves by expected impact and surface only the top 1-2, not a list of every possible action.

---

## 10. 🆕 Ad-level vs adset-level optimization decision rules (analytically dense net-new claim)

The most analytically dense net-new claim in the video. No other speaker has articulated this asymmetry.

**Verbatim:**
> "When do we optimize at the ad level? I only optimize at the ad level when I'm working in ad set budgets or ABOs, okay? Or single ad set CBOs. Why? Well, in ABOs the ad sets are not algorithmically competing for spend. So, if I were to make a change at the ad level inside one of the adsets, that change wouldn't necessarily affect the relationship between the ad sets… Same thing with single adset CBOs." `[17:48]`

**The domino-effect explanation (verbatim):**
> "The reason why I optimize at the adset level in multi adset CBOs is I'm trying to avoid any domino effect where it's like you edit the ad which then changes the relationship between those ads which then messes with the performance of the ad set which then messes with the relationship of the ad sets which can then break the whole campaign. Right? So, we're trying to avoid that domino effect. So to limit the variables, I simply turn off adsets in multi adset CBOs just to avoid that domino effect." `[19:02]`

**Decision matrix extracted:**

| Budget structure | Optimization happens at | Reason |
| --- | --- | --- |
| **ABO** (adset budgets) | **Ad level** | Adsets aren't competing for spend; ad-level changes stay isolated to the adset. |
| **Single-adset CBO** | **Ad level** | Same reason — only one adset to break. |
| **Multi-adset CBO** | **Adset level** | Domino effect: ad change → adset perf change → adset relationship change → can break campaign. Limit variables by acting at the adset level only. |

**Quick aside (verbatim, weakly articulated):**
> "Just keep in mind I don't ever add new adsets into an active CBO for many reasons but that's I've covered that in other videos." `[18:54]`

**Pattern shape extracted:** the level at which to make optimization moves is a function of the budget structure. NOT a function of operator preference.

**Status:** single-source. **Highest priority analytical net-new claim to corroborate next** — this is a structural rule that will materially change the Strategy Optimizer's decision tree.

---

## 11. § Cross-source state — updated for 8-source corpus

### 11.1 New promotion to STRONG RULE (3 distinct speakers)

- **Snow globe / 3-5 day cadence between optimization moves** — Ben + Charlie + Optimizer (§8). **Lift to playbook.**

### 11.2 Existing 3-speaker strong rules from prior videos (unchanged)

- Leave detailed targeting / suggested-audience mostly blank — Ben + Charlie + Moonlighters
- Don't artificially constrain audience — Ben + Charlie + Moonlighters
- Consolidate to one prospecting campaign — Ben + Charlie + Moonlighters

### 11.3 New 1.5-source claim

- **"Don't trust Meta to value-judge your ads/offers"** (§3) — Optimizer explicit; Charlie implicit via profit_volume (`_youtube__E_wZJhuSK5U` §3). Promote when 1 more source confirms.

### 11.4 Single-speaker net-new claims (high priority)

- 🆕 **Ad-level vs adset-level optimization decision matrix** (§10) — Optimizer only. **Highest analytical priority** — materially structural for the eventual Optimizer agent.
- 🆕 **Filter-by-row-selected preview trick** (§4) — Optimizer only. Operational; pairs with §5.
- 🆕 **Spend redistribution math when killing a top spender** (§5) — Optimizer only. Operational guard.
- 🆕 **7-day average + multi-window context stack** (§2) — Optimizer only. Decision-window framework.
- 🆕 **Stand-by-your-decision anti-pattern** (§7) — Optimizer only.
- 🆕 **Risk-vs-reward decision frame + "don't optimize already-good"** (§6) — Optimizer only.
- 🆕 **Biggest impact, fewest moves** (§9) — Optimizer only.

### 11.5 Sub-domain coverage gap exposed

This video establishes that `paid-ad-account-ops` actually splits into 4 distinct sub-domains:

| Sub-domain | Sources | Coverage |
| --- | --- | --- |
| account-setup | Ben (foundational) | 1 voice |
| campaign-topology | Ben (×3) + Charlie + Moonlighters | 3 voices |
| creative-strategy (within ops, not the same as paid-ad-creative) | Ben + Moonlighters | 2 voices |
| **post-launch-optimization** | **Optimizer (this video) only** | **1 voice — biggest gap** |

The **biggest single gap in the corpus** is now post-launch-optimization. Ingesting one more source on this specifically would let multiple of §11.4's claims advance to 2-speaker status quickly.

---

## 12. Things I deliberately did NOT extract

- **`[20:00]`–end** — school community + course plug ("currently at the lowest price… get grandfathered in"). Drop.
- **His specific CPA thresholds** ($200 good / $300 bad / $300+ unacceptable) — keep as *illustrative example* of how to set thresholds, NOT as corpus-citable numbers. The reusable pattern is "operator pre-sets thresholds before optimization decisions"; the magic number is operator-specific.
- **"Like a financial advisor" / "elite media buying" / "fun puzzle"** colour language — drop.
- **"I've covered that in other videos"** callouts (~3×) — drop.
- **The "if my job is wrong then I'd be broke" rhetoric** `[03:25]` — drop. It's a credibility claim, not a rule.

---

## 13. Open questions deferred to user

1. **Sub-domain split of `paid-ad-account-ops`** (§11.5) — should we split this lane into 4 sub-domains for the eventual playbook, or keep as one lane with sub-headings? With 8 sources covering wildly different surfaces (setup vs structure vs creative vs daily ops), splitting may be cleaner.
2. **Ad-level vs adset-level decision matrix** (§10) — this is structural enough that it should probably feature prominently in the eventual Optimizer's decision tree. Want me to flag it as a promote-on-first-corroboration claim?
3. **The "trust Meta on X / don't trust Meta on Y" line** (§3) — the corpus now has enough material to draw this line precisely. Want this captured as its own meta-rule somewhere, or only inside the Optimizer's decision logic?
4. **Filter-by-row-selected + spend redistribution math** (§4 + §5) — together these form a "preview the move before making it" pattern that the Strategy Optimizer should embed as a hard pre-move check. Confirm?
5. **Post-launch-optimization is the biggest single corpus gap** (§11.5). Want to ingest one more source specifically on this sub-domain before we lock in the optimization-loop design?
