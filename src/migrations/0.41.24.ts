import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_FILE_CHAR_CEILING } from '../lib/core-index.js';
import { appendLedger, readLedger } from '../lib/migration-ledger.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * 0.41.24: settle the agent work old ledgers left undecided.
 *
 * Before 0.41.24 a task counted as waiting when ANY code/detected entry of its
 * version existed, so a vault whose 0.23.0 detection found nothing (a soul
 * under the ceiling, no residue) still read as having work. From 0.41.24 a task
 * is due only through an `agentWorkFor` sighting (see `dueAgentTasks`). Ledgers
 * written before that carry no sighting at all, so this step looks at the
 * filesystem ONCE and decides each of the two legacy 0.23.0 tasks:
 *
 *   - work is there: a re-check sighting, `<task>-recheck#work`, so the task is due;
 *   - nothing is there: the task's own `agent` entry, so it never comes back.
 *
 * A vault that never ran 0.23.0 is skipped: its own 0.23.0 run (in this pass
 * or a later one) reports work through `agentWorkFor`. A file that cannot be
 * read is never "nothing there": that task is left for the next run.
 *
 * Writes the ledger only.
 */
export const SETTLE_VERSION = '0.41.24';

export const LEGACY_SETTLED_TASKS = ['distribute-user-md-residue', 'split-soul-into-patterns'] as const;

type Verdict = 'due' | 'clear' | 'unknown';

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function residueVerdict(root: string): Verdict {
  try {
    lstatSync(join(root, 'inbox', '1.user-residue.md'));
    return 'due';
  } catch (err) {
    return errCode(err) === 'ENOENT' ? 'clear' : 'unknown';
  }
}

function soulVerdict(root: string): Verdict {
  const soulPath = join(root, 'core', '0.soul.md');
  try {
    const st = lstatSync(soulPath);
    // A symlinked soul is not read through (vault-path rule): undecided.
    if (st.isSymbolicLink() || !st.isFile()) return 'unknown';
    const chars = readFileSync(soulPath, 'utf-8').length;
    return chars > CORE_FILE_CHAR_CEILING ? 'due' : 'clear';
  } catch (err) {
    return errCode(err) === 'ENOENT' ? 'clear' : 'unknown';
  }
}

export function settleAgentWork(root: string): MigrationStepResult {
  const step = 'settle-agent-work';
  const ledger = readLedger(root);
  if (!ledger.some((e) => e.version === '0.23.0')) {
    return {
      step,
      filesTouched: [],
      summary: 'This vault never ran 0.23.0: its own run reports any agent work.',
      detected: true,
    };
  }
  const verdicts: Record<(typeof LEGACY_SETTLED_TASKS)[number], () => Verdict> = {
    'distribute-user-md-residue': () => residueVerdict(root),
    'split-soul-into-patterns': () => soulVerdict(root),
  };
  const notes: string[] = [];
  for (const id of LEGACY_SETTLED_TASKS) {
    if (ledger.some((e) => e.executor === 'agent' && e.step === id)) continue;
    // Already sighted under the new rule (0.23.0 ran in this same pass).
    if (ledger.some((e) => e.agentWorkFor === id)) continue;
    const verdict = verdicts[id]();
    const timestamp = new Date().toISOString();
    if (verdict === 'due') {
      appendLedger(root, {
        version: SETTLE_VERSION,
        step: `${id}-recheck#work`,
        executor: 'detected',
        timestamp,
        filesTouched: [],
        summary: `Re-checked by ${SETTLE_VERSION}: work is still there.`,
        agentWorkFor: id,
      });
      notes.push(`${id}: due`);
    } else if (verdict === 'clear') {
      appendLedger(root, {
        version: '0.23.0',
        step: id,
        executor: 'agent',
        timestamp,
        filesTouched: [],
        summary: `nothing left to do (checked by ${SETTLE_VERSION})`,
      });
      notes.push(`${id}: nothing left`);
    } else {
      notes.push(`${id}: could not read, left for the next run`);
    }
  }
  return {
    step,
    filesTouched: [],
    summary: notes.length > 0 ? `Settled legacy agent work (${notes.join('; ')}).` : 'No legacy agent work to settle.',
    detected: true,
  };
}

export const migration04124: Migration = {
  version: SETTLE_VERSION,
  steps: [settleAgentWork],
};
