# Pinewood Pantry

Inventory and parcel tool for the Pinewood community food pantry (a fictional project).
Volunteers record donated stock, the coordinator prints a weekly report, and every
registered household gets a weekly parcel built from what is in stock.

- `src/inventory.ts`: stock in memory
- `src/parcels.ts`: builds a household's parcel (rules in `_dream_context/knowledge/parcel-rules.md`)
- `src/report.ts`: the weekly text report
- `src/store.ts`: JSON file storage
- `src/cli.ts`: `list`, `expiring --days N`, `report`, `parcel <householdId>`

Tests: `npx vitest run`. Types: `npx tsc --noEmit`.
