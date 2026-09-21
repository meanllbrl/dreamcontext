---
id: know_ln2iP5_k
name: patterns/test-a-diagnosis-where-it-predicts-success
description: >-
  A diagnosis that explains the symptom is a hypothesis. Test it at a case where
  it predicts the bug should NOT happen — an incomplete-but-real explanation is
  more dangerous than none, because it stops you looking and its fix passes
  review.
tags:
  - 'kind:pattern'
  - 'domain:correctness'
  - onboarding
pinned: false
date: '2026-09-21'
---

## Why This Exists

`dreamcontext app status` reported `running: no` about an app the owner was looking at. The
brain already held a diagnosis, written months earlier and measured at the time:

> macOS `pgrep -f` matches only the first ~66 characters of a process's argument string. At
> `/Users/<user>/Applications/dreamcontext-beta.app/Contents/MacOS/` the marker occupies
> chars 35..72, so it straddles the cutoff and can NEVER be seen.

Real, reproducible, and it explained the symptom completely. The obvious fix follows directly:
shorten the marker so it fits inside the window.

**That fix would have shipped broken.** The app this time was running from `/Applications`,
where the same marker sits at chars 15..51 — comfortably inside any truncation window. The
theory predicts it should work there. It did not work there.

So I measured what pgrep could see at all:

```
ps -A            → 660 processes
pgrep -f .       → 644 processes      # the universal pattern
the running app  → in the 16-process difference
```

No pattern found it. Not the full 71-character path, not `dreamcontext-desktop`, not a
five-character prefix. `ps` listed it with full argv in the same shell, same uid, process
alive. Truncation was never the whole story, and a shortened marker would have passed at one
install path and failed at the other — with the old explanation in the commit message,
sounding authoritative.

The real fix was to stop asking `pgrep` and read `ps`.

## The Pattern

**A diagnosis that explains the symptom is a hypothesis, not a cause. Test it at a case where
it predicts the bug should NOT happen.**

If the bug happens there too, the diagnosis is incomplete — however well it fits the case you
started from, and however carefully it was measured.

```
theory: "the marker straddles pgrep's 66-char window"
        → so at a path where it does NOT straddle, the check must work
        → measure THAT path
        → still broken ⇒ the theory is a symptom, not the cause
```

One extra measurement, chosen because it could FALSIFY the explanation rather than confirm it
again.

## Why An Incomplete Diagnosis Is Worse Than None

With no explanation you keep looking. With a plausible, documented, previously-measured one
you stop — and you stop holding a fix that is correct about a real mechanism and wrong about
this bug. It then survives review, because the reasoning IS sound; it just is not sufficient.

The tell is always the same shape: **the explanation is about a boundary, and the failure also
occurs away from the boundary.** A 66-char cutoff, a 25 MB cap, a timeout, a race window — if
the bug reproduces where the boundary is not in play, the boundary is not the cause.

## Applies Beyond Debugging

The same move belongs anywhere an inherited explanation is load-bearing: a task body, a
knowledge file, a code comment stating why something is the way it is. Those are evidence
written by someone who measured once, under conditions that may no longer be yours. Re-measure
at the case that would prove them wrong before building on them.

Here the inherited note was this project's own, written honestly, with numbers. It was still
only half the answer. The correction is now recorded on that task rather than left for the
next person to re-derive.

## Anti-patterns

- **Confirming the theory again at the case you already know fails.** That measurement cannot
  change your mind, so it buys nothing.
- **Treating "previously measured" as "still true".** Conditions drift — install paths,
  versions, sandboxes.
- **Fixing the boundary.** Shortening the marker, raising the cap, widening the timeout: if
  the bug lives away from the boundary too, you have moved it, not removed it.
