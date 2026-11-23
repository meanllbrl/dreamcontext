import type { Unit } from './types.js';

/** Grams for a weighed quantity; null for units that are not a weight or volume. */
export function toGrams(quantity: number, unit: Unit): number | null {
  switch (unit) {
    case 'g':
      return quantity;
    case 'kg':
      return quantity * 1000;
    case 'ml':
      // Pantry convention: 1 ml of liquid food counts as 1 g.
      return quantity;
    case 'l':
      return quantity * 1000;
    case 'pcs':
      return null;
  }
}

export function formatQuantity(quantity: number, unit: Unit): string {
  return unit === 'pcs' ? `${quantity}` : `${quantity} ${unit}`;
}
