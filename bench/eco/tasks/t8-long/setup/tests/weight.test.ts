import { expect, it } from 'vitest';
import { Inventory } from '../src/inventory.js';
import { buildParcel } from '../src/parcels.js';

it('weighs a parcel with a litre of milk and a kilo of apples at 2000 g', () => {
  const inv = new Inventory([
    { id: 'milk', name: 'Milk', category: 'dairy', quantity: 6, unit: 'l', expiresOn: '2026-05-20', location: 'fridge' },
    { id: 'apples', name: 'Apples', category: 'produce', quantity: 3, unit: 'kg', expiresOn: '2026-05-15', location: 'crate' },
  ]);
  const p = buildParcel({ id: 'h1', name: 'Pine', size: 1, infants: 0 }, inv, '2026-05-04');
  expect(p.weightGrams).toBe(2000);
});
