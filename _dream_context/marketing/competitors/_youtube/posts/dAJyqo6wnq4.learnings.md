---
source: _youtube__dAJyqo6wnq4
url: https://www.youtube.com/watch?v=dAJyqo6wnq4
speaker: Ben Heath (same speaker as `_youtube__JLlcwojiVtw`; "$200M over 12 years, 3,000+ clients")
runtime: 66:41
type: end-to-end Meta ads tutorial — Business Manager → campaign → adset → ad → publish
lane: paid-ad-account-ops
foundational_reference: true
status: draft
evidence_strength: same-speaker-second-video · high-credibility-source
source_weight_note: |
  Live walk-through inside Ads Manager UI from start to finish. The most
  comprehensive single source in the corpus to date — defines the foundational
  vocabulary (3-level structure, objective taxonomy, controls vs suggestions,
  performance goal vs campaign objective, etc.) that the other paid-ad-account-ops
  sources assume.

  SAME-SPEAKER CAVEAT: this is Ben Heath's SECOND video in the corpus. The two
  videos cannot be counted as 2 sources for cross-source corroboration — they are
  two articulations of the same operator's worldview. Each video adds new
  tactical surface, not new evidence. Honest source count for paid-ad-account-ops
  remains: 2 distinct speakers (Ben + Charlie), 3 videos total.

  Heavy self-promotion of "Meta Ads Mentorship Program" used as the demo offer
  throughout. The structural setup IS extractable; the specific landing page,
  testimonials, and product references are NOT.
promotion_rule: "Each tactic stays as 'observation' until ≥2 DISTINCT speakers independently confirm it. Multiple Ben videos do not satisfy this requirement."
lane_distinction: |
  Same lane as `_youtube__JLlcwojiVtw` (Ben Heath, video 1) and
  `_youtube__E_wZJhuSK5U` (Charlie). This video is the foundational
  reference within the lane — when a future playbook needs to define
  what "campaign objective" means, this is the citation.
---

# Learnings — `_youtube__dAJyqo6wnq4` (foundational reference)

> Lane: **paid-ad-account-ops · foundational reference**. Every claim cites a verbatim transcript quote with timestamp. Same-speaker caveat: this is Ben Heath's 2nd video — claims here only count once toward cross-source corroboration alongside `_youtube__JLlcwojiVtw`.

---

## 1. Three-level campaign structure (canonical vocabulary)

> "There are three levels to a campaign. You've got the campaign level, and then within that, you've got ad sets, and then within ad sets, you've got ads. And each one of those stages is responsible for different things… around what people see, but also who sees it, various settings, budgets, etc." `[07:36]`

**Pattern shape (canonical for the eventual skill):**

| Level | What it controls |
| --- | --- |
| **Campaign** | Buying type · Campaign objective · Campaign-level budget · Bid strategy · Special ad categories |
| **Adset** | Conversion location · Performance goal · Pixel/event · Adset-level budget · Audience (controls + suggestions) · Placements |
| **Ad** | Identity (page/IG) · Format · Destination URL · Creative (image/video) · Copy (primary text / headline / description / CTA) · AI enhancements · Tracking pixel check |

**Implication for the eventual Strategy Optimizer:** every recommendation must specify which level it acts on. "Add a value rule" lives at the adset; "change the campaign objective" lives at the campaign; "rotate creative" lives at the ad. No level-ambiguous recommendations.

---

## 2. Buying type — auction, not reservation

> "Auction is just the cost of your Facebook and Instagram ads is going to be determined by simple market forces, demand and supply… Reservation, you can actually guarantee a certain price, often a lower price." `[08:25]`
> "In order for Meta to be able to guarantee that lower cost, they are going to put your ads in front of lower quality prospects, or lower quality ad placements. The better quality ad impressions are usually seen through auction, and that's a big deal. So, I'd recommend you go with auction." `[09:07]`

**Anti-pattern:** picking reservation because the CPM is lower. Pattern shape: cheaper CPM ≠ cheaper customer.

---

## 3. Campaign objective taxonomy

Six options; the choice determines what downstream options exist.

| Objective | When (per Ben) |
| --- | --- |
| **Awareness** | Big-budget brand. Beginners avoid. Exception: high-ticket/expertise services using "omnipresent content" strategy. |
| **Traffic** | Beginner trap. Use only if conversions cannot be tracked (third-party site etc.). |
| **Engagement** | Use cases exist; not for beginners. |
| **Leads** | Sales funnel where conversion is *off-website* (call booking, contact form, instant form). |
| **Sales** | Sales funnel where purchase happens *on website*. |
| **App promotion** | Have an app → use; otherwise don't. |

**Quoted rule on Meta's literal optimisation:**
> "Meta's optimization system is very literal. So, if you say to Meta, 'I want as many link clicks as possible.' Meta is very good at finding people that are likely to click. But those people don't necessarily go on to convert." `[11:18]`

**Decision tree extracted:**
- Off-website conversion (calls, forms, quotes) → Leads
- On-website purchase → Sales
- Forced into Traffic only when neither is trackable

---

## 4. Budget — daily over lifetime

**Verbatim:**
> "I prefer daily budgets. With a lifetime budget, you end up with a fixed-length campaign… Meta is going to spend your money to try and get you as many of your result… over that time period. So, your spend might be quite lumpy." `[15:30]`
> "If you want to run a campaign longer, you don't want to after the 7-day lifetime campaign have to create a new one and Meta go back through the learning phase." `[16:14]`

**Budget-amount heuristic (verbatim):**
> "Set a budget that you could afford to lose… But on the other hand, you don't want to spend a budget amount that is so small that you don't care about it at all… there's often a sweet spot where you could afford to lose that money and it wouldn't be disastrous, but it would sting a little. That's normally a sweet spot where you're really actively in there." `[16:34]`

**Pattern shape:** `daily_budget = max(can_afford_to_lose, would_sting_to_lose)`. No universal number — *"For some businesses, that's going to be $10 a day. For others, it's going to be $5,000 a day."* `[17:43]`

---

## 5. Bid strategy — highest volume default

> "Highest volume is the default. That's exactly what I want to go with here because that will determine how Meta optimizes the campaign… we set this up as a leads campaign and we want the highest volume of leads as possible." `[18:00]`

Cost-per-result goal and bid cap: explicitly *not* for beginners.

---

## 6. Special ad categories — must select if applicable

> "If your ads fall into any of these categories… financial products and services, employment, housing, social issues, election or politics, then you have to select that that's the case." `[18:39]`
> "If you don't and then you go ahead and run ads anyway, a good chance not only your ads will be rejected, but your whole ad account can get disapproved." `[19:11]`

**Implication for Strategy Optimizer:** before any campaign-create recommendation, agent must ask the operator whether the offer falls in any restricted category. False answer here → ad account disapproval, not a recoverable error.

---

## 7. Conversion location options (adset level)

> "Within this audience section… you can generate leads either via your website or via instant forms… [also] Messenger… Instagram… WhatsApp… calls." `[19:46]` `[21:48]`

**Geo nuance corroborates Ben's other video §8:**
> "WhatsApp's a lot more prevalent in certain parts of the world than others, that might be a really good way to go where you can start a chat on WhatsApp." `[22:05]`

For Tilki (Türkiye context): WhatsApp click-to-chat as a conversion location is plausibly higher-leverage than Ben's UK-default suggests. Still flagged for TR-specific corroboration before promoting.

---

## 8. 🚨 Performance goal trap — NEW critical anti-pattern

The most actionable single guard in the video.

**Verbatim:**
> "I talked earlier at the campaign creation stage about how important the campaign objective is in getting that right. You can still mess up a good campaign objective selection with a bad performance goal." `[22:35]`
> "Don't say maximize number of landing page views or link clicks. If you do that, it's going to run just like a traffic campaign, and you'll get lots of clicks, lots of landing page views, probably not many leads, not many sales. Don't go with daily unique reach. That's going to run just like an awareness campaign… So, you can mess things up by selecting one of these other goals." `[25:50]`

**Pattern shape extracted:** within a Leads or Sales campaign, the performance goal must remain `maximize number of conversions` (or `maximize value of conversions` for differing-LTV services). Any other choice silently downgrades the campaign to its lowest-fidelity equivalent.

**Implication for Strategy Optimizer:** this is a hard guard. The agent should refuse to ship a campaign config where `objective ∈ {leads, sales}` AND `performance_goal ∈ {landing_page_views, link_clicks, daily_unique_reach, impressions}`. No override. Single-source for now, but extremely actionable — promote to `playbooks/account-ops-anti-patterns.md` on first corroboration.

---

## 9. Maximize number vs maximize value

> "If you're advertising multiple services, then it might be that one service, if someone goes on to convert, they're worth $200 to your business. Whereas with another service, if they go on to convert, they're worth $5,000 to your business… If you go with maximize value of conversions, then Meta is going to not just try and get as many conversions as possible, but optimize and weight it in favor of the more valuable conversions." `[23:27]`

**Decision rule:**
- Single offer / equally-valuable leads → maximize number of conversions.
- Multiple offers / differing LTVs → maximize value of conversions.

**Prerequisite (verbatim):** *"You're going to need to make sure that you've got all the tracking set up properly. So, you're going to need to have the Meta pixel installed and the values of each lead being sent back to Meta."* `[24:00]`

---

## 10. Pixel + CAPI prerequisite

> "If you're sending people to your website… you're going to need to have the pixel installed properly… I've also got videos on conversions API, which is something else that's recommended from a tracking standpoint." `[24:20]`

**Strategy Optimizer rule:** before recommending a Sales or Leads campaign with website conversion location, the agent must verify the pixel + CAPI are installed and the relevant conversion event is firing. Without that, the campaign will silently degrade.

---

## 11. Targeting model — controls (hard) vs suggested audience (soft)

The most important model-shift in modern Meta targeting.

**Verbatim:**
> "Within this audience section, we have two main categories. We've got controls, and we've got suggested audience. The difference between these two sections is that anything set within the control section is a hard constraint, a hard boundary… Whereas anything added in this suggested audience section is a suggestion. You're basically giving Meta's targeting algorithms an indication of who you think should see your ads… but at the end of the day, it's up to Meta to either go with people within that targeting criteria or find other people." `[28:01]`

**Hard controls (small, deliberate set):**
- Location (the only one most operators set)
- Minimum age (18–25 only — for legal-restriction cases)
- Custom audiences (warm/excluded lists)
- Languages (only when service truly is language-bound)

**Soft suggestions (give Meta direction, don't constrain):**
- Age range (give your core demographic, e.g., 30–55)
- Gender (only if 90%+ skewed)
- Detailed targeting (interests/behaviors)

**Anti-pattern (verbatim):**
> "You can click on further limit the reach of your ads, and then get really specific with the targeting, and basically say to Meta, 'No, I only want to target these people.' Not something I'd recommend for most beginners. It overcomplicates it, and typically, we see better results now by giving Meta direction, and letting Meta's machine learning algorithm work it out, as opposed to us advertisers trying to have too much specific control." `[36:14]`

**Anti-pattern — artificial constraint:**
> "If you sell products nationally in the UK, don't go, 'Oh, I'm only going to advertise in London because people in London are wealthier'… Meta will work that out. And if your best prospects are in a certain location, more of your ad spend will be spent there." `[31:09]`

---

## 12. Local-business location tip — deselect "reach more people interested in your selected cities"

> "We'll also show ads to people interested in your selected cities and regions in those countries… A lot of local businesses find that they'll generate leads from people that have perhaps traveled to that location, but if you're a roofer, that's not overly helpful because you're not going to be able to serve those people that live halfway across the country. So, a lot of local businesses want to deselect this, even if Meta pops up a warning saying you're likely to see worse results. 6.7% lower cost per result if you select it. Yeah, but what's the point of having a lower cost per lead if you can't service those leads." `[31:52]`

**Pattern shape:** `lower CPL ≠ better CPL` when leads can't be serviced. Strategy Optimizer must factor service-area constraints into the targeting recommendation.

---

## 13. Placements — default-all for leads/sales, deselect Audience Network for traffic

> "If you are using a leads campaign or a sales campaign, just leave it as is. Basically, let Meta run ads on all placements because they're only going to put your ads on those placements that Meta thinks are going to get you the result that you've asked for." `[37:31]`
> "If, however, you are forced to run a different campaign objective, like traffic, because you cannot track the leads or sales that you generate, then I do think you want to become more specific, and the obvious option is just to get rid of the Audience Network. Because what you don't want is for Meta to put your ads on the placement options that are lower quality, less likely to lead to a conversion, but that's exactly what Meta will do if you're not optimizing for a conversion, because those placements are cheaper." `[37:48]`

**Pattern shape extracted:** placement default is conditional on objective. With a properly-tracked Leads/Sales objective, leave all 24 placements + 5 platforms enabled. With a fallback Traffic objective, deselect Audience Network specifically.

---

## 14. Manual upload vs Advantage+ catalog

> "We're going to go ahead and use manual upload. Advantage plus catalog ads, again, slightly more of an advanced thing… if you are an e-commerce business and you want to run… you have a catalog, you want to run ads using a catalog, this is a great way to go, particularly for retargeting warm audiences." `[41:09]`

For e-commerce + product-catalog retargeting → Advantage+ catalog. Otherwise → manual upload.

---

## 15. Aspect ratios — square + vertical, horizontal least important

> "Most of your ad impressions are going to be from a square ad format or a vertical ad format. Square's typically going to be used for things like the feeds… Vertical's going to be things like stories, reels across both platforms." `[47:21]`

**Best practice (verbatim):**
> "In an ideal world, what you would do is you would either crop, if possible… or you would replace it with a different image that is specifically designed and formatted for that aspect ratio." `[47:51]`

**Pattern shape:** every paid ad ships with at least square (1:1) + vertical (9:16) source files. Horizontal optional.

**Fallback:** Meta's image-expansion AI fills missing ratios. Works for product imagery; struggles with people-in-the-image.

---

## 16. 🔗 Ad copy framework demonstration — CROSS-LANE CORROBORATION OF JARED

The most important cross-source moment in the corpus to date.

**Verbatim ad copy used:**
> "Tired of wasting money on Facebook ads that don't deliver? We'll mentor you daily to explode your revenue. Limited spots available. Apply now and transform your ad game." `[50:25]`

**Ben's annotation (verbatim — he names the boxes ticked):**
> "We're highlighting the problem and calling out the target audience with the first sentence. Tired of wasting money on Facebook ads that don't deliver? So, anyone that is suffering from that problem is likely to pay attention to the rest of the ad. It also is sort of agitating that problem, re-emphasizing… Then, we've got we'll mentor you daily to explode your revenue. So, we've got a feature what's involved in this? Oh, it's a daily mentorship, gotcha. To explode your revenue, great. It's exactly what I do. I really want exploded revenue. So, there's a benefit associated. Limited spots available, introducing scarcity. Apply now and transform your ad game. And there's a call to action." `[50:46]`

**Boxes ticked (Ben's enumeration, in 4 sentences):**
1. Audience callout
2. Problem agitation
3. Feature
4. Benefit
5. Scarcity
6. CTA

**Cross-lane mapping to Jared's 4-pillar framework (`_youtube__ooF7rNBYAog` §1):**

| Ben's box (paid-ad-account-ops) | Jared's pillar (paid-ad-creative) |
| --- | --- |
| Audience callout | Connection (to ICP) |
| Problem agitation | Emotion (pain side) |
| Feature + Benefit | Curiosity (close the gap) |
| CTA | (sale-close primitive) |

**Why this matters:** two distinct speakers, two different lanes, both confirming the same underlying ad-copy architecture (callout → agitation → benefit → urgency → CTA). This is the corpus's first **multi-lane** corroboration. The eventual `playbooks/copy-formulas.md` can be promoted from "single-source observation" to "established rule" on the strength of this cross-confirmation alone.

---

## 17. Up-to-5 primary text + 5 headline variants per ad

> "We've got primary text we've got here one of five. So, you can have up to five different options… absolutely fine just to go with the one if you just want to get started, you can always add other ones in later on. But, a good idea to test multiple options cuz it just increases the chance that A, you'll find an option that works really well, and B, it gives Meta more flexibility." `[53:18]`

**Persona-targeted variants (verbatim):**
> "Meta's going to use AI to generate text alternatives, and they're going to do that, you can see here, tailor variations to personas. So, they've come up with three different personas that they think like basically avatars… ambitious entrepreneurs, digital marketers, and small business owners. So, Meta's like, look, if we think that someone in your target audience is an ambitious entrepreneur, we're going to put this primary text in front of them." `[52:01]`

**Operator-as-filter rule (verbatim — corroborates Jared on AI):**
> "My recommendation with everything AI generated, copy, imagery, is absolutely use it, but you need to be the filter as the advertiser cuz sometimes it's going to be great, you can just use it. Other times, some of the suggestions are not going to work at all, you can't use them. Sometimes it's going to be a hybrid where you go, well, that's kind of good, but does need a little bit of this changing." `[52:30]`

**Pattern shape:** ship 1–5 variants per slot; use AI-generated as drafts; human-curate before publish.

---

## 18. CTA button — pick the verb that names the next step

> "What I'd recommend here is you just go with the option that best describes what it is you want people to do. Like, what's the next step?… Don't overthink it." `[55:30]`

Examples (verbatim): Learn more · Contact us · Schedule a call · Get quote · Shop now.

**Pattern shape:** CTA button mirrors the destination's primary action verb. Single-source but uncontroversial.

---

## 19. AI image variations — operator-as-filter, person-vs-product

> "When you're using people in your ads, particularly if you that needs that person needs to be the same person involved like it is here, less so. But, when I did this video a year ago, it didn't come up with any versions of me at all. So, we just couldn't use this use any of the AI generated images. Now, we can. You can see this is improving all the time." `[57:10]`

**Pattern shape:**
- Product imagery → AI variations work well (different backgrounds/scenes).
- Person-fronted creative → AI variations risky; usually filter all out except those that preserve identity faithfully.

---

## 20. Creative enhancements — 10 toggles, with overrides

10 enhancement options Meta auto-recommends per ad. General rule (verbatim):
> "I would err on the side of trusting Meta with this. Highly incentivized to improve stuff to help us get better performance." `[62:01]`

**Specific overrides Ben names:**

| Toggle | Default | Ben's recommendation | Reason |
| --- | --- | --- | --- |
| Enhanced media text (replace text on image) | Off | **Keep off** | Unpredictable; can break message |
| Translate text | Off | **Keep off if you can't fulfil in those languages** | Drives unservice-able leads |
| Enhanced CTA | Off | Keep off | (Ben: "happy with that") |
| Ad overlays (text overlays) | On | **Turn off if image is already text-heavy** | Doubled-up text |
| Visual touch-ups | On | Leave on | Meta's good at this |
| Add music | On | Leave on (or customise) | Corporate jingle, low-risk |
| Text improvements (Meta moves text between fields) | On | Leave on unless copy structure breaks when fields swap | Generally helpful |
| Adapt multi-image format | On | Leave on | Low impact |
| Add animation | On | Leave on | Low impact |
| Flex media (use any aspect ratio anywhere) | On | Leave on | Meta picks best ratio per placement |

**Pattern shape:** 10-toggle review every campaign. Default to trust; override only with named reason.

---

## 21. Tracking sanity check at ad level

> "Just basically come down and just check that the pixel is actually here and that that's the right pixel. You can check the ID based on what you've set up. I've seen issues go down." `[63:42]`

**Strategy Optimizer rule:** the publish gate must verify pixel ID matches the data-set defined at the adset level. Mismatch → silently broken tracking → silently broken optimisation.

URL parameters for cross-platform analytics (e.g. GA): optional, beginner-overkill.

---

## 22. Review timing & campaign-structure starter

**Review (verbatim):** *"Meta's normally going to take a bit of time to review the ad… Normally takes about 30 minutes, but particularly with your first ads could take a while more."* `[64:54]`

**Starter structure (verbatim):**
> "What I demonstrated here is one campaign, one ad set, one ad, although there are a few variations of things like primary text, headlines, and the images themselves within that ad. And that is absolutely fine to get started with… You can make things really complicated should you wish to later on. But let's keep it simple to start with… As you go on, you're going to want to add other things, probably other campaigns with things like different services, different product ranges, certainly different ads to be able to test different creatives." `[65:30]`

**Pattern shape extracted:**
- Phase 1 (start): 1 campaign × 1 adset × 1 ad (with multiple primary-text + headline + image variants).
- Phase 2 (volume earned): add adsets and creatives (per Charlie's low-budget rule and Ben's 20-creatives-per-adset post-Andromeda guidance).
- Phase 3 (different services/products): separate campaigns.

**This is the bridge to Charlie's structural escalation ladder** (`_youtube__E_wZJhuSK5U` §10): same shape, different framing.

---

## 23. § Cross-source state — updated for 4-source corpus

### 23.1 New corroborations introduced by this video

| Claim | Sources | Status |
| --- | --- | --- |
| **Ad copy structure: callout + agitation + benefit + scarcity + CTA** | Jared (paid-ad-creative §1, §3) + Ben (this video §16) | **2 distinct speakers, 2 different lanes → cross-lane corroboration. PROMOTABLE.** First true cross-lane confirmation in the corpus. |
| **AI generates options, human curates** | Jared (paid-ad-creative §4 anti-pattern on ChatGPT-only) + Ben (this video §17, §19, §20) | **2 distinct speakers, 2 different lanes → near-rule.** |
| **Targeting controls are hard; everything else is a suggestion** | Ben (×2 videos) + Charlie (`_youtube__E_wZJhuSK5U` §7, §10) | **2 distinct speakers → near-rule.** |
| **Don't artificially constrain audience** | Ben (this video §11–12) + Charlie (similarity-beats-scale §7) | **2 distinct speakers → near-rule.** |
| **Start simple, add complexity later** | Ben (this video §22) + Charlie (low-budget rule §10) | **2 distinct speakers → near-rule.** |
| **WhatsApp as conversion channel is geo-dependent** | Ben (this video §7) + Ben (other video §8) | **Same speaker — does NOT graduate.** Still single-speaker. Needs a non-Ben source. |

### 23.2 Same-speaker self-corroborations (do NOT count toward promotion)

- Creative testing tool (Ben video 1 §5 ↔ this video §22 mention)
- Hybrid retargeting / no-separate-retargeting (Ben video 1 §6 ↔ this video §22 implicit)
- Audience suggestions vs hard controls (Ben video 1 §1 value rules ↔ this video §11 in detail)
- Creative volume guidance (Ben video 1 §3 — this video doesn't reach the 20+ rule, only mentions multiple variants)

These are all **same speaker re-articulating** — useful for stitching the playbook together, NOT additional evidence.

### 23.3 Conflict status (unchanged — testing methodology)

The Ben-vs-Charlie testing-methodology conflict from `_youtube__E_wZJhuSK5U` §12.2 is **not resolved** by this video. Ben mentions creative testing here but defers it as advanced (`[62:21]`). Conflict remains open until a 3rd distinct speaker breaks the tie.

### 23.4 Updated promotion table

| Claim | Distinct speakers | Promote to |
| --- | --- | --- |
| Audience controls hard / suggestions soft | 2 (Ben + Charlie) | `playbooks/targeting.md` — promote on next corroboration |
| Don't fragment campaigns/adsets | 2 (Ben + Charlie) | `playbooks/campaign-topology.md` — promote on next corroboration |
| Get-out-of-learning is paramount | 2 (Ben + Charlie) | `playbooks/budget-tiers.md` — promote on next corroboration |
| Start simple, add complexity later | 2 (Ben + Charlie) | `playbooks/account-ops.md` — promote on next corroboration |
| Don't artificially constrain audience | 2 (Ben + Charlie) | `playbooks/targeting.md` — promote on next corroboration |
| **Ad copy structure: callout/agitation/benefit/scarcity/CTA** | **2 cross-lane (Jared + Ben)** | **`playbooks/copy-formulas.md` — eligible for promotion now (cross-lane bonus)** |
| AI as drafts not authority; human filter | 2 cross-lane (Jared + Ben) | `playbooks/copy-formulas.md` AI-handling section — promote on next corroboration |
| Performance goal trap | 1 (Ben only — this video §8) | `playbooks/account-ops-anti-patterns.md` — single-source but extremely actionable. **Highest-priority single-source claim to corroborate next.** |

---

## 24. Things I deliberately did NOT extract

- **Meta Ads Mentorship Program references** (his own paid offer, used as the demo subject ~10×). The structural example is keepable; the specific URL, testimonials, and pricing pitches are not.
- **"I have a video about that on my channel" callouts** — referenced ~15× across the runtime. All dropped.
- **Specific landing page URLs** (`admasters365.com` and the mentorship offer page).
- **Client-result testimonials** quoted in his ad creative ("8x ROI in 3 weeks", "$29K with 7.3x ROI", "30€/day to 100K month") — these are unverifiable third-party claims used as proof in his ad, not corpus-extractable rules.
- **"For demonstration purposes I'll select X" disclaimers** — narrative scaffolding, not insight.
- **Business Manager admin/people-management walkthrough** (`[05:40]`–`[06:42]`) — table-stakes for any operator already in Ads Manager; out of scope for the marketing skill.
- **Step-by-step UI navigation prose** ("click here, then click there") — captured only when it anchors a non-obvious decision, not as full transcription.

---

## 25. Foundational-reference flag — what this video gives the eventual skill

Because this is the only end-to-end walkthrough in the corpus, mark it as the **canonical reference** for these vocabulary items the future Optimizer will need to define:

- "Campaign", "Adset", "Ad" (with what each level controls)
- "Buying type" (auction vs reservation)
- "Campaign objective" (the 6-option taxonomy)
- "Performance goal" (vs campaign objective — distinct concept)
- "Conversion location"
- "Dataset / Pixel / CAPI / Conversion event"
- "Targeting controls" vs "suggested audience"
- "Custom audience" (warm vs excluded)
- "Detailed targeting" (interests/behaviors as suggestions)
- "Placement" (5 platforms × 24 placement options)
- "Identity" (page/IG account that shows on the ad)
- "Manual upload" vs "Advantage+ catalog" vs "Existing post"
- "Format" (single image / video / carousel / collection)
- "Aspect ratio" (1:1 square, 9:16 vertical, 1.91:1 horizontal)
- "Primary text" vs "Headline" vs "Description" vs "CTA button" (the 4 copy slots)
- "Creative enhancement" (Meta's 10-toggle AI assist surface)
- "Special ad category" (the 5 restricted categories)

When the future skill needs to teach the operator (or onboard the agent) these terms, this video is the citation. Other videos can then assume the vocabulary.

---

## Promotion checklist (updated for 4-source corpus)

**Eligible for promotion now (cross-source criteria met):**
- [ ] **Ad copy structure (callout/agitation/benefit/scarcity/CTA)** — 2 distinct speakers across 2 lanes. Promote to `playbooks/copy-formulas.md`.

**Need 1 more distinct speaker to promote:**
- [ ] Targeting controls hard / suggestions soft
- [ ] Don't fragment campaigns/adsets
- [ ] Get-out-of-learning is paramount
- [ ] Start simple, add complexity later
- [ ] Don't artificially constrain audience
- [ ] AI as drafts not authority; human filter

**Single-source but highest-priority to corroborate next:**
- [ ] **Performance goal trap (§8)** — extremely actionable; one corroboration → promote to `playbooks/account-ops-anti-patterns.md`.

**Single-source observations from this video (lower priority):**
- [ ] 3-level structure (canonical vocabulary; treat as foundational baseline)
- [ ] Buying type = auction (uncontroversial; promote on first co-mention)
- [ ] Campaign objective taxonomy (canonical baseline)
- [ ] Maximize value vs maximize number (LTV-conditional)
- [ ] Local-business "deselect interest-based reach" tip
- [ ] Placement default conditional on objective
- [ ] Manual upload vs Advantage+ catalog
- [ ] Up-to-5 primary text/headline variants
- [ ] Creative enhancement 10-toggle review
- [ ] Pixel ID sanity check at ad level

## Open questions deferred to user

1. **Cross-lane promotion** — ad copy structure now meets the 2-source criterion but spans 2 lanes (Jared paid-ad-creative + Ben paid-ad-account-ops). For this specific claim, do you want to (a) promote it to a shared `playbooks/copy-formulas.md` that both lanes import, or (b) duplicate it in each lane's playbook?
2. **Performance goal trap as a hard guard** — if you accept this as a single-source-but-load-bearing rule, want me to flag it for a hard-block in the eventual Strategy Optimizer's pre-publish check?
3. **Foundational-reference status** — confirm this video should be treated as the canonical vocabulary citation; future learnings files can then say "see `_youtube__dAJyqo6wnq4` §X" instead of redefining terms.
