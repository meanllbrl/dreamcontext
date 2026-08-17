---
id: diagnostic-repair-loop
name: "Diagnostic-Driven Repair Loop (machine-readable errors the agent repairs by choosing, not guessing)"
description: >-
  A validator that only says "invalid" sends the agent into a guess-and-retry
  spiral. Emit every failure as a machine-readable diagnosis — subject (what is
  broken), evidence (measured proof), supportedFixes (repairs to choose from) —
  and bind the consumer to one diagnosed repair per round, stopping honestly
  when the objective error count stops improving. Harvested from the archify
  skill's validator receipts (2026-08); first dreamcontext application:
  `doctor --json`.
tags:
  - 'kind:pattern'
  - architecture
  - 'topic:cli'
  - 'domain:quality'
pinned: false
date: '2026-08-17'
---

## Why This Exists

The default failure mode of an agent facing a failing validator is the guess
loop: change something plausible, rerun, change something else, drift further,
and finally either "fix" the check by weakening it or claim success that the
tool never granted. The root cause is that the error channel carries prose for
humans, not decisions for machines — the agent must *infer* what is broken,
*infer* what proof exists, and *invent* the repair.

Archify (tt-a1i/archify, MIT) closes this loop structurally: every validation
failure is a typed diagnostic — `code`, `severity`, `message`, `subject`,
`evidence`, `supportedFixes` — and its SKILL.md binds the agent to a repair
contract on top of it. The result is a repair loop that converges or stops,
never wanders.

## The Pattern

**Producer side** — every failure a tool reports carries:

- `code` — a stable namespaced slug (`doctor/core-file-ceiling`). Consumers
  route and dedupe on it; messages may be reworded, codes may not.
- `subject` — what is broken: the file, entity, or field. Never make the
  consumer parse it out of the message.
- `evidence` — the measured proof: bytes counted, refs that failed to resolve,
  the matched placeholder. Evidence is data the tool *observed*, not opinion.
- `supportedFixes` — concrete repairs the consumer may pick from. If a
  deterministic healer exists, its exact command is the first entry.

**Consumer side** — the agent contract:

1. Repair only the diagnosed `subject`, choosing from `supportedFixes`.
2. One diagnosed repair per round, then re-validate. No batching of guesses.
3. Track the objective error count. Continue while it reaches a new minimum.
4. If two consecutive rounds fail to improve the best count, STOP and report
   the unresolved diagnostics truthfully. Never weaken the check to pass it.

## When to Use / Avoid

- **Use** wherever a tool validates agent-produced or agent-repaired artifacts:
  `doctor --json` (shipped), the excalidraw scene audit (candidate), any future
  lint/verify surface consumed by sub-agents (curator-verifier,
  initializer-verifier, curator-worker).
- **Avoid** for human-only output — don't bloat interactive prose with JSON —
  and don't fabricate `supportedFixes` the tool cannot stand behind: a wrong
  "supported" fix is worse than none, because the contract tells the agent to
  trust it.

## Related

- First application: `doctor --json` — see the dreamcontext skill's
  cli-reference (What `doctor` checks) for the shipped contract.
- [[freeze-and-receipt-delivery]] — the delivery half of the same archify
  contract: what happens after validation finally passes.
- Source: archify SKILL.md + `renderers/shared/diagnostics.mjs`
  (github.com/tt-a1i/archify, reviewed 2026-08-17).
