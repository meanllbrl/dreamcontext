import {
  migrateDataStructures,
  fenceExistingDataStructures,
} from '../lib/data-structures-migration.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.7.0: data-structures layout.
 *
 * Two steps:
 *   1. move-data-structures — moves core/data-structures/*.md →
 *      knowledge/data-structures/*.md (enriches frontmatter, wraps SQL fence).
 *   2. fence-data-structures — backfills the sql fence on any files already
 *      present in knowledge/data-structures/ that are not yet fenced.
 *
 * Version key is 0.7.0 because that is the release in which the
 * knowledge/data-structures/ layout was introduced. Both steps are idempotent;
 * the 'detected' path fires on clones that already ran the migration.
 *
 * Reuses migrateDataStructures + fenceExistingDataStructures from
 * src/lib/data-structures-migration.ts — do NOT reimplement.
 */
export const migration070: Migration = {
  version: '0.7.0',
  steps: [
    // Step 1: move core/data-structures/ → knowledge/data-structures/
    (root: string): MigrationStepResult => {
      const result = migrateDataStructures(root);
      const filesTouched = result.migrated.map(
        (p) => `knowledge/data-structures/${p}.md`,
      );
      // detected = nothing was moved (either already at dest or no source dir)
      const detected = result.migrated.length === 0;
      const summary =
        result.migrated.length > 0
          ? `Moved data-structures: ${result.migrated.join(', ')}`
          : result.skipped.length > 0
          ? `Data-structures already at destination (skipped: ${result.skipped.join(', ')})`
          : 'No core/data-structures/ source directory — nothing to move';
      return {
        step: 'move-data-structures',
        filesTouched,
        summary,
        detected,
      };
    },

    // Step 2: fence any unfenced knowledge/data-structures/*.md in place
    (root: string): MigrationStepResult => {
      const fenced = fenceExistingDataStructures(root);
      const filesTouched = fenced.map(
        (p) => `knowledge/data-structures/${p}.md`,
      );
      const detected = fenced.length === 0;
      const summary =
        fenced.length > 0
          ? `Fenced data-structures as SQL: ${fenced.join(', ')}`
          : 'All data-structures already fenced — nothing to do';
      return {
        step: 'fence-data-structures',
        filesTouched,
        summary,
        detected,
      };
    },
  ],
  // No agentTask on 0.7.0 — both steps are fully deterministic.
};
