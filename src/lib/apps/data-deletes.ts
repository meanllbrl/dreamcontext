/**
 * Deletes of shared app data (app-veri-ortak plan r6, K6). Absence is never a delete: a tracked
 * shared file missing from disk stays in git. A real delete comes only from the app itself
 * (`dc.data.remove`), which leaves a TOMBSTONE here, `~/.dreamcontext/apps/deletes/<hash>.json`
 * = `{paths: [{path, at}]}`. The exchange layer (data-exchange.ts) stages `git rm --cached` only
 * for a tombstoned path, and clears the stone once the delete commit reached the remote. A stone
 * that never lands is dropped after {@link TOMBSTONE_TTL_MS}. A sync with more than
 * {@link PER_SYNC_DELETE_CAP} deletes sends none of them and asks the owner.
 */

import { appStateFile, readJsonStrict, writeJsonAtomic } from './data-consent.js';
import { pathNameRefusal } from './data-share.js';

export const PER_SYNC_DELETE_CAP = 20;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A runaway app cannot grow the file without bound. */
const MAX_STONES = 1000;

export interface Tombstone { path: string; at: string }

export function tombstonesPath(home: string, hash: string): string {
  return appStateFile(home, 'deletes', hash);
}

function readAll(home: string, hash: string): Tombstone[] {
  let raw: unknown;
  try { raw = readJsonStrict(tombstonesPath(home, hash)); } catch { return []; }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { paths?: unknown }).paths)) return [];
  const out: Tombstone[] = [];
  for (const t of (raw as { paths: unknown[] }).paths) {
    if (!t || typeof t !== 'object') continue;
    const { path, at } = t as Record<string, unknown>;
    if (typeof path !== 'string' || pathNameRefusal(path) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue;
    if (!out.some((x) => x.path === path)) out.push({ path, at });
  }
  return out;
}

const live = (t: Tombstone, nowMs: number) => nowMs - Date.parse(t.at) < TOMBSTONE_TTL_MS;

/** Record that the app deleted `relPath` (relative to its data folder). Throws on a bad path. */
export function addTombstone(home: string, hash: string, relPath: string, nowMs: number = Date.now()): Tombstone {
  if (pathNameRefusal(relPath)) throw new Error(`bad path: ${relPath.slice(0, 80)}`);
  const all = readAll(home, hash).filter((t) => live(t, nowMs) && t.path !== relPath);
  const stone = { path: relPath, at: new Date(nowMs).toISOString() };
  all.push(stone);
  writeJsonAtomic(tombstonesPath(home, hash), { paths: all.slice(-MAX_STONES) });
  return stone;
}

/** The live tombstones (expired ones left out). Never throws. */
export function listTombstones(home: string, hash: string, nowMs: number = Date.now()): Tombstone[] {
  try { return readAll(home, hash).filter((t) => live(t, nowMs)); } catch { return []; }
}

/** Drop the stones whose delete reached the remote, and the expired ones. */
export function clearTombstones(home: string, hash: string, delivered: string[], nowMs: number = Date.now()): void {
  const all = readAll(home, hash);
  const keep = all.filter((t) => live(t, nowMs) && !delivered.includes(t.path));
  if (keep.length === all.length) return;
  writeJsonAtomic(tombstonesPath(home, hash), { paths: keep });
}

/** One sync's deletes: all of them, or none and ask, when there are more than the cap. */
export function capDeletes(paths: string[]): { send: string[]; ask: boolean } {
  return paths.length > PER_SYNC_DELETE_CAP ? { send: [], ask: true } : { send: paths, ask: false };
}
