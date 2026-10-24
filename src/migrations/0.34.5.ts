import { relative } from 'node:path';
import { backfillFaces } from '../lib/agents/faces.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.34.5: every agent and automation wears its figure.
 *
 * A new member is stamped at create (`face: {shape, color}`, unhashed, like `photo`); this step
 * stamps the members that predate figures, in creation order, each taking the next free pair
 * (`lib/agents/faces.ts`, the rule in `figure.ts`). `everyRun`: a vault already at this version
 * still gets its older members stamped, and a vault whose members are all stamped costs one read
 * of each manifest and writes nothing (`detected`, not ledgered). No hash changes: `face` is
 * not approval-hashed, so no approval anywhere is touched.
 */
export const migration0345: Migration = {
  version: '0.34.5',
  everyRun: true,
  steps: [
    (root: string): MigrationStepResult => {
      const step = 'stamp-agent-faces';
      const stamped = backfillFaces(root);
      if (stamped.length === 0) {
        return { step, filesTouched: [], summary: 'Every agent and automation already wears its figure', detected: true };
      }
      return {
        step,
        filesTouched: stamped,
        detected: false,
        summary: `Gave ${stamped.length} agent${stamped.length === 1 ? '' : 's'} and automation${stamped.length === 1 ? '' : 's'} a figure (${stamped.map((p) => relative(root, p)).join(', ')})`,
      };
    },
  ],
};
