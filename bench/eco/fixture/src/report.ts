import { Inventory } from './inventory.js';
import { formatQuantity } from './units.js';

export interface ReportOptions {
  today: string;
  lowStockThreshold?: number;
  expiringWindowDays?: number;
}

/** The weekly plain-text report the coordinator posts on the volunteer board. */
export function weeklyReport(inventory: Inventory, opts: ReportOptions): string {
  const threshold = opts.lowStockThreshold ?? 5;
  const windowDays = opts.expiringWindowDays ?? 3;
  const out: string[] = [];
  out.push(`Pinewood Pantry weekly report (${opts.today})`);
  out.push(`Items in stock: ${inventory.all().length}`);
  const low = inventory.lowStock(threshold);
  out.push(`Low stock (<= ${threshold}): ${low.length}`);
  for (const i of low) out.push(`  - ${i.name}: ${formatQuantity(i.quantity, i.unit)}`);
  const soon = inventory.expiringSoon(opts.today, windowDays);
  out.push(`Expiring within ${windowDays} days: ${soon.length}`);
  for (const i of soon) out.push(`  - ${i.name} (${i.expiresOn})`);
  return out.join('\n');
}
