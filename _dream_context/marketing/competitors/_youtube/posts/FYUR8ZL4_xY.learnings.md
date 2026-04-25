---
source: _youtube__FYUR8ZL4_xY
url: https://www.youtube.com/watch?v=FYUR8ZL4_xY
speaker: Edward (founder, The Moonlighters — e-comm Meta ads agency; runs paid school.com/fas community with 400+ brands)
runtime: 13:41
type: M4 method walkthrough — post-Andromeda prospecting + retention structure with live Ads Manager setup
lane: paid-ad-account-ops
foundational_reference: false
delta_extraction: false
status: draft
evidence_strength: single-source · high-credibility-source
source_weight_note: |
  THIRD distinct speaker in the paid-ad-account-ops lane. E-commerce
  specialty (Ben = generalist, Charlie = philosophical). $35M managed
  in 6 months, 400+ brand community, walks live in Ads Manager UI.

  This is a corpus inflection point. Multiple claims previously at
  2 distinct speakers (Ben + Charlie) are now at 3 speakers (Ben + Charlie +
  Moonlighters), which clears the bar for promotion to firm playbook rules.
  Several previously single-Ben claims also gain a 2nd speaker via this video.

  Heavy self-promotion of school.com/fas community + themoonlighters.com
  agency (3× across the runtime). Excluded.
promotion_rule: "With 3 distinct speakers now in the lane, the corroboration bar for paid-ad-account-ops is satisfied for any 3-speaker claim. Net-new single-speaker claims here still wait for a second source."
lane_distinction: |
  Same lane as Ben (×3) and Charlie (×1). E-commerce-flavoured but
  structurally compatible with Ben's general-business framing and
  Charlie's philosophical framing. No new lane introduced.
references_back_to:
  - _youtube__dAJyqo6wnq4 (foundational reference for Ads Manager vocabulary + setup flow)
  - _youtube__JLlcwojiVtw (Ben video 1 — value rules, partnership ads, creative testing tool, hybrid retargeting)
  - _youtube__13s-G9Uj51A (Ben video 3 — auction overlap, top-funnel-ad anti-pattern, audience-permutation testing rejection)
  - _youtube__E_wZJhuSK5U (Charlie — campaign topology, profit_volume, similarity-beats-scale)
---

# Learnings — `_youtube__FYUR8ZL4_xY`

> Lane: **paid-ad-account-ops · 3rd-speaker entry**. Every claim cites a verbatim transcript quote with timestamp. With this video the lane has 3 distinct speakers — strong rules become possible.

---

## 1. The M4 method — overall structure (would feed → future `playbooks/campaign-topology.md`)

The branded operational shape Edward uses across his managed accounts.

**Three-component structure (verbatim summary):**

> "In the M4 method, we have a core prospecting CBO campaign, multiple ad sets with all minimum budgets… we are grouping our creatives by avatar or concept. We then have this same retention campaign to hit our existing customers with all-time purchasers and 180-day purchasers mixed in… one of the biggest sweeping changes is now our retargeting campaign is optional." `[02:32]`–`[03:06]`

**Component table:**

| Component | Audience | Optional? | Notes |
| --- | --- | --- | --- |
| **Prospecting** (CBO campaign) | Excludes all-time purchasers; otherwise broad | No — always-on | Multiple adsets = "packs" grouped by avatar+concept |
| **Retention** | All-time purchasers + 180-day purchasers | No | Ad menu: evergreen + sale + new products + upsells/downsells |
| **Retargeting** (engaged audience) | 90-day add-to-cart + 30-day site visitors | **Yes — optional based on data** | "You have to be skilled enough to actually understand if you should have it or not" `[03:09]` |

**Pattern shape extracted (vs Ben + Charlie):**
- Aligns with Ben + Charlie on consolidation: one prospecting campaign with multiple adsets (not multiple campaigns).
- **Adds a structural distinction the others didn't make explicit:** prospecting and retention live in **separate campaigns** (because they need different audiences and different ad menus). This is consistent with Ben's "1 campaign per product/service range" rule (`_youtube__13s-G9Uj51A` §5.1) but applied to a different axis: campaign-per-funnel-stage where the funnel-stage actually requires audience separation.
- **Retargeting becomes optional** — neither Ben nor Charlie said this directly. This is a data-conditional decision, not a default.

---

## 2. Avatar + Concept pack grouping (NEW operational discipline)

The unit of organisation inside the prospecting campaign.

**Verbatim:**
> "Every single time we launch a new pack, we're thinking about the avatar in that pack. So, we're grouping our ad concepts by avatar and by concept. So in this case, I would name my pack number one and I would put my avatar name plus concept name." `[04:32]`

**The duplication discipline:**
> "When we add new packs, new creatives, whenever they're available for us, all we're doing is we're duplicating the exact same adset. We're changing this from pack one to pack two. We're including whatever unique avatar and concept we are launching here. And if you're launching iterations, then mention that it's iterations. We're keeping all of these settings exactly the same." `[09:55]`

**Pattern shape extracted:**
- Adset name template: `pack_<N>_<avatar>_<concept>` (or `pack_<N>_<avatar>_<concept>_iteration_<M>`).
- All adset settings (audience, placement, performance goal) are **identical across packs** — the only thing that changes is the creative inside.
- Adsets are NOT used to test audiences (corroborates Ben + Charlie). Adsets ARE used to organise creative briefs by ICP × angle.

**Implication for Strategy Optimizer:** when the agent generates a creative brief, it must specify (avatar, concept) so the brief maps cleanly to a pack name. Avatar + concept become first-class fields in the brief schema.

---

## 3. 🆕 Adset minimum-spend rule — solves the "new creative gets starved" problem (NEW solution path)

This is the most important net-new tactical claim in the video. It introduces a **third path** through the Ben-vs-Charlie testing-methodology conflict.

**The rule (verbatim):**
> "Every time you launch a new pack, you're going to be setting an ad set spending limit typically equal to one time your target CPA." `[07:11]`

**Setup detail (verbatim):**
> "We're clicking set a minimum. We're choosing use dollar value and we're setting our minimum equal to our target CPA. If you're only spending a little bit of money, then you might not have the flexibility to do this. This is going to be most applicable and most effective for businesses that are spending a lot. If you're spending $1,000 a day, $2,000, $5,000 a day, this is going to be particularly helpful to actually get the most amount of spend to your best ads while also testing a small amount on new ads that are running." `[07:22]`

**First-pack carve-out (verbatim):**
> "If this is your first pack and your only pack, then you don't need to set a limit. The limit is actually only going to be applied when we're launching new packs moving forward." `[06:43]`

**Pattern shape extracted:**
`new_pack_min_spend = 1 × target_CPA`. Forces Meta to actually spend on new packs without starving them, while preventing them from cannibalising the established winners.

**🔁 Resolves (or at least breaks) the Ben-vs-Charlie testing-methodology conflict** (recorded in `_youtube__E_wZJhuSK5U` §12.2 and reaffirmed in `_youtube__13s-G9Uj51A` §5.4):

| Approach | Where the test lives | Mechanism |
| --- | --- | --- |
| **Ben** (`_youtube__JLlcwojiVtw` §5) | Outside the main campaign (Meta's Creative Testing tool, isolated audience splits) | Per-ad CPA comparison with non-overlapping audiences |
| **Charlie** (`_youtube__E_wZJhuSK5U` §1, §2) | Inside the main campaign — control + test adsets | Campaign-level profit_volume; "did this make the system better?" |
| **Moonlighters (this video) — NEW** | Inside the main campaign — new pack as a new adset, with min-spend = 1× target CPA | Forced minimum spend on new pack; Meta then redistributes naturally based on performance |

**The Moonlighters approach is a hybrid:** it preserves Charlie's "test inside the main campaign" topology while solving the "starvation" problem that Ben tries to solve with the Creative Testing tool.

**Caveat (per Edward himself):** *"If you're only spending a little bit of money, then you might not have the flexibility to do this."* `[07:30]` — this approach assumes account-level spend is high enough that 1× target CPA per new pack is a meaningfully small fraction of total daily spend. For low-budget accounts, this collapses back to Charlie's low-budget rule (everything in one adset).

**Status:** single-source (Edward only). Second-most-actionable single-source claim in the corpus after the performance-goal trap. **Highest priority to corroborate next** for resolving the testing-methodology conflict.

---

## 4. Attribution settings — 7-day click + 1-day engaged + 1-day view (NEW specific recommendation)

**Verbatim:**
> "Our attribution model is going to be standard. Although there are times when incremental makes sense. We're going to choose standard for now. And then we're going to change our attribution setting to 7-day click, one day engaged, one day view." `[06:00]`

**Insider context (verbatim):**
> "By the time you're watching this, the upcoming changes to engaged view attribution are going to be more clear. They're going to be public to everyone. We have beta tested this in multiple accounts because we have early access. And I can confidently tell you that running 7day, one day, one day is going to long-term be more beneficial or at least give you the most amount of signals for your pixel." `[06:13]`

**Pattern shape extracted:**
`attribution_window = (7d_click, 1d_engaged, 1d_view)`. Standard attribution model (not incremental) as the default.

**Status:** single-source. Edward has insider knowledge (beta access) which raises confidence but doesn't satisfy the cross-source criterion. Flag for verification when the rollout becomes public.

---

## 5. 🆕 Meta UI behaviour change — "Exclude these custom audiences" is now HARD, not a suggestion (corpus's first platform-state observation)

This is the corpus's first explicit documentation of a recent Meta UI semantic change.

**Verbatim:**
> "This used to be something that was a suggestion. It's no longer a suggestion. If you exclude these audiences, as we can see from the info button here, any custom audiences added here will be excluded from the audience for this ad set." `[08:11]`

**Implication (verbatim — what the change enables):**
> "We need to exclude everything here in the retention campaign and we are excluding anyone all time who's purchased. So this is going to be from a Klaviyo or a CRM list manually uploaded into Facebook." `[08:42]`

**Pattern shape extracted:**
- `Audience > Show settings > Exclude these custom audiences` — the exclusion list IS now a hard boundary, contrary to the suggestion-based model that governs everything else in the suggested-audience section.
- Prerequisite for clean prospecting / retention split: exclude all-time purchasers (uploaded from Klaviyo / CRM) from the prospecting campaign.

**Why this matters for the corpus:**
- Adds nuance to the controls-vs-suggestions framework (now at 3-speaker confirmation). The clean binary "controls = hard / suggestions = soft" gets a third state: "exclusions = hard, even though they sit in the suggested-audience section UI."
- This is platform state, not operator strategy. Will require occasional re-verification as Meta evolves.

**Status:** single-source for the platform claim itself. Worth recording as a *time-stamped platform-state fact* (timestamped to `2026-04-25` ingestion date) rather than a general operator rule.

---

## 6. ⚠️ Interest-winners adset — uses `further limit reach` (TENSION with Ben)

A specific defensive use of interest targeting that creates apparent tension with Ben's "don't use further-limit-reach" guidance.

**Verbatim setup:**
> "We're quickly duplicating our pack. We're changing this instead of from pack 2 to interest winners. In the interest group, we are only running our best performing ads overall time. Truly testing the interest, not testing the ads." `[10:30]`

**Configuration (verbatim):**
> "When it comes to your audience, this is where things do in fact change. We're going to click further limit the reach of our ads. Switch setup. You might have a couple of different toggles there. Just make sure you're always clicking further limit, further limit, further limit. We're then going to detail targeting. Describe your audience before. Don't worry. Just go to use original options and then go into here. And what you are doing is selecting a single interest target. You are not selecting a whole lot of targets. You're selecting a single interest. And you want it to be adjacent to your brand." `[11:01]`

**Adjacency rule (verbatim):**
> "If I was Nike, I would not select Adidas. I would not select Reebok. I would not select Under Armour. Those are exactly the same as who I'm currently targeting. The point of an interest is to expand your audience. So, if I was Nike, what I would target instead is something like Range Rover because Range Rover is a different group of people, kind of like Nike likes to position as a luxury brand." `[11:30]`

**Pattern shape extracted:**
`interest_winners_adset = best_performing_ads + further_limit_reach + 1_adjacent_interest`. Adjacent = different audience the brand could plausibly cross-sell to, NOT a same-category competitor.

**⚠️ Tension with Ben** (`_youtube__dAJyqo6wnq4` §11):
> Ben: *"You can click on further limit the reach of your ads… Not something I'd recommend for most beginners. It overcomplicates it, and typically, we see better results now by giving Meta direction, and letting Meta's machine learning algorithm work it out."*

**Reconciliation (proposed, not corroborated):**
- Ben's framing = beginner default. Don't reach for `further limit reach` reflexively.
- Edward's framing = advanced winner-amplification. Use `further limit reach` deliberately, with a single adjacent interest, ONLY when you have proven winners to amplify into adjacent audiences.
- These are not strict contradictions — they target different operator skill levels — but the eventual playbook must surface this nuance, not collapse it into a single rule.

**Status:** Edward single-source for the *advanced* use; Ben single-source (×2 articulations) for the *beginner default*. Need a 3rd speaker on either side before promoting either as a firm rule.

---

## 7. The 30–50 active adset reality (operational expectation)

> "In time with this kind of a setup, you're going to notice you start to launch a lot of packs and you might find 30, 40, 50 active adsets. Now, that is all fine if you're scaling the actual ad spend as you're launching new packs. But if you're not scaling your ad spend and you're stuck at a specific ad spend or you don't even want to and you just want to get a slightly higher return on ad spend, then you're going to have to pause down certain adsets and certain ads to maintain a good flow and allow the account to breathe." `[11:54]`

**Pattern shape extracted:**
- `weekly_pack_launches × time` → naturally drives adset count up to 30–50 active.
- **Pacing rule:** `total_daily_spend / active_adset_count ≥ minimum_meaningful_spend_per_adset`. If the account's spend isn't growing as fast as adsets are being added, pause older packs proportionally.

**Status:** single-source. Operational rule of thumb, not a hard rule.

---

## 8. 🔗 Hard corroborations introduced — counter advances to 3 speakers

The most important update from this video.

| Claim | Sources (now) | Status |
| --- | --- | --- |
| **Leave detailed targeting / suggested-audience mostly blank** | Ben (×3) + Charlie + Moonlighters (*"99% of the time, I am leaving this blank"* `[09:31]`) | **3 distinct speakers → STRONG RULE. Promote.** |
| **Don't artificially constrain audience** | Ben (×3) + Charlie + Moonlighters (*"In most cases, it's better to go broad and then narrow down later"* `[08:09]`) | **3 distinct speakers → STRONG RULE. Promote.** |
| **Default placement = leave Meta to choose; don't pre-optimize** | Ben + Moonlighters (*"There is nothing that we're doing on the placement side… The analysis happens after we run the ads, not before. And we're not over optimizing"* `[09:43]`) | 2 distinct speakers → near-rule |
| **Conversions API is mandatory, not optional** | Ben + Moonlighters (*"the correct data into the pixel is so critical… Without that, to be completely honest, you are doomed"* `[05:42]`) | **2 distinct speakers → near-rule.** First corroboration of CAPI as load-bearing. |
| **Auto-translate ads off if you can't fulfill** | Ben + Moonlighters (*"Do not allow your ads to be autorated into a bunch of different languages, especially if they don't apply to those languages"* `[09:08]`) | **2 distinct speakers → near-rule** |
| **Consolidate to one prospecting campaign** | Ben (×3) + Charlie + Moonlighters | **3 distinct speakers → STRONG RULE. Promote.** |
| **Don't lie to Meta about minimum age (don't restrict for non-legal reasons)** | Ben + Moonlighters (*"truly set this to your minimum age. Don't lie to Facebook. Don't put 21 plus if you actually aren't exclusively limited to 21 plus"* `[07:58]`) | 2 distinct speakers → near-rule. Specific corollary of "don't artificially constrain". |

---

## 9. § Cross-source state — updated for 7-source corpus

### 9.1 Promotion-eligible NOW (3+ distinct speakers — strong rules)

These can be lifted to firm playbook rules, not just observations:

- **Leave detailed targeting / suggested-audience mostly blank** — Ben + Charlie + Moonlighters
- **Don't artificially constrain audience** — Ben + Charlie + Moonlighters
- **Consolidate to one prospecting campaign** — Ben + Charlie + Moonlighters
- **Audience controls are hard; everything else is a suggestion** — Ben + Charlie (now also Moonlighters' explicit handling of the exclusion-as-now-hard nuance)

### 9.2 Promotion-eligible NOW (2+ distinct speakers — strong but single-corroboration)

- Ad copy structure: callout + agitation + benefit + scarcity + CTA — Jared + Ben (cross-lane)
- Don't fragment campaigns/adsets — Ben + Charlie + Moonlighters → now 3 speakers
- Get-out-of-learning is paramount — Ben + Charlie
- Start simple, add complexity later — Ben + Charlie
- AI generates options, human filters — Jared + Ben (cross-lane)
- Stop testing audience permutations — Ben + Charlie
- **Conversions API is mandatory** — Ben + Moonlighters (NEW from this video)
- **Default placement = leave Meta to choose** — Ben + Moonlighters (NEW from this video)
- **Auto-translate off if can't fulfill** — Ben + Moonlighters (NEW from this video)
- **Don't restrict minimum age unless legal** — Ben + Moonlighters (NEW from this video)

### 9.3 Single-speaker — high priority to corroborate next

- **🆕 Adset min-spend = 1× target CPA on new packs** (§3) — Moonlighters only. **Highest priority** because it potentially resolves the Ben-vs-Charlie testing conflict.
- **🆕 Attribution settings (7d click / 1d engaged / 1d view)** (§4) — Moonlighters only.
- **🆕 Exclusion-list-now-hard UI behavior** (§5) — Moonlighters only. Time-stamped platform fact.
- **Avatar + Concept pack discipline** (§2) — Moonlighters only. Operational pattern; corpus-novel.
- **Retention ad menu (evergreen + sale + new products + upsell/downsell)** (§1) — Moonlighters only. First retention-content prescription in corpus.
- **Retargeting campaign as optional based on audience-breakdown data** (§1) — Moonlighters only.
- **Auction overlap mechanism** (`_youtube__13s-G9Uj51A` §1) — Ben only.
- **Don't kill the top-funnel ad** (`_youtube__13s-G9Uj51A` §2) — Ben only.
- **Performance goal trap** (`_youtube__dAJyqo6wnq4` §8) — Ben only.
- **Profit_volume / blended outcome** (`_youtube__E_wZJhuSK5U` §3, §5) — Charlie only.
- **Test purpose = improve weakest ad in control** (`_youtube__E_wZJhuSK5U` §2) — Charlie only.
- **Low-budget rule (everything in one adset)** (`_youtube__E_wZJhuSK5U` §10) — Charlie only.

### 9.4 ⚠️ New tension introduced

**`further limit reach` toggle:**
- Ben (×2 articulations): beginner default = don't use it. `_youtube__dAJyqo6wnq4` §11.
- Moonlighters (this video §6): advanced winner-amplification = use it deliberately with one adjacent interest.

Not a strict contradiction — different operator-skill contexts — but the eventual playbook must preserve the nuance, not pick a side.

### 9.5 Testing methodology conflict — third path emerges

Three approaches now in the corpus:
- **Ben:** Meta's Creative Testing tool (separate testing infra).
- **Charlie:** in-campaign control + test adsets.
- **Moonlighters (NEW):** in-campaign new pack with min-spend = 1× target CPA forcing fair share.

The Moonlighters approach **structurally resembles Charlie's** but **mechanistically solves the same problem Ben uses the Creative Testing tool for** (new-creative-gets-starved). This is the closest the corpus has come to a unified answer. Recommend the eventual Optimizer:
1. Default to Moonlighters' approach for high-spend accounts ($1K+/day).
2. Fall back to Charlie's low-budget rule (everything in one adset) for sub-threshold accounts.
3. Reserve Ben's Creative Testing tool for *deliberate* per-creative attribution comparisons, not as the default testing method.

This is a **proposal**, not yet a rule — needs user sign-off.

---

## 10. Things I deliberately did NOT extract

- **`[03:20]`–`[03:42]`, `[12:50]`–`[13:00]`, `[13:08]`–`[13:25]`** — three plugs for school.com/fas community + themoonlighters.com agency. Drop entirely.
- **`$66K/month → $100K/week` client claim** `[00:39]` — unverified third-party testimonial. Drop as a metric; keep "$35M managed in 6 months" as speaker-context only.
- **"M3 method" / "M4 method"** as branded names. Use the structural shape (prospecting CBO + retention + optional retargeting + avatar/concept packs), not the brand label.
- **"We have early access beta"** name-drop `[06:22]`. Useful only as context for the attribution recommendation, not as a corpus-citable fact.
- **"You are doomed" colour language** — keep the *what* (CAPI is mandatory), drop the rhetoric.

---

## 11. Open questions deferred to user

1. **Promote the 3-speaker claims now?** — 4 claims have hit the 3-distinct-speaker threshold (§9.1). Want me to lift them out of the per-source learnings and into a real `playbooks/` file, or wait until we have enough lanes to commit to the skill-pack structure?
2. **Min-spend = 1× target CPA as the testing-conflict resolver?** — §9.5 proposes the Moonlighters approach as the default, with Charlie + Ben methods as documented alternatives. Need your call before treating this as the corpus's answer.
3. **`further limit reach` policy** (§6) — keep both Ben's beginner-default and Moonlighters' advanced-amplification framings in the eventual playbook, or pick one as the canonical guidance?
4. **Platform-state facts** (§5 — exclusion-list-now-hard) — these need a different lifecycle than operator rules (Meta UI changes constantly). Want me to maintain a separate `_dream_context/marketing/platform-state.md` with timestamped facts, distinct from the playbooks?
5. **CAPI as a hard prerequisite** — now 2-speaker (Ben + Moonlighters) and both extreme on it ("you are doomed" + Ben's "you're going to need it no matter what"). Want the eventual Optimizer to refuse to ship a Sales/Leads campaign that lacks verified CAPI installation, full stop?
