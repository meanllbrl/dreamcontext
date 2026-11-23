import { expect, it } from 'vitest';
import { searchItems } from '../src/search.js';
import { categoryTotals, weeklyReport } from '../src/report.js';
import { Inventory } from '../src/inventory.js';
import { run } from '../src/cli.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const x = (id: string, name: string, category: any, quantity: number) => ({ id, name, category, quantity, unit: 'pcs' as const, expiresOn: null, location: 's' });
it('h8 search is case-insensitive and sorted', () => {
  expect(searchItems([x('2', 'Tomato soup', 'canned', 1), x('1', 'Black beans', 'canned', 1), x('3', 'Soup spoon', 'hygiene', 1)], 'SOUP').map((i) => i.id)).toEqual(['3', '2']);
});
it('h8 search cli and no match', () => {
  const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json');
  writeFileSync(p, JSON.stringify({ items: [x('1', 'Black beans', 'canned', 4)], households: [] }));
  expect(run(['search', 'bean'], p, '2026-05-04')).toContain('Black beans');
  expect(run(['search', 'zzz'], p, '2026-05-04')).toBe('no match');
});
it('h8 category totals and report line', () => {
  const items = [x('1', 'A', 'dry', 3), x('2', 'B', 'canned', 5), x('3', 'C', 'canned', 7), x('4', 'D', 'baby', 0)];
  expect(categoryTotals(items)).toEqual([['canned', 12], ['dry', 3]]);
  expect(weeklyReport(new Inventory(items), { today: '2026-05-04' })).toContain('By category: canned 12, dry 3');
});
