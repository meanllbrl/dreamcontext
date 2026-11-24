import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { Household, Item } from './types.js';

export interface PantryData {
  items: Item[];
  households: Household[];
}

/** Plain JSON on disk (decision: no database, see knowledge/storage.md). */
export function load(path: string): PantryData {
  if (!existsSync(path)) return { items: [], households: [] };
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PantryData>;
  return { items: raw.items ?? [], households: raw.households ?? [] };
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
export function save(path: string, data: PantryData): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}
