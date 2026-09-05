---
id: unrecognized-shape-returns-null
name: "Unrecognized Shape Returns Null (unknown is not zero, and success-shaped failure is worse than a hang)"
description: >-
  When reading a signal you do not own — another process's frame, a CLI's exit code, a third-party
  payload — an unrecognized or absent shape must return null, and every caller must treat null as
  UNKNOWN rather than as zero/healthy/allowed. Guessing from the envelope turns a missing field
  into a confident wrong answer that no exception ever surfaces.
type: knowledge
tags:
  - "kind:pattern"
  - "kind:architecture"
  - "layer:backend"
  - "domain:quality"
pinned: false
date: "2026-09-05"
updated: "2026-09-05"
---

## Why This Exists

Two independent defects in the multi-account work (2026-09-05) had exactly one shape: **an absent
or unrecognized signal was converted into a confident wrong value.** Neither threw. Both were
found only because a human noticed the product behaving impossibly.

**Case 1 — the frame that was read as its own payload.** The Claude CLI emits a
`rate_limit_event` on EVERY turn; it is a METER, not a refusal. Its payload lives under
`rate_limit_info`. The reader looked for `rate_limit` / `event`, did not find them, and fell back
to `payload = obj` — the frame itself. So `toWindow(obj.type)` became `toWindow('rate_limit_event')`
→ `window: 'unknown'`; `obj.resetsAt` did not exist → a DEFAULT cooldown marked `estimated: true`;
no reason, no status, no detail. Every message then disqualified its own account, auto-switch moved
to the next one, that account's first turn exiled it too, and the user was told **"Every account is
at its limit"** while the measured utilizations were 7% and 19%.

Three traps sat inside that one healthy frame: (a) the payload key was not the frame's name;
(b) `overageStatus` reads `"rejected"` on a healthy turn too — overage is a separate, org-level
disabled facility, so a reader that consults it instead of `status` rejects everything forever;
(c) treating the frame as its own payload is precisely the act of turning a missing field into a
confident wrong answer.

**Case 2 — the probe that succeeded at failing.** A `/usage` probe run in an identity-less or
broken sandbox does not error: exit code 0, `is_error: false`, `subtype: 'success'`, an empty cost
summary, and no cache write. **Worse than a hang, because it looks like success.** An
implementation trusting the exit code reads a logged-out account as healthy.

## The Pattern

1. **Recognize the shape explicitly; return `null` when you do not.** No envelope fallback, no
   "close enough" key. The reader's job is to say *"I know what this is"* or *"I do not"*.
2. **`null` means UNKNOWN at every caller, never zero / healthy / allowed.** In the account picker
   this is written as a rule: an `unknown` or `stale` reading is not a candidate and is never
   counted as zero. Unknown must be *unusable*, not *optimistic*.
3. **Never trust an exit code as a health predicate for a thing the process does not exit over.**
   Assert on the CONTENT the success was supposed to produce (a written cache, a non-empty
   summary, a signed identity), and classify "exited 0 with nothing" as its own state.
4. **Distinguish the status field from its neighbours.** A payload usually has several fields that
   look like verdicts (`status`, `overageStatus`, `isUsingOverage`). Pick the authority
   deliberately and write down why the others are not it — the near-miss field is what the next
   reader will grab.
5. **Pin the real shape verbatim in a test.** Replace invented fixtures with a CAPTURED frame from
   a real run: one healthy, one genuinely rejected. Then assert the negatives by name — "a meter is
   not a refusal", "`overageStatus` is not `status`", "an unrecognized status is silence".
6. **Measure the baseline, don't assume it.** The fix was verified by running 15 captured frames
   through both readers: 0 rejections from the new one, exactly 1 (`{window:'unknown',
   resetsAtMs:null}`) from the old — which matched the two poisoned records on disk field for
   field. That correspondence is what proves the diagnosis, not the green suite.

## The Tension With `forward-compatible-field-cast`

They are not in conflict, but the boundary matters. `forward-compatible-field-cast` says: read a
field that does not exist YET through a typed cast with a benign fallback, so two features can ship
in parallel. That is safe because the fallback is a **presentation default** on a field you own the
roadmap for. This pattern governs **safety-bearing reads of signals you do not own**, where the
fallback would be a verdict. Rule of thumb: if being wrong changes what the system DOES (gates,
switches, refusals, spend), there is no benign default — return null.

## When to Apply

- Parsing another process's stream frames, protocol messages, or webhook payloads.
- Reading a CLI's result when the CLI can succeed at doing nothing.
- Any reading that feeds a gate: rate limits, auth state, quota, permission, health.

Do not apply to cosmetics — a missing display label may absolutely fall back to a placeholder.

## Related

- `presentation-field-must-not-double-as-safety-predicate` — the sibling failure: a field that IS
  well-formed, but was computed for display and then reused as a gate.
- `runtime-measurement-verification` §7 — the same error class one level up: a measuring harness's
  own limits arriving disguised as the subject's faults.
- `knowledge/features/claude-multi-account.md` — where both cases shipped.
