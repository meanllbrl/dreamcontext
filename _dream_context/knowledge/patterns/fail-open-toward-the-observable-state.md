---
id: fail-open-toward-the-observable-state
name: "Fail Open Toward the Observable State (a silent mode is indistinguishable from a broken one)"
description: >-
  When a guard, probe or permission check degrades, you still have to pick a direction. Pick the one
  whose failure the user can SEE or HEAR. Failing closed on an optional safeguard converts a
  cosmetic problem into a silent one — and a feature that is silently off looks exactly like a
  feature that is broken, so nobody reports it and nobody can debug it.
type: knowledge
tags:
  - "kind:pattern"
  - "kind:architecture"
  - "domain:quality"
  - "layer:backend"
pinned: false
date: "2026-09-11"
updated: "2026-09-11"
---

## Why This Exists

Three guards in the J.A.R.V.I.S voice work degraded for three unrelated reasons — an unmeasurable
signal, an unreachable route, a refused OS permission — and in all three the CORRECT answer was the
same, and in all three the reflex answer was the opposite.

- **The silence gate fails open when there is no measurement.** The gate refuses a take it believes
  heard nothing. When the analyser returns no measurement at all (a suspended `AudioContext`, as
  actually happened), "no measurement" is not "silence": failing closed refused every take however
  loudly it was spoken, and said nothing about why. Failing open costs one wasted transcription.
- **The audio-focus hold fails open toward SPEAKING** (`OPEN_GRANT`, a 4s timeout well under the
  ~1.3s a chunk spends generating, a `keepalive` release that is never awaited). A `/focus` route
  that is down, slow or 403 costs at most an answer read over music. Treating a failed hold as "you
  may not speak" turns a cosmetic problem into a silent mode.
- **A refused Apple event (-1743) leaves the music alone and reads the answer anyway**, and the
  refusal is REMEMBERED rather than retried every turn. The user still gets the feature; they just
  do not get the courtesy.

The same week, in an unrelated subsystem, the connector store landed on the read side of the same
line: **reads are lenient, writes are strict** — one malformed manifest degrades instead of
throwing, so a single bad file cannot blind the whole feed.

## The Pattern

1. **Name the two failure costs out loud before choosing a direction.** Not "is this safe?" but
   "what does the user experience in each direction?" The voice route's first justification was
   wrong because it measured the wrong axis ("it doesn't spend money") — the real axis was what the
   user hears when it fails.
2. **Degrade toward the outcome that is OBSERVABLE.** Music over an answer is reportable. Silence is
   not. A wasted API call is reportable. A key that appears to do nothing is not.
3. **This applies to OPTIONAL safeguards and courtesies, NOT to safety rules.** A guard whose whole
   job is to stop something irreversible fails CLOSED — in this same feature, "a changed transcript
   is never auto-submitted" holds even when every other check is unavailable. The test: does failing
   open risk an action the user cannot undo? Then it is not this pattern.
4. **Remember the refusal, don't re-ask.** A permission that said no will say no again; retrying per
   turn spends latency on a known answer and trains the user to ignore the dialog.
5. **Put a ceiling on the open path.** Failing open is not failing forever: the watchdog reclaims a
   turn whose heartbeat stopped, and `MAX_SILENCE_MS` bounds how long the machine can stay altered.
   Open with a timer, not open indefinitely.

## Boundary with the neighbouring pattern

`[[patterns/unrecognized-shape-returns-null]]` governs **reading**: an absent or unrecognized signal
must be reported as UNKNOWN, never coerced into zero/healthy/allowed. This pattern governs **acting**
once you already know the check is unavailable: which way to degrade. They compose — read honestly
(`null`), then degrade toward the visible state.

## Evidence

`src/lib/voice/audioFocus.ts` (`OPEN_GRANT`, `HOLD_TIMEOUT_MS`, `MAX_SILENCE_MS`, the watchdog),
`dashboard/src/lib/voice/useVoiceCapture.ts` (the fail-open silence gate), `c69ed2c1`, `b2210600`,
and `[[features/jarvis-voice-mode]]`'s Constraints & Decisions for 2026-09-08 / 2026-09-11.
