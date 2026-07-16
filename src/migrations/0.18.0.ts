import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SyncLedger } from '../lib/task-backend/sync-state.js';
import { TASKS_SYNC_REL } from '../lib/task-backend/paths.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.18.0: clear a pull watermark poisoned by our own pushes (#185).
 *
 * Until 0.18.0 the push advanced the GLOBAL pull watermark to the server time of
 * its own write. The watermark gates the delta pull (`date_updated_gt`), so a
 * push could jump it past a collaborator's older, unpulled task — excluding that
 * task from every future pull, permanently and with no error (the pull simply
 * reports `pulled 0`). Whoever pushed last went blind.
 *
 * Fixing the push code stops NEW poisoning, but an upgrading project still has
 * the poisoned number on disk: its ledger claims "I have pulled everything up to
 * T" when it never did. Nothing in a delta sync can discover what it was told to
 * skip, so the fix does not reach existing users on its own — this migration is
 * what makes `dreamcontext update` / `sleep start` actually heal them.
 *
 * One step, `reset-poisoned-pull-watermark`: null the watermark so the next sync
 * re-reads the container once, in full, recovering anything the poisoned value
 * hid. Everything already current is skipped by the per-task echo gate, so the
 * re-read costs one fetch and writes nothing.
 *
 * Deterministic (no agentTask) and idempotent: a null watermark, a project on
 * the local backend, or a second run all report `detected` and touch nothing.
 * The ledger is gitignored and per-person, so each collaborator heals their own
 * copy when they upgrade — which is right, since each one was poisoned by their
 * own pushes.
 */
export const migration0180: Migration = {
  version: '0.18.0',
  steps: [
    (root: string): MigrationStepResult => {
      const step = 'reset-poisoned-pull-watermark';
      const syncPath = join(root, TASKS_SYNC_REL);

      // No ledger at all = local backend (or never synced). Nothing to heal, and
      // we must not conjure the file into existence.
      if (!existsSync(syncPath)) {
        return {
          step,
          filesTouched: [],
          summary: 'No task-sync ledger (local backend or never synced) — nothing to reset',
          detected: true,
        };
      }

      // A torn ledger needs no handling here: the ledger's own reader contracts
      // "unreadable → fresh default", so the whole sync already treats it as
      // having no watermark — i.e. it full-re-reads anyway, which is exactly what
      // this migration is for. Nothing to reset, nothing hidden.
      const changed = new SyncLedger(root).resetPullWatermark();

      return {
        step,
        filesTouched: changed ? [syncPath] : [],
        summary: changed
          ? 'Cleared the pull watermark — the next task sync re-reads the remote in full once, '
            + 'recovering any collaborator change a pre-0.18.0 push had silently excluded (#185)'
          : 'Pull watermark already clear — nothing to reset',
        detected: !changed,
      };
    },
  ],
};
