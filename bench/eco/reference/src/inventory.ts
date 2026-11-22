import type { Category, Item, Reservation } from './types.js';
import { isExpired, isExpiringSoon } from './dates.js';
const HOLD_MS = 48 * 60 * 60 * 1000;
export class Inventory {
  private items = new Map<string, Item>();
  private holds: Reservation[] = [];
  constructor(items: Item[] = [], reservations: Reservation[] = []) {
    for (const item of items) this.add(item);
    this.holds = reservations.map((r) => ({ ...r }));
  }
  add(item: Item): void {
    if (item.quantity < 0) throw new Error(`negative quantity for ${item.id}`);
    const existing = this.items.get(item.id);
    if (existing) { existing.quantity += item.quantity; return; }
    this.items.set(item.id, { ...item });
  }
  get(id: string): Item | undefined { return this.items.get(id); }
  remove(id: string, quantity: number): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown item ${id}`);
    if (quantity > item.quantity) throw new Error(`only ${item.quantity} of ${id} in stock`);
    item.quantity -= quantity;
  }
  reservations(): Reservation[] { return this.holds.map((r) => ({ ...r })); }
  available(itemId: string): number {
    const item = this.items.get(itemId);
    if (!item) return 0;
    return item.quantity - this.holds.filter((r) => r.itemId === itemId).reduce((s, r) => s + r.quantity, 0);
  }
  reserve(householdId: string, itemId: string, quantity: number, now: string): void {
    if (!this.items.has(itemId)) throw new Error(`unknown item ${itemId}`);
    if (quantity > this.available(itemId)) throw new Error(`only ${this.available(itemId)} of ${itemId} available`);
    const mine = this.holds.find((r) => r.householdId === householdId && r.itemId === itemId);
    if (mine) { mine.quantity += quantity; mine.at = now; } else this.holds.push({ householdId, itemId, quantity, at: now });
  }
  release(householdId: string, itemId: string): number {
    const i = this.holds.findIndex((r) => r.householdId === householdId && r.itemId === itemId);
    if (i < 0) return 0;
    return this.holds.splice(i, 1)[0].quantity;
  }
  expireReservations(now: string): number {
    const cut = Date.parse(now) - HOLD_MS;
    const before = this.holds.length;
    this.holds = this.holds.filter((r) => Date.parse(r.at) >= cut);
    return before - this.holds.length;
  }
  all(): Item[] { return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  byCategory(category: Category): Item[] { return this.all().filter((i) => i.category === category); }
  lowStock(threshold: number): Item[] { return this.all().filter((i) => this.available(i.id) <= threshold); }
  expiringSoon(today: string, windowDays: number): Item[] { return this.all().filter((i) => isExpiringSoon(i, today, windowDays)); }
  purgeExpired(today: string): Item[] {
    const gone = this.all().filter((i) => isExpired(i, today));
    for (const g of gone) this.items.delete(g.id);
    return gone;
  }
}
