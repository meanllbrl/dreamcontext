import { dirname, join } from 'node:path';
import { formatJournalMigrationReport, migrateTaskJournals } from '../lib/task-journal-migration.js';
import { ensureLocalStateIgnored } from '../lib/task-audit.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.33.0: a task's history moves off its card into its journal.
 *
 * Every top-level `state/<slug>.md` loses its `## Changelog` section (moved
 * verbatim to `state/journal/<slug>.md`) and the old template HTML comments;
 * ticked criteria that name no evidence are marked `(evidence: legacy)`, which
 * lets a task stay in review but never satisfies a new done. See
 * lib/task-journal-migration.ts for the byte ledger, backup, locks and the
 * remote sync ledger seeding.
 *
 * Deterministic and idempotent: a second run finds no card with a Changelog or
 * a template comment and reports `detected`. A busy sync or task lock counts
 * as failed so `setupVersion` stays pinned and the next update retries.
 */
export const migration0330: Migration = {
  version: '0.33.0',
  steps: [
    (root: string): MigrationStepResult => {
      const step = 'task-journal-split';
      const report = migrateTaskJournals(root);
      if (report.migrated.length === 0 && report.failed.length === 0) {
        return {
          step,
          filesTouched: [],
          summary: 'Task cards already carry no Changelog or template comments — nothing to do',
          detected: true,
        };
      }
      return {
        step,
        filesTouched: report.migrated.map((slug) => join(root, 'state', `${slug}.md`)),
        summary: formatJournalMigrationReport(report).split('\n').map((l) => l.trim()).join('; '),
        detected: false,
        ...(report.failed.length > 0 ? { failedCount: report.failed.length } : {}),
      };
    },
    // The three machine-local task-system state files (owner chat quotes, the learned-pattern
    // history, the task audit) are ignored in both governing .gitignore files on EVERY vault,
    // whatever shape its ignore has: a generated one, one made by other ensure blocks, or
    // none. Appending is safe: no existing negation matches these paths. The writers also
    // ensure before their first write; this step covers the window before any of them runs.
    // Never throws: a .gitignore that cannot take the lines reports failedCount, so
    // setupVersion stays pinned and the next update retries.
    (root: string): MigrationStepResult => {
      const step = 'local-state-ignore';
      try {
        const added = ensureLocalStateIgnored(root);
        if (added.length === 0) {
          return { step, filesTouched: [], summary: 'Local task-system state files already ignored — nothing to do', detected: true };
        }
        const touched = new Set<string>();
        for (const e of added) touched.add(e.startsWith('_dream_context/') ? join(dirname(root), '.gitignore') : join(root, '.gitignore'));
        return {
          step,
          filesTouched: [...touched],
          summary: `Ignored the local task-system state files: ${added.join(', ')}`,
          detected: false,
        };
      } catch (err) {
        return {
          step,
          filesTouched: [],
          summary: `Could not add the local task-system state files to .gitignore: ${err instanceof Error ? err.message : String(err)}`,
          detected: false,
          failedCount: 1,
        };
      }
    },
  ],
};
