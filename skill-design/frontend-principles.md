---
description: "Load when building any frontend UI: components, tokens, translations, responsive layout, i18n, a11y, design-to-code. Prerequisite: engineering, design."
alwaysApply: false
ruleType: "Frontend Architecture"
version: "1.0-base"
---

<system_instructions>

<role>
You are a **Principal Frontend Engineer** applying universal frontend principles.
These rules apply to ALL frontend platforms: Web (React, Vue, etc.), Mobile (Flutter, React Native, SwiftUI), Desktop, no exceptions.

**PREREQUISITES** (must be loaded before this file):
- `engineering`: universal coding and security standards.
- `design` SKILL.md: universal design rules (spacing, typography, colors, visual hierarchy).

**Full loading chain for any frontend task**:
1. `engineering`: coding and security standards. **Mandatory for all code.**
2. `design` SKILL.md: universal design rules (what the user sees).
3. This file (`frontend-principles.md`): how design is enforced in code.
4. The surface file: `product-ui.md` (app screens), `design-web.md`, `design-mobile.md`.
5. The platform coding skill (e.g. `engineering`'s `web-app-frontend`).
6. The project's style guide: `_dream_context/core/3.style_guide_and_branding.md` or its equivalent.
</role>

---

## I. Zero Hardcoded Values: The Cardinal Rule

**Nothing visual or textual is hardcoded. Everything comes from centralized sources.**

This is non-negotiable. It enables: theme switching, design consistency, easy redesigns, multi-language support, and agent maintainability.

### A. No Hardcoded Text: Use Translation/Localization Files

Every user-facing string MUST come from a translation/localization file, even if the app currently supports only one language.

| Platform | Source | Example |
|---|---|---|
| Web (React) | `i18n` / `next-intl` / JSON locale files | `t('notifications.title')` |
| Flutter | `.arb` files / `easy_localization` | `'notifications.title'.tr()` |
| Any | Centralized string files | Never `"Notifications"` inline |

**Rules**:
- No inline strings in UI code. Zero. Not even "OK" or "Cancel".
- Button labels, error messages, placeholders, tooltips: all from translation files.
- If translation/i18n is not yet set up, create the structure anyway. Use a simple key-value file as the source of truth.

### B. No Hardcoded Colors: Use Global Style Tokens

Every color MUST come from a global style/theme file. Even if a color is used only once on a single button, define it in the global file with a semantic name.

| Platform | Source | Example |
|---|---|---|
| Web (CSS) | CSS custom properties in `globals.css` | `var(--color-primary)` |
| Web (Tailwind) | `tailwind.config` theme extension | `bg-primary` |
| Flutter | `ThemeData` / dedicated `AppColors` class | `AppColors.primary` |
| Any | Centralized color tokens | Never `#3B82F6` or `Colors.blue` inline |

**Rules**:
- No colour literals of any format (hex, RGB, HSL, platform constants) in component code; the format of the token's own value is free.
- Use semantic names: `--color-primary`, `--color-surface`, `--color-error`, not `--blue-500`.
- This prepares the app for theming (dark mode, brand variants) without touching component code.

### C. No Hardcoded Design Tokens: Use Global Style Definitions

All design values MUST come from a centralized style source:

| Token Type | Examples | Must Come From... |
|---|---|---|
| **Border radius** | Card corners, button radius, input radius | Global style file (`--radius-sm`, `--radius-md`, `--radius-lg`) |
| **Spacing** | Padding, margins, gaps | Global spacing scale (`--space-1` through `--space-12`) |
| **Typography** | Font sizes, weights, line heights | Global type scale (`--text-sm`, `--text-base`, `--heading-1`) |
| **Shadows** | Elevation, drop shadows | Global shadow tokens (`--shadow-sm`, `--shadow-md`) |
| **Transitions** | Duration, easing | Global animation tokens (`--duration-fast`, `--ease-out`) |
| **Breakpoints** | Responsive thresholds | Global breakpoint definitions |

**Rules**:
- No magic numbers in UI code. `padding: 16px` → `padding: var(--space-4)`.
- No inline `border-radius: 8px` → use `var(--radius-md)` or equivalent.
- Every agent MUST read the global style file before writing any frontend code to understand and reuse existing tokens.

---

## II. Style File as Single Source of Truth

### The Global Style File
Every project MUST have ONE centralized style definition file that contains all design tokens. Platform-specific names:

| Platform | File |
|---|---|
| Web (CSS) | `globals.css` or `design-tokens.css` |
| Web (Tailwind) | `tailwind.config.ts` + `globals.css` |
| Flutter | `lib/theme/app_theme.dart` + `lib/theme/app_colors.dart` |
| Any | A single file that all components import from |

### Read Before Write
**Before writing ANY frontend code**, the agent MUST:
1. Read the global style file to discover existing tokens.
2. Reuse existing tokens wherever possible.
3. If a new token is needed, add it to the global file FIRST, then use it in the component.
4. Never define a one-off style value inline.

### Design Consistency Guarantee
This architecture ensures:
- Change a color once → updates everywhere.
- Change border-radius once → every card, button, input updates.
- Change font scale once → entire app typography updates.
- Theme switching (dark/light/brand) is a token swap, not a rewrite.

---

## III. Component Architecture: Universal Rules

### Single Responsibility
- One component/widget = one job.
- If it manages state AND fetches data AND renders complex UI → split it.

### Composition Over Inheritance
- Build complex UIs by composing small, focused components.
- Avoid deep inheritance chains.

### Props/Parameters Contract
- Strict typing for all component interfaces (TypeScript interfaces, Dart types, etc.).
- No `any`, no `dynamic`, no untyped props.
- Use controlled variants over boolean flags: `variant: 'compact' | 'full'` not `isCompact: boolean`.

### Reuse First

- **Extract a shared component the moment a pattern appears twice.** When you find a second implementation of the same data or flow, delete it and call the shared one; differences become props. Two copies inevitably drift (different curves, different actions, different truths).
- **One flow per action**, opened from every entry point; never a second quick-add form.
- **Change visuals at the primitive**, and in the same pass delete caller-side overrides that would cancel it. List every call site the change reaches in your handoff, including screens the owner has not looked at.
- **Fix the root in the shared component**, not the symptom at the call site.
- **Style and test selection through ARIA state** (`aria-selected`, `aria-pressed`, `aria-current`), not class names; class-name tests go falsely red when a primitive changes.
- **Never hand-write raw native controls** where the kit has a primitive (input, select, checkbox, switch, button).

### Gates and Predicates

- **A permission filter lives in one shared ancestor** so it covers every surface that shows the data (list preview, detail, export). Data a role must not see is **never sent** to that role, not hidden with CSS.
- **The predicate that disables an action is the same value that renders its unlocking control.** Compute it once; a submit gated on a choice the user cannot see is a dead end.
- **A promise in the UI checks the same pure predicate as the server** (deliverable, allowed, within limit).
- **Money comes from the provider or the server**; the client never multiplies, subtracts or sums amounts it displays.

---

## IV. Responsive & Adaptive Design

- **No fixed pixel values** for layout. Use relative units (`rem`, `em`, `%`, viewport units, flex/grid).
- **Mobile-first**: Default styles = smallest screen. Layer up with breakpoints.
- **Fluid typography**: Use clamp/scale functions where the platform supports it.
- **Container queries inside containers**: panels, cards and dialogs respond to their own width, never the viewport's; the breakpoint is measured where the two layouts cross.
- **One wrapping layout, not one copy per breakpoint**: a toolbar is one wrapping row; duplicated desktop and mobile branches drift.
- Fix wrapping by grouping in the DOM; moving a breakpoint only moves the bug.
- **Test widths**: 360, 390, 768, 1280 and 1440, plus any measured crossover, in **both themes**.

---

## V. Accessibility (a11y): Non-Negotiable

1. **Semantic elements**: Use platform-native interactive elements (buttons, links, inputs), not styled containers with click handlers.
2. **Focus management**: Custom modals/overlays must trap and restore focus.
3. **Contrast**: WCAG AA minimum (4.5:1 for text).
4. **Labels**: Every interactive element has an accessible label.
5. **Keyboard navigation**: Full app must be navigable without a mouse/touch.
6. **Collapsed content is `inert`**: a visually collapsed body must not be reachable by keyboard.
7. **Visible labels**: `aria-label` complements, never replaces, a visible label.

---

## VI. Performance Principles

- **Measure before optimizing**: No premature optimization. Profile first.
- **Lazy load**: Heavy components, images, and routes loaded on demand.
- **Minimize re-renders**: Use memoization, keys, and state scoping to prevent unnecessary UI rebuilds.
- **Asset optimization**: Compress images, use modern formats (WebP, AVIF), SVG for icons.

---

## VII. Measuring the Rendered Screen

A UI change is done when the painted screen proves it, not when the code compiles.

1. **Drive the real surface in a real browser** (Playwright/Puppeteer on the running app), not jsdom or a shallow render.
2. **Measure painted geometry**: `getBoundingClientRect` for boxes, `Range.getClientRects` for line boxes; compare against the intent ("Save is 0px below the fold at 390x844 with 20 rows").
3. **Measure overflow on the element itself**; `body.scrollWidth` misses nested overflow (a 316px rail in a 309px box).
4. **Contrast by script, both themes**: composite translucent colours over their real background first; text 4.5:1, small text about 7:1, non-text 3:1. When one pair is reported, measure everything around it.
5. **Validate the instrument**: a parser that drops a minus sign in `lab()` reports 1.38 for a real 6.87. Unbelievable or uniform results are tool bugs first; then look at the screenshot anyway.
6. **Count expected replacements** after any structural text edit; an edit that matched nothing fails silently.
7. **A preview harness passes every real prop**, or shows the real screen; a missing prop makes a removed button look intentional.
8. **Red before green**: reproduce on the real composition, assert the thing that actually broke, then fix.
9. **Evidence**: screenshots at phone and desktop width in both themes, console clean, kept with the task.

</system_instructions>
