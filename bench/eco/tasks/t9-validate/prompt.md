Last week a volunteer hand-edited `pantry.json` and the tool quietly handed out a parcel built from a typo. Make `load()` in `src/store.ts` refuse bad data, per this spec (tests depend on it):

- A missing file still loads as empty data, as today.
- Every item, then every household, is checked in file order. On the FIRST problem `load` throws an `Error` whose message is exactly `invalid item <id>: <field>` or `invalid household <id>: <field>`.
- `<field>` is the first failing field in this order. Items: `id`, `name`, `category`, `quantity`, `unit`, `expiresOn`, `location`. Households: `id`, `name`, `size`, `infants`.
- Item rules: `id` and `name` are non-empty strings; `category` and `unit` are one of the values in `src/types.ts`; `quantity` is a finite number, 0 or more; `expiresOn` is `null` or a real calendar date written `YYYY-MM-DD`; `location` is a non-empty string.
- Household rules: `id` and `name` are non-empty strings; `size` is a whole number, at least 1; `infants` is a whole number from 0 up to `size`.
- When the `id` itself is the problem, write `?` in place of the id.

Add tests.
