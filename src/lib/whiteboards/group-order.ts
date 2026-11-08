import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLockWithin, releaseFileLock } from '../file-lock.js';
import { ensureWhiteboardsDir, whiteboardsDir } from './store.js';
import { foldGroup, parseGroupInput, readGroup } from './validate.js';
import { WhiteboardLockError, WhiteboardValidationError } from './errors.js';

/**
 * The order of the board explorer's groups (owner, 2026-11-04: "can I reorder the groups by
 * drag and drop?"). A group itself is derived from the boards' frontmatter, so it has no file
 * of its own; its PLACE lives here, in `whiteboards/.groups.json`, beside the boards, and
 * syncs with the brain the same way they do. The dot keeps it out of the board list.
 *
 * Shape: `{ "order": ["Tilki", "Ops"] }`. Names are matched by {@link foldGroup}; a group not
 * listed sorts after the listed ones, by name. An entry no board carries is harmless and is
 * dropped by the next reorder (the dashboard sends the whole order it shows).
 *
 * A two-sided edit is merged by {@link mergeGroupOrderJson} (semantic-merge.ts), never handed
 * to an agent: the order is a preference, not prose.
 */
export const GROUP_ORDER_FILE = '.groups.json';
/** More groups than any explorer shows; a bigger list is cut, never refused on read. */
export const GROUP_ORDER_MAX = 500;

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** Valid names, one per fold, first spelling wins, at most {@link GROUP_ORDER_MAX}. */
function cleanOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const name = readGroup(x);
    if (name === null) continue;
    const key = foldGroup(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= GROUP_ORDER_MAX) break;
  }
  return out;
}

/** The order inside a file's text; anything unreadable is the empty order. */
export function parseGroupOrder(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return cleanOrder((parsed as Record<string, unknown>).order);
  } catch {
    return [];
  }
}

export function serializeGroupOrder(order: readonly string[]): string {
  return `${JSON.stringify({ order }, null, 2)}\n`;
}

function orderFile(root: string): string {
  return join(whiteboardsDir(root), GROUP_ORDER_FILE);
}

/** The stored order. A missing, broken or symlinked file reads as no order (never followed). */
export function readGroupOrder(root: string): string[] {
  const file = orderFile(root);
  try {
    const st = lstatSync(whiteboardsDir(root));
    if (!st.isDirectory()) return [];
    const f = lstatSync(file);
    if (!f.isFile()) return [];
    return parseGroupOrder(readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

async function withOrderLock(root: string, fn: (current: string[]) => string[] | null): Promise<string[]> {
  const base = ensureWhiteboardsDir(root);
  const file = join(base, GROUP_ORDER_FILE);
  try {
    if (lstatSync(file).isSymbolicLink()) throw new WhiteboardValidationError(`whiteboards/${GROUP_ORDER_FILE} is a symlink; refusing to write through it`);
  } catch (err) {
    if (err instanceof WhiteboardValidationError) throw err;
  }
  const lockPath = join(base, '.locks', 'groups-order.lock');
  const held = await acquireFileLockWithin(lockPath, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
  if (!held) throw new WhiteboardLockError('the group order is busy (another write holds its lock); try again');
  try {
    const current = readGroupOrder(root);
    const next = fn(current);
    if (next === null) return current;
    const out = serializeGroupOrder(next);
    let before: string | null = null;
    try { before = readFileSync(file, 'utf-8'); } catch { /* not there yet */ }
    if (before === out) return next;
    const tmp = join(base, `${GROUP_ORDER_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, out, 'utf-8');
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return next;
  } finally {
    releaseFileLock(lockPath);
  }
}

/**
 * Replace the order (the dashboard's PUT). Every entry must be a valid group name: a bad one
 * is refused, never quietly dropped. Duplicates by fold keep the first.
 */
export async function writeGroupOrder(root: string, order: unknown): Promise<string[]> {
  if (!Array.isArray(order)) throw new WhiteboardValidationError('send {order}: the group names, top first');
  if (order.length > GROUP_ORDER_MAX) throw new WhiteboardValidationError(`at most ${GROUP_ORDER_MAX} groups`);
  const names = order.map((x) => {
    if (typeof x !== 'string') throw new WhiteboardValidationError('every entry of order is a group name');
    return parseGroupInput(x) as string;
  });
  const clean = cleanOrder(names);
  return withOrderLock(root, () => clean);
}

/**
 * A group renamed keeps its place; ungrouped (`to: null`) leaves the order. If the new name
 * folds onto a group already listed, that one keeps its place and the old entry goes.
 * No file, or the group not listed: nothing written.
 */
export async function renameInGroupOrder(root: string, from: string, to: string | null): Promise<void> {
  const key = foldGroup(from);
  if (!readGroupOrder(root).some((g) => foldGroup(g) === key)) return;
  await withOrderLock(root, (current) => {
    const at = current.findIndex((g) => foldGroup(g) === key);
    if (at < 0) return null;
    const next = [...current];
    if (to === null || current.some((g, i) => i !== at && foldGroup(g) === foldGroup(to))) next.splice(at, 1);
    else next[at] = to;
    return next;
  });
}

/**
 * Two machines reordered at once: ours wins where both list a group; a group only theirs
 * added since the base is kept, right after the group it followed there (or at the top);
 * a group either side dropped since the base stays dropped.
 */
export function mergeGroupOrderJson(base: string, ours: string, theirs: string): string {
  const b = new Set(parseGroupOrder(base).map(foldGroup));
  const o = parseGroupOrder(ours);
  const t = parseGroupOrder(theirs);
  const tKeys = new Set(t.map(foldGroup));
  const result = o.filter((g) => !b.has(foldGroup(g)) || tKeys.has(foldGroup(g)));
  const has = (k: string) => result.some((g) => foldGroup(g) === k);
  for (let i = 0; i < t.length; i++) {
    const k = foldGroup(t[i]);
    if (has(k) || b.has(k)) continue;
    // After the nearest group above it there that we also have; none above = the top.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = result.findIndex((g) => foldGroup(g) === foldGroup(t[j]));
      if (idx >= 0) { at = idx + 1; break; }
    }
    result.splice(at, 0, t[i]);
  }
  return serializeGroupOrder(cleanOrder(result));
}
