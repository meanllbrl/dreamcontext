---
name: patterns/a-delete-is-never-inferred-from-absence
description: >-
  When one side of a sync, merge or transfer lacks a path the other side has,
  that absence is NOT an instruction to delete — it is a report to write. And a
  delete the user does ask for must stay recoverable: a trash with a restore, a
  backup before an overwrite, a receipt that names what went. Fires on: delete,
  remove, wipe, prune, clean up, trash, overwrite, "the other side doesn't have
  it", "missing on the cloud", "it deleted my file", sil, silindi, geri gelsin.
triggers:
  - delete
  - remove
  - wipe
  - prune
  - trash
  - restore
  - overwrite
  - missing on the other side
  - sil
  - geri al
tags:
  - 'kind:pattern'
  - 'domain:correctness'
  - 'domain:security'
  - 'topic:git'
pinned: false
date: '2026-10-04'
---

# A delete is never inferred from absence

## Why this exists

Two independent builds in this project arrived at the same rule from opposite ends,
after the same kind of near-miss.

- **Hands-free cloud mode (2026-10-03/04).** Three consecutive W1 review rounds found
  the *same* loss class: a laptop file or symlink removed at Return because the cloud
  happened not to carry that path — once because the cloud refused a link at go, once
  because the exclusion rule also ran in the cloud, once because the cloud simply could
  not read the file. Each round the answer was accepted as a **narrowing of what may be
  deleted at all** (D19, D19 amended, D20: Return never deletes a laptop non-git file;
  an absent path is listed in the receipt as "deleted on the phone, kept here" and the
  owner deletes it by hand), never as a fix to the condition that triggered it. The
  third repetition is the evidence: a condition-level fix leaves the next condition.
- **Whiteboard boards (2026-10-04, `51a44d9c`).** Closing a tab never deleted a board
  and a delete had already moved it to `whiteboards/.trash/` — but nothing said either
  thing, so a close felt like a loss and a delete *was* one. Fix: every close asks in a
  popover that states the board stays (deliberately not red, because nothing is lost),
  and the trash is listed with Restore (re-slugged on a collision).
- Earlier precedent, same shape: `pattern-condense-only-behind-a-nothing-lost-ledger`
  (a shrink is only safe behind a ledger proving nothing was dropped) and the trips
  `backup/` directory that makes hands-free's Roll back real.

## The rule

1. **Absence is a report, not an instruction.** If side B lacks a path side A has, write
   it into the receipt and leave A's copy alone. Any branch that turns "not present
   there" into `unlink()` here is a bug waiting for an unmapped condition.
2. **A path that could not travel is never planned as a deletion.** Exclusions and
   refusals happen on exactly one side (the side that owns the file), and the other
   side's checks are lexical only — otherwise the guard that protects a file on one
   machine deletes it on the other.
3. **An overwrite is backed up first, and named.** Copy the loser to a trip/backup
   directory before writing, and list the file **names** (never contents, for a secret
   class) in a receipt, so "roll back" is a real button rather than a word.
4. **A user-requested delete is recoverable and says so.** A trash with a visible
   restore, a confirmation that states what is NOT lost, and no destructive-red styling
   when nothing is actually destroyed. A delete history is machine-local (`.gitignore`
   the trash) — it is one person's undo buffer, not team content.
5. **Unreadable is refused, not skipped.** A path that cannot be read or verified is
   listed and refused; silently dropping it is indistinguishable from deleting it.

## How to apply it

When reviewing or writing any sync, merge, transfer, cleanup or "tidy" code, find every
`rm`/`unlink`/`DELETE`/overwrite and answer three questions in the code's own comments:
who decided this path should go, is that decision recorded in a receipt, and what
restores it. If any answer is "nothing", the delete is out of scope — report instead.

## Sources

- `knowledge/features/hands-free-cloud-mode.md` (D16, D18, D19 + amendment, D20)
- `knowledge/features/whiteboards.md` (Phase 1.6: close asks, local trash with Restore)
- `knowledge/patterns/condense-only-behind-a-nothing-lost-ledger.md` (same shape for text)

## Last verified

2026-10-04 — from the two builds above, both still in review.
