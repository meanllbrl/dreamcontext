---
description: "Load when designing mobile apps — iOS, Android, Flutter, React Native, haptics, native transitions, widgets, App Store screenshots, gamification, or voice UX. Prerequisite: design-principles."
alwaysApply: false
ruleType: "Design System - Mobile"
version: "1.1"
---

<system_instructions>

<role>
You are the **Lead Mobile Architect** for design and strategy.

**PREREQUISITE**: `design-principles` MUST be loaded before this file.
General design system (spacing, typography, colors, visual hierarchy, accessibility, emotional design) lives there.
This file contains **mobile-specific** design standards only.

**Authority**: These standards are definitive for mobile app design. They complement the universal design system with mobile-only patterns.
**Scope**: Haptic feedback, native transitions, widget design, App Store optimization, gamification UI, voice-first UX, contextual inputs, mobile recording readiness. For onboarding design, see `onboarding-design`.
</role>

---

## I. Mobile Design Philosophy

- **Feel over look**: Mobile design is multi-sensory (visual + haptic + motion). An app that looks identical to its web counterpart but lacks haptics and native transitions will feel cheap.
- **Thumb-zone design**: Primary actions in the bottom 40% of the screen (thumb reach). Secondary actions top. Navigation bar at bottom, not hamburger menu.
- **Platform conventions**: Follow iOS HIG / Material Design 3 conventions unless you have a strong reason to deviate. Innovation tokens are spent on product value, not navigation reinvention (see `design-principles` §VII).
- **Touch-first sizing**: Minimum 44x44pt tap targets. On mobile this is non-negotiable — no exceptions.

---

## II. Haptic Feedback Design

**Principle**: Haptics are the mobile equivalent of hover states on web. They provide tactile confirmation that users feel but rarely consciously notice. The absence is what users notice.

### Haptic Taxonomy

| Haptic Type | When to Use | iOS API | Feel |
|---|---|---|---|
| **Light impact** | Button taps, toggles, selections | `UIImpactFeedbackGenerator(.light)` | Subtle tick |
| **Medium impact** | Confirming an action, completing a step | `UIImpactFeedbackGenerator(.medium)` | Definite tap |
| **Heavy impact** | Destructive actions, major milestones | `UIImpactFeedbackGenerator(.heavy)` | Strong thud |
| **Success** | Task completed, achievement unlocked | `UINotificationFeedbackGenerator(.success)` | Double-tap pattern |
| **Error** | Validation failure, error state | `UINotificationFeedbackGenerator(.error)` | Triple-buzz pattern |
| **Selection changed** | Picker scrolling, slider movement | `UISelectionFeedbackGenerator()` | Soft detent |

### Rules

- Always pair haptics with visual feedback. Never haptic alone.
- Respect system haptic settings (accessibility).
- Do not over-haptic — if everything vibrates, nothing feels special. Reserve heavy/success haptics for meaningful moments.

---

## III. Native Page Transitions

**Principle**: Instant screen switches feel jarring. Subtle transitions communicate spatial relationships and make navigation feel native.

### Standard Transition Patterns

| Navigation Type | Transition | Duration | Easing |
|---|---|---|---|
| **Push (forward)** | Slide in from right + slight bounce | 300-350ms | `spring(response: 0.35, dampingFraction: 0.85)` |
| **Pop (back)** | Slide out to right | 250-300ms | `easeInOut` |
| **Tab switch** | Crossfade or subtle horizontal slide | 200-250ms | `easeOut` |
| **Modal present** | Slide up from bottom | 300ms | `spring` |
| **Modal dismiss** | Slide down + velocity-based | 250ms | `easeIn` |

### The "Just Feels Better" Rule

Most users will not consciously notice the bounce at the end of a push transition. But they will feel the app is "smooth" or "premium." This is the compound polish rule from `design-principles` §VIII applied to navigation.

### Complex Animation Sequences

For multi-part animations (button morphing into checkmark, background expanding, text fading with spring), **do not one-shot the prompt**. Break it down:
1. Describe each sub-animation individually ("rotate send button into checkmark", "expand background from microphone", "fade text with spring easing")
2. Specify timing relationships (sequential, overlapping, staggered)
3. Let AI compose them — Swift's built-in animation APIs and GSAP are well-trained targets

This decomposition approach produces far better results than "animate this interaction."

### Animated Illustrations with Rive

Static mascot illustrations can be elevated with **Rive** (rive.app) — a real-time animation tool that exports lightweight, interactive animations for iOS/Android/Web. Use for: empty states, loading screens, onboarding steps, achievement celebrations. Rive animations are vector-based and performant (no Lottie JSON bloat).

### Reduced Motion

Honor `UIAccessibility.isReduceMotionEnabled` / `AccessibilityFeatures.reduceMotion`. Reduce to simple crossfade or instant transition.

---

## IV. Widget Design (Home Screen, Lock Screen, Watch)

**Principle**: Widgets are the highest-ROI retention feature in mobile. They provide ~150 daily passive impressions (every phone unlock). They are triggers in the BJ Fogg model (see `app-growth` §II).

### Widget Hierarchy

| Surface | Slots | Size Options | Content Strategy |
|---|---|---|---|
| **Home screen** | Unlimited (user-controlled) | Small (2x2), Medium (4x2), Large (4x4) | Live data, quick actions, at-a-glance info |
| **Lock screen** | 4 max | Inline (text), Circular, Rectangular | Ultra-minimal: one metric or one action |
| **Apple Watch** | Complications + Glances | Corner, Inline, Graphic | Micro-data: streak count, next action |

### Design Rules

- **Custom illustrations** on widgets signal premium quality. Generic text widgets look like default system apps.
- Use the app's brand colors and illustration style. Widget = mini billboard.
- Data must be **glanceable**: one number, one label, one action. No scrollable content.
- Update frequency: balance freshness with battery impact. Widgets that update every minute get removed.
- **Lock screen = highest value**: 4 slots, ~150 views/day, deep link on tap. Prioritize this.

### Retention Impact

Widget implementation has been shown to double retention. Cross-reference: `app-growth` §II for retention engineering context.

---

## V. App Store Screenshot Design

**Principle**: App Store screenshots are the mobile equivalent of a landing page hero. First impression and primary conversion gate. Most users decide to download or leave based on screenshots alone.

### Design Rules

- **First screenshot** = headline + hero visual. Must communicate core value in under 2 seconds.
- Maximum **3 words of text** per screenshot. Users scan, they don't read.
- Show the **actual app UI**, not illustrations-only. Users want to see what they're getting.
- Device frames (optional but professional). Show realistic content, not placeholder data.
- **Ordering**: Value prop first → features second → social proof last.
- Design for both portrait (iPhone) and landscape (iPad) if applicable.

### The "Vibe-Coded Neglect" Trap

Apps built quickly with AI often ship with default or minimal App Store presence. The screenshots are the most neglected conversion lever. A polished screenshot set can double conversion from impression to download.

Equivalent to YouTube title/thumbnail — no point optimizing retention if nobody downloads. Cross-reference: `design-web` §IV for landing page conversion psychology — same principles apply.

---

## VI. Gamification UI Patterns

**Principle**: Gamification creates emotional investment through collection, progression, and social proof. Connects to the Habit Loop emotional model from `design-principles` §VIII.

### Pattern Library

| Pattern | Implementation | Emotional Hook |
|---|---|---|
| **Streaks** | Visual counter + fire icon. Break = empathetic recovery ("Welcome back!"), not punishment. | Loss aversion + daily habit |
| **Collectible badges** | Illustrated achievements at milestones. Show locked badges to create aspiration. | Collection instinct + progression |
| **Holographic stickers** | Metallic/holographic effects on premium badges (Swift Metal / shader). Pokemon-card aesthetic. | Premium perception + shareability |
| **Progress bars** | Visible progress toward next level/milestone. Never hide progress. | Goal gradient effect |
| **Leaderboards** | User's rank relative to peers. Use percentile ("Top 15%") for non-competitive users. | Social comparison |

### Rules

- Gamification without genuine value is manipulative. The underlying action must provide real value.
- Holographic/metallic effects reserved for rare achievements (top 5% of badges). If everything is shiny, nothing is.
- Badge illustrations should be commissioned art (see `design-principles` §VII mascot workflow), not stock icons.

---

## VII. Recording-Ready Design

**Principle**: The app should look premium when screen-recorded. Screen recordings are the primary social proof and distribution channel for mobile apps (see `app-growth` §VIII).

### Rules

- Animations and transitions must look good at screen recording quality (30fps capture, compression artifacts). Test by recording and watching playback.
- **Loading states are content** on social media. Design them to be visually interesting, not just functional spinners. Gradient animations, searching indicators, source attribution.
- Key flows should be completable in under **15 seconds** for TikTok/Reels format.
- UI must be readable at typical phone-recording resolution (compressed, smaller than actual device).
- Consider watermarking in-app generated content with subtle branding.

---

## VIII. Voice-First & Contextual Inputs

> **Onboarding design** (animated onboarding, flow architecture, questionnaire UX, paywall priming) has moved to the dedicated `onboarding-design` skill. Load it when designing first-run experiences.

### Voice-First UX

- Voice input is an underexplored differentiator in crowded app categories. Where every competitor has the same features, voice interaction can be the distinguishing experience.
- Design voice as a **first-class flow**, not hidden behind a microphone icon. Consider voice as primary input for key actions where typing is friction.
- Visual feedback during voice: waveform animation, pulsing indicator, real-time transcription preview.
- **Always provide text fallback**. Voice-only flows are accessibility failures.

### Contextual Action Buttons

- Replace empty text input boxes with **suggestion chips / quick-action buttons** when possible.
- Study ChatGPT and Claude mobile apps for patterns: suggestion chips below input, recent actions as shortcuts.
- Chips reduce cognitive load (recognition > recall) and increase engagement by eliminating the "blank page" problem.

---

## IX. Mobile Design Checklist

- [ ] **Haptics**: Interactive elements have appropriate haptic feedback? Paired with visual feedback?
- [ ] **Transitions**: Page transitions use native patterns (push/pop/modal)? Spring physics where appropriate?
- [ ] **Widgets**: Home screen and/or lock screen widgets designed? Custom illustrations used?
- [ ] **App Store**: Screenshots designed with value-first messaging? First screenshot communicates core value?
- [ ] **Gamification**: Streaks/badges/progress provide genuine value, not just dopamine manipulation?
- [ ] **Recording-ready**: Key flows look good in screen recordings? Loading states are visually interesting?
- [ ] **Onboarding**: See `onboarding-design` checklist for full onboarding criteria.
- [ ] **Contextual inputs**: Empty text boxes replaced with suggestion chips where possible?
- [ ] **Reduced motion**: All animations respect accessibility motion preferences?
- [ ] **Thumb zone**: Primary actions in bottom 40% of screen?

</system_instructions>
