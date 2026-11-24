import { expect, it } from 'vitest';
import { isExpiringSoon } from '../src/dates.js';
import { Inventory } from '../src/inventory.js';
import { weeklyReport } from '../src/report.js';
import { run } from '../src/cli.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const T = '2026-05-04';
const it_ = (id: string, exp: string | null) => ({ id, name: id, category: 'canned' as const, quantity: 9, unit: 'pcs' as const, expiresOn: exp, location: 's' });
it('h1 counts the last day of the window', () => { expect(isExpiringSoon(it_('a', '2026-05-07'), T, 3)).toBe(true); });
it('h1 excludes the day after the window', () => { expect(isExpiringSoon(it_('a', '2026-05-08'), T, 3)).toBe(false); });
it('h1 includes today, excludes expired and no-expiry', () => {
  expect(isExpiringSoon(it_('a', T), T, 3)).toBe(true);
  expect(isExpiringSoon(it_('a', '2026-05-03'), T, 3)).toBe(false);
  expect(isExpiringSoon(it_('a', null), T, 3)).toBe(false);
});
it('h1 report counts it', () => {
  const r = weeklyReport(new Inventory([it_('a', '2026-05-07'), it_('b', '2026-05-09')]), { today: T });
  expect(r).toContain('Expiring within 3 days: 1');
});
it('h1 cli expiring --days 3 lists it', () => {
  const d = mkdtempSync(join(tmpdir(), 'pp-')); const p = join(d, 'pantry.json');
  writeFileSync(p, JSON.stringify({ items: [it_('edge', '2026-05-07')], households: [] }));
  expect(run(['expiring', '--days', '3'], p, T)).toContain('edge');
});
