import { Inventory } from './inventory.js';
import { formatQuantity } from './units.js';
import type { Category, Item } from './types.js';
import type { Donation } from './donations.js';
import { addDays } from './dates.js';

const ORDER: Category[] = ['canned', 'dry', 'dairy', 'produce', 'hygiene', 'baby'];
export function categoryTotals(items: Item[]): Array<[Category, number]> {
  return ORDER.map((c) => [c, items.filter((i) => i.category === c).reduce((s, i) => s + i.quantity, 0)] as [Category, number]).filter(([, n]) => n > 0);
}

export interface ReportOptions {
  today: string;
  lowStockThreshold?: number;
  expiringWindowDays?: number;
  donations?: Donation[];
}

/** The weekly plain-text report the coordinator posts on the volunteer board. */
export function weeklyReport(inventory: Inventory, opts: ReportOptions): string {
  const threshold = opts.lowStockThreshold ?? 5;
  const windowDays = opts.expiringWindowDays ?? 3;
  const out: string[] = [];
  out.push(`Pinewood Pantry weekly report (${opts.today})`);
  out.push(`Items in stock: ${inventory.all().length}`);
  const totals = categoryTotals(inventory.all());
  if (totals.length) out.push(`By category: ${totals.map(([c, n]) => `${c} ${n}`).join(', ')}`);
  const low = inventory.lowStock(threshold);
  out.push(`Low stock (<= ${threshold}): ${low.length}`);
  for (const i of low) out.push(`  - ${i.name}: ${formatQuantity(i.quantity, i.unit)}`);
  const soon = inventory.expiringSoon(opts.today, windowDays);
  out.push(`Expiring within ${windowDays} days: ${soon.length}`);
  for (const i of soon) out.push(`  - ${i.name} (${i.expiresOn})`);
  if (opts.donations) {
    const from = addDays(opts.today, -6);
    const n = opts.donations.filter((d) => d.date >= from && d.date <= opts.today).reduce((s, d) => s + d.quantity, 0);
    out.push(`Donations this week: ${n} items`);
  }
  return out.join('\n');
}
