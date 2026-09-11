---
id: proof-of-looking-gate
name: "Proof-of-Looking Gate (when a threshold's bands overlap, refuse unless the caller names the match back)"
description: >-
  A similarity/heuristic gate whose signal and noise bands OVERLAP cannot decide.
  Do not pick between a hard refusal (silently blocks legitimate work with no exit)
  and a free bypass (no gate at all): refuse UNLESS the caller passes back the
  identity of the thing the gate matched. Naming it is the proof it looked. Set the
  floor LOW on purpose, because a false alarm then costs one read, not a lost outcome.
type: knowledge
tags:
  - "kind:pattern"
  - "kind:architecture"
  - "topic:agents"
  - "domain:quality"
pinned: false
date: "2026-09-11"
---

# Proof-of-Looking Gate (when a threshold's bands overlap, refuse unless the caller names the match back)

## Why This Exists

Two things are usually true at once about an automated gate: the thing it is trying to catch is real, and the score it has to catch it with does not separate cleanly. Measured on this repo's own task corpus (e5-small q8, short-vs-short), *same-idea* pairs bottom out at cosine **0.8256** while *distinct* pairs top out at **0.8984** — the bands overlap, so **no threshold exists** that refuses every bad case and admits every good one.

The two obvious responses are both wrong:

- **Hard refusal at some cutoff.** Legitimate work is blocked with no exit the caller can reach. Worse, the block is silent-by-design — the caller learns only that it failed, never that the gate was uncertain. This is how a gate gets an environment variable that turns it off permanently.
- **Advisory / warn-only.** The caller learns to scroll past it. A directive that fires wrongly is a directive agents stop reading — the same failure that killed the description-prose trigger experiment in `patterns-auto-injection`.

## The Pattern

**Refuse, but publish the exit — and make the exit cost exactly one act of attention: naming what the gate matched.**

```
gate fires (score ≥ FLOOR)
  → REFUSE, printing the matched item's identity AND its evidence (the reason, the neighbour, the date)
  → the caller may retry with `--<thing>-checked <identity>` naming EXACTLY that item
  → a wrong or absent name still refuses
```

The caller cannot produce the identity without receiving the refusal, and cannot produce the *right* identity without having read what the refusal said. That is the whole enforcement: **the flag is not a bypass, it is a receipt.**

Concrete instances in this repo (`src/lib/task-filing-bar.ts`, 2026-09-11): the review-band neighbour gate is lifted by `--neighbor-checked <slug>`; the semantic declined-idea gate is lifted by `--declined-checked <key>`. Compare `dreamcontext embed dedup`'s **REVIEW** verdict, which names the neighbour and asks the agent to decide — the same shape, one layer up.

## Rules that make it work

1. **Set the floor BELOW the overlap, not inside it.** Once a false positive costs one read instead of a lost outcome, misses are the expensive error and false alarms are cheap. (`DECLINED_MATCH_THRESHOLD = 0.82`, under the measured same-idea minimum of 0.8256.)
2. **The refusal must carry the evidence, not just the verdict.** "Looks like a declined idea" teaches nothing; "Declined on 2026-09-04: *offline mode* — the owner dropped it because the sync story isn't settled" is what makes naming it back meaningful.
3. **Keep ONE unconditional gate beside it.** Where the match is *exact* (a slug equality, a tombstone hit), there is no uncertainty and therefore no exit: refuse outright. The proof-of-looking treatment is only for the band where the score genuinely cannot decide.
4. **Never let a proof-of-looking gate be lifted by a generic `--force`.** A blanket override is the free bypass you were avoiding; the escape must be item-specific.
5. **Fail OPEN and SAY SO.** When the gate cannot run at all (model absent, index missing, disabled), pass and print that it was skipped. Silence is otherwise read as a clean check — the caller cannot tell a gate that passed from a gate that never ran.
6. **Watch for saturation.** If the review band eventually matches nearly everything, the naming flag degrades into a reflex and the gate is decorative. Measure it periodically against real candidates and tune the floor; the gate's value is in being *sometimes* silent.

## When NOT to reach for it

- The score separates cleanly (measure before assuming it doesn't) → just refuse.
- The caller is a **human at a form**, who cannot be asked to paste an identity string back → short-circuit before the gate entirely, as the dashboard's `by: 'human'` path does.
- There is no stable identity to name (no slug, no key) → invent one first, or the receipt is unverifiable.

## Related

- `knowledge/patterns/presentation-field-must-not-double-as-safety-predicate.md` — a gate must be named for what it actually gates.
- `knowledge/patterns/unrecognized-shape-returns-null.md` — the fail-open sibling: unknown is not "allowed".
- `knowledge/features/sleep-consolidation.md` — the shipping instance and its measured bands.
