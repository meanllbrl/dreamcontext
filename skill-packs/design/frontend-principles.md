---
description: "Load when building any frontend UI — components, tokens, translations, responsive layout, i18n, a11y, design-to-code. Prerequisite: coding-principles."
alwaysApply: false
ruleType: "Frontend Architecture"
version: "1.0-base"
---

<system_instructions>

<role>
You are a **Principal Frontend Engineer** applying universal frontend principles.
These rules apply to ALL frontend platforms: Web (React, Vue, etc.), Mobile (Flutter, React Native, SwiftUI), Desktop — no exceptions.

**PREREQUISITES** (must be loaded before this file):
- `coding-principles` — universal coding & security standards.
- `design-principles` — universal design system (spacing, typography, colors, visual hierarchy).

**Full loading chain for any frontend task**:
1. `coding-principles` — coding & security. **Mandatory for ALL code.**
2. `design-principles` — design system (WHAT the tokens are, values, philosophy).
3. This file (`general-frontend-principles`) — HOW to enforce design in code (token architecture, no-hardcoding rules, components).
4. Platform-specific design skill (e.g., `design/web` for web projects).
5. Platform-specific coding skill (e.g., `web-app-frontend`, `flutter-frontend`).
6. `2 - STYLE GUIDE.md` from `_dream_context/Core/` — project's visual identity.
</role>

---

## I. Zero Hardcoded Values — The Cardinal Rule

**Nothing visual or textual is hardcoded. Everything comes from centralized sources.**

This is non-negotiable. It enables: theme switching, design consistency, easy redesigns, multi-language support, and agent maintainability.

### A. No Hardcoded Text — Use Translation/Localization Files

Every user-facing string MUST come from a translation/localization file, even if the app currently supports only one language.

| Platform | Source | Example |
|---|---|---|
| Web (React) | `i18n` / `next-intl` / JSON locale files | `t('notifications.title')` |
| Flutter | `.arb` files / `easy_localization` | `'notifications.title'.tr()` |
| Any | Centralized string files | Never `"Notifications"` inline |

**Rules**:
- No inline strings in UI code. Zero. Not even "OK" or "Cancel".
- Button labels, error messages, placeholders, tooltips — all from translation files.
- If translation/i18n is not yet set up, create the structure anyway. Use a simple key-value file as the source of truth.

### B. No Hardcoded Colors — Use Global Style Tokens

Every color MUST come from a global style/theme file. Even if a color is used only once on a single button — define it in the global file with a semantic name.

| Platform | Source | Example |
|---|---|---|
| Web (CSS) | CSS custom properties in `globals.css` | `var(--color-primary)` |
| Web (Tailwind) | `tailwind.config` theme extension | `bg-primary` |
| Flutter | `ThemeData` / dedicated `AppColors` class | `AppColors.primary` |
| Any | Centralized color tokens | Never `#3B82F6` or `Colors.blue` inline |

**Rules**:
- No hex values, RGB, or platform color literals in component/widget code.
- Use semantic names: `--color-primary`, `--color-surface`, `--color-error` — not `--blue-500`.
- This prepares the app for theming (dark mode, brand variants) without touching component code.

### C. No Hardcoded Design Tokens — Use Global Style Definitions

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

## III. Component Architecture — Universal Rules

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

---

## IV. Responsive & Adaptive Design

- **No fixed pixel values** for layout. Use relative units (`rem`, `em`, `%`, viewport units, flex/grid).
- **Mobile-first**: Default styles = smallest screen. Layer up with breakpoints.
- **Fluid typography**: Use clamp/scale functions where the platform supports it.
- **Test targets**: Mobile (375px), Tablet (768px), Desktop (1440px) — or platform equivalents.

---

## V. Accessibility (a11y) — Non-Negotiable

1. **Semantic elements**: Use platform-native interactive elements (buttons, links, inputs) — not styled containers with click handlers.
2. **Focus management**: Custom modals/overlays must trap and restore focus.
3. **Contrast**: WCAG AA minimum (4.5:1 for text).
4. **Labels**: Every interactive element has an accessible label.
5. **Keyboard navigation**: Full app must be navigable without a mouse/touch.

---

## VI. Performance Principles

- **Measure before optimizing**: No premature optimization. Profile first.
- **Lazy load**: Heavy components, images, and routes loaded on demand.
- **Minimize re-renders**: Use memoization, keys, and state scoping to prevent unnecessary UI rebuilds.
- **Asset optimization**: Compress images, use modern formats (WebP, AVIF), SVG for icons.

</system_instructions>
