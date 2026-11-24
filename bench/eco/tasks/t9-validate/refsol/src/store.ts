import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { Household, Item } from './types.js';

export interface PantryData {
  items: Item[];
  households: Household[];
}

const CATEGORIES = ['canned', 'dry', 'dairy', 'produce', 'hygiene', 'baby'];
const UNITS = ['pcs', 'g', 'kg', 'ml', 'l'];
const str = (v: unknown) => typeof v === 'string' && v.length > 0;
const whole = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
function realDate(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

function itemField(i: Record<string, unknown>): string | null {
  if (!str(i.id)) return 'id';
  if (!str(i.name)) return 'name';
  if (!CATEGORIES.includes(i.category as string)) return 'category';
  if (typeof i.quantity !== 'number' || !Number.isFinite(i.quantity) || i.quantity < 0) return 'quantity';
  if (!UNITS.includes(i.unit as string)) return 'unit';
  if (i.expiresOn !== null && !realDate(i.expiresOn)) return 'expiresOn';
  if (!str(i.location)) return 'location';
  return null;
}
function householdField(h: Record<string, unknown>): string | null {
  if (!str(h.id)) return 'id';
  if (!str(h.name)) return 'name';
  if (!whole(h.size) || (h.size as number) < 1) return 'size';
  if (!whole(h.infants) || (h.infants as number) < 0 || (h.infants as number) > (h.size as number)) return 'infants';
  return null;
}

/** Plain JSON on disk (decision: no database, see knowledge/storage.md). */
export function load(path: string): PantryData {
  if (!existsSync(path)) return { items: [], households: [] };
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PantryData>;
  const items = raw.items ?? [];
  const households = raw.households ?? [];
  for (const i of items as unknown as Record<string, unknown>[]) {
    const f = itemField(i);
    if (f) throw new Error(`invalid item ${f === 'id' ? '?' : i.id}: ${f}`);
  }
  for (const h of households as unknown as Record<string, unknown>[]) {
    const f = householdField(h);
    if (f) throw new Error(`invalid household ${f === 'id' ? '?' : h.id}: ${f}`);
  }
  return { items, households };
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
export function save(path: string, data: PantryData): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}
