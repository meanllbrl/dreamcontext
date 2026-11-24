import type { Item } from './types.js';
export function searchItems(items: Item[], text: string): Item[] {
  const t = text.toLowerCase();
  return items.filter((i) => i.name.toLowerCase().includes(t)).sort((a, b) => a.name.localeCompare(b.name));
}
