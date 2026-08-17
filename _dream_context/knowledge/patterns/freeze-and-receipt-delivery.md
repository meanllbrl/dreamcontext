---
id: freeze-and-receipt-delivery
name: "Freeze-and-Receipt Delivery (a passing artifact is frozen, then delivered atomically with a receipt)"
description: >-
  Once an artifact passes its final validation, freeze it — never edit it
  again. Delivery snapshots the exact bytes, re-validates the snapshot (not the
  live file), atomically commits the output, and reports a receipt: SHA-256 +
  byte counts for both source and artifact. Kills the "fixed one more thing
  after the tests passed" class of regressions. Harvested from the archify
  skill's deliver command (2026-08).
tags:
  - 'kind:pattern'
  - architecture
  - decisions
pinned: false
date: '2026-08-17'
---

## Why This Exists

The most common way a validated artifact ships broken is the post-validation
touch-up: tests pass, then someone (human or agent) "just fixes a typo" in the
artifact and delivers the edited, never-revalidated version. The validation
receipt now describes bytes that no longer exist, and nothing detects it.

Archify's `deliver` command makes that impossible by construction, and states
the rule bluntly in its agent contract: *"A passing final validation freezes
the candidate: never edit it afterward."*

## The Pattern

1. **Freeze on pass.** The final validation run marks the candidate immutable.
   Any further edit reopens the loop — validation must run again.
2. **Snapshot before render.** Delivery copies the exact specification bytes to
   a private snapshot and operates on the snapshot, so a concurrent edit of the
   live file cannot race the delivery.
3. **Validate the snapshot, not the intent.** The delivered artifact is
   produced from and checked against the snapshot.
4. **Atomic commit.** The output replaces its target only after passing —
   a failed delivery never leaves a half-written artifact behind.
5. **Receipt.** Report SHA-256 and byte counts for BOTH the source snapshot and
   the artifact. The receipt is the claim "these exact bytes passed"; anyone
   can re-hash to audit it.
6. **A non-zero exit is never success.** The deliverer may not describe a
   failed delivery as delivered — report the diagnostics instead.

## When to Use / Avoid

- **Use** for any pipeline where a validated artifact leaves the loop that
  validated it: publish steps, sleep-cycle consolidation outputs, generated
  skill/agent installs (`dreamcontext update` already regenerates from
  canonical sources — the receipt idea would let `update -y` prove
  byte-identity), release packaging.
- **Avoid** for artifacts that are *meant* to keep evolving in place (core
  files, task bodies) — freezing is for delivery boundaries, not for living
  documents.

## Related

- [[diagnostic-repair-loop]] — the repair half of the same archify contract:
  how the candidate gets to a passing state before freeze.
- Existing kin: the manifest-driven install in `install-skill.ts` restores
  tampered installed copies byte-identical on update — freeze-and-receipt is
  the same instinct, made explicit with hashes.
- Source: archify SKILL.md (Delivery section) + `bin/archify.mjs deliver`
  (github.com/tt-a1i/archify, reviewed 2026-08-17).
