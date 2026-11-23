The volunteer board's new screen wants the weekly report as data, and the coordinator wants to tune its limits. Per this spec (tests depend on it):

- In `src/report.ts` add `reportData(inventory: Inventory, opts: ReportOptions)` returning exactly this shape:
  `{ today, itemsInStock, lowStock: { threshold, items: [{ id, name, quantity, unit }] }, expiring: { windowDays, items: [{ id, name, expiresOn }] } }`.
  It uses the same defaults and the same items, in the same order, as `weeklyReport`. `weeklyReport`'s text does not change.
- The `report` command takes optional flags in any order: `--low N` sets the low-stock threshold, `--days N` sets the expiring window, and `--json` prints `JSON.stringify(reportData(...), null, 2)` instead of the text. `--low` and `--days` apply to the text report too.
- A flag value that is not a number throws `--low needs a number` (or `--days needs a number`).

Add tests.
