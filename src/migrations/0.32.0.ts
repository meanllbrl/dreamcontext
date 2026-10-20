import { join, relative } from 'node:path';
import { foldTaskJournals, hasTaskJournals } from '../lib/task-journal-fold.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.32.0: the reverted 0.33.0 task journals go back onto their cards.
 *
 * Only vaults a 0.33.0 build touched have `state/journal/` (that build was
 * installed on a few machines and never published). Those vaults carry
 * `setupVersion` 0.33.0, above this CLI, so the step is `everyRun`: a version
 * range can never reach it. It costs one directory check everywhere else and
 * reports `detected`, which the runner does not ledger.
 *
 * What it does, the backups it keeps, why the next sync posts nothing and why a
 * brain that syncs through git keeps its journals in place: lib/task-journal-fold.ts. A busy lock or an unwritable card counts as failed
 * (retried on the next run, nothing lost); a journal with no card is kept in
 * the backup and named, not counted as failed.
 */
export const migration0320: Migration = {
  version: '0.32.0',
  everyRun: true,
  steps: [
    (root: string): MigrationStepResult => {
      const step = 'fold-task-journals';
      if (!hasTaskJournals(root)) {
        return { step, filesTouched: [], summary: 'No 0.33.0 task journals — nothing to fold', detected: true };
      }
      const r = foldTaskJournals(root);
      const parts: string[] = [];
      if (r.lockBusy) {
        parts.push(`a task sync is running: ${r.journals} journal(s) left in state/journal/ for the next run`);
      } else {
        parts.push(
          `Folded ${r.folded.length} of ${r.journals} task journal(s) back into their cards' ## Changelog `
          + `(${r.entriesAdded} entries added, ${r.entriesPresent} already on the card)`,
        );
        if (r.entriesRescued > 0) {
          parts.push(`${r.entriesRescued} log entr${r.entriesRescued === 1 ? 'y' : 'ies'} the reverted CLI had appended at the end of ${r.rescuedCards.length} card(s) moved into their Changelog (the next sync posts them as comments): ${r.rescuedCards.join(', ')}`);
        }
        if (r.ledgerSeeded > 0) parts.push(`sync ledger: ${r.ledgerSeeded} task(s) record that history as already posted, so no sync posts it again`);
        if (r.kept) {
          parts.push('this brain syncs through git, so the journals stay in state/journal/ (moving them would delete every teammate\'s copy); neither the task list nor recall reads them');
          if (r.orphans.length > 0) parts.push(`no card for ${r.orphans.length} journal(s), left in place: ${r.orphans.join(', ')}`);
          if (r.backupDir) parts.push(`the cards as they were before are in ${relative(root, r.backupDir)}/`);
        } else {
          if (r.orphans.length > 0) parts.push(`no card for ${r.orphans.length} journal(s), kept in the backup: ${r.orphans.join(', ')}`);
          if (r.backupDir) parts.push(`journals and the cards they changed are in ${relative(root, r.backupDir)}/`);
        }
      }
      for (const f of r.failed.slice(0, 5)) parts.push(`not folded: ${f.slug} (${f.reason})`);
      if (r.failed.length > 5) parts.push(`…and ${r.failed.length - 5} more not folded`);
      return {
        step,
        // Kept journals: only the cards this run rewrote were touched (the journals stay).
        filesTouched: (r.kept ? r.cardsWritten : r.folded).map((slug) => join(root, 'state', `${slug}.md`)),
        summary: parts.join('; '),
        detected: false,
        ...(r.failed.length > 0 ? { failedCount: r.failed.length } : {}),
      };
    },
  ],
};
