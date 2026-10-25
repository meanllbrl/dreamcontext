import { relative } from 'node:path';
import { backfillFaces } from '../lib/agents/faces.js';
import { applyAgentPrivacy, stampOwners } from '../lib/agents/agent-sync.js';
import { seedAssignmentLedger } from '../lib/agents/assignment-ledger.js';
import { currentOwnAssignments } from '../lib/agents/outside-assignments.js';
import { dirname } from 'node:path';
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
 *
 * Second step (AI Team v2 B1-3): every agent and automation carries its owner. Stamped on every
 * upgraded machine whether or not the agent-sync switch is on: a file created here gets this
 * machine's login, an already-shared file the login of whoever added it (the same answer on every
 * machine), `unowned` when that cannot be worked out. `owner:` is unhashed, the line is added
 * byte-surgically, and the privacy block in `.git/info/exclude` is put in place.
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
    (root: string): MigrationStepResult => {
      const step = 'stamp-agent-owners';
      const { stamped, unowned } = stampOwners(root);
      applyAgentPrivacy(root);
      if (stamped.length === 0) {
        return { step, filesTouched: [], summary: 'Every agent and automation already carries its owner', detected: true };
      }
      return {
        step,
        filesTouched: stamped,
        detected: false,
        summary: `Stamped the owner on ${stamped.length} agent${stamped.length === 1 ? '' : 's'} and automation${stamped.length === 1 ? '' : 's'}${unowned.length > 0 ? ` (${unowned.length} unowned, read-only everywhere: ${unowned.join(', ')})` : ''}`,
      };
    },
    (root: string): MigrationStepResult => {
      // Once per machine: the assignments in flight at upgrade were made by a local action (the
      // only way there was), so they start as this machine's ledger instead of a flood of
      // "assigned outside the app" rows. Machine-local (M0): no file in the vault changes.
      const step = 'seed-assignment-ledger';
      const added = seedAssignmentLedger(dirname(root), currentOwnAssignments(root));
      return { step, filesTouched: [], detected: added === 0, summary: added === 0 ? 'Assignment ledger already seeded' : `Recorded ${added} task assignment${added === 1 ? '' : 's'} already in flight as this machine's` };
    },
  ],
};
