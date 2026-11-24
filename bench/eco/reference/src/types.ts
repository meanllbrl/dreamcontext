// Pinewood Pantry: a fictional community food pantry's inventory tool (benchmark fixture).

export type Category = 'canned' | 'dry' | 'dairy' | 'produce' | 'hygiene' | 'baby';
export type Unit = 'pcs' | 'g' | 'kg' | 'ml' | 'l';

export interface Item {
  id: string;
  name: string;
  category: Category;
  quantity: number;
  unit: Unit;
  /** ISO date, YYYY-MM-DD. Hygiene items have no expiry. */
  expiresOn: string | null;
  location: string;
}

export interface Household {
  id: string;
  name: string;
  size: number;
  /** Members under 2 years old. */
  infants: number;
}

export interface ParcelLine {
  itemId: string;
  name: string;
  quantity: number;
  unit: Unit;
}

export interface Parcel {
  householdId: string;
  lines: ParcelLine[];
  /** Total weight in grams of every weighed line. */
  weightGrams: number;
}

export interface Reservation { householdId: string; itemId: string; quantity: number; at: string }
