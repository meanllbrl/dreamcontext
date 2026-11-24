Add a CSV export so the Thursday shift can open the stock in a spreadsheet.

- New module `src/export.ts` exporting `toCsv(items: Item[]): string`.
- Header line exactly: `id,name,category,quantity,unit,expiresOn,location`
- One row per item, sorted by name (same order as `Inventory.all()`); an item with no expiry gets an empty `expiresOn` field.
- A field that contains a comma, a double quote or a newline is wrapped in double quotes, and each double quote inside it is doubled (RFC 4180).
- Lines are joined with `\n` and the output ends with a single `\n`.
- New CLI command: `run(['export'], dataPath, today)` returns `toCsv` of the whole inventory.

Add tests.
