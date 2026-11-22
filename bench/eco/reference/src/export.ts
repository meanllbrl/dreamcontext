import type { Item } from './types.js';
const HEADER = ['id', 'name', 'category', 'quantity', 'unit', 'expiresOn', 'location'] as const;
const cell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function toCsv(items: Item[]): string {
  const rows = [...items].sort((a, b) => a.name.localeCompare(b.name)).map((i) =>
    [i.id, i.name, i.category, String(i.quantity), i.unit, i.expiresOn ?? '', i.location].map(cell).join(','));
  return [HEADER.join(','), ...rows].join('\n') + '\n';
}
