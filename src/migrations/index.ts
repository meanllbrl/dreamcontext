import { compareVersions } from '../lib/version-check.js';
import { readLedger } from '../lib/migration-ledger.js';
import { migration070 } from './0.7.0.js';
import { migration072 } from './0.7.2.js';
import { migration080 } from './0.8.0.js';
import { migration1007 } from './0.10.7.js';
import { migration0180 } from './0.18.0.js';
import { migration0230 } from './0.23.0.js';
import { migration0230SoulSplit } from './0.23.0-soul-split.js';
import { migration0280 } from './0.28.0.js';
import { migration0310 } from './0.31.0.js';
import { migration0320 } from './0.32.0.js';
import { migration0345 } from './0.34.5.js';
import { migration0402 } from './0.40.2.js';
import { migration04124 } from './0.41.24.js';
import type { Migration } from './types.js';

/**
 * The ordered registry of all versioned migrations.
 * Adding a new release migration: add src/migrations/<version>.ts,
 * export its Migration object, and push it here.
 * See CONTRIBUTING.md §"Shipping a migration" for the full checklist.
 */
// Two entries share version 0.23.0 on purpose (people-first + soul-split):
// the runner gates each step by its own id, merges same-version changelog
// entries, and dueAgentTasks matches each agentTask id separately.
// The user-split entry stays FIRST so its residue task is printed first.
export const REGISTRY: Migration[] = [migration070, migration072, migration080, migration1007, migration0180, migration0230, migration0230SoulSplit, migration0280, migration0310, migration0320, migration0345, migration0402, migration04124];

/**
 * The registry as read at CALL time. A migration module sits in an import cycle (0.31.0 → the
 * agents store → the task starter → migrate-and-stamp → here): when the cycle is entered through
 * a migration, `REGISTRY` above is built while that migration's binding is still unset, so it
 * holds `undefined`. The live bindings are set by the time anything calls in.
 */
function registry(): Migration[] {
  return REGISTRY.includes(undefined as unknown as Migration)
    ? [migration070, migration072, migration080, migration1007, migration0180, migration0230, migration0230SoulSplit, migration0280, migration0310, migration0320, migration0345, migration0402, migration04124]
    : REGISTRY;
}

/**
 * Return all migrations whose version falls in the half-open range (from, to].
 * Equal `from === to` → empty (nothing to do on a same-version run).
 * Sorted ascending by version so they apply in the correct order.
 *
 * Reuses compareVersions from src/lib/version-check.ts.
 */
export function pendingMigrations(from: string, to: string): Migration[] {
  return registry().filter(
    (m) =>
      compareVersions(m.version, from) > 0 &&
      compareVersions(m.version, to) <= 0,
  ).sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * What one runner pass executes: the `(from, to]` range plus every `everyRun`
 * migration this CLI carries (version <= to), whatever `from` says, a
 * downgrade (`from` > `to`) included. Same ascending order as the range.
 */
export function migrationsToRun(from: string, to: string): Migration[] {
  const inRange = compareVersions(to, from) >= 0 ? pendingMigrations(from, to) : [];
  const everyRun = registry().filter(
    (m) => m.everyRun && compareVersions(m.version, to) <= 0 && !inRange.includes(m),
  );
  return [...inRange, ...everyRun].sort((a, b) => compareVersions(a.version, b.version));
}

/** One agentTask that has work waiting: what the snapshot, the Super and `migrations pending --json` name. */
export interface DueTask {
  version: string;
  id: string;
  title: string;
}

/**
 * Agent tasks with work WAITING — judged by the LEDGER, never by setupVersion,
 * and by the TASK, never by its version.
 *
 * A task is due iff some ledger entry reports work for it (`agentWorkFor ===
 * task.id`: a step's `<step>#work` sighting, or the 0.41.24 settle's re-check)
 * and no `executor: 'agent'` entry carries `step === task.id` (the agent's tick,
 * or the owner's recorded "no"). So:
 *   - a fresh vault (init'ed at the current version, an empty ledger) has none;
 *   - a detection that found nothing writes no sighting, so it has none either;
 *   - one migration's sighting never makes a sibling on the same version due
 *     (0.23.0 carries two tasks).
 *
 * The old rule ("any code/detected entry of the version, no agent entry")
 * called a 3,000-char soul due because its detection step had run. Legacy
 * ledgers written under it are settled once by the 0.41.24 migration.
 *
 * Pure read. A malformed ledger reads as `[]` (readLedger); never throws.
 */
export function dueAgentTasks(contextRoot: string, toVersion: string): DueTask[] {
  let ledger: ReturnType<typeof readLedger>;
  try {
    ledger = readLedger(contextRoot);
  } catch {
    return [];
  }
  const entries = ledger.filter((e) => e && typeof e === 'object');
  const out: DueTask[] = [];
  for (const m of registry()) {
    const task = m.agentTask;
    if (!task || task.optIn) continue;
    if (compareVersions(m.version, toVersion) > 0) continue;
    const sighted = entries.some((e) => e.agentWorkFor === task.id);
    if (!sighted) continue;
    const done = entries.some((e) => e.executor === 'agent' && e.step === task.id);
    if (done) continue;
    out.push({ version: m.version, id: task.id, title: task.title });
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** The registered agentTask for an id, with its migration's version. */
export function agentTaskById(id: string): { version: string; task: NonNullable<Migration['agentTask']> } | null {
  for (const m of registry()) {
    if (m.agentTask?.id === id) return { version: m.version, task: m.agentTask };
  }
  return null;
}
