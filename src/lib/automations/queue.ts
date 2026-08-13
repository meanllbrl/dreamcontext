/**
 * The machine-local run queue (D9).
 *
 * THE PROBLEM THIS SOLVES. There is no queue today: `tick.ts` checks `isDue()`
 * and awaits each due automation sequentially, and a fire that arrives while
 * the per-slug lock is held is simply lost — the watermark is not advanced for
 * it, but nothing remembers it either, so the next tick has no record that a
 * fire was owed. This file gives a fire somewhere to wait.
 *
 * AT MOST ONE WAITING ENTRY PER SLUG, BY CONSTRUCTION. The on-disk shape keys
 * a slug's queued fire by the slug itself (an object key), so a second enqueue
 * of the same slug overwrites the first — that overwrite IS D9's "drop the
 * older waiting entry", not a rule enforced on top of a list.
 *
 * MACHINE-LOCAL, NEVER THE BRAIN. A synced queue is a remote-write primitive:
 * a teammate pushing an entry into a shared brain would make THIS machine run
 * an automation at a time nobody here scheduled, spending this machine's
 * `bypassPermissions` grant. Same threat class as a synced review card (see
 * `card-registry.ts`), and `automations/cache/` is not a substitute — its
 * gitignore coverage is best-effort (re-ensured every run precisely because it
 * can go missing), which is a weaker guarantee than "not in the repo at all".
 *
 * Mechanics mirror `card-registry.ts` exactly: injectable `home` (defaults to
 * `homedir()`), never-throw sanitizing reads, atomic temp-file + `renameSync`
 * writes at mode 0600, and a TTL prune on every write so the file cannot grow
 * forever on a machine that runs automations daily.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSafeAutomationSlug } from './store.js';

/** A queued fire past this age is no longer useful to drain — it is well
 *  outside any sane `catchupHours` window, so pruning it here (rather than
 *  only at drain time) keeps the file from accumulating entries nothing will
 *  ever read. Shorter than `card-registry.ts`'s 90-day TTL on purpose: a card
 *  waits on a human indefinitely, but a queued fire waits on a lock clearing,
 *  and D-D's own catch-up bound is measured in hours, not months. */
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface QueuedFire {
  slug: string;
  /** The scheduled fire this entry answers for — carried through unchanged so
   *  draining advances the watermark to the fire it answers for, never to
   *  drain time. */
  firedAt: string;
  enqueuedAt: string;
}

interface QueueFile {
  [projectRoot: string]: {
    [slug: string]: QueuedFire;
  };
}

export function automationsQueuePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'automations-queue.json');
}

function isValidQueuedFire(v: unknown): v is QueuedFire {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.slug === 'string' &&
    e.slug.length > 0 &&
    typeof e.firedAt === 'string' &&
    e.firedAt.length > 0 &&
    typeof e.enqueuedAt === 'string' &&
    e.enqueuedAt.length > 0
  );
}

/** Never throws: an unreadable or malformed file degrades to "nothing is
 *  queued", which is safe — a lost queue entry means one fire is missed and
 *  caught up on later, where a thrown error would take the tick down with it.
 *  A malformed project or slug entry is dropped individually; sibling valid
 *  entries survive. */
function readAll(home: string): QueueFile {
  const path = automationsQueuePath(home);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: QueueFile = {};
    for (const [projectRoot, slugs] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof projectRoot !== 'string' || projectRoot.length === 0) continue;
      if (!slugs || typeof slugs !== 'object' || Array.isArray(slugs)) continue;
      const kept: Record<string, QueuedFire> = {};
      for (const [slug, entry] of Object.entries(slugs as Record<string, unknown>)) {
        if (typeof slug === 'string' && slug.length > 0 && isValidQueuedFire(entry)) {
          kept[slug] = entry;
        }
      }
      if (Object.keys(kept).length > 0) out[projectRoot] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic write (temp + rename) at mode 0600, pruning every entry past the
 *  TTL first — the same discipline `card-registry.ts` uses for its bindings. */
function writeAll(home: string, all: QueueFile, nowMs: number): void {
  const path = automationsQueuePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const kept: QueueFile = {};
  for (const [projectRoot, slugs] of Object.entries(all)) {
    const keptSlugs: Record<string, QueuedFire> = {};
    for (const [slug, entry] of Object.entries(slugs)) {
      const enqueuedAt = Date.parse(entry.enqueuedAt);
      if (Number.isFinite(enqueuedAt) && nowMs - enqueuedAt > QUEUE_TTL_MS) continue;
      keptSlugs[slug] = entry;
    }
    if (Object.keys(keptSlugs).length > 0) kept[projectRoot] = keptSlugs;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Record that `slug` fired but could not run, so a later drain can catch it
 * up. A second enqueue for the same slug OVERWRITES the first — the object
 * key is the whole mechanism behind D9's "at most one waiting entry per
 * automation, the newer replaces the older".
 *
 * Silently refuses an unsafe slug: it is not used as a path segment here, but
 * a queue entry naming a traversal string would eventually be handed to
 * `getAutomation`, and refusing at the boundary is cheaper than reasoning
 * about it downstream.
 */
export function enqueueFire(projectRoot: string, slug: string, firedAt: string, home: string = homedir(), nowMs: number = Date.now()): void {
  if (!isSafeAutomationSlug(slug)) return;
  const all = readAll(home);
  const slugs = { ...(all[projectRoot] ?? {}) };
  slugs[slug] = { slug, firedAt, enqueuedAt: new Date(nowMs).toISOString() };
  writeAll(home, { ...all, [projectRoot]: slugs }, nowMs);
}

/** The queued fire for one slug, or null if none is waiting. Read-only —
 *  does not clear the entry (see {@link drainQueue} for the path that does). */
export function queuedFire(projectRoot: string, slug: string, home: string = homedir()): QueuedFire | null {
  return readAll(home)[projectRoot]?.[slug] ?? null;
}

/** Remove one slug's queued fire, if any. A no-op, never a throw, when
 *  nothing was queued for it. */
export function clearQueuedFire(projectRoot: string, slug: string, home: string = homedir(), nowMs: number = Date.now()): void {
  const all = readAll(home);
  const slugs = all[projectRoot];
  if (!slugs || !(slug in slugs)) return;
  const kept = { ...slugs };
  delete kept[slug];
  writeAll(home, { ...all, [projectRoot]: kept }, nowMs);
}

/**
 * Every queued fire for one project, and clears them all in the same write —
 * the tick's "drain then run" idiom, so a fire is never left half-drained
 * (still on disk after the tick has already decided to run it).
 *
 * Entries under OTHER project roots are left untouched.
 */
export function drainQueue(projectRoot: string, home: string = homedir(), nowMs: number = Date.now()): QueuedFire[] {
  const all = readAll(home);
  const slugs = all[projectRoot];
  if (!slugs) return [];
  const drained = Object.values(slugs);
  const rest = { ...all };
  delete rest[projectRoot];
  writeAll(home, rest, nowMs);
  return drained;
}
