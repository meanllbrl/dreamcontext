import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * task-tombstones — a durable marker that a task slug was deliberately RETIRED.
 *
 * The bug this exists for: `planCuratorTask` looked its chore up by fixed slug.
 * When that chore was merged into another task and the file deleted, the lookup
 * missed, and the next sleep cycle filed a fresh, entirely-empty copy. Observed
 * on this brain from 2026-07-18 to 2026-08-23 — one chore resurrected every
 * cycle, and B0's diagnosis found it is the ONLY zero-justification task in 116
 * created since August. A deleted file is not evidence of anything; a tombstone
 * is, and it survives the deletion.
 *
 * The file is BRAIN CONTENT (it syncs to teammates) — unlike the lock/sidecar
 * state, a teammate needs to know a task was consolidated away, or their next
 * cycle re-files it.
 */

export const TOMBSTONES_REL_PATH = 'state/.task-tombstones.json';

/** Newest-first cap. Old enough tombstones stop being load-bearing: the slug
 *  they name is no longer anything a sleep cycle would think to re-file. */
export const MAX_TOMBSTONES = 500;

/** Guard against a pathological chain (a rename loop, a hand-edited file). */
export const MAX_TOMBSTONE_HOPS = 10;

export interface TaskTombstone {
  slug: string;
  /** The task id, when known — lets a remote-backend mapping still be traced. */
  id?: string;
  deletedAt: string;
  /**
   * The task that ABSORBED this one's work, when it was merged rather than
   * dropped. This is what makes the marker actionable: "re-filing this is
   * wrong, and here is where the work actually lives".
   */
  absorbedBy?: string;
  reason?: string;
}

function tombstonesPath(brainRoot: string): string {
  return join(brainRoot, TOMBSTONES_REL_PATH);
}

/** Read the ledger. NEVER throws — a corrupt file degrades to "no tombstones",
 *  which is exactly today's behaviour, rather than breaking every task delete. */
export function readTombstones(brainRoot: string): TaskTombstone[] {
  const path = tombstonesPath(brainRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is TaskTombstone =>
        !!t && typeof t === 'object' && typeof t.slug === 'string' && typeof t.deletedAt === 'string',
    );
  } catch {
    return [];
  }
}

export function writeTombstones(brainRoot: string, tombstones: TaskTombstone[]): void {
  const path = tombstonesPath(brainRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tombstones.slice(0, MAX_TOMBSTONES), null, 2) + '\n', 'utf-8');
}

/**
 * Record that a slug is gone. Newest first; a slug recorded again REPLACES its
 * older entry (a task deleted, recreated and deleted again has one truth, and
 * the newest `absorbedBy` is the one that still points anywhere).
 *
 * Best-effort by design: it is called from inside `delete`/`rename`, and losing
 * the marker must never lose the operation the user actually asked for.
 */
export function appendTombstone(brainRoot: string, tombstone: TaskTombstone): void {
  try {
    const existing = readTombstones(brainRoot).filter((t) => t.slug !== tombstone.slug);
    writeTombstones(brainRoot, [tombstone, ...existing]);
  } catch {
    /* the delete already happened; a missing marker is today's behaviour */
  }
}

export function findTombstone(brainRoot: string, slug: string): TaskTombstone | null {
  return readTombstones(brainRoot).find((t) => t.slug === slug) ?? null;
}

export interface TombstoneResolution {
  /** The tombstone for the slug asked about, if any. */
  tombstone: TaskTombstone | null;
  /**
   * Where the work ended up after following `absorbedBy` transitively: the
   * first slug in the chain that is NOT itself tombstoned. `null` when the
   * chain dead-ends on another tombstone (everything in it was deleted) or
   * when nothing absorbed it.
   */
  livingSlug: string | null;
  /** The slugs walked, for a message that can name the whole chain. */
  chain: string[];
}

/**
 * Follow `absorbedBy` until it reaches a slug with no tombstone of its own.
 *
 * A → B → C where only A and B are tombstoned resolves to C. A chain that ends
 * on a tombstone with no `absorbedBy` resolves to `null` — the work was dropped,
 * not moved, so re-filing it is legitimate again. Cycles and runaway chains stop
 * at {@link MAX_TOMBSTONE_HOPS}.
 */
export function resolveTombstone(brainRoot: string, slug: string): TombstoneResolution {
  const all = readTombstones(brainRoot);
  const byslug = new Map(all.map((t) => [t.slug, t]));
  const tombstone = byslug.get(slug) ?? null;
  const chain: string[] = [slug];

  let cursor = tombstone;
  for (let hops = 0; hops < MAX_TOMBSTONE_HOPS; hops++) {
    if (!cursor?.absorbedBy) break;
    const next = cursor.absorbedBy;
    if (chain.includes(next)) break;   // a cycle — stop rather than spin
    chain.push(next);
    const nextTombstone = byslug.get(next);
    if (!nextTombstone) return { tombstone, livingSlug: next, chain };
    cursor = nextTombstone;
  }

  return { tombstone, livingSlug: null, chain };
}
