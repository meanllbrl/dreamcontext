import { expect, it } from 'vitest';
import { reportData } from '../src/report.js';
import { Inventory } from '../src/inventory.js';
import { run } from '../src/cli.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const T = '2026-05-04';
const items = [
  { id: 'r', name: 'Rice', category: 'dry' as const, quantity: 3, unit: 'kg' as const, expiresOn: '2026-05-05', location: 'shelf-a' },
  { id: 'b', name: 'Beans', category: 'canned' as const, quantity: 8, unit: 'pcs' as const, expiresOn: '2026-05-05', location: 'shelf-a' },
  { id: 's', name: 'Soap', category: 'hygiene' as const, quantity: 1, unit: 'pcs' as const, expiresOn: null, location: 'shelf-b' },
  { id: 'm', name: 'Milk', category: 'dairy' as const, quantity: 6, unit: 'l' as const, expiresOn: '2026-05-20', location: 'fridge' },
];
const file = () => { const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json'); writeFileSync(p, JSON.stringify({ items, households: [] })); return p; };
it('h12 reportData shape with defaults', () => {
  expect(reportData(new Inventory(items), { today: T })).toEqual({
    today: T,
    itemsInStock: 4,
    lowStock: { threshold: 5, items: [{ id: 'r', name: 'Rice', quantity: 3, unit: 'kg' }, { id: 's', name: 'Soap', quantity: 1, unit: 'pcs' }] },
    expiring: { windowDays: 3, items: [{ id: 'b', name: 'Beans', expiresOn: '2026-05-05' }, { id: 'r', name: 'Rice', expiresOn: '2026-05-05' }] },
  });
});
it('h12 report --json prints the data, flags in any order', () => {
  const out = run(['report', '--days', '30', '--json', '--low', '2'], file(), T);
  const data = JSON.parse(out);
  expect(out).toBe(JSON.stringify(data, null, 2));
  expect(data.lowStock).toEqual({ threshold: 2, items: [{ id: 's', name: 'Soap', quantity: 1, unit: 'pcs' }] });
  expect(data.expiring.windowDays).toBe(30);
  expect(data.expiring.items.map((i: { id: string }) => i.id)).toEqual(['b', 'm', 'r']);
});
it('h12 flags apply to the text report', () => {
  const out = run(['report', '--low', '2'], file(), T);
  expect(out).toContain('Low stock (<= 2): 1');
  expect(out).toContain('Expiring within 3 days: 2');
});
it('h12 text report unchanged without flags', () => {
  expect(run(['report'], file(), T)).toBe(['Pinewood Pantry weekly report (2026-05-04)', 'Items in stock: 4', 'Low stock (<= 5): 2', '  - Rice: 3 kg', '  - Soap: 1', 'Expiring within 3 days: 2', '  - Beans (2026-05-05)', '  - Rice (2026-05-05)'].join('\n'));
});
it('h12 bad flag value throws', () => {
  expect(() => run(['report', '--low', 'many'], file(), T)).toThrow('--low needs a number');
  expect(() => run(['report', '--days'], file(), T)).toThrow('--days needs a number');
});
