import { migrateFeaturesToKnowledge } from '../lib/features-migration.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.10.7: collapse the `feature` entity into typed knowledge.
 *
 * One step, `move-features-to-knowledge`: moves core/features/*.md →
 * knowledge/features/*.md, enriching frontmatter with the knowledge-index
 * contract (`type: feature`, name, description, pinned:false, date). Slugs are
 * preserved unchanged; bodies are copied verbatim.
 *
 * The step is fully deterministic (no agentTask), two-phase, crash-safe, and
 * NEVER throws — `migrateFeaturesToKnowledge` collects every failure into
 * `failed`, surfaced here as `failedCount` so the runner keeps setupVersion
 * pinned on a partial run.
 *
 * Reuses migrateFeaturesToKnowledge from src/lib/features-migration.ts — do NOT
 * reimplement.
 */
export const migration1007: Migration = {
  version: '0.10.7',
  steps: [
    (root: string): MigrationStepResult => {
      const { migrated, skipped, failed } = migrateFeaturesToKnowledge(root);
      const filesTouched = migrated.map((s) => `knowledge/features/${s}.md`);
      // detected = a true no-op: nothing moved, nothing failed, AND nothing
      // skipped. A skipped-only run still unlinks leftover sources in phase 2
      // (crash-recovery after a run killed between phases) — that is a real
      // write and must record executor 'code' so the CHANGELOG entry and the
      // sleep notice fire. A fully-migrated re-run enumerates zero sources, so
      // all three counts are 0 and detected stays true there.
      const detected = migrated.length === 0 && failed.length === 0 && skipped.length === 0;

      const parts: string[] = [];
      if (migrated.length > 0) parts.push(`Moved features: ${migrated.join(', ')}`);
      if (skipped.length > 0) parts.push(`already at destination: ${skipped.join(', ')}`);
      if (failed.length > 0) {
        parts.push(
          `${failed.length} failed (${failed.map((f) => `${f.slug}: ${f.error}`).join('; ')})`,
        );
      }
      const summary =
        parts.length > 0
          ? parts.join('; ')
          : 'No core/features/ source directory — nothing to move';

      return {
        step: 'move-features-to-knowledge',
        filesTouched,
        summary,
        detected,
        failedCount: failed.length,
      };
    },
  ],
  // No agentTask on 0.10.7 — the step is fully deterministic.
};
