---
id: tinted-surface-not-filled-swatch
name: "Tinted Surface, Not Filled Swatch"
description: "An accent token validated on chips and buttons is not thereby validated on paragraphs. Long-form content the reader OWNS and re-reads takes a tinted surface — accent color-mixed into a theme surface, accent mixed further into the border, ordinary body text on top — never a solid accent fill with its paired on-accent text."
tags: ["design", "topic:frontend", "domain:dashboard"]
pinned: false
date: "2026-08-01"
updated: "2026-08-27"
---

## Why This Exists

Every design system ships an accent pair: `--color-accent` as a background, `--color-accent-text` as the foreground guaranteed to read on it. That pair gets proven on the things it was drawn for — chips, badges, primary buttons, tab indicators — where the text is two or three words, often at higher weight, and the reader glances at it rather than reads it.

The pair then gets reused for a block of prose, because it is "the accent", and nobody re-checks it. That is where it breaks. The chat user bubble in this project was a solid `--color-accent` fill with snow text; it passed every review at mockup size and failed the moment a real user typed a real paragraph into it. The owner's report was exactly the symptom this pattern names: *"benim mesajlarım nedense okunması güç duruyor"* — **the user's own words had become the hardest thing in their own transcript to re-scan.**

That is the worst possible place to lose contrast. Assistant output is read once, top to bottom. A user's own message is what they scroll BACK to: to check what they asked, to quote it, to edit and resend it. Long-form content the reader owns is the highest-re-read surface in the app, and it was carrying the app's lowest-endurance color pairing.

## The Pattern

### 1. Classify the block before you pick its color

| Block | Length | Read pattern | Treatment |
|---|---|---|---|
| Chip, badge, button, tab | 1–3 words | Glanced at | Solid accent fill + `--color-accent-text` is fine |
| Status pill, counter | short | Glanced at | Solid or tinted, either reads |
| **Reader-owned prose** (their message, their note, their draft) | **paragraphs** | **Re-read, quoted, edited** | **Tinted surface + body text** |
| Assistant / system prose | paragraphs | Read once | Plain canvas, no fill needed |
| **Inline marker** (`==highlight==`, `.dc-mark`) | a phrase | **Read THROUGH, mid-sentence** | **Pen stroke + `color: inherit`** (§5) |

The axis is not "is this important" — the accent fill is often chosen *because* the block is important. The axis is **length × re-read frequency**.

### 2. The tinted-surface recipe

```css
/* dashboard/src/components/sleepy/chat/cards.css — .chat-msg-user-bubble */
background: color-mix(in srgb, var(--color-accent) 14%, var(--color-bg-tertiary));
border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
color: var(--color-text);
```

Three properties, and each one is doing a job:

- **Fill** — the accent mixed a *little* way into a theme surface. Enough hue to be unmistakably "the accent", not enough to force a special foreground.
- **Border** — the accent mixed *further* into the theme border. This is what carries the identity that the desaturated fill gave up; without it the block reads as a generic grey card.
- **Text** — the ordinary `--color-text`. Not the on-accent pair. The whole point is that this block no longer needs a special foreground.

### 3. Mix against a theme surface, never against a hardcoded color

`color-mix(… , var(--color-bg-tertiary))` tracks the theme automatically: the same declaration produces a light violet tint on the light theme and a dark violet tint on the dark one, and both keep `--color-text` at body-text contrast. A hardcoded second operand pins one theme and silently fails the other — which is how a contrast fix ships half-done.

### 4. Identity survives desaturation

The objection to this change is always "it won't read as *mine* anymore". It does, because identity in a transcript was never carried by saturation:

- **alignment** — the block is `align-self: flex-end`
- **radius** — `--radius-2xl` against un-guttered assistant blocks that have no bubble at all
- **hue** — still present in both the fill and, strongly, the border

Saturation was the one identity signal that also cost readability, and it is the one worth spending.

### 5. An inline MARKER is prose, not a chip

The `dream-html` kit's `.dc-mark` — the highlighter an author paints over the load-bearing
phrase in a block — shipped as `--color-accent-text` on `--color-accent-soft`: a filled
lavender swatch with white text. It looked like the kit's chips because it was written next
to them, and it failed on the light theme the way this pattern predicts (owner report
2026-08-27, with a screenshot): the one phrase marked as *the phrase to read* was the only
phrase in the block that could not be read.

A marker is not a short glanced-at element even though it is short. It sits INSIDE a
sentence, in the sentence's own type and color, and the reader's eye lands on it first and
then keeps reading — so it must not restate the foreground at all:

```css
/* Ink a STROKE, inherit the text. `--color-highlight` / `--color-highlight-edge`. */
background: linear-gradient(to bottom, transparent 8%, var(--ink) 8%, var(--ink) 88%,
                            var(--edge) 88%, var(--edge) 94%, transparent 94%);
color: inherit;
box-decoration-break: clone;   /* a wrapped highlight is two strokes, one per line */
```

The give-away in review: **a rule that sets both `background` and `color` on something the
reader reads THROUGH is already wrong.** Fill and foreground together make a badge; a pen
sets only the ink.

## When NOT to Apply This

- **Short glanced-at elements.** A button that says "Save" should stay a solid accent fill; desaturating it costs affordance and buys nothing.
- **Deliberate one-shot emphasis** — a banner meant to interrupt, read once and dismissed.
- **When the accent pair has actually been contrast-tested at paragraph length in both themes.** The pattern is about the *untested* reuse, not about the pair being forbidden.

## Occurrences In This Repo

- `dashboard/src/components/sleepy/SleepDebtTracker.css` — the debt/level pills, where the recipe originated.
- `dashboard/src/components/sleepy/chat/cards.css` `.chat-msg-user-bubble` — commit `fa06c2a`, the occurrence that turned the recipe into a rule.
- `dashboard/src/components/sleepy/chat/chat-html-kit.css` `.dc-mark` — the inline marker above, re-inked as the same pen `styles/global.css` gives the transcript's own `==highlight==`. Pinned by `tests/unit/chat-html.test.ts`, which now refuses `var(--color-accent-text)` anywhere in the kit and checks every token the kit reads is one the sandbox actually resolves.

## Related

- [[in-app-agent-terminal]] — the feature PRD carrying the decision record for the chat surface.
- [[agent-chat-redesign-12-state-native-chat-ui-per-corrected-design-brief]] — the task whose Constraints & Decisions holds the same lesson at task scope.
