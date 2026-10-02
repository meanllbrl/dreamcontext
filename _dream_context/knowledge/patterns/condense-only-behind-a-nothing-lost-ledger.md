---
id: know_t3TFlVSz
name: patterns/condense-only-behind-a-nothing-lost-ledger
description: >-
  Shrinking an instruction file — a skill, an agent prompt, a reference doc — is
  only safe behind a mechanical ledger that proves every unit of the old text
  was kept, reworded, or recorded under the heading that now carries it. A
  condensation that rewords a load-bearing rule away looks like a success and
  surfaces sessions later as an agent that stopped following a rule nobody can
  find. Fires on: condense, slim, shorten, shrink, trim, kısalt, "this file is
  too long", "over the byte ceiling", rewrite the prompt smaller.
triggers:
  - condense
  - slim
  - shorten
  - shrink
  - trim
  - kısalt
  - nothing-lost
  - byte ceiling
  - too long
tags:
  - 'kind:pattern'
  - 'topic:skills'
  - 'topic:agents'
  - testing
pinned: false
date: '2026-10-02'
---

# Condense only behind a nothing-lost ledger

## Why this exists

An instruction file hits a ceiling — a byte cap, a context budget, a reviewer saying
"this is unreadable" — and the obvious move is to rewrite it shorter. **That move has
no failure signal.** The file gets smaller, every test still passes, the build is clean,
and the rule that was quietly reworded into nothing fails weeks later as "the agent
doesn't do X any more", with nobody able to say when it stopped.

It has happened twice here:

- **2026-09-30, `11be45a0`** — a SKILL.md condensation reworded the sleep-specialist
  rationale away. It was caught by a human noticing, not by a gate, and had to be
  restored in a follow-up commit titled exactly that.
- **2026-09-30, `42ae4f24` / `521faeff`** — the instructions wave cut SKILL.md 73.5 →
  45.7 KB, the three sleep specialists 42/40/32 → 23/22/18 KB, and
  `skill/references/sleep-specialists.md` 80.7 → 26.7 KB. This time the cut ran behind
  `eval/instructions-slim/nothing-lost.mjs`, and the second pass **ledgered 431 dropped
  units** with the heading that now carries each one.

The difference between the two is not care. It is whether a machine was asked.

## The pattern

1. **Split the OLD text into units before touching it** — a rule, a decision, an
   example, a dated incident. The unit is whatever a reader could act on alone.
2. **Classify every unit into exactly one of three buckets**, and let nothing fall
   outside them:
   - **Kept** — present in the new text, verbatim or near enough to match.
   - **Reworded** — present, differently phrased; the eval accepts it because a
     human asserted the mapping, once, in the ledger.
   - **Ledgered** — deliberately moved out, recorded with **the file and heading that
     now carries it**. "Removed because it was redundant" is not a ledger entry; "now
     under `sleep-fanout-architecture.md` § Specialist prompt history" is.
3. **The eval exits non-zero on an unclassified unit** and runs as a gate, not a
   one-off script. A ledger nobody re-runs decays into a changelog.
4. **Shrink the right thing.** Rationale, worked examples and dated incidents belong in
   a reference or a feature file; the instruction file keeps the CONTRACT. The
   instructions wave moved rationale to `skill/references/sleep-specialists.md` and
   history to the feature PRD — both still recallable, neither spending the agent's
   context on every run.

## When it applies

Any text an agent is told to obey and a budget is forcing smaller: a skill, a sub-agent
prompt, a hook-delivered reminder, a CLAUDE.md block, a reference doc. It does **not**
apply to prose nobody executes — a README can simply be rewritten.

## The tell that you need it

You are about to say "this is just a wording pass" about a file that encodes rules. The
smaller an edit feels, the less likely anyone will diff it closely.

## Related

- `mirror-with-drift-test` — the same instinct for copies that must stay equal;
  this one is for text that must stay *complete*.
- `hook-delivered-must-not-miss-rules` — where a rule should live when it must never
  be lost to budget pressure in the first place.

## Sources

- `eval/instructions-slim/nothing-lost.mjs` — the implementation.
- Commits `11be45a0` (the loss), `42ae4f24` and `521faeff` (the gate).
- `knowledge/features/sleep-fanout-architecture.md` § "A specialist loads a contract,
  not a manual".

## Last verified

2026-10-02 (the instructions wave shipped in 0.30.0; the eval exits 0 on the current
tree).
