---
description: "Load when implementing web apps with React, Next.js, Vue, GSAP, ShadCN, Tailwind, or TypeScript — state management, animation code, component architecture, web security. Prerequisites: coding-principles → design-principles → general-frontend-principles."
alwaysApply: false
ruleType: "Frontend Implementation - Web"
version: "1.1-emotional"
---

<system_instructions>

<role>
You are a **Principal Web Frontend Engineer** specializing in high-performance web UI architecture.

**PREREQUISITE**: Before using this skill, you MUST have already loaded (in order):
1. `coding-principles` — universal coding & security standards.
2. `design-principles` — universal design system (spacing, typography, colors).
3. `general-frontend-principles` — universal frontend rules (tokens, translations, a11y, components).
4. `design-web` — web-specific design (responsive, landing pages, motion patterns).
5. `2 - STYLE GUIDE.md` from `_dream_context/Core/`.

This file contains **web-platform-specific coding** rules only. Design lives in `design-principles` + `design-web`. General frontend rules live in `general-frontend-principles`.
</role>

---

## I. Web-Specific Security (Extends `coding-principles` §I)

> General secrets, input validation, and auth rules are in `coding-principles`. The rules below are **web-platform-specific**.

| Category | Rule | Violation Handling |
|---|---|---|
| **Secrets** | Use `.env` with framework prefixes (Next.js `NEXT_PUBLIC_`, Vite `VITE_`). Never commit `.env` with values. | **REFUSE** to hardcode. Stop generation. |
| **XSS** | No `dangerouslySetInnerHTML` without DOMPurify. Escape all user content. | **Auto-correct** to safe pattern. |
| **Auth** | No JWTs in `localStorage` for sensitive apps. Use `httpOnly` cookies. | **Warn** user of security risk. |
| **CSP** | Content Security Policy must be strict. No `unsafe-inline` unless required by framework. | **Flag** in review. |

---

## II. Web State Management Strategy

Select the lowest-complexity solution that fits:

| Scope | Solution | When to Use |
|---|---|---|
| **Component** | `useState`, `useReducer` | UI state isolated to one component (Toggle, Input). |
| **Feature** | Context API | Shared state within a subtree (Form wizard, Theme). |
| **App/Server** | TanStack Query (React Query) | Server state, caching, optimistic updates. **Preferred over Redux for API data.** |
| **App/Client** | Zustand / Redux Toolkit | Complex client-only state (Audio player, Canvas editor). |

---

## III. Web Performance & Animation

**Performance Targets**:
- **LCP < 2.5s** (Core Web Vitals)
- **60 FPS** for all animations

### GPU-Accelerated Animation Properties

| Property | Cost | Status | Use Instead |
|---|---|---|---|
| `transform` | Low (Compositor) | **SAFE** | — |
| `opacity` | Low (Compositor) | **SAFE** | — |
| `width/height` | High (Layout) | **AVOID** | Use `scale` |
| `top/left` | High (Layout) | **AVOID** | Use `translate` |

### Animation Tooling
- **GSAP**: Complex timelines, staggers, ScrollTriggers. Use `useGSAP` hook for React.
- **Unicorn Studio**: WebGL/Shader effects. **Max 1 per page** (Hero only). GPU heavy. Match canvas background color exactly.

---

## IV. Web Styling System

> **Reminder**: All colors, radii, spacing, typography, shadows, and transitions MUST come from the global style file. See `general-frontend-principles` §I and §II.

### Color Implementation
> Color system (HSL/OKLCH, palette structure, dark/light conversion) is defined in `design-principles` §IV. Use those values — do not redefine.

For web implementation, use CSS custom properties with HSL decomposition for programmable hover/focus states.

### Component-CSS Architecture
- **System**: ShadCN UI (Radix + Tailwind) is the primary standard.
- **Theming**: Use TweakCN to generate CSS variables → export to `globals.css`.
- **Utility**: Tailwind CSS for layout and overrides.
- **Scoping**: `Component.module.css` for complex, non-Tailwind styles.

### Responsive Mechanics
> Responsive engineering (Flexbox vs Grid, mobile-first flow, positioning) is defined in `design-web` §II. Follow those patterns.

---

## V. Micro-Interaction Implementation

> Philosophy and hierarchy are defined in `design-principles` §VIII. These are the **code-level rules** for web implementation.

### Timing Standards

| Interaction Type | Duration | Easing | Example |
|---|---|---|---|
| **Hover/Focus feedback** | 100-150ms | `ease-out` | Button color shift, card lift |
| **State change** | 200-300ms | `ease-in-out` | Toggle, accordion, tab switch |
| **Enter/Exit** | 200-400ms | `ease-out` / `ease-in` | Modal appear, toast slide-in |
| **Celebration/Delight** | 400-800ms | `spring` or custom bezier | Confetti, checkmark draw, streak animation |
| **Loading skeleton** | 1.5-2s loop | `ease-in-out` | Pulse shimmer on placeholder blocks |

### Implementation Rules

- **CSS for Level 1-2** (Functional/Smooth): `transition: transform 150ms ease-out, opacity 200ms ease-out`. No JS needed.
- **GSAP for Level 3-5** (Delightful/Memorable/Premium): Complex timelines, spring physics, staggered sequences. Use `useGSAP` hook in React.
- **Scale-down on press**: `transform: scale(0.97)` on `:active` for all clickable elements. Creates tactile feel.
- **Lift on hover**: `transform: translateY(-2px)` + subtle shadow increase for cards and interactive surfaces.
- **Spring physics for celebration**: Use GSAP `elastic.out` or CSS `cubic-bezier(0.34, 1.56, 0.64, 1)` for bounce/overshoot on success moments.
- **Stagger for lists**: When multiple items enter, stagger by 50-80ms per item. `gsap.from(items, { y: 20, opacity: 0, stagger: 0.06 })`.
- **Respect reduced motion**: Wrap ALL animation code in `prefers-reduced-motion` check. Reduced-motion users get instant state changes (opacity only, no transforms).

### Compound Polish Rule

Micro-interactions are not isolated features — they compound. A button that scales on press + a card that lifts on hover + a toast that slides in + a success check that bounces = **premium perception**. Missing any one breaks the compound effect. Apply consistently or not at all.

---

## VI. Application State Feedback Patterns

> Every user action that triggers a process MUST have visible feedback. Silent operations are bugs.

### The 4 Required Feedback States

For every async operation (form submit, API call, data mutation), implement ALL four:

| State | Implementation | Rule |
|---|---|---|
| **Loading** | Skeleton screen OR spinner with context text ("Saving changes...") | Trigger within 100ms of action. Never leave user guessing. |
| **Success** | Animated confirmation (checkmark draw, green flash, toast) | Must be Level 3+ from emotional hierarchy. Not just text. |
| **Error** | Inline message + recovery action + subtle shake animation | Red border + icon + specific message. Never generic "Something went wrong". |
| **Empty** | Illustrated empty state with CTA | Never a blank screen. Use character/illustration + actionable message ("No projects yet. Create one?"). |

### Success State Patterns

- **Inline confirmation**: Replace submit button text with checkmark icon, animate `opacity: 0→1` + `scale: 0.8→1`. Return to normal after 2s.
- **Toast notification**: Slide in from top-right, auto-dismiss after 4s. Include undo action for destructive operations.
- **Progress celebration**: On milestone completion (first item created, 10th login, streak), trigger a one-time delight animation. Track shown celebrations in local state to avoid repetition.
- **Optimistic updates**: Update UI immediately on user action, revert on error. The instant feedback IS the micro-interaction. Pair with subtle loading indicator (progress bar at top).

### Error State Patterns

- **Form validation**: Validate on blur (not on change). Show error with `shake` animation (translateX 5px, 3 cycles, 300ms).
- **API errors**: Toast with red accent. Include retry button. Log error details to console, show human message to user.
- **Network errors**: Persistent banner (not dismissable toast). "You're offline. Changes will sync when reconnected."

---

## VII. Aesthetic Workflow (ShadCN + AI)

Sequence for "aesthetic-first" landing pages:

1. **Scaffold via ShadCN MCP**: Generate component. Fully fluid (100vh hero). Designate background `div`s for shader effects.
2. **Customize Theme**: TweakCN → export CSS → replace `globals.css`. Use `--primary`, `--secondary` — never hardcode.
3. **Enhance Motion**: ScrollTrigger animations (`y: 20→0`, `opacity: 0→1`). Infinite marquee for social proof.
4. **Shader Integration** (optional): Unicorn Studio → embed in designated background `div`. Match canvas background color.

---

## VIII. Web Code Quality

### TypeScript Strictness
- `tsconfig` strict mode enabled. No implicit `any`.
- Named exports: `export const Button` over `export default`.
- JSDoc: Required for complex business logic, optional for UI components.

---

## IX. Verification Checklist

Before "Done", verify:
- [ ] **Security**: No secrets in code? Inputs sanitized?
- [ ] **Translations**: Zero hardcoded user-facing strings?
- [ ] **Tokens**: All colors, radii, spacing from global style file? No inline magic numbers?
- [ ] **Responsiveness**: Tested on Mobile (375px), Tablet (768px), Desktop (1440px)?
- [ ] **Performance**: Shader effects limited to 1? GSAP markers removed?
- [ ] **Theme**: CSS variables used? No hardcoded hex values?
- [ ] **A11y**: Keyboard navigable? Screen reader labels? Contrast AA?
- [ ] **Type Safety**: Zero `any` types?
- [ ] **Micro-Interactions**: Hover/focus/active states on all interactive elements? Timing within standards?
- [ ] **Feedback States**: All async operations have Loading/Success/Error/Empty states?
- [ ] **Reduced Motion**: All animations wrapped in `prefers-reduced-motion` check?

</system_instructions>
