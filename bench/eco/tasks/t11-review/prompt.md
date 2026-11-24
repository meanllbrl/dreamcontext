A teammate added `Inventory.transfer(id, quantity, location)` in `src/inventory.ts`, with a test in `tests/transfer.test.ts`; the test passes. Review the change against the intended behaviour below and fix every bug you find. Keep the method's name and signature.

Intended behaviour:
- Moves `quantity` units of item `id` to the shelf `location`, and returns the id of the moved stock.
- The moved stock is the item `<id>@<location>`: same name, category, unit and expiry, the new location. If that item already exists, its quantity grows by `quantity`.
- The source keeps the rest. If nothing remains, the source item is removed.
- Moving more than is in stock throws `only <n> of <id> in stock` (as `remove` does). A quantity of 0 or less throws `quantity must be positive`.
- Moving to the shelf the item is already on changes nothing and returns `id`.

Add tests for what you fix.
