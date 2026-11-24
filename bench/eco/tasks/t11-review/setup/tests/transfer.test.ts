import { expect, it } from 'vitest';
import { Inventory } from '../src/inventory.js';

it('moves stock to another shelf', () => {
  const inv = new Inventory([{ id: 'a', name: 'Beans', category: 'canned', quantity: 10, unit: 'pcs', expiresOn: '2026-06-01', location: 'shelf-a' }]);
  const dest = inv.transfer('a', 4, 'shelf-b');
  expect(dest).toBe('a@shelf-b');
  expect(inv.get('a')?.quantity).toBe(6);
  expect(inv.get('a@shelf-b')).toMatchObject({ quantity: 4, location: 'shelf-b', name: 'Beans' });
});
