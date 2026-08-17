---
id: git-pinned-evidence
name: "Git-Pinned Evidence (claims about code cite a repo path + commit SHA, and are verified against git)"
description: >-
  A document that claims "component X lives in src/y.ts" rots silently.
  Pin every such claim to a repo-relative path plus a full commit SHA, and
  verify the pin against the actual repository when the document is built or
  checked — an unverifiable claim is a validation error, not a footnote.
  "No invented topology." Harvested from archify's repository-evidence module
  (2026-08); speculative future application: the bookmarks layer.
tags:
  - 'kind:pattern'
  - architecture
  - 'topic:github'
pinned: false
date: '2026-08-17'
---

## Why This Exists

Documentation that references code drifts the moment the code moves, and
nothing notices: the doc still reads confidently, the reader trusts it, the
trust is misplaced. Worse, an agent generating documentation can *invent*
plausible-looking references that never existed at all.

Archify's repository-evidence module makes code references falsifiable:
a diagram node may carry `sources` (repo-relative POSIX paths) under a
`repository` block (normalized URL + full 40-char revision SHA), and the
renderer verifies each pin by actually running git — path escapes rejected,
missing paths a hard diagnostic, the revision checked out for real. Its README
sells the consequence honestly: *"truthful interaction (no invented
topology)."*

## The Pattern

1. **Pin shape**: `{ repository: { url, revision }, sources: [path, ...] }` —
   normalized URL (no `.git`, no trailing slash, lowercased), full commit SHA
   (never a branch name — branches move), repo-relative POSIX paths.
2. **Reject unverifiable pins at authoring time**: absolute paths, `..`
   escapes, `.git/` addressing, control characters — structurally invalid
   before git is even consulted.
3. **Verify against git, not against belief**: the checker runs git to confirm
   the path exists at that revision. Failure is a diagnostic (with
   `supportedFixes`: "use the intended repository and verify its revision"),
   not a warning to ignore.
4. **Degrade honestly**: when git is unavailable, report the evidence as
   unverified — never render an unverified pin as verified.

## When to Use / Avoid

- **Candidate here (not built)**: the bookmarks layer — a bookmark that
  records path + SHA at capture time stays auditable after refactors; `doctor`
  could verify pins and flag rot. Revisit when a measured miss pattern shows
  bookmark rot actually biting; until then this file is the parked design.
- **Also fits**: knowledge files that cite specific code ("the healer lives in
  feature-links.ts") in projects where that rot has caused real re-derivation.
- **Avoid** pinning things that are meant to float (a claim about "current
  main") and pinning so densely that every refactor invalidates half the
  corpus — pin the load-bearing claims, not every mention.

## Related

- [[diagnostic-repair-loop]] — evidence failures surface through the same
  diagnostic contract (`subject` / `evidence` / `supportedFixes`).
- Kin decision: graphify coexistence (task `feat(interop): graphify
  coexistence`) — same lane discipline: we point at structure truth, we don't
  rebuild AST tooling.
- Source: archify `renderers/shared/repository-evidence.mjs`
  (github.com/tt-a1i/archify, reviewed 2026-08-17).
