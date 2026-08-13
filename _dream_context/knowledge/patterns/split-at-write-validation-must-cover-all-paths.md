---
id: know_validation_split
name: Split-at-Write Validation Must Cover All Paths
description: >-
  When a value can arrive through multiple code paths (user-typed vs
  auto-stamped, manually-built vs machine-generated), the validation check must
  be applied consistently across ALL write paths, not just the human-facing one.
  Missing validation on an auto-write path silently lands invalid data in
  storage.
tags:
  - 'kind:pattern'
  - architecture
  - decisions
  - 'layer:backend'
  - validation
date: '2026-08-13'
---

## Why This Exists

Validators applied only to user-typed input but not to machine-generated values is a recurring defect class. Two occurrences shipped in the same window (2026-08-11→2026-08-13), both caught by multi-review:

1. **PR #296** (task dates): Stamped dates (auto-filled `start_date` on first `in_progress`, auto-filled `completed_at` on first `completed`) were not validated. Only explicitly-set dates ran through `isCalendarDate()` and the start≤due≤completed constraint. An invalid auto-stamp could silently land in frontmatter.
2. **PR #294** (council headings): The section-body terminator regex was correct in eight sites (`$(?![\s\S])`), but `extractNamedSubsection`'s heading interpolation had a broken escape (character class closed early), so special chars in headings could break the match in ONE code path while working in the others.

Both share the same shape: the validation exists and is correct, but only half the write paths run through it.

## The Pattern

### Litmus Test

When a field/value/structure can be written by multiple code paths, ask:
- Does path A validate before writing?
- Does path B validate before writing?
- Does path C (if any) validate before writing?

If any answer is "no" or "I'm not sure", the validation is split. The paths must converge on ONE validator.

### Three Common Splits

| Split type | Example | Fix |
|---|---|---|
| **User-typed vs auto-stamped** | User sets `start_date` via CLI → validated. Auto-stamp on first `in_progress` → not validated (PR #296). | Both paths call the same `normalizeDateRange()` / `isCalendarDate()`. |
| **Manual construction vs derived/interpolated** | Section-body regex built by hand → correct. Heading regex built via interpolation → broken escape (PR #294). | Extract the regex builder into ONE shared pure function; both call sites use it. |
| **Frontend vs backend** | Dashboard form validates. API route does not (or vice-versa). | Server validates ALWAYS; client validation is UX only. |

### The Repair Ladder

1. **Unify the validator** — extract it into a shared pure function / schema / constraint. Both paths call it.
2. **Test the uncovered path** — if the validator existed but the auto-write path didn't call it, the test suite missed it. Add a test that exercises the uncovered path with invalid input and asserts it's rejected.
3. **Audit parallel paths** — if one write path was uncovered, check whether others exist. The calendar-date validation was missing from TWO auto-stamp paths (start + completed), not one.

## When To Use / Avoid

- **Use** whenever a value has multiple write paths. A field that can ONLY arrive through user input (e.g., a CLI-only `--why` flag with no auto-fill) does not need this pattern.
- **Avoid** duplicating the validation itself across paths — that is the OPPOSITE of this pattern and how the split happens in the first place. One validator, called from every path.

## Occurrences (2)

1. **2026-08-13, PR #296** — Stamped dates not validated (`shouldStampStartDate()`, `shouldStampCompletedAt()` wrote values directly to frontmatter without calling `isCalendarDate()` / `normalizeDateRange()`). Fixed by routing both auto-stamp paths through the same validator the typed-date paths already used.
2. **2026-08-13, PR #294** — Council heading escape broken in `extractNamedSubsection` (character class `[.*+?^${}()|[\\]\\\\]` closed at the second `]`), while the section-body terminator regex was correct in eight other sites. Fixed by properly escaping `.*+?^${}()|[]\` in the regex literal — the shared correct pattern is now `$(?![\s\S])` for end-of-input.

## Related

- **Presentation field must not double as safety predicate** — same validator-split failure mode, different axis (a display field doing double-duty as a mount/security gate).
- **Type-driven validation** (if it exists as a pattern) — schema-first validation ensures every write path respects the same constraints by construction.
