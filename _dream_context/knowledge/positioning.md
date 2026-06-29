---
id: know_b6Oj-A9y
name: positioning
description: Canonical product positioning and messaging rules
tags:
  - decisions
  - topic:branding
pinned: false
date: '2026-05-31'
---

# dreamcontext — Canonical Positioning

## Short (≤120 chars)

dreamcontext — the persistent brain for your AI agents. Remembers what you built, knows how your project works.

_Used in: package.json `description`, npm registry, one-line intro._

## Medium

dreamcontext — the persistent brain for your AI agents. It remembers what you've built, knows how your project works, and is learning to act on it.

_Used in: in-app copy, skill descriptions, one-sentence summaries._

## Long (README hero / 2–3 sentences)

dreamcontext is the persistent brain for your AI agents — and for you. It remembers every decision you made, knows how your project is structured, and is learning to act on that knowledge so that every session starts ready instead of blind. Built for founders and builders, technical or not, who are tired of watching their agent re-discover context it already had.

_Used in: README hero, landing page, pitch decks._

## Visual Identity — Violet + "Dream Gem" (2026-06-27)

The app rebrand shipped in the same cycle as the Sleepy Search/Ask view. Key identity elements:

- **Color:** Violet (`#9d8cff` primary accent). Consistent across the brand mark, query highlights, type-filter glyphs, and constellation animation.
- **Logo:** A folded-diamond "dream gem" glyph implemented as `BrandMark` (`dashboard/src/components/brand/BrandMark.tsx`). Replaced the prior circular mark. Used as the app icon, favicon, and the constellation center in the Sleepy idle view.
- **Wordmark:** Two-tone "dreamcontext" wordmark (light + violet); used in the sidebar header.
- **Sleepy persona:** "Sleepy" names the in-app assistant/mascot persona and the Search/Ask surface. The product remains "dreamcontext"; copy should read "dreamcontext's Sleepy" or just "Search." Do not rebrand the product as Sleepy.

The full visual specification lives in `core/3.style_guide_and_branding.md` (owned by sleep-state). This section records only the rationale and naming rules, not pixel-level details.

**Rationale:** The violet palette was chosen to differentiate the app from generic dev-tool grays while staying in the cool-tone space that reads as "intelligent system" rather than "enterprise tool." Violet carries the dream/memory semantic without being purple-for-purple's-sake. The folded-diamond mark is geometric (trustworthy, systematic) but has an organic fold (not purely mechanical). The two-tone wordmark keeps "dreamcontext" readable at small sizes where a logotype with equal-weight letters would blur.

## Rule: Roadmap Framing

The phrase "learning to act" and any variant of "act on it" describe the product **direction** — a roadmap commitment, not a shipped capability. This framing is intentional: it signals where dreamcontext is heading without overstating what is live today.

Do NOT use words that imply the agent acts independently without human direction (e.g. self-directed, fully-agentic, or similar). dreamcontext is a tool that augments human steering — it is not, and does not claim to be, a replacement for it. Any such framing in copy, READMEs, or skill files is a violation of this rule.
