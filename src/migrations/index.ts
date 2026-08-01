import { compareVersions } from '../lib/version-check.js';
import { readLedger } from '../lib/migration-ledger.js';
import { migration070 } from './0.7.0.js';
import { migration072 } from './0.7.2.js';
import { migration080 } from './0.8.0.js';
import { migration1007 } from './0.10.7.js';
import { migration0180 } from './0.18.0.js';
import { migration0230 } from './0.23.0.js';
import { migration0230SoulSplit } from './0.23.0-soul-split.js';
import type { Migration } from './types.js';

/**
 * The ordered registry of all versioned migrations.
 * Adding a new release migration: add src/migrations/<version>.ts,
 * export its Migration object, and push it here.
 * See CONTRIBUTING.md §"Shipping a migration" for the full checklist.
 */
// Two entries share version 0.23.0 on purpose (people-first + soul-split):
// the runner gates each step by its own id, merges same-version changelog
// entries, and unfinishedAgentTasks matches each agentTask id separately.
// The user-split entry stays FIRST so its residue task is printed first.
export const REGISTRY: Migration[] = [migration070, migration072, migration080, migration1007, migration0180, migration0230, migration0230SoulSplit];

/**
 * Return all migrations whose version falls in the half-open range (from, to].
 * Equal `from === to` → empty (nothing to do on a same-version run).
 * Sorted ascending by version so they apply in the correct order.
 *
 * Reuses compareVersions from src/lib/version-check.ts.
 */
export function pendingMigrations(from: string, to: string): Migration[] {
  return REGISTRY.filter(
    (m) =>
      compareVersions(m.version, from) > 0 &&
      compareVersions(m.version, to) <= 0,
  ).sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Migrations whose CODE steps ran but whose agentTask was never recorded —
 * judged by the LEDGER, never by setupVersion.
 *
 * `update` advances setupVersion as soon as the code steps land, which made a
 * setupVersion-ranged `migrations pending` compute the empty range
 * (cliVersion, cliVersion] and go blind to the very task it exists to print —
 * the 0.23.0 residue file pointed the user here, and "here" said there was
 * nothing to do (found live on the first real 0.23.0 run, 2026-07-30).
 *
 * "Started" is required so a FRESH vault (init'ed at the current version, no
 * ledger entries at all) is never told to distribute a residue that does not
 * exist: a migration is unfinished only when its code/detected steps are in
 * the ledger and its agent step is not.
 */
export function unfinishedAgentTasks(contextRoot: string, toVersion: string): Migration[] {
  const ledger = readLedger(contextRoot);
  return REGISTRY.filter((m) => {
    if (!m.agentTask) return false;
    // Opt-in tasks are an offer, not an obligation — never "unfinished".
    if (m.agentTask.optIn) return false;
    if (compareVersions(m.version, toVersion) > 0) return false;
    const entries = ledger.filter((e) => e.version === m.version);
    const started = entries.some((e) => e.executor === 'code' || e.executor === 'detected');
    const done = entries.some((e) => e.executor === 'agent' && e.step === m.agentTask!.id);
    return started && !done;
  }).sort((a, b) => compareVersions(a.version, b.version));
}
