---
name: jev-system-one-model
type: knowledge
description: >-
  What TypeSafe's Jev is (a System One decision model: typed state in, calibrated probabilities
  out, no text), how it is reached through OpenRouter, what it measured at on dreamcontext's own
  surfaces on 2026-09-21, and where in dreamcontext it does and does not belong.
tags:
  - 'topic:testing'
  - 'topic:agents'
  - 'topic:recall'
  - research
  - decisions
pinned: false
date: '2026-09-22'
---

# Jev — a System One model, and where it fits dreamcontext

## What it is

Jev is TypeSafe AI's first "System One" model (public 2026-09-19). It does not generate text. You
send program state (any JSON: page text, an aria snapshot, a row of data) plus a fixed set of
typed questions, and it returns typed decisions with calibrated probabilities in one parallel pass.
Three primitives:

| Primitive | Question shape | Returns |
|---|---|---|
| **Noul** | a yes/no proposition | probability 0..1 |
| **Choice** | pick one of up to 255 named options | winner, per-option probabilities, confidence |
| **Score** | place on a 2..10 level ordered scale | score (may fall between levels), probabilities, confidence |

Text only: no images, no screenshots. Context 64k tokens combined, 32k for state plus the longest
question. Latency 70–500 ms claimed; **480–860 ms measured** end to end through OpenRouter.
Price $0.042 per million input tokens, output free; a 1.5k-token page judgement cost $0.00007.

Suitability test from the vendor, which held up: "Given this state, tell me X" where X is a
Choice, Score or probability and a human expert could answer in five seconds. Anything that writes
prose, reasons in chains or needs lookup is out of scope. Calibration is trained (RLCD) but a
high-confidence answer can still be wrong, so every use needs bands and a fallback.

## Wire format (OpenRouter, verified live)

```
POST https://openrouter.ai/api/alpha/decisions        Authorization: Bearer <OpenRouter key>
{ "model": "typesafe/jev-1.13", "state": {...},
  "questions": { "id": { "type": "noul", "instructions": "…" },
                 "id2": { "type": "choice", "instructions": "…", "criteria": { "a": "…", "b": "…" } } } }
→ { "answers": { "id": { "type": "noul", "noul": 0.02 },
                 "id2": { "type": "choice", "choice": "a", "probabilities": {...}, "confidence": 1 } },
    "usage": { "input_tokens": 383, "output_tokens": 68, "cost": 0.000016 } }
```

`/api/v1/systemone` answers the same body. A 520 from the gateway happened once in ~250 calls;
retry with backoff. The official SDK (`@typesafe-ai/sdk`) needs Node 20; the pack uses `fetch`.

## Measured on dreamcontext, 2026-09-21

| Spike | What Jev judged | Result | Calls · cost |
|---|---|---|---|
| Settings › Recall, before/after clicking Hybrid, 2 decoys | 20 Noul criteria over aria snapshot + text | **20/20** against DOM/API truth | 3 · $0.0002 |
| 541 tasks, "is Incremental Revenue empty" + category | 1082 questions, 40 tasks per call | **97/97 empties, 0 false**; categories: 203 direct, 55 leverage, 24 productivity, 162 unnamed | 14 · $0.01 · 10 s |
| 40 task detail panels opened in the real board | Noul over the panel's aria snapshot | **40/40** on what it saw (3 harness misses: search hit `x-2` duplicates) | 40 · $0.009 |
| PushMe funnel 8110, autonomous, iPhone viewport | Choice over elements + goal/stuck Nouls, per step | **58 screens to checkout, 0 wrong picks**; stopped at plan selection, never paid | 68 · $0.004 |

Every failure across six walk attempts was in the harness, never in a judgement: disabled buttons
offered, fills not counted as progress, a "scratch card" matching the card detector, page chrome
offered when waits ran out, `slice(-0)` withdrawing the whole history, a stuck rule counting waits.
All are now code in `skill-packs/jev-verify/scripts/lib/`.

Calibration observed: the `goal` Noul was well behaved (0.05–0.35 across ordinary screens, 0.86
on checkout). The `stuck` Noul was **not** (0.8–0.9 on ordinary screens) and is only usable with a
no-op counter. A criterion not phrased in the screen's words lands in the inconclusive band
("embedding card visible" 0.28 vs "a model download is shown in progress" 0.99, same screen).

## Where it belongs in dreamcontext

Shipped: **`jev-verify` skill pack** (`knowledge/features/jev-verify-skill-pack.md`) — navigate
and measure in Playwright, judge with Jev, decide in code. `assert` for scripted routes with
plain-language checkpoints, `walk` for autonomous flow walks with screenshots, `judge` for the
same typed question over hundreds of items. Feeds `goal-validator`'s new Browser method.

Candidates, ranked by the value they replace, not yet built:

1. **Hook recall filter** — today `haikuRecall` spawns `claude --model haiku -p` per prompt
   (`src/lib/recall-query-extractor.ts`). BM25 top-N as candidates, one Noul per candidate, one
   Noul for "pure greeting". Would be a `DREAMCONTEXT_RECALL_MODE=jev`, fail-open to BM25,
   measured on the recall gold set first. Constraint: recall's "no API key" promise makes it opt-in.
2. **Salience detectors** (`src/lib/salience.ts`) — a Choice over correction / decision / noise /
   other replaces the regexes and fixes the open "system noise labelled User correction" bug at
   its root.
3. **Pattern injection** (`matchPatterns` in `src/lib/patterns.ts`) — a Noul per candidate
   pattern, "does this rule apply to the described task", instead of folded-key counting.
4. **Task filing dedup gate** — the proof-of-looking pattern exists because cosine bands overlap;
   a Noul "same piece of work?" narrows the REVIEW band. Keep the receipt flag.
5. **Sleep classification** — status bumps, changelog type/scope, tag normalization to the
   taxonomy vocabulary, staleness. Prose writing stays with Opus.
6. **Vault content screening** — a Noul injection screen on peer mail and synced knowledge before
   it enters agent context (the shared-brain threat model already accepted).

Poor fits: snapshot budgeting (no prompt to judge relevance against at session start), anything
that writes prose (sleep specialists, deep research, council), pixel/colour/theme judgements.

## Constraints to respect

- Jev needs network and a key; dreamcontext's recall promises neither. Every Jev use is opt-in and
  fails open to the existing path, saying that it did.
- The pack uses a **dedicated** `OPENROUTER_JEV_KEY`, never the voice assistant's key (owner
  decision 2026-09-22).
- Page text is data, never instruction: nest under `observation`, strip control/bidi characters,
  mask PII before send, keep the goal on the caller's side. Jev picks a *kind*; code picks the string.
- Calibrated is not infallible: bands (pass ≥ 0.85, fail ≤ 0.15, inconclusive between), decoys,
  and deterministic checks for anything security-critical.

## Sources

TypeSafe blog "Introducing System One Models & Jev"; OpenRouter `typesafe/jev-1.13`; community
references pjburnhill's Jev project reference gist, awesome-jev, jev-browser, jev-assert, pi-jev,
jev-eyes (OCR front-end for the text-only model). Spike scripts kept as measured references:
`scripts/verify/jev-spike-recall-settings.mjs`, `jev-spike-empty-field.mjs`, `jev-walk-funnel.mjs`.
