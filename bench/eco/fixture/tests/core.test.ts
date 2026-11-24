import { describe, expect, it } from 'vitest';
import { Inventory } from '../src/inventory.js';
import { addDays, daysUntil, isExpired } from '../src/dates.js';
import { buildParcel } from '../src/parcels.js';
import { weeklyReport } from '../src/report.js';
import type { Item } from '../src/types.js';

const TODAY = '2026-05-04';
const item = (over: Partial<Item>): Item => ({
  id: 'x',
  name: 'Thing',
  category: 'canned',
  quantity: 10,
  unit: 'pcs',
  expiresOn: '2026-06-01',
  location: 'shelf-a',
  ...over,
});

describe('dates', () => {
  it('counts whole days', () => {
    expect(daysUntil('2026-05-10', TODAY)).toBe(6);
    expect(addDays(TODAY, 3)).toBe('2026-05-07');
  });
  it('marks past items expired', () => {
    expect(isExpired(item({ expiresOn: '2026-05-03' }), TODAY)).toBe(true);
    expect(isExpired(item({ expiresOn: null }), TODAY)).toBe(false);
  });
});

describe('inventory', () => {
  it('merges the same id and removes stock', () => {
    const inv = new Inventory([item({ id: 'b', quantity: 3 }), item({ id: 'b', quantity: 2 })]);
    expect(inv.get('b')?.quantity).toBe(5);
    inv.remove('b', 4);
    expect(inv.get('b')?.quantity).toBe(1);
    expect(() => inv.remove('b', 2)).toThrow();
  });
  it('lists low stock and purges expired items', () => {
    const inv = new Inventory([
      item({ id: 'a', name: 'Beans', quantity: 2 }),
      item({ id: 'c', name: 'Rice', category: 'dry', quantity: 40, expiresOn: '2026-01-01' }),
    ]);
    expect(inv.lowStock(5).map((i) => i.id)).toEqual(['a']);
    expect(inv.purgeExpired(TODAY).map((i) => i.id)).toEqual(['c']);
  });
});

describe('parcels', () => {
  it('gives two cans per person, earliest expiry first, and skips items about to expire', () => {
    const inv = new Inventory([
      item({ id: 'late', name: 'Late beans', expiresOn: '2026-09-01' }),
      item({ id: 'early', name: 'Early beans', expiresOn: '2026-05-20' }),
      item({ id: 'now', name: 'Old beans', expiresOn: '2026-05-05' }),
    ]);
    const p = buildParcel({ id: 'h1', name: 'Oak family', size: 3, infants: 0 }, inv, TODAY);
    const cans = p.lines.filter((l) => l.itemId !== 'now');
    expect(cans[0].itemId).toBe('early');
    expect(cans.reduce((s, l) => s + l.quantity, 0)).toBe(6);
    expect(p.lines.some((l) => l.itemId === 'now')).toBe(false);
  });
  it('gives baby items only to households with infants', () => {
    const inv = new Inventory([item({ id: 'nappy', name: 'Nappies', category: 'baby', expiresOn: null })]);
    const none = buildParcel({ id: 'h2', name: 'Elm', size: 2, infants: 0 }, inv, TODAY);
    expect(none.lines).toEqual([]);
    const some = buildParcel({ id: 'h3', name: 'Ash', size: 2, infants: 1 }, inv, TODAY);
    expect(some.lines[0]).toMatchObject({ itemId: 'nappy', quantity: 3 });
  });
});

describe('report', () => {
  it('prints the headline counts', () => {
    const inv = new Inventory([item({ id: 'a', name: 'Beans', quantity: 2, expiresOn: '2026-05-05' })]);
    const r = weeklyReport(inv, { today: TODAY });
    expect(r).toContain('Items in stock: 1');
    expect(r).toContain('Low stock (<= 5): 1');
    expect(r).toContain('Expiring within 3 days: 1');
  });
});
