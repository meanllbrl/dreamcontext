---
id: know_vLcW0Ryz
name: "Decision: no Jev plugin for the validators — the browser bucket is script execution, not model thinking"
description: >-
  Measured whether TypeSafe's Jev would speed up the validators' browser step
  loop, and stopped: the loop is 47% of wall clock but 85-88% of it is
  deterministic Playwright script execution Jev cannot touch.
tags:
  - 'kind:decisions'
  - 'layer:testing'
  - 'domain:quality'
pinned: false
date: '2026-09-27'
---

# Decision: no Jev plugin for the validators

**Verdict (2026-09-27): (b) STOP.** Do not build a Jev plugin for `goal-validator` or the
verify skill. The measurement that produced it is worth keeping even though the answer is no,
because the tempting number is 47% and the number that actually decides is 9.5%.

## Why this exists

Validations felt slow, and TypeSafe's **Jev** (their "System One" model: a state plus *typed*
questions in, a probabilistic typed answer out — no text, no tool calls, claimed ~200× faster
and ~400× cheaper at classification) looked like a direct fit for the validator's inner loop:
look at the page, decide, click, look again. `jev-web-agent` already demonstrates exactly that
shape with Playwright. Rather than write the integration and find out, a spike measured the
thing first (task
`validator-larin-tarayici-adim-dongusu-jev-ile-hizlaniyor-mu-olc-bir-validasyonu-jev-ile-tekrar-kos-karar-ver`).

## What was measured

Three past `goal-validator` sub-agent transcripts (two browser-heavy, one API/CLI-heavy) were
bucketed from their own jsonl timestamps — every gap between consecutive records assigned to
exactly one bucket, so the buckets sum to wall clock. Script: `tmp/jev-spike/bucket-times.mjs`;
raw tables in `tmp/jev-spike/w1-measurement.md`.

| run | total | setup | server start | browser step loop | assert + report |
|---|---|---|---|---|---|
| R1 (browser, FAIL verdict) | 1092.6 s | 5.0% | 0% | **62.2%** (104.7 s model / 574.4 s tool) | 32.8% |
| R2 (browser, PASS) | 762.2 s | 10.8% | 0% | **79.1%** (71.5 s model / 531.8 s tool) | 10.0% |
| R3 (API/CLI, PASS) | 194.7 s | 52.4% | 0% | **0%** | 47.6% |

Average browser step loop: **47.1%** across three runs, 70.7% across the two browser runs.

## The decision, and the number that made it

The pre-registered gate said "continue if the browser step loop is ≥40% of total". The literal
number cleared it. **The gate was still the wrong question**, and the spike is more useful for
catching that than for its headline figure.

The task's premise was that validators drive the browser *step by step with the model in the
loop* — look, think, click, look again. **No run did that.** Validators execute prewritten
deterministic Playwright scripts, so **85–88% of the "browser step loop" bucket is script
execution Jev cannot touch at all.** The Jev-replaceable part is the model time inside that
bucket: **~9.5% of total** on the browser runs (9.6% R1, 9.4% R2) and **0%** on the CLI run.
A 200× speedup on 9.5% of wall clock is worth at most ~9%, for a paid external dependency, a
new key to manage, and a probabilistic answer sitting near the one thing the validator exists
to protect.

The lead put the gap between the premise and the evidence to the owner rather than proceeding
on the passing number; the owner chose **Stop: decision (b)** (AskUserQuestion, 2026-09-27).

## Where the time actually goes

The bottleneck is **script execution**, not model thinking:

- verify scripts' own scratch-vault setup and dashboard server start, inside the browser bucket;
- the Playwright run itself;
- unit tests in assert + report — one `npm test` was **276 s** in R1, alone a quarter of that run.

That is where a future optimization belongs. Nothing here needs a model at all.

## Constraints that still hold if this is ever revisited

- Jev sees the page as **text** (DOM observation); vision is undocumented. For pixel/layout
  checks (`knowledge/patterns/runtime-measurement-verification.md`) the expected gain is zero.
- A Jev plugin would have to be **optional and default-off**, with the Claude loop as fallback:
  dreamcontext ships as an npm package and cannot require users to hold a TypeSafe account.
- The validator's value is **refusing to PASS without evidence**. A probabilistic "looks done"
  may only ever be a *trigger to check now*; PASS/FAIL must still come from a DOM assertion or
  a measured value.

## The generalisable lesson

**A pre-registered gate measures the bucket you named, not the mechanism you assumed lives in
it.** The gate here was "is the browser loop ≥40%?" — and it passed while the loop it was
protecting did not exist. Before acting on a threshold, check that the bucket's *content* is
the thing the intervention would replace; decompose it one level further when an intervention
targets only part of it.

## Sources

- Task: `_dream_context/state/validator-larin-tarayici-adim-dongusu-jev-ile-hizlaniyor-mu-olc-bir-validasyonu-jev-ile-tekrar-kos-karar-ver.md`
  (`completed`, AC1–AC3 + AC10 ticked, AC4–AC9 N/A by the owner's stop; validator PASS).
- Measurement: `tmp/jev-spike/bucket-times.mjs`, `tmp/jev-spike/w1-measurement.md`.
- Jev: https://docs.typesafe.ai/introduction/coding-agents · reference loop:
  https://github.com/Shai-Koffman/jev-web-agent
- Never read: Jason Arbon, "I Put Jev in a Playwright Browser Testing Loop. It's fast, but…"
  (Medium, 2026-09) — WebFetch returned 403. The "but" in that title is still unread.

**Last verified:** 2026-09-27. Revisit only if validators start driving the browser with the
model in the loop, or if the script-execution bottleneck is removed and the ~9.5% starts to
matter.
