import { expect, it } from 'vitest';
import { toGrams } from '../src/units.js';
import { Inventory } from '../src/inventory.js';
import { buildParcel } from '../src/parcels.js';
it('h3 litres convert to 1000 g', () => { expect(toGrams(2, 'l')).toBe(2000); expect(toGrams(3, 'kg')).toBe(3000); expect(toGrams(250, 'ml')).toBe(250); expect(toGrams(4, 'pcs')).toBeNull(); });
it('h3 parcel weight with litres', () => {
  const inv = new Inventory([{ id: 'j', name: 'Juice', category: 'dairy', quantity: 4, unit: 'l', expiresOn: '2026-05-30', location: 'f' }]);
  expect(buildParcel({ id: 'h', name: 'H', size: 1, infants: 0 }, inv, '2026-05-04').weightGrams).toBe(1000);
});
it('h3 original suite still holds', () => {
  const inv = new Inventory([{ id: 'r', name: 'Rice', category: 'dry', quantity: 2, unit: 'kg', expiresOn: '2026-09-30', location: 'd' }]);
  expect(buildParcel({ id: 'h', name: 'H', size: 1, infants: 0 }, inv, '2026-05-04').weightGrams).toBe(1000);
});
