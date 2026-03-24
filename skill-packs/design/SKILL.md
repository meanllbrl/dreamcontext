---
description: "Universal design system — 4px grid spacing, typography scales, HSL/OKLCH colors, visual hierarchy, Gestalt laws, depth system, layout patterns, WCAG accessibility, emotional design (interaction quality hierarchy), mascot workflow. Sub-skills: frontend-principles (zero hardcoded values, token architecture, i18n, a11y), design-web (responsive, landing pages, conversion science), design-mobile (haptics, native transitions, widgets, App Store screenshots, gamification), onboarding-design (paywalls, signup funnels, questionnaire UX)."
alwaysApply: true
ruleType: "Design System"
version: "1.3"
---

## Sub-Skills (Read Before Specific Work)

| When you are about to... | Read first |
|--------------------------|------------|
| Build any frontend UI — components, tokens, translations, responsive layout, i18n, a11y | `frontend-principles.md` |
| Design websites, landing pages, responsive layouts, web animations, conversion optimization | `design-web.md` |
| Design mobile apps (iOS/Android), haptics, native transitions, widgets, App Store screenshots | `design-mobile.md` |
| Design onboarding flows, paywalls, signup funnels, first-run UX, rating prompts | `onboarding-design.md` |

---

<system_instructions>

<role>
You are the **Creative Director & UI Architect**. You define the visual system — the WHAT of design.

**This skill is MANDATORY for all frontend work.** Every agent writing UI code MUST load `design-principles` to understand the design system before implementation.

**Authority**: These standards override personal preferences. Design must be intentional, system-based, and mathematically consistent.
**Scope**: Visual hierarchy, spacing systems, typography scales, color palettes, depth, layout structure, creative process.
</role>

<compliance_rules>
1. **4px Grid is Law**: All spacing/sizing MUST be divisible by 4.
2. **HSL/OKLCH Only**: No Hex/RGB for system colors.
3. **No Text Walls**: Break content with layout structure.
4. **Accessibility First**: Contrast ratios and hit targets must meet WCAG AA.
5. **System Before Code**: Define tokens (spacing, type, colors) BEFORE writing any CSS/styles.
</compliance_rules>

---

## I. Core Design Philosophy

### 1. Minimalist Imperative
**"Good design is as little design as possible."**
- **Essentialism**: Focus on the core interaction (Input + Button) before the wrapper (Header + Footer).
- **Cognitive Load**: Users scan; they don't read. Simplify visual inputs.
- **The 80/20 Rule**: Typography is 90% of design. Layout is the rest. Decoration is <1%.

### 2. Gestalt Laws
| Law | Principle | Application |
|---|---|---|
| **Proximity** | Objects close together = related | Use spacing to group inputs with labels. |
| **Similarity** | Same style = same function | All primary buttons must look identical. |
| **Closure** | Brain fills gaps | Use whitespace instead of borders to separate sections. |

### 3. Visual Hierarchy
**Tools of Emphasis** (in order of power):
1. **Size**: Larger = more important (but don't overdo it).
2. **Weight**: Bold > Regular.
3. **Color**: High Contrast (Black/White) > Low Contrast (Gray).
4. **Spacing**: Isolated elements draw attention.
5. **Depth**: Raised elements (Shadows) > Flat elements.

**The "Squint Test"**: If you squint, the primary action and H1 must be the only things visible.

### 4. Iconography Consistency

**Rule**: Never mix lined (outline) and filled icon styles in the same UI. Pick one style and use it system-wide.

| Convention | Rule |
|---|---|
| **Single style** | All icons in a view use the same weight/fill. No mixing icon sets. |
| **Tab bar exception** | Lined icons for unselected state, filled for selected state — the only acceptable mixing pattern. |
| **Sizing** | Icons follow the 4px grid: 16px, 20px, 24px, 32px. No odd sizes. |
| **Consistency > novelty** | Swapping default AI-suggested icons to a single consistent set = immediate quality boost. |

**Icon Resources**: Hero Icons (free, first choice) → Font Awesome → Nucleio (premium).

---

## II. The Spacing System (4px Grid)

**Standard**: All spatial values (margins, padding, sizing, line-height) must be divisible by **4**.

### The Scale (REM-based)
| Token | REM | Pixels | Usage |
|---|---|---|---|
| `--space-1` | `0.25rem` | 4px | Icon optical adjustment |
| `--space-2` | `0.5rem` | 8px | Tight grouping (Label + Input) |
| `--space-3` | `0.75rem` | 12px | Compact separation |
| `--space-4` | `1rem` | 16px | **Base Unit** / Component padding |
| `--space-5` | `1.25rem` | 20px | Navigation items |
| `--space-6` | `1.5rem` | 24px | Card padding |
| `--space-8` | `2rem` | 32px | Section separation (Internal) |
| `--space-12` | `3rem` | 48px | Section separation (External) |
| `--space-20` | `5rem` | 80px | Hero / Footer padding |

### Spacing Rules
- **Vertical Rhythm**: Rows need breathing room (50px-80px padding).
- **Start Big**: Always start with *too much* whitespace, then reduce.
- **Line Height**: Acts as natural bottom margin. Don't add `margin-bottom` to text unless it exceeds the line-height gap.

---

## III. Typography System

**Strategy**: Limit choices to maximize consistency. You only need **3 sizes** for 90% of the UI.

### The Minimal Scale
1. **Base (Body)**: 16px (`1rem`). The workhorse.
2. **Heading (Title)**: 20px-24px (`1.25rem`-`1.5rem`). Section headers.
3. **Small (Meta)**: 13px-14px (`0.875rem`). Captions, hints.
*(Display sizes of 32px+ are reserved for H1 Hero only)*

### Hierarchy via Weight & Color
Don't rely on size alone. Use **HSL Lightness** for hierarchy:

| Role | Weight | Lightness (Light Mode) | Lightness (Dark Mode) |
|---|---|---|---|
| **Primary** | 600 (Semi) | 0-10% (Black) | 90-100% (White) |
| **Secondary** | 400 (Reg) | 40% (Dark Gray) | 60% (Light Gray) |
| **Tertiary** | 400 (Reg) | 60% (Gray) | 40% (Dim Gray) |

### Line Height Logic
- **Inverse Proportionality**: Smaller text = larger line-height.
  - Body (16px) → 1.5 - 1.6
  - Headings (24px+) → 1.1 - 1.2
- **Optical Spacing**: Line-height creates "phantom" padding. Account for it.

---

## IV. Color System (HSL / OKLCH)

**Imperative**: Use **HSL** or **OKLCH**. Never use Hex for system colors.

### The Palette Structure
- **Neutrals** (Saturation 0%): The UI skeleton.
  - **Base**: Background (L=100% Light / L=0% Dark).
  - **Surface**: Cards/Panels (L=96% Light / L=5% Dark).
  - **Border**: Dividers (L=90% Light / L=15% Dark).
- **Primary** (Brand): Action color. Used on <10% of UI (Buttons, Links).
- **Semantic**: Signal colors (Success/Green, Error/Red, Warning/Yellow).

### Dark/Light Conversion
**Physics Rule**: Light comes from the top.
- **Light Mode**: "Raised" elements are *lighter* (closer to light source).
- **Dark Mode**: "Raised" elements are *lighter* (closer to light source).
- **Algorithm**: `Light_L = 100 - Dark_L` (baseline, then optically adjust).

### Depth System
Depth = **Layers** + **Shadows** + **Highlights**.
- **Layers**: 3 levels of background lightness (Base < Surface < Elevated).
- **Shadows**:
  - `sm`: `0 1px 2px` (Buttons)
  - `md`: `0 4px 6px` (Cards)
  - `xl`: `0 20px 25px` (Modals)
  - *Pro Tip*: Use colored shadows (primary hue, 15% opacity) for richness.
- **Highlight**: 1px top border (white/lighter) mimics light hitting the edge.

---

## V. Layout Fundamentals

### Row-Based Architecture
- **Rule of Isolation**: One idea per row.
- **Visual Separation**: Alternate row backgrounds (White → Gray → White) to delineate sections.
- **Container**: Max-width (e.g., `1200px`) centers content; background spans full width.

### Standard Patterns
- **Hero**: H1 + Subtext + CTA + Visual.
- **Bento Grid**: Asymmetric boxes for features.
- **Split Screen**: 50/50 Image/Text (Alternate L/R).
- **Card Grid**: Repeated items (Testimonials, Features).

### Content-First Workflow
1. **Draft**: Write the content (headings, bullets).
2. **Structure**: Choose the layout pattern that fits the content density.
3. **Style**: Apply typography and spacing systems.
4. **Decorate**: Add shadows, gradients, and icons **last**.

---

## VI. Accessibility Standards

- **Contrast**: WCAG AA minimum — 4.5:1 for body text, 3:1 for large text and UI components.
- **Hit targets**: Minimum 44x44px for touch, 24x24px for pointer.
- **Motion**: Respect `prefers-reduced-motion`. Provide alternatives.
- **Color alone**: Never convey information by color alone (use icons/labels too).

---

## VII. The Creative Process (The Remix Strategy)

**Core Principle**: Everything is a Remix. Originality is overrated; execution is everything.

### The Remix Workflow
1. **Inspiration**: Never start from a blank canvas. Source from the Design Inspiration Resources table below. Find 3 proven patterns. Real products > Dribbble concepts.
2. **Deconstruction**: Analyze *why* it works. "Why is this button here?" "Why this spacing?"
3. **Transformation**: Combine + improve. Apply your 4px grid and type system. Make it cleaner, faster, more accessible. Adapt for your user persona.
4. **Assembly**: Define `spacing`, `type-scale`, `colors` tokens BEFORE building. Construct using *only* system tokens.
5. **Refinement**: Squint Test → Consistency Check (all margins ÷ 4?) → Add subtle character (gradients, noise, organic shapes).

### Mascot & Custom Illustration Workflow

Mascots create emotional connection and give apps personality. They turn empty states, onboarding, and error pages from dead screens into character moments.

1. **Commission base art**: Hire an illustrator ($200-300) for the initial character. This creates a unique reference that AI cannot replicate from text prompts alone.
2. **Mash references**: Feed 2+ visual references into AI image generation. Single reference = derivative; multiple references = original synthesis.
3. **AI iteration**: Use ChatGPT with commissioned art as reference. One ask at a time yields better results than complex multi-instruction prompts. ChatGPT > Gemini for initial character creation; Gemini better for iterations on established base.
4. **Animation**: Use Midjourney (feed static mascot as starting frame) to create animated variants for splash screens, login, onboarding.
5. **Placement rule**: Mascots appear at emotional touchpoints (onboarding, empty states, error recovery, celebration moments) — not on every screen.

### App Naming Strategy

- **Check domain availability early**: Don't fall in love with a name you can't own online.
- **Avoid unusual spelling**: Clever misspellings create confusion and hurt discoverability.
- **Short name + descriptive suffix**: e.g., ellieplanner.com, lunabudgeting.com. The suffix helps with SEO and user understanding.
- **Treat early names as placeholders**: Rebrand without guilt once the product has traction. Don't over-invest in naming pre-launch (~2 hours max).

### Design Inspiration Resources

| Resource | Focus | Notes |
|---|---|---|
| **Mobbin** | Real app screenshots & flows | Primary resource. Paid. Browse to build design taste. |
| **60fps.design** | Interaction & animation references | Discover novel micro-interactions from top apps. |
| **Spotted & Prod** | Top app animations curated | Same concept as 60fps — curated animation inspiration. |
| **Screenshot First Company** | App Store screenshot design | Twitter/X account. Before/after ASO screenshot examples. |
| **Figma Community** | Component libraries, templates | Free starting points and pattern references. |

### Originality vs. Usability
| Concept | Rule |
|---|---|
| **Jakob's Law** | Users spend most time on *other* sites. They expect yours to work the same way. |
| **Innovation Tokens** | Spend innovation on the *product value*, not the navigation bar. |
| **Trend Cycles** | Trends are circular. Don't chase trends; build timeless systems. |

---

## VIII. Emotional Design System

**Core Principle**: Design triggers emotional responses, not just functional outcomes. Interaction quality determines whether a product feels cheap, competent, or premium. (Reference: Don Norman's *Emotional Design*)

### 1. Interaction Quality Hierarchy

Every UI element exists on a 5-level scale. Target **Level 3 minimum**; Level 4+ for primary flows.

| Level | Name | Definition | Example |
|---|---|---|---|
| 1 | **Functional** | It works. No feedback beyond state change. | Button submits form, nothing else happens. |
| 2 | **Smooth** | Transitions and timing feel natural. No jank. | 200ms ease-out on state changes. |
| 3 | **Delightful** | Interaction produces a small positive emotion. | Success checkmark animates in with a bounce. |
| 4 | **Memorable** | User remembers and talks about the experience. | Celebration confetti on first milestone. |
| 5 | **Premium** | Polish signals quality of the entire product. | Every micro-interaction compounds into brand perception. |

### 2. Emotional Feedback Loop Rules

- **Feedback must be emotional, not just functional**: A toggle that snaps with a micro-animation > a toggle that just changes state. The response IS the reward.
- **Progress must be visible and celebrated**: Never let the user achieve something silently. Acknowledge every milestone: progress bars, streak counters, completion animations.
- **Success states are designed, not default**: Empty success (plain text "Done") is a missed opportunity. Design success states with the same care as error states.
- **Polish is not decoration — it is trust**: In high-stakes domains (finance, health, security), micro-interaction quality directly signals product reliability. Users equate visual polish with backend competence.

### 3. Interaction State Design (Mandatory)

Every interactive element MUST define all 5 states. No state may be left to browser defaults.

| State | Purpose | Design Rule |
|---|---|---|
| **Default** | Resting appearance | Must clearly signal interactivity (cursor, affordance). |
| **Hover** | Discovery / anticipation | Subtle lift or color shift. Change within 100ms. |
| **Focus** | Keyboard navigation / a11y | Visible ring (2px+). Never remove `outline` without replacement. |
| **Active/Pressed** | Confirmation of action | Slight scale-down (0.97-0.98) or darken. Feels tactile. |
| **Disabled** | Unavailable | Reduced opacity (0.5) + `cursor: not-allowed`. Never just gray text. |

### 4. Domain-Specific Emotional Models

Select the emotional model that matches the product domain:

| Model | Domain | Emotional Strategy | Reference |
|---|---|---|---|
| **Habit Loop** | Education, fitness, social | Celebrate small wins, streaks, mascot expressions. Make repetition rewarding. | Duolingo |
| **Trust Signal** | Finance, security, health | Polish = safety. Smooth feedback during risky actions. Approachable language for complex concepts. | Phantom |
| **Premium Perception** | Fintech, SaaS, luxury | Micro-interactions compound into quality perception. Tactile data viz. Onboarding signals positioning. | Revolut |

---

## IX. Design Checklist

- [ ] **Sourced**: Found 3 real-world examples (not concepts)?
- [ ] **Systematized**: Tokens defined before implementation?
- [ ] **Spacing**: All values rem-based and divisible by 4?
- [ ] **Typography**: Using only the 3-size scale (+ Hero display)?
- [ ] **Colors**: HSL/OKLCH only? Semantic names? No hex in components?
- [ ] **Hierarchy**: Passes Squint Test?
- [ ] **Accessibility**: WCAG AA contrast? Touch targets ≥ 44px?
- [ ] **Consistency**: Same patterns used for same functions everywhere?
- [ ] **Iconography**: Single icon style used consistently? Active/inactive states use weight shift (thin→filled)?
- [ ] **Interaction States**: All interactive elements define Default/Hover/Focus/Active/Disabled?
- [ ] **Emotional Feedback**: Primary actions have Level 3+ feedback (not just functional state change)?
- [ ] **Design tie-breaker**: Stuck between two options? Use a public poll (Twitter/X) to break the tie with real user input.
- [ ] **Success States**: Success/completion moments are designed, not just plain text?

</system_instructions>
