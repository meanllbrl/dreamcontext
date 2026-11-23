import type { Category, Item } from './types.js';
import { isExpired, isExpiringSoon } from './dates.js';

export class Inventory {
  private items = new Map<string, Item>();

  constructor(items: Item[] = []) {
    for (const item of items) this.add(item);
  }

  add(item: Item): void {
    if (item.quantity < 0) throw new Error(`negative quantity for ${item.id}`);
    const existing = this.items.get(item.id);
    if (existing) {
      existing.quantity += item.quantity;
      return;
    }
    this.items.set(item.id, { ...item });
  }

  get(id: string): Item | undefined {
    return this.items.get(id);
  }

  /** Take `quantity` out of stock. Throws when there is not enough. */
  remove(id: string, quantity: number): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown item ${id}`);
    if (quantity > item.quantity) throw new Error(`only ${item.quantity} of ${id} in stock`);
    item.quantity -= quantity;
  }

  all(): Item[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  byCategory(category: Category): Item[] {
    return this.all().filter((i) => i.category === category);
  }

  /** Items whose quantity is at or under `threshold`. */
  lowStock(threshold: number): Item[] {
    return this.all().filter((i) => i.quantity <= threshold);
  }

  expiringSoon(today: string, windowDays: number): Item[] {
    return this.all().filter((i) => isExpiringSoon(i, today, windowDays));
  }

  /** Drop every expired item; returns what was dropped. */
  purgeExpired(today: string): Item[] {
    const gone = this.all().filter((i) => isExpired(i, today));
    for (const g of gone) this.items.delete(g.id);
    return gone;
  }
}
