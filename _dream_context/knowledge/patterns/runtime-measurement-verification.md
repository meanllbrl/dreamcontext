---
id: runtime-measurement-verification
name: "Runtime Measurement Verification (measure painted pixels, not CSS intentions)"
description: >-
  Verify the RENDERED artifact in real Chromium by measuring what the user actually sees —
  painted line boxes via Range.getClientRects, element geometry via getBoundingClientRect,
  not CSS values read by hand. Compare variants on REAL data (a captured transcript, not a
  mockup), in both themes, and pin the measurements as executable assertions. A rule that
  measured 35px while its CSS said 26px proves the test.
tags: ["architecture", "testing", "topic:frontend", "domain:dashboard", "kind:pattern"]
pinned: false
date: "2026-08-02"
updated: "2026-08-02"
---

## Why This Exists

Owner report 08-02: *"satır araları hafif artabilir mi, okuması güç oluyor."* The CSS said
`line-height: 1.6`, which is readable. The measurement said **21px between lines in the findings
list** — the tightest text on screen, in the shape most long answers take.

The gap was selector specificity. `MarkdownPreview.css` pinned `li` to `--line-height-relaxed`
(1.43 — *smaller* than normal, it means body-sm) through `.md-preview .markdown-body li`, which
matched the chat's override in specificity and won on import order. So the override applied to
paragraphs but not to lists, and no unit test or visual inspection could have caught it —
**the CSS was right, the painted pixels were wrong.**

A second example from the same cycle: the 08-01 density pass shipped a rule that measured **35px**
while its CSS said `min-height: 26px`. The rule had padding it didn't account for. Nothing but a
runtime measurement catches that.

## The Pattern

### 1. Drive the real surface in real Chromium

Not jsdom, not a mock renderer, not a shallow render — the full app in an actual browser,
because the painter is what decides what the user sees.

```typescript
// scripts/verify/chat-prose.mjs
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5174/…');  // real dev server
```

### 2. Measure what was PAINTED, not what was intended

CSS values lie when specificity fights or when the layout engine overrides. Measure the
**actual rendered geometry**:

| What you want | How to measure it | Why |
|---|---|---|
| Line height | `Range.getClientRects()` over a wrapped block, longest match | CSS `line-height` is the intention; the rects are what painted |
| Element height/width | `el.getBoundingClientRect()` | `.offsetHeight` rounds; the rect has subpixel precision |
| Spacing between elements | Adjacent rects' edges | `margin`/`gap` in CSS can collapse or be overridden |
| What's visible | `IntersectionObserver` or rect positions | `display:none` hides but `visibility:hidden` reserves space |

**Never compute from the CSS by hand.** If the measurement and the rule disagree, the measurement
is the truth.

### 3. Feed the surface REAL data, not a mockup

The owner report's underline-vs-wash comparison was rendered on **the same real transcript** that
exposed the line-height gap — a captured answer with findings lists, wrapped multi-line clauses,
inline code, everything a review report actually contains. A mockup with "lorem ipsum" would have
said the wash and the underline both work.

```typescript
// A real captured CLI transcript, not invented frames
const transcriptFrames = await fs.readFile('fixtures/real-session-123.jsonl', 'utf-8');
```

### 4. Test both themes

A rule that works in dark can fail contrast in light. The chat highlighter's dark ink is **1/3 of
the light ink**, measured to keep white text above 7:1 contrast — guessing would have shipped a
WCAG failure.

```typescript
for (const theme of ['light', 'dark']) {
  await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
  // … assertions
}
```

### 5. Pin the measurements as executable assertions

The verification script IS the test. It fails the build when the painted artifact drifts from
the rule.

```typescript
// verify:chat-prose (16 assertions × 2 themes = 32 total)
const paragraphLeading = await measureLineHeight(page, 'p');
assert(paragraphLeading >= 26 && paragraphLeading <= 27,
  `paragraph leading ${paragraphLeading}px (expected ~26px)`);

const listLeading = await measureLineHeight(page, 'li');
assert(listLeading >= 26 && listLeading <= 27,
  `list leading ${listLeading}px (expected ~26px, was 21px before fix)`);
```

### 6. Name what you're preventing

The comment or test name says what broke before, so the next person knows the assertion isn't
paranoia.

```typescript
// The 08-01 density pass shipped 35px; the CSS said 26px. Padding was unaccounted.
const collapsedRowHeight = await page.evaluate(…);
assert(collapsedRowHeight === 32, `collapsed row ${collapsedRowHeight}px, expected 32px`);
```

## When to Apply

- **Visual rhythm matters** (line-height, spacing, density) — a 3px gap looks identical in two
  screenshots but reads as cramped versus comfortable.
- **Specificity can fight** (overrides, themes, markdown inside app chrome).
- **The layout engine can override** (flexbox `min-height`, grid auto-sizing, `contain:size`).
- **Variants must be compared** (wash vs underline, light vs dark) on the SAME real content.

Don't apply to:
- **Logic tests** — pure functions, state machines, protocol parsing (those are unit tests).
- **One-off prototypes** — the fixture cost exceeds the value until the surface ships.

## Proof in This Repo

| Script | What it measures | Why |
|--------|------------------|-----|
| `verify:chat-prose` | Painted line-box heights via `Range.getClientRects` | 16 assertions × 2 themes; caught the list-tighter-than-paragraph bug |
| `verify:chat-toolrows` | Row heights via `getBoundingClientRect`, grouping | 68 assertions × 2 themes; 32px collapsed row, run grouping |
| `verify:dream-actions` | dreamcontext command row geometry, mark, tone | 44 assertions; the 32px measurement that caught padding drift |
| `verify:chat-scroll` | Scroll hold across reveal, settle discipline | 33 assertions; momentum + programmatic writes don't collide |
| `verify:chat-steer` | Queue state, steering, drain on idle | 82 assertions; both themes |

Every one runs the real dev server, drives real Chromium, and fails the build when the painted
artifact diverges from the rule.

## Related

- `cli-derived-action-rows` — also says "verified by measurement, not by reading the CSS"
- `tinted-surface-not-filled-swatch` — the contrast measurement that kept the highlighter's dark
  ink above 7:1
