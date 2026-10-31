import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPER_STATE_REL } from '../super/store.js';
import { allPendingQuestions, listQuestions } from './hitl.js';
import { readThread } from './threads.js';
import type { ThreadEntry } from './types.js';

/**
 * A job the Super Agent gave an AI Team member (`super team ask`) reports to the Super Agent, not
 * to the owner: it comes back as `team=<job> event=done`. So what it says is no news for him: no
 * unread, no banner, no notch row (owner, 2026-10-31). It stays readable in the member's thread.
 *
 * THE ONE RULE, read by every unread count and every banner. Derived from the thread, never
 * stored, so old jobs fall out of the counts with nothing written or deleted:
 *  - an entry belongs to whoever spoke last in its run. `via: 'super'` makes what follows the
 *    Super's; the owner writing into that run takes it back.
 *  - a failure is never quiet: it must not vanish if the Super says nothing about it.
 *  - a run with a question waiting on the owner is never quiet: only he can answer it.
 *  - the project must be handed over NOW. With the mode off nobody relays the result.
 */

const LOUD_EVENTS = new Set(['failed', 'timeout', 'skipped']);

/** Is this project handed over to its Super Agent? Read from the record, so a CLI process (which
 *  has no in-memory index) agrees with the server. Anything unreadable reads as off: notify. */
export function superHandedOver(contextRoot: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(contextRoot, SUPER_STATE_REL), 'utf-8')) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/** The entries of one run that are the Super's job's own, by the rule above (questions apart). */
function superOwned(run: readonly ThreadEntry[]): Set<string> {
  const quiet = new Set<string>();
  let asker: string | null = null;
  for (const e of [...run].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (e.kind === 'user') { asker = e.via; continue; }
    if (asker !== 'super') continue;
    if (e.kind === 'system' && e.event && LOUD_EVENTS.has(e.event)) continue;
    quiet.add(e.id);
  }
  return quiet;
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * A reader for one pass over a project: `(slug, run) => the ids that count for nobody`. The record
 * and the questions are read at most once, and only for a run the Super actually spoke in, so a
 * project that never used it pays nothing.
 */
export function superQuietReader(contextRoot: string): (slug: string, run: readonly ThreadEntry[]) => ReadonlySet<string> {
  let handed: boolean | null = null;
  let asking: Set<string> | null = null;
  return (slug, run) => {
    if (!run.some((e) => e.kind === 'user' && e.via === 'super')) return NOTHING;
    handed ??= superHandedOver(contextRoot);
    if (!handed) return NOTHING;
    if (!asking) {
      asking = new Set();
      try { for (const q of allPendingQuestions(contextRoot)) asking.add(`${q.slug}::${q.runFiredAt}`); } catch { /* unreadable: no question known */ }
    }
    if (asking.has(`${slug}::${run[0]?.runId}`)) return NOTHING;
    return superOwned(run);
  };
}

/** Is the run's turn now a Super job's clean end, so a banner about it would be noise? */
export function superRunQuiet(contextRoot: string, slug: string, runId: string): boolean {
  try {
    if (!superHandedOver(contextRoot)) return false;
    const fired = Date.parse(runId);
    const fromDay = Number.isFinite(fired) ? new Date(fired - 86_400_000).toISOString().slice(0, 10) : undefined;
    const run = readThread(contextRoot, slug, { runId, ...(fromDay ? { fromDay } : {}) });
    const asks = run.filter((e) => e.kind === 'user').sort((a, b) => (a.id < b.id ? -1 : 1));
    if (asks[asks.length - 1]?.via !== 'super') return false;
    return !listQuestions(contextRoot, slug).some((q) => q.state === 'pending' && q.runFiredAt === runId);
  } catch {
    return false;
  }
}
