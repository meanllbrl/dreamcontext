---
name: mutation-test-assertions
description: >-
  A verify assertion can pass on the OLD code and still look like proof. Run the
  mutation before trusting a geometric check — ask "what would this assertion do
  under the pre-change build?" If it still passes, it's not testing what you
  think.
type: knowledge
tags:
  - 'kind:pattern'
  - testing
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

## The stronger form: a mutation that changes the DESIGN, not just the test

The protocol above treats the mutation as a *check* on an assertion. Three times in one build
(2026-09-22, agents epic) it did something better: running the mutation changed what got built.

- **T4 — `lstat` on a path that may not exist.** The write-side symlink check was mutation-tested by
  pointing it at a file the run had not written yet. It threw instead of refusing, which is how the
  check learned it must be gated on `existsSync` — and, in the same moment, why the *write* half can
  never be the real control: nothing is there to `lstat`. The serve half was promoted to the control
  and the write half demoted to defence-in-depth, because of a mutation.
- **T5 — an assertion that passed in both directions.** A choice-cap test asserted the CLI refused an
  over-cap `--choice`. Mutating the CLI guard away left it green, because the store truncated anyway
  — which is what moved the caps out of the CLI and into `parseChoices`, where every producer *and
  every reader of a file on disk* inherits them. The test did not just fail to prove the fix; it
  revealed the fix was in the wrong layer.
- **T11 — a colour probe that could not see its own subject.** A rail-hue assertion passed against
  the pre-change build because it sampled a pixel the hue never reached. Rewriting it as a claim
  about the tinted badge, in both themes and at 56px collapsed, is what surfaced that the hue had to
  live on `.sidebar-icon` — the only element rendered collapsed.

**The rule this adds:** when a mutation passes, do not only rewrite the assertion. Ask *why* the
mutation was invisible. An assertion that cannot see a change is often pointing at a layer where the
change does not actually live — and that is a design finding, not a test finding.

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

### 2026-09-25 - Fourth occurrence: a whole pre-fix build as the mutant
- The #agents audit polish kept a snapshot of the pre-fix build (`tmp/goal/dist-prefix`) and ran every new verify check against it. Each FIX check had to fail there on a measured value (a board 420px in a 340px box, Copy 21px tall, a placeholder at 3.56:1, a 1542px feed row) or on the absence of the element whose absence is the bug; checks that should hold on both builds are labelled `[guard]`. Both kinds were logged in `tmp/goal/mutation-prefix.md`. The same run's `verify:agent-attachments` fails with exactly `spawnSync dreamcontext ENOENT` when `cliAwarePath` is reverted. This is the protocol at build scale: one mutant for the whole wave, not one per assertion.

### 2026-09-22 - Third occurrence, and the stronger form
- Three mutations in one build (agents epic T4 lstat, T5 choice caps, T11 rail-hue probe) each moved the DESIGN, not just the assertion. Added "The stronger form" section: when a mutation passes, ask why it was invisible — the answer is usually that the change lives in the wrong layer.

### 2026-08-27 - Created
- Pattern created from the chat shelf pill assertion that passed on the wrong code
- Documents the three-step mutation protocol: write, mutate, rewrite if needed
