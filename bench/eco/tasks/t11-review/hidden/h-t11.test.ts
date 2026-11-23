import { expect, it } from 'vitest';
import { Inventory } from '../src/inventory.js';
const beans = () => new Inventory([{ id: 'a', name: 'Beans', category: 'canned', quantity: 10, unit: 'pcs', expiresOn: '2026-06-01', location: 'shelf-a' }]);
it('h11 basic move keeps the rest', () => {
  const inv = beans();
  expect(inv.transfer('a', 4, 'shelf-b')).toBe('a@shelf-b');
  expect(inv.get('a')?.quantity).toBe(6);
  expect(inv.get('a@shelf-b')).toMatchObject({ quantity: 4, location: 'shelf-b', name: 'Beans', expiresOn: '2026-06-01' });
});
it('h11 a second move to the same shelf adds up', () => {
  const inv = beans();
  inv.transfer('a', 4, 'shelf-b');
  inv.transfer('a', 3, 'shelf-b');
  expect(inv.get('a@shelf-b')?.quantity).toBe(7);
  expect(inv.get('a')?.quantity).toBe(3);
});
it('h11 moving everything removes the source', () => {
  const inv = beans();
  inv.transfer('a', 10, 'shelf-b');
  expect(inv.get('a')).toBeUndefined();
  expect(inv.get('a@shelf-b')?.quantity).toBe(10);
});
it('h11 too much throws and changes nothing', () => {
  const inv = beans();
  expect(() => inv.transfer('a', 11, 'shelf-b')).toThrow('only 10 of a in stock');
  expect(inv.get('a')?.quantity).toBe(10);
  expect(inv.get('a@shelf-b')).toBeUndefined();
});
it('h11 zero or negative throws', () => {
  const inv = beans();
  expect(() => inv.transfer('a', 0, 'shelf-b')).toThrow('quantity must be positive');
  expect(() => inv.transfer('a', -2, 'shelf-b')).toThrow('quantity must be positive');
  expect(inv.get('a')?.quantity).toBe(10);
});
it('h11 same shelf is a no-op', () => {
  const inv = beans();
  expect(inv.transfer('a', 4, 'shelf-a')).toBe('a');
  expect(inv.get('a')?.quantity).toBe(10);
  expect(inv.get('a@shelf-a')).toBeUndefined();
});
