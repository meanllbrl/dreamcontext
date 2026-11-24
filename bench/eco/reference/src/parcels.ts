import type { Category, Household, Item, Parcel, ParcelLine } from './types.js';
import { Inventory } from './inventory.js';
import { daysUntil } from './dates.js';
import { toGrams } from './units.js';

/** Units of each category per household member (see knowledge/parcel-rules.md). */
export const PER_PERSON: Record<Category, number> = {
  canned: 2,
  dry: 1,
  dairy: 1,
  produce: 1,
  hygiene: 0.5,
  baby: 0,
};

/** Items this close to expiry never go into a parcel (decision 2026-03, parcel-rules.md). */
export const MIN_SHELF_DAYS = 2;

function eligible(item: Item, today: string, inventory: Inventory): boolean {
  if (inventory.available(item.id) <= 0) return false;
  if (item.expiresOn === null) return true;
  return daysUntil(item.expiresOn, today) > MIN_SHELF_DAYS;
}

/**
 * Build one household's parcel from stock, earliest-expiring first, and take it out of the
 * inventory. Baby items go only to households with infants: 3 per infant.
 */
export function buildParcel(household: Household, inventory: Inventory, today: string): Parcel {
  const lines: ParcelLine[] = [];
  const categories = Object.keys(PER_PERSON) as Category[];
  for (const category of categories) {
    let want = category === 'baby' ? household.infants * 3 : Math.ceil(PER_PERSON[category] * household.size);
    const pool = inventory
      .byCategory(category)
      .filter((i) => eligible(i, today, inventory))
      .sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999'));
    for (const item of pool) {
      if (want <= 0) break;
      const avail = inventory.available(item.id);
      const take = item.unit === 'pcs' ? Math.min(want, avail) : Math.min(1, avail);
      if (take <= 0) continue;
      inventory.remove(item.id, take);
      lines.push({ itemId: item.id, name: item.name, quantity: take, unit: item.unit });
      want -= item.unit === 'pcs' ? take : 1;
    }
  }
  return { householdId: household.id, lines, weightGrams: parcelWeight(lines, inventory) };
}

function parcelWeight(lines: ParcelLine[], _inventory: Inventory): number {
  let grams = 0;
  for (const line of lines) {
    const g = toGrams(line.quantity, line.unit);
    if (g !== null) grams += g;
  }
  return grams;
}
