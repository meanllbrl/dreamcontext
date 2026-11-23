Volunteers keep doing date maths in their heads at the shelf. Show a plain label instead of the raw expiry date, per this spec (tests depend on it):

- New module `src/labels.ts` exporting `expiryLabel(expiresOn: string | null, today: string): string`. Both dates are `YYYY-MM-DD`.
- `null` gives `no expiry`.
- The same day gives `expires today`; one day later gives `expires tomorrow`; N days later (N of 2 or more) gives `expires in N days`.
- One day earlier gives `expired yesterday`; N days earlier (N of 2 or more) gives `expired N days ago`.
- The `list` command shows this label as its fourth column, in place of the date (so an item with no expiry shows `no expiry` instead of `-`). Every other part of a `list` line stays as it is.

Add tests.
