---
name: mutation-test-assertions
description: >-
  A verify assertion can pass on the OLD code and still look like proof. Run the
  mutation before trusting a geometric check — ask "what would this assertion do
  under the pre-change build?" If it still passes, it's not testing what you think.
type: knowledge
tags:
  - kind:pattern
  - topic:testing
  - architecture
date: '2026-08-27'
---

# Mutation-Test Your Assertions Pattern

## Why This Exists

A verify assertion can pass on the **OLD code** and still look like proof. The symptom: you write a test that "proves" your fix works, the test is green, but when you revert the fix, the test is *still* green. It was never testing what you thought it was.

**The rule:** before trusting a geometric check, run the mutation — ask "what would this assertion do under the pre-change build?" If it still passes, it's not catching the bug.

## The Problem

Real example from the chat shelf work (bookmark `bm_TBYDLiSL`, 2026-08-27):

**The bug:** A `dream-html` placeholder pill appeared at the bottom of the message, not in the block's own slot.

**The fix:** Give the block its own slot in the transcript.

**The assertion written to prove it:**
```javascript
// "The placeholder is in the block's own slot"
const blockTop = await block.boundingBox().then(b => b.y);
const proseBottom = await prose.boundingBox().then(b => b.y + b.height);
expect(blockTop).toBeGreaterThan(proseBottom); // pill is below prose
```

**The mutation test:** What would this assertion do under the **pre-change** build (where the pill was still at the message bottom)?

Answer: **It would still pass.** Why? Because mid-stream, an open fence is always last in the text — so the prose's bottom and the pill's top sat in the same place even when the pill was wrong. The assertion was comparing two things that happened to be equal in both the broken and fixed states.

**The replacement:** A footprint claim that actually differs between the two states:
```javascript
// The slot spans the transcript measure; the card lands within 4px of it
const slotWidth = await slot.boundingBox().then(b => b.width);
const transcriptWidth = await transcript.boundingBox().then(b => b.width);
const cardX = await card.boundingBox().then(b => b.x);
const slotX = await slot.boundingBox().then(b => b.x);

expect(slotWidth).toBeCloseTo(transcriptWidth, -1); // slot IS the measure
expect(Math.abs(cardX - slotX)).toBeLessThan(4);     // card lands in it
```

This assertion **fails** on the pre-change build (the old pill was in a different container) and **passes** on the post-change build.

## The Solution — Three Steps

### Step 1: Write the assertion as usual

Document what you're testing:
```javascript
// Verify: the progress row stays at the same y-coordinate when detail opens/closes
const rowY = await getRowY();
await clickRow(); // open detail
const rowYOpen = await getRowY();
expect(rowYOpen).toBe(rowY);
```

### Step 2: Run the mutation

Check out the **pre-change** build (the commit before your fix), run the same assertion, and ask: does it fail?

```bash
git stash
git checkout HEAD~1  # or the commit before your fix
npm run verify:your-test
```

**What you want to see:**  
The assertion **fails** on the old code. This proves it's actually testing the bug you fixed.

**What you don't want to see:**  
The assertion **passes** on the old code. This means it's not testing what you think, and you need to rewrite it.

### Step 3: Rewrite if needed

If the assertion passes on the old code, ask: **what's actually different between the broken and fixed states?**

Replace the assertion with one that captures that difference. Often this means:
- Switching from a relative comparison to an absolute footprint claim
- Checking a property that only exists in the fixed state
- Comparing against a known-good constant instead of deriving two values that drift together

### Step 4: Document the mutation

In the test or commit message, note that you ran the mutation:

```javascript
// Verified by mutation: this assertion FAILS on the pre-change build
// (the old pill was in a different container and did not have this width)
expect(slotWidth).toBeCloseTo(transcriptWidth, -1);
```

## When to Use This Pattern

**Always mutation-test:**
- Geometric assertions (position, size, layout)
- Timing assertions (debounce, animation, race conditions)
- Any assertion added to prove a fix works (not just regressions)

**You can skip the mutation when:**
- The assertion is a unit test for a pure function (input/output pairs don't need mutation testing)
- The test was written before the code (TDD)
- The test has been running for months and caught multiple regressions (it's proven itself)

## Related Patterns

- `mirror-with-drift-test.md` — related in spirit (both are about tests that look like they work but don't), but different in mechanism (mirroring vs verification)
- `runtime-measurement-verification.md` — geometric assertions are the domain where mutation-testing matters most

## Evidence

- Bookmark `bm_TBYDLiSL` (salience 2, 2026-08-27) — the chat shelf pill assertion that passed on the old code
- Fixed by: rewriting the assertion as a footprint claim (slot width, card position)
- Mutation-checked in both directions: with the fix stubbed off it fails, with the fix applied it passes

## Changelog

### 2026-08-27 - Created
- Pattern created from the chat shelf pill assertion that passed on the wrong code
- Documents the three-step mutation protocol: write, mutate, rewrite if needed
