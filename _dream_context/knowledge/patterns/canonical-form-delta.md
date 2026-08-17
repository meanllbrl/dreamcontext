---
id: canonical-form-delta
name: "Canonical Form Before Delta (normalize both sides, then diff — the delta becomes a reviewable artifact)"
description: >-
  Diffing two structured documents raw drowns the real change in noise: key
  order, equivalent URL spellings, array order. Reduce both sides to a
  deterministic canonical form first (sorted keys, normalized URLs/paths,
  stable array ordering), then diff canonical-to-canonical — the delta is now
  semantic, reproducible, and small enough to attach to a PR as a review
  artifact. Harvested from archify's architecture-delta comparator (2026-08).
tags:
  - 'kind:pattern'
  - architecture
  - 'topic:schema'
pinned: false
date: '2026-08-17'
---

## Why This Exists

A naive diff of two JSON documents reports differences that aren't changes:
reordered keys, `https://github.com/x/y.git/` vs `https://github.com/x/y`,
arrays whose order carries no meaning. Reviewers learn to skim such diffs,
which is how real changes slip through. And because the diff depends on
accidental byte order, it is not reproducible — two runs over the same
semantic change can render differently.

Archify's `compare` command (Architecture Delta for PR review) solves this
with a strict two-step: canonicalize, then compare.

## The Pattern

1. **Canonical form** — a pure function over the document:
   - objects: keys sorted (stable codepoint order);
   - meaning-free arrays: sorted by a canonical key (id, or the canonical
     serialization of the element itself);
   - equivalent spellings normalized (trailing slashes, `.git` suffixes,
     case-insensitive hosts, path separators);
   - volatile fields that are not part of identity (output paths, timestamps)
     deleted before comparison.
2. **Equality = canonical equality.** Two documents are "the same" iff their
   canonical serializations match — byte equality of raw files is neither
   necessary nor sufficient.
3. **Delta over canonical forms.** Compute added/removed/changed against the
   canonical sides, and version the comparator itself (archify stamps
   `COMPARATOR_VERSION`) so old deltas remain interpretable.
4. **The delta is an artifact.** Render it (before/delta/after) and attach it
   to the PR — the reviewer reads the semantic change, not the byte noise.

## When to Use / Avoid

- **Use** when structured state is compared across time or across writers:
  sync reconciliation, config drift detection, release-over-release comparison
  of any JSON store (CHANGELOG.json, taxonomy.json, roadmap state).
- **Already applied here** in spirit: the brain-sync engine's deterministic
  merge keys entities by `dcId` and reconciles JSON stores structurally rather
  than textually — see the sync identity decision below.
- **Avoid** when byte fidelity IS the contract (installed-copy tamper checks
  want byte identity, not semantic identity), or when arrays are ordered
  semantically (changelogs are LIFO — sorting them destroys meaning; canonical
  form must preserve meaningful order).

## Related

- [[decision-sync-identity-and-reconciliation]] — dreamcontext's existing
  structural-reconciliation decisions; this pattern names the general shape.
- [[freeze-and-receipt-delivery]] — receipts hash exact bytes; deltas compare
  canonical meaning. The two answer different questions (integrity vs change).
- Source: archify `delta/architecture-delta.mjs` (`canonicalArchitecture`,
  `COMPARATOR_VERSION`) (github.com/tt-a1i/archify, reviewed 2026-08-17).
