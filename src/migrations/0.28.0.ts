import { migrateThreadIgnoreBlocks } from '../lib/automations/sharing.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.28.0: an agent's CHANNEL becomes private by default.
 *
 * Threads land at `automations/threads/<slug>/<YYYY-MM-DD>.md`. The automations
 * ignore block's manifest wildcard is `automations/*.md`, which matches only
 * files directly under `automations/` — so before this release a thread file
 * was, by default, TRACKED. A private automation's channel, which is where its
 * run now says what it found, would publish to the team brain: precisely the
 * content the private-by-default design exists to withhold, leaking with no
 * setting changed and nothing to notice.
 *
 * `automations/threads/*` cannot be solved the way agent PHOTOS were (their own
 * `automations/photos/` directory ignore): git cannot re-include a file inside
 * an IGNORED DIRECTORY, and a SHARED automation's channel must publish. So the
 * rule is a two-segment wildcard plus a fourth per-slug negation — and that
 * makes ordering load-bearing, which is what this migration is really for.
 *
 * Appending the new wildcard to an existing `.gitignore` would place it BELOW
 * every negation already in the file, and git then drops those negations
 * silently: every previously shared automation would go dark with no error and
 * `shared: true` still in its frontmatter. So the step reaches the same repair
 * path `shareAutomation` uses (wildcards re-appended first, the file's own
 * negations after), then backfills the fourth negation for each slug that was
 * already shared.
 *
 * Deterministic (no agentTask) and idempotent: a vault with no automations
 * block, or a second run, reports `detected` and writes nothing.
 */
export const migration0280: Migration = {
  version: '0.28.0',
  steps: [
    (root: string): MigrationStepResult => {
      const step = 'automation-threads-ignore';
      const touched = migrateThreadIgnoreBlocks(root);

      if (touched.length === 0) {
        return {
          step,
          filesTouched: [],
          summary: 'Automation thread ignore rules already correct (or no automations block) — nothing to do',
          detected: true,
        };
      }

      const added = touched.reduce((n, t) => n + t.added.length, 0);
      return {
        step,
        filesTouched: touched.map((t) => t.path),
        summary: `Re-ordered the automations ignore block and added ${added} line${added === 1 ? '' : 's'} so private channels stay private and shared ones still publish`,
        detected: false,
      };
    },
  ],
};
