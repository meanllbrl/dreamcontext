Build reservations: a household can hold stock for a pickup, and held stock is not given to anyone else.

API (exact names, tests depend on them):
- `export interface Reservation { householdId: string; itemId: string; quantity: number; at: string /* ISO datetime */ }` in `src/types.ts`.
- `new Inventory(items?: Item[], reservations?: Reservation[])`, and `inventory.reservations(): Reservation[]`.
- `inventory.reserve(householdId, itemId, quantity, now: string)`: throws when `quantity` is more than what is available or the item is unknown. A second reserve by the same household for the same item adds to its reservation (and refreshes `at` to `now`).
- `inventory.release(householdId, itemId): number`: removes that reservation, returns the quantity released (0 when there was none).
- `inventory.available(itemId): number`: quantity in stock minus every reservation on it (0 for an unknown item).
- `inventory.expireReservations(now: string): number`: drops reservations made more than 48 hours before `now`; returns how many were dropped.
- `lowStock` counts available quantity, and `buildParcel` only uses available quantity (reserved stock stays in the inventory).
- `PantryData` gets `reservations?: Reservation[]`; `load` returns `reservations: []` when the file has none, and `save` writes them.
- CLI: `run(['reserve', householdId, itemId, qty], …)` and `run(['release', householdId, itemId], …)` persist the change and return a one-line confirmation.
- Add a short README note about the new JSON field (the Thursday shift needs it for the backup).

Work like this: build it with tests, run the tests and the type-check, then dispatch the `reviewer` sub-agent once on your change and fix any real defect it reports.
