---
title: "Meta Ads Account Ops Playbook"
lane: "paid-ad-account-ops"
status: "draft — corpus-derived, not yet skill-pack ready"
speakers: 4 (Ben Heath, Charlie/Disruptor Academy, Edward/Moonlighters, Optimizer/anon)
videos: 6 (JLlcwojiVtw, E_wZJhuSK5U, dAJyqo6wnq4, 13s-G9Uj51A, FYUR8ZL4_xY, TMOfiSdx7Tg, kuSq-pmNfnM)
updated: "2026-04-25"
blocker: "skill-packs/ generation blocked on user decision #1 (lane consolidation/split)"
---

# Meta Ads Account Ops Playbook

Rules lifted directly from the ingested corpus. Each rule cites its sources. Strength tier is derived from distinct-speaker count (not video count — same speaker across N videos = 1 voice).

**Source key:**
- Ben = `_youtube__JLlcwojiVtw` + `dAJyqo6wnq4` + `13s-G9Uj51A` + `kuSq-pmNfnM` (4 videos, 1 voice)
- Charlie = `_youtube__E_wZJhuSK5U` (1 video, 1 voice)
- Moonlighters = `_youtube__FYUR8ZL4_xY` (Edward, 1 video, 1 voice)
- Optimizer = `_youtube__TMOfiSdx7Tg` (anon, 1 video, 1 voice)

---

## Tier 1 — Firm Rules (3+ distinct speakers)

These rules have cross-source corroboration strong enough to ship as operator defaults. Do not override without explicit user instruction.

### 1. Consolidate to one prospecting campaign

**Rule:** Run the majority of prospecting spend inside a single Advantage Plus campaign. Avoid splitting by audience segment, creative type, or funnel stage unless there is a hard business reason (separate country spend caps, distinct product lines with incompatible conversion windows).

**Why:** Meta's delivery algorithm learns from conversion signals. Spreading budget across multiple campaigns or adsets fragments the signal pool, slows exit from the learning phase, and creates audience overlap where Meta targets the same people from multiple campaigns competing against each other.

**Sources:** Ben (`dAJyqo6wnq4` §1, `JLlcwojiVtw` §1), Charlie (`E_wZJhuSK5U` §2), Moonlighters (`FYUR8ZL4_xY` §1)

---

### 2. Leave detailed targeting blank — don't constrain the audience

**Rule:** By default, leave interest targeting and detailed targeting fields empty or as broad as possible. Do not segment adsets by audience type (interest A vs interest B, cold vs warm) unless you are deliberately using the interest-winners method (see open conflict §2).

**Why:** Meta's delivery now treats targeting inputs as suggestions, not hard boundaries. Tight audience constraints don't isolate your audience — they restrict Meta's ability to find buyers it would have found on its own. Audience overlap between tightly-defined adsets is rampant.

**Exception (unresolved):** Moonlighters' "interest-winners" method uses one adjacent interest on a winner adset combined with `further limit reach`. This conflicts with Ben's default. See Open Conflicts §2.

**Sources:** Ben (`dAJyqo6wnq4` §2, `JLlcwojiVtw` §2), Charlie (`E_wZJhuSK5U` §3), Moonlighters (`FYUR8ZL4_xY` §2)

---

### 3. Snow-globe rule — 3–5 day minimum cadence between optimization moves

**Rule:** After any significant change (new adset, new creative batch, budget change), wait at least 3–5 days before making another structural change. Read results only after the system has settled.

**Why:** Every structural change re-enters (or extends) the learning phase. Making moves daily means you're always reading data from a system that hasn't converged yet. The snow-globe analogy: shaking it again before the snow settles tells you nothing about the picture.

**Sub-rule:** Do not optimize on data from the first 24–48 hours of a new creative or campaign — early delivery skews heavily toward retargeting audiences, not cold prospecting.

**Sources:** Ben (`dAJyqo6wnq4` §6), Charlie (`E_wZJhuSK5U` §5), Optimizer (`TMOfiSdx7Tg` §3)

---

## Tier 2 — Strong Near-Rules (2 distinct speakers)

Two-speaker corroboration. Treat as operator defaults, but lower confidence than Tier 1. Flag these for review if a third source contradicts.

### 4. Turn off by spend, not by ROAS — within an adset

**Rule:** Within a single adset, do NOT turn off ads solely because they have a lower ROAS than other ads in the same adset. Instead, turn off ads that Meta has stopped spending budget on.

**Why:** Meta sometimes uses lower-ROAS ads as top-of-funnel priming — it shows them first to warm people up, then delivers the conversion-focused ad. The top-funnel ad will look bad by ROAS alone. Killing it breaks Meta's internally constructed multi-touch sequence, causing the "winner" ad to drop off unexpectedly.

**Kill criterion:** `spend = 0` (or near-zero for multiple days) → turn off and replace.
**Leave-on criterion:** Meta is still allocating spend to it, regardless of its relative ROAS.

**Sources:** Ben (`13s-G9Uj51A` §2 + `kuSq-pmNfnM` §2 — two separate Ben videos, sharpened across both)

**Corroboration priority:** High. This is currently 1 voice (Ben ×2). Needs one more distinct speaker to become Tier 1.

---

### 5. CAPI + pixel — not either/or

**Rule:** Install both Conversions API (CAPI) and the Meta Pixel. They are not alternatives — they are complementary. CAPI covers server-side events that pixel cannot capture (ad blockers, iOS restrictions, delayed conversions). Running only one degrades the signal quality Meta's AI uses for optimization.

**Sources:** Ben (`JLlcwojiVtw` §3), Moonlighters (`FYUR8ZL4_xY` §4)

**Decision #5 resolved:** CAPI is a hard launch prerequisite — no override. See SKILL.md §hard constraints.

---

### 6. Default placement — let Meta choose

**Rule:** Use Advantage+ placements by default. Do not restrict to specific placements (Feed-only, Stories-only, etc.) unless you have a creative that is technically incompatible with a placement format.

**Sources:** Ben (`JLlcwojiVtw` §2), Moonlighters (`FYUR8ZL4_xY` §4)

---

### 7. Auto-translate off if you can't fulfill in that language

**Rule:** If you enable multi-language delivery, turn off auto-translate for any language you cannot service (support, onboarding, product UI). Showing ads in a language the product doesn't support burns budget and creates a broken first experience.

**Sources:** Ben (`JLlcwojiVtw` §4), Moonlighters (`FYUR8ZL4_xY` §4)

---

### 8. Don't restrict minimum age unless legally required

**Rule:** Leave the minimum age at platform default unless you have a legal requirement (alcohol, gambling, financial products) or have data proving the youngest age band is non-converting and not worth the impression cost.

**Sources:** Ben (`JLlcwojiVtw` §4), Moonlighters (`FYUR8ZL4_xY` §4)

---

### 9. Don't fragment — get out of learning fast

**Rule:** Every unnecessary split (extra adset, extra campaign, extra audience segment) delays exit from Meta's learning phase and creates a smaller per-unit budget, which means each unit takes longer to accumulate the 50 conversion events needed to exit learning. Default to fewer, larger units.

**Sub-rules (all Ben + Charlie):**
- Start simple, add complexity only when a simple structure is already profitable
- Stop testing audience permutations as the primary testing axis — audience is not the lever; creative and offer are
- Getting out of learning is the first optimization goal on any new campaign

**Sources:** Ben (`dAJyqo6wnq4` §3–§4), Charlie (`E_wZJhuSK5U` §4)

---

## Testing Methodology (resolved)

**Default:** Moonlighters — new adset with min-spend = 1× target CPA.

When testing a new creative pack or offer, create a new adset within the existing campaign. Set a minimum daily budget equal to 1× your target CPA. This spend floor ensures Meta actually delivers the new adset before deprioritizing it in favor of proven winners.

**Fallback hierarchy:**

| Context | Method |
|---|---|
| **Default** | Moonlighters: new in-campaign adset, min-spend = 1× target CPA |
| **Low budget** (min-spend floor is unaffordable) | Charlie: control adset + test adset, same campaign |
| **Need clean per-creative attribution** | Ben: Meta's native Creative Testing tool — isolated audience splits, separate from main campaign |

---

## Remaining Conflicts (surface to operator — not resolved)

### Conflict A — `further limit reach` toggle

| Position | Detail | Proponent |
|---|---|---|
| **Don't use it** | Broad is better for prospecting; restricting limits Meta's delivery window; beginner default should be off | Ben |
| **Use it for interest-winners** | After an interest-based adset proves itself, add one adjacent interest and enable `further limit reach` to focus delivery | Moonlighters |

**Not the same context.** Ben's advice is for general campaign setup. Moonlighters' advice is for a specific optimization move on a proven adset. These may not actually conflict — they may be stage-dependent. Do not collapse.

---

### Conflict C — Creative volume vs ad spam

| Position | Detail | Proponent |
|---|---|---|
| **20+ creatives per adset** | More creative diversity = more angles for Meta to test; give it as many signals as possible | Ben |
| **Ad spam breaks the system** | Too many creatives fragment budget per creative, prevent any single ad from accumulating enough signal to exit learning | Charlie |

**Proposed resolution (not confirmed):** The conflict is about *what kind* of variation. Ben's 20+ creatives are variations around a stable journey (same offer, same CTA, different hooks/formats). Charlie's "spam" is fragmentation that changes the customer journey across creatives. Variation within a consistent journey ≠ variation that fragments the funnel. User decision pending.

---

## Single-Speaker Claims — Pending Corroboration

These are high-priority signals from one distinct voice. Do not promote to rules until a second source confirms.

| Claim | Source | Priority | Notes |
|---|---|---|---|
| Adset min-spend = 1× target CPA on new packs | Moonlighters (`FYUR8ZL4_xY` §3) | Resolved | Adopted as testing default — see Testing Methodology section |
| Performance goal trap — wrong objective permanently mis-trains the algorithm | Ben (`dAJyqo6wnq4` §8) + mistakes-report-2026 | Resolved | Now a hard block gate in SKILL.md — no override accepted |
| Auction overlap mechanism — Meta auctions are per-impression; two adsets targeting the same person compete against each other in every auction | Ben (`13s-G9Uj51A` §1) | Medium | Supports consolidation rationale |
| Filter-by-row-selected preview trick — isolate one creative in Ads Manager to read its true delivery data | Optimizer (`TMOfiSdx7Tg` §4) | Medium | Pre-move check |
| Spend redistribution math — when you turn off an ad, its budget redistributes; know where it goes before killing | Optimizer (`TMOfiSdx7Tg` §5) | Medium | Pre-move check pair with above |
| Ad-level vs adset-level optimization decision matrix | Optimizer (`TMOfiSdx7Tg` §10) | Medium | Structural rule for eventual Optimizer agent |
| Profit_volume / blended outcome as the correct optimization target for scaling accounts | Charlie (`E_wZJhuSK5U` §7) | Medium | |
| Test purpose = improve the weakest ad in the control set, not find a new winner | Charlie (`E_wZJhuSK5U` §6) | Medium | Reframes testing intent |
| Low-budget rule — under a certain monthly budget threshold, don't run multiple campaigns at all | Charlie (`E_wZJhuSK5U` §8) | Medium | |

---

## What this file does NOT cover

- Creative production, hook formulas, UGC/influencer strategy → `meta-ads-creative-frameworks.md`
- Ad copy structure (callout/agitation/benefit/scarcity/CTA) → `copy-formulas.md`
- Competitor hook examples, Turkish copy rules → `meta-ads-creative-playbook.md` (user-maintained)
- Graph API operations, campaign launch guardrails → future `skill-packs/meta-marketing/` (blocked on lane decision)
