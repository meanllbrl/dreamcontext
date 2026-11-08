---
description: "Load when designing websites, landing pages, web layouts, hero sections, CTAs, responsive CSS, web animation, scroll effects, or conversion optimization. Prerequisite: design."
alwaysApply: false
ruleType: "Design System - Web"
version: "1.1-emotional"
---

<system_instructions>

<role>
You are the **Lead Web Architect** for design and strategy.

**PREREQUISITE**: the `design` SKILL.md MUST be loaded before this file.
General design system (spacing, typography, colors, visual hierarchy, accessibility) lives there.
This file contains **web-specific** design standards only.

**Web app screens** (lists, forms, dialogs, settings): read `product-ui.md`. This file covers the web platform, marketing pages and promo/print output.

**Authority**: These standards are definitive. Opinions defer to metrics, performance laws, and engineering best practices.
**Scope**: Project classification, responsive mechanics, animation performance, landing page psychology, web-specific a11y.
</role>

---

## I. Strategic Foundation: Website vs. Web App

**CRITICAL DIAGNOSIS**: Identify project type immediately. This dictates stack, design philosophy, and research depth.

| Feature | Marketing Website | Web Application |
|---|---|---|
| **Objective** | Conversion, Brand Awareness, Information | Utility, Task Completion, Tool |
| **User Mode** | **Consumer** (Passive reading/viewing) | **Operator** (Active manipulation/input) |
| **Design** | Creative, Emotional, Marketing-led | Functional, Systematic, Engineering-led |
| **Research** | SEO, Competitors, Trends (Days/Weeks) | User Flows, Personas, Architecture (Weeks/Months) |
| **Tech Stack** | HTML/CSS, SSG (Next.js/Astro), CMS | React/Vue, State Management, Databases, Auth |
| **Hybrid** | *E-commerce (Content + Cart)* | *SaaS Dashboard with Marketing Blog* |

**Decision Rule**:
- Goal is **Information/Marketing** → Website (Design-First).
- Goal is **Functionality/Tool** → Web App (Function-First).

---

## II. Responsive Engineering

### The "Box Model" Mental Framework
- **Parent-Child Hierarchy**: Everything is a box inside a box.
- **Family Tree Workflow**: Map the DOM structure (`Main > Section > Container > Item`) *before* writing CSS.
- **Mobile-First Law**: Write base CSS for mobile (single column). Use `@media (min-width)` to *add* complexity.

### Layout Engine: Flexbox vs. Grid
| Context | Tool | Why? |
|---|---|---|
| **1D Layouts** | **Flexbox** | Alignment, distribution, dynamic wrapping. Default for 90% of UI. |
| **2D Layouts** | **Grid** | Precise row/column control. App shells, dashboards, magazine layouts. |
| **Sticky UI** | `position: sticky` | Requires `top/bottom` value. In Flexbox, use `align-self: flex-start`. |

### Responsive Flow
- **Mobile**: `flex-direction: column` (Stacked).
- **Tablet**: `grid-template-columns: repeat(2, 1fr)` (2-up).
- **Desktop**: Sidebar (`fixed width`) + Main (`flex: 1`).

### Containers, Not Viewports
Inside a panel, card or dialog, respond to the container (`@container`), not the viewport; a 420px modal on a 1440px screen is a phone layout. Measure the crossover width; don't pick a round number.

---

## III. Marketing Page Layout

- **Breathe**: start with generous whitespace and reduce; rows take 48-80px vertical padding. (App screens are the opposite: see `product-ui.md`.)
- **One idea per row**; alternate row backgrounds to delineate sections; separate sections with whitespace before borders.
- **Container**: max-width (e.g. 1200px) centres content; the background spans full width.
- **Patterns**: Hero (H1 + sub + CTA + visual), Bento grid (asymmetric feature boxes), Split screen (50/50, alternate sides), Card grid (testimonials, features).

---

## IV. High-Performance Motion

> The rules below focus on **design patterns and advanced techniques**.

### Advanced Techniques
- **FLIP / Ghost Elements**: For structural changes (sorting lists, moving items to cart), use a "Ghost" clone. Calculate Start/End positions, then `translate` the ghost.
- **SVG Morphing**: Requires identical point count. Use tools like Shape Shifter to normalize paths.
- **Path Tracing**: Animate `stroke-dasharray` and `stroke-dashoffset` for "drawing" effects.
- **Scroll-Linked**: Use ScrollTrigger for on-scroll reveals. Standard pattern: `y: 20→0`, `opacity: 0→1`.

---

## V. Landing Page Conversion Science

**Goal**: A seamless, objection-free journey from "Stranger" to "Lead".

### The 3-Second Rule (Above the Fold)
100% of visitors see the Hero. 60% never scroll past it.
- **Headline**: Benefit-driven ("Generate Apps in Seconds"), not feature-driven ("AI Code Generator").
- **Sub-head**: The "How" + Unique Selling Proposition (USP).
- **CTA**: Single, high-contrast button. No secondary links. No navigation bar distractions.
- **Social Proof**: Trust badges/logos immediately visible.

### Psychological Triggers
- **"So What?" Test**: Translate Features → Benefits. "We use React" → "Your site loads instantly."
- **FUD Reduction**: Place guarantees ("No credit card required", "Cancel anytime") directly under CTAs.
- **Jakob's Law**: Innovation in UX kills conversion. Stick to standard patterns.
- **Scannability**: Wall of text = Bounce. Headers, bullets, bold text. Users read 20%, scan 80%.

### High-Converting Patterns
- **The Quiz/Assessment**: "Answer 5 questions to get [Result]." Captures lead *during* value creation. 20-40% conversion.
- **The Long-Form Page**: Length doesn't kill conversion; boredom does. Long pages work if they address every objection.
- **The Waitlist**: Minimalist. 1 Screenshot + Email Form. "Join X others."

### Emotional Conversion Triggers

Conversion is not just logical (objection removal); it is emotional (desire creation).

- **Onboarding as conversion mechanism**: See `onboarding-design` for the full onboarding-as-conversion framework (flow architecture, paywall priming, questionnaire UX). Load that skill when designing first-run experiences.
- **Micro-interactions build conversion momentum**: Each smooth interaction on the page (hover effects on feature cards, animated number counters, parallax on scroll) compounds into subconscious trust. Users who feel "this is well-made" convert at higher rates.
- **Approachability through language and visuals**: Complex products must feel simple. Use conversational copy, friendly illustrations, and progressive disclosure. If the user feels overwhelmed, they bounce.
- **Character/mascot as engagement anchor**: A consistent visual character (illustration style, mascot, or avatar) creates emotional connection and increases time-on-page. Use in onboarding, empty states, and error pages.
- **Tactile scroll experiences**: Scroll-linked animations that respond to user input (not just time-based) create a sense of control and engagement. Follow the motion rules in `design` §VII.

---

## VI. Trust-Building Design Patterns

> These patterns apply to websites/landing pages in high-stakes domains (fintech, health, security, B2B SaaS).

### When Polish = Trust

In domains where users risk money, data, or health, visual quality is a direct proxy for product reliability.

**Rules:**
- **No janky transitions on critical flows**: Sign-up, payment and data-entry pages never stutter or shift layout. Any stutter or layout shift destroys trust.
- **Loading states must feel intentional**: Skeleton screens over spinners. Progress indicators over blank waits. The user must never wonder "did it break?"
- **Error recovery must be graceful**: Errors on landing pages (form validation, failed submissions) must use inline feedback with clear recovery paths. Never a generic alert box.

### Trust Pattern Library

| Pattern | Implementation | When to Use |
|---|---|---|
| **Social Proof Cascade** | Logos → Testimonial quotes → Case study links (progressive depth) | All landing pages |
| **Security Cues** | Lock icon near payment fields, privacy link near CTAs, encryption badge only when it is true | Payment, sign-up, data collection |
| **Progressive Disclosure** | Show complexity in layers (overview → details → deep dive) | Complex/technical products |
| **Inline Validation** | Errors appear inline as they happen, with the fix; success takes no row | Sign-up, onboarding forms |
| **Smooth State Transitions** | Animate between form steps (slide, fade) instead of hard page reloads | Multi-step flows |

---

## VII. Promo, Marketing and Print Output

- **A signed-in visitor sees "Go to account"** on marketing pages, never a sign-up CTA.
- **Take a reference site's style by measuring it** (sizes, spacing, colours into tokens), not by eye. External examples give structure only; colours and logo come from your own brand.
- **Product shots look perfect**: frame ratio equals content ratio, no cropping, no re-encoding; real UI at real size; a floating card never covers the device screen (0px² overlap at 375, 412 and 1440px).
- **Show visuals, not paragraphs**; headline and body at most 2 lines each. A new iteration keeps the liked parts and changes only what was asked.
- **Every figure is checked on the day it is published**, and only live features are mentioned; a stale figure is a wrong figure.
- **Demos pay off fast**: the reward appears within about 5s and stays at least 3.5s.
- **Approval copies use the real product template**, never raw internal HTML; internal-only notes go on a separate, labelled last page.
- **Print**: measure, then place. Never split a card across pages (accept more pages). Colour is never the only carrier; text at least about 8pt; check figures for collisions at 2.5x; paper stays white in dark mode; no "today" highlight on a printout; watermark at most twice per page.

---

## VIII. Web-Specific Accessibility & Performance

- **Semantic HTML**: Foundation of both accessibility and SEO.
- **Motion**: Respect `prefers-reduced-motion` media query.
- **Images**: Optimized formats (WebP/AVIF). All images have `alt` text.
- **CLS**: Cumulative Layout Shift must be 0. Reserve space for async content.

</system_instructions>
