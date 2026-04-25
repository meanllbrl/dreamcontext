---
source: _youtube__JLlcwojiVtw
url: https://www.youtube.com/watch?v=JLlcwojiVtw
speaker: Ben Heath (well-known Meta ads YouTuber; runs the paid "Ben Heath Inner Circle" coaching program)
runtime: 18:31
type: Meta Ads Manager mechanics + media-buying tactics (post-Andromeda)
lane: paid-ad-account-ops
status: draft
evidence_strength: single-source · high-credibility-source
source_weight_note: |
  Named, established operator demonstrating live inside Ads Manager. References
  current Meta product features (value rules, creative testing tool, creator
  marketplace, post-Andromeda creative volume guidance). Two sponsor sections
  ([05:45]–[07:18] for "Holo" + [14:14]–[14:48] for his own Inner Circle) were
  excluded. The non-sponsor 80% is the highest-density Meta-mechanics source
  in the corpus to date.
promotion_rule: "Each tactic stays as 'observation' until ≥2 other corpus sources independently confirm it. Then promote to a future paid-ad-account-ops playbook."
lane_distinction: |
  This source is in a THIRD LANE separate from `_youtube__ooF7rNBYAog`
  (paid-ad-creative — what to put IN an ad) and `_youtube__HwO7g5uHHYY`
  (organic-dm-funnel — comment-trigger DM systems). This lane is about
  Meta Ads Manager mechanics: account structure, audience definition,
  bid mechanics, testing infrastructure, campaign topology. The same
  operator may run all three lanes; the patterns must NOT be cross-mixed
  when distilling. Final skill-pack shape (one skill / multiple sections vs
  sibling skills) deferred until each lane has 3+ corroborated sources.
---

# Learnings — `_youtube__JLlcwojiVtw`

> Lane: **paid-ad-account-ops** (NOT creative strategy, NOT organic). Every claim cites a verbatim transcript quote with timestamp. Single-source = **observation**, not yet **rule**. Source credibility is *high* for Meta platform mechanics specifically.

---

## 1. Value rules — soft bid-multiplier targeting (would feed → future `playbooks/targeting.md`)

The mechanic that lets you bias delivery toward valuable segments without hard-restricting the audience.

**Verbatim claim:**
> "value rules… allow you to have the best of both worlds when it comes to targeting… you can have open targeting and the full flexibility that Meta wants… but give it direction towards your most valuable prospects or customers." `[00:22]`

**Path inside Ads Manager (verbatim walkthrough):**
> "Advertising settings → Value rules → Create a rule set → Select my criteria [conversion location, age, gender, etc.] → select… age ranges above 35 → select by how much I want to increase my bid… add in 30 in here." `[00:50]`

**Worked example given:**
- Customer data shows age 35+ is 30% more valuable.
- Set value rule: bid +30% on age 35+.
- Result: *"Meta will continue to advertise to people that are both over 35 and under 35, but it is going to favor the people that are over 35 — be willing to pay more in the auction to reach those people."* `[01:49]`

**Pattern shape extracted:**
`[Audience analysis identifies a segment with measurably higher LTV / CVR / AOV]` → `[Value rule: bid lift % ≈ measured value lift %]` → `[Keep targeting open; let Meta auction-favour the segment without restricting reach]`.

**Why this matters for the Strategy Optimizer:** any time the operator says "I think X demographic converts better," the agent should propose a value rule, not a hard targeting constraint.

---

## 2. Audience segment definitions (would feed → future `playbooks/account-setup.md`)

Meta splits reach into three buckets — **new audience / engaged audience / existing customers** — but only if you tell it which is which.

**Setup steps (verbatim summary of what's shown):**
- Upload customer list → mark as "existing customers" in Advertising settings.
- Define engaged audience as "all website visitors 180" (180-day window) + email-list-not-customers + people who engaged across Meta apps. `[02:52]`

**Two payoffs (verbatim):**
> "it allows Meta to better allocate budget across cold, warm, and hot audience" `[03:10]`
> "you also able to see in breakdown data… the split of spend, but also where your results are coming from. How many of our purchases are coming from existing customers versus from new audience?" `[03:18]`

**Implication:** any account ops audit should check: (a) is a customer list uploaded, (b) is engaged audience defined with a sensible window (180-day used here), (c) is the operator reading breakdown data per segment.

---

## 3. Creative volume — 20 per adset, was 6 (would feed → future `playbooks/creative-volume.md`)

The single most-quoted Meta creative-strategy shift post-Andromeda.

**Verbatim claim:**
> "We now aim for 20 different ad creatives per adset. We used to be limited to six. That's what Meta used to recommend. But post Andromeda, things have really changed. Meta is now prioritizing creative diversity." `[03:42]`

**Two reasons given:**

a) **Personalised delivery (Andromeda capability):**
> "they're not going to put the same ads in front of everyone. They're not going to work out from your six ads previously, this is the best performer. Let's put that in front of everyone. Instead, they're going to work out, this person's probably going to be more interested in this ad, but this person's probably going to be more interested in this ad." `[04:00]`

b) **Slower fatigue:**
> "If someone sees the same ad seven or eight times, even in a 2 or three day period, they might get pretty bored of it… But if you've got lots of different ads and Meta is showing one ad in the morning, a different ad in the afternoon, different ad the next morning…" `[04:39]`

**Tactical follow-throughs (verbatim):**
- Don't make it all video: *"video is the best performing ad format for most advertisers, but we want to make sure we've got a range of formats live at any one time."* `[05:09]`
- Use Meta's own AI variation suggestions: *"when you're uploading your imagery to the ad platform… Meta is often going to use AI to suggest variations of that image. By all means, take advantage of those."* `[05:30]`

**Numeric anchors:** `was 6 → now 20`, `7–8 impressions to fatigue (per individual)`.

---

## 4. Partnership ads — creator-co-signed paid ads (would feed → future `playbooks/creator-partnerships.md`)

Ads run from both your account and a creator's account simultaneously — paid amplification of influencer content.

**What it is (verbatim):**
> "ads that are run from both your account and a creator's account… It's effectively influencer marketing but not reliant on the organic distribution of their posts, but you could actually put budget behind it and advertise and run it to their audience." `[07:25]`

**Four named benefits:**

| # | Benefit | Verbatim |
| --- | --- | --- |
| 1 | Creative production at scale | *"a quick and easy way to produce a lot more ad creative because you're not doing it yourself"* `[07:54]` |
| 2 | Hook-rate boost | *"if you work with the right people and they have influence over your target market, they have scroll stopping power. People are more likely to pay attention, so your hook rate improves. That's a big deal that should not be underestimated."* `[07:59]` |
| 3 | Recommendation weight | *"their recommendation carries weight… if it's someone that is respected in your space, people are more likely to do it as opposed to that recommendation coming from someone they don't know or from someone within your company"* `[08:11]` |
| 4 | Brand-by-association | *"if you work with creators over an extended period of time, the creators that you work with, people will start to associate with your business and your business will take on the values and the things that people think about those creators. Means you need to pick well in the first place"* `[08:27]` |

**Heuristic — quotable trade rule:**
> "If you take 10% of your advertising budget, for example, and pay that to creators, but that creator makes your ad campaign 40% more effective, that's a great trade. You should do that every time. And I see that come up again and again." `[09:12]`

**Path inside Ads Manager:**
> "all tools → creator marketplace… Meta even gives recommendations around the creators most relevant for you." `[09:36]`

**Pattern shape extracted:** `[Creator who actually has authority with your ICP]` × `[Paid amplification beyond their organic reach]` → bypasses three of the four ad-psychology pillars (attention via scroll-stop power, ICP-connection via the creator, emotion via parasocial trust). Only "curiosity gap" still has to come from the creative itself.

---

## 5. Creative testing tool — fix for "new ad gets zero spend" (would feed → future `playbooks/testing.md`)

The native fix for a problem most operators hack around with separate test campaigns.

**Problem statement (verbatim):**
> "A lot of advertisers are running into problems where they upload new ad creative, add that into an existing adset, and it just gets no ad spend whatsoever, and it feels pointless, like a complete waste of time. The existing best performers just continue to get all the ad spend." `[10:13]`

**Anti-pattern explicitly called out:**
> "I've seen advertisers do all sorts of things with like separate campaigns and testing setups. It can get very complicated very quickly. You can end up with fragmented data. Not the way to go." `[10:28]`

**The fix — Creative testing tool path (verbatim):**
> "ad level → scroll down… click on setup test. And you can test two to five different ads simultaneously. You can tell meta how much of your budget you want to spend on this test, how long you want this test to run, and then what do you want to compare performance?" `[10:53]`
>
> "Meta will segment out your audience into five different chunks and make sure they don't overlap. So you can properly test to see ad creative A, how does it perform against ad creative B." `[11:30]`

**Critical config detail (verbatim — this is where most operators get it wrong):**
> "I would absolutely recommend changing from say cost per post engagement to something like cost per lead or cost per purchase or whatever it is that you're actually optimizing for in a campaign. That might mean you need to add in extra time, extra budget to make it work, etc." `[11:07]`

**Default-comparison-metric trap:** the tool defaults to a vanity metric (post engagement). Manual override to the real conversion metric is mandatory or the test outcome is meaningless.

**Speaker's framing:** *"Not many advertisers know about it. Even fewer use it."* `[11:55]`

---

## 6. Hybrid retargeting — no separate retargeting campaign (would feed → future `playbooks/campaign-topology.md`)

The most counter-intuitive tactic in the video, with a clear mechanistic argument.

**Verbatim claim:**
> "Strategy number six is to not use a separate retargeting campaign or even a separate retargeting adset. Instead, we like to combine the two and run a hybrid so your ads are being delivered to a combination of warm and cold audiences." `[11:59]`

**The mechanistic reason (verbatim):**
> "no matter how you set up your targeting, it is very likely that Meta is going to target a mixture of cold and warm audiences anyway… most of your targeting inputs are suggestions. When you set up an adset to be a warm audience adset, you add in your warm audiences, your custom audiences as targeting, but you do so as a suggestion in the suggest an audience section as opposed to within… the hard targeting constraints." `[12:14]`
>
> "If you're targeting more open, more cold audiences, Meta is absolutely going to find your warm audiences. Those are the people that are most likely to engage with your ads. Those are the people that Meta will quickly identify as most likely to purchase." `[13:12]`

**Quotable maxim — learning-phase math:**
> "One ad campaign producing 50 conversions a week is much better than two ad campaigns producing 25 conversions a week because getting out of the learning phase, you're not being caught in learning limited. Meta has more data to optimize. You have more data as the advertiser to be able to assess things and make optimization decisions." `[13:46]`

**Caveat (verbatim — keeps this from becoming an absolute):**
> "there are circumstances where we do [retarget separately]." `[14:08]`

**Pattern shape extracted:** `[Default = single hybrid campaign with warm + cold]`. `[Separate retargeting only when there's a specific reason — to be enumerated as the corpus grows]`.

---

## 7. Barbell pricing — avoid the middle (would feed → future `playbooks/offer-design.md`)

A pricing-strategy claim about which businesses Meta ads scale for.

**Verbatim:**
> "focus your initial acquisition on free/inexpensive products or services or go to the other end of the spectrum and go high price point, premium luxury, high ticket, hightouch sales process. I think the mid-range is often the hardest particularly to scale." `[14:51]`

**Reasoning given:**
- Mid-range = where most competitors are → hard to differentiate. `[15:08]`
- Mid-range economics: *"high enough price where people want a bit more than something just easy automated, but you don't really make enough money from them to be able to justify an elongated sales process."* `[15:38]`
- Free/cheap end = give-something-easy-to-deliver (tripwire). High end = unit economics cover all the high-touch sales process.

**Strength of evidence (verbatim hedge):**
> "the more I've seen businesses that are outliers that really succeed with their meta ads, the more they tend to fall into one end or the other" `[15:53]`

**Caveat:** this is the speaker's pattern observation, not a measurement. Treat as a *hypothesis the agent should ask the operator about*, not a rule to enforce.

---

## 8. WhatsApp funnels — location-dependent click-to-WhatsApp (would feed → future `playbooks/funnel-channels.md`)

**Verbatim setup:**
> "Strategy number eight is to embrace WhatsApp and use it as part of your meta marketing funnels. Now, this is going to be location dependent to some extent. In the US, for example, people use WhatsApp a lot less than just about everywhere else in the world, but if your target audience is on WhatsApp regularly, then definitely experiment with a WhatsApp-based salesfunnel." `[16:18]`

**Friction-reduction case (verbatim):**
> "previously people would click come through to a landing page book in a call or inquire. They then get contacted by the company to arrange a call. A lot of friction, slow process. How much easier is it for your prospect to just click on an ad, go straight into WhatsApp, send a few messages and those initial messages are all automated and people are filtered depending on, you know, you can find out whether they actually are a qualified lead or not." `[16:48]`

**Geo cheat-sheet (per Ben):**
- US: low WhatsApp penetration → not yet, but he predicts 5–10 year window. `[17:54]`
- UK: WhatsApp better for **high ticket**, not low ticket. `[17:41]`
- India / Brazil: WhatsApp works for **anything, including low ticket**. `[17:48]`

**Note for our context (Tilki / Türkiye):** WhatsApp penetration in Turkey is closer to the India/Brazil pattern than the US one. This tactic is plausibly more applicable here than Ben's UK examples imply. Flag for follow-up — needs a Turkey-specific corroborating source before promoting.

---

## 9. Anti-patterns lifted out of the transcript (would feed → future `playbooks/account-ops-anti-patterns.md`)

Direct rejections, bundled here so they can be enforced as guards in the agent:

| # | Anti-pattern | Verbatim trigger |
| --- | --- | --- |
| A1 | Hard age/interest targeting when value rules would do the same job | "You don't need to have this trade-off between hard constraints but small audience versus open targeting." `[02:05]` |
| A2 | Skipping the audience-segment definition step | implied — without it, Meta can't allocate budget across cold/warm/hot, and breakdown reports lose the segment lens. |
| A3 | 6 creatives per adset post-Andromeda | "We used to be limited to six… But post Andromeda, things have really changed." `[03:47]` |
| A4 | Adding new ads to an existing adset and expecting fair share of spend | "it just gets no ad spend whatsoever, and it feels pointless." `[10:18]` |
| A5 | Running the creative testing tool with the default "cost per post engagement" metric | "I would absolutely recommend changing from say cost per post engagement to something like cost per lead or cost per purchase." `[11:07]` |
| A6 | Separate retargeting campaign as a default | "We rarely have separate retargeting campaigns." `[14:03]` |
| A7 | Mid-priced offer scaled via paid Meta | "the mid-range is often the hardest particularly to scale." `[15:08]` |
| A8 | Booking-call funnel where prospects could just message you | implied throughout the WhatsApp section — "slow and… cumbersome and… friction and people are busy." `[17:21]` |

---

## 10. Numeric anchors (for promotion-checklist verification later)

Pull these out separately so they can be cross-checked when other sources land:

- **Creative count per adset:** was 6, now aim 20. `[03:42]`
- **Bid lift example for value rules:** +30% for 30%-more-valuable segment. `[01:32]`
- **Creator partnership economics:** 10% of budget → 40% campaign efficiency = good trade. `[09:12]`
- **Learning-phase math:** 1 campaign × 50 conv/wk > 2 campaigns × 25 conv/wk. `[13:46]`
- **Engaged audience window:** 180-day site visitors. `[02:59]`
- **Creative testing tool capacity:** 2–5 ads simultaneously, non-overlapping audience. `[10:55]`

---

## 11. Things I deliberately did NOT extract

- **`[05:45]–[07:18]` — sponsor read for "Holo" creative tool.** Pure paid placement. The creative-volume claim from §3 stands on its own outside the sponsor wrapping; nothing else from this section was lifted.
- **`[14:14]–[14:48]` — self-promo for the Ben Heath Inner Circle.** Drop entirely.
- **The "Andromeda" name** as a citable thing. Used here as a reference to Meta's algorithmic update; the speaker doesn't define it precisely. The patterns above (creative diversity, personalised delivery) are what we extract — not the brand name of the update.
- **Specific Holo features** ("paste website URL → batches of hooks/angles/formats…"). Out — sponsor-only.
- **"Most advertisers don't know about it" claims.** Treat as colour, not data.

---

## Promotion checklist (when 2+ more sources land in this lane)

- [ ] **Value rules** as the default targeting bias mechanism (§1) — need 1+ corroboration.
- [ ] **Audience segment definitions + breakdown reading** (§2) — likely a baseline practice; corroborate then promote as account-setup checklist item.
- [ ] **20+ creatives per adset** (§3) — need ≥2 more sources confirming the post-Andromeda volume shift before this becomes a hard recommendation.
- [ ] **Partnership ads — 4 benefits + 10/40 trade rule** (§4) — corroborate the trade-rule heuristic specifically; the four benefits are easier to confirm.
- [ ] **Creative testing tool + override-the-default-metric trap** (§5) — promote the default-metric trap with even one corroboration; it's load-bearing.
- [ ] **Hybrid retargeting + learning-phase math** (§6) — most counter-intuitive tactic; need ≥2 confirmations before pushing it as a default in the optimizer agent.
- [ ] **Barbell pricing** (§7) — speaker himself hedged; treat as a *question the agent asks the operator*, not a recommendation, until corroborated.
- [ ] **WhatsApp funnels by geo** (§8) — Turkey specifically needs a TR-context source before this becomes a recommendation in the Tilki context.

## Questions deferred to user

1. Confirm the **third lane** (`paid-ad-account-ops`) is real and worth its own playbook section — or should it merge with `paid-ad-creative` into a single `paid-meta-ads` skill?
2. The **barbell pricing** claim (§7) intersects with Tilki product strategy decisions outside this skill's scope. Should the agent surface it as an "operator question" prompt, or stay silent on pricing?
3. **WhatsApp funnels for Turkey** (§8) — when we hit a TR-context source, will it carry enough weight on its own to override Ben's UK-specific high-ticket-only framing?
