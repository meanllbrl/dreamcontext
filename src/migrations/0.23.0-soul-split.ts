import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_FILE_CHAR_CEILING } from '../lib/core-index.js';
import type { Migration } from './types.js';

/**
 * 0.23.0 (part 2): the soul becomes CONSTITUTION-ONLY.
 *
 * Owner decision 2026-07-28/30: `core/0.soul.md` holds ONLY the always-valid
 * identity + voice + unconditional rules, and it renders VERBATIM at every
 * budget — so an oversized soul is a CONTENT problem, and the versioned
 * migration is where it gets solved for every existing vault (owner: the
 * bloat is truly fixed here, not by a render-time trim).
 *
 * Splitting is judgment — which rule is conditional, what clusters together —
 * so the deterministic step only DETECTS and reports; the agentTask performs
 * the split. Exactly the shape of 0.23.0's `distribute-user-md-residue`.
 * Registered under the SAME version as the people-first migration: the runner
 * merges same-version changelog entries and gates each step by its own id.
 */
export const migration0230SoulSplit: Migration = {
  version: '0.23.0',
  steps: [
    (root: string) => {
      const soulPath = join(root, 'core', '0.soul.md');
      if (!existsSync(soulPath)) {
        return {
          step: 'detect-oversized-soul',
          filesTouched: [],
          summary: 'No core/0.soul.md — nothing to split.',
          detected: true,
        };
      }
      const chars = readFileSync(soulPath, 'utf-8').length;
      const over = chars > CORE_FILE_CHAR_CEILING;
      return {
        step: 'detect-oversized-soul',
        filesTouched: [],
        summary: over
          ? `core/0.soul.md is ${chars.toLocaleString('en-US')} chars — over the `
            + `${CORE_FILE_CHAR_CEILING.toLocaleString('en-US')}-char ceiling; the `
            + 'split-soul-into-patterns agent task distills it into knowledge/patterns/.'
          : `core/0.soul.md is ${chars.toLocaleString('en-US')} chars — within the `
            + `${CORE_FILE_CHAR_CEILING.toLocaleString('en-US')}-char ceiling; nothing to split.`,
        detected: true,
      };
    },
  ],
  agentTask: {
    id: 'split-soul-into-patterns',
    instruction:
      'Start by checking the filesystem: if _dream_context/core/0.soul.md is at or under '
      + '4,000 chars, there is nothing to split — record this step and stop.\n\n'
      + "The soul is the agent's CONSTITUTION and renders VERBATIM in every snapshot at every "
      + 'budget, so an oversized soul busts the harness limit on its own. Keep in the soul ONLY: '
      + 'project identity (what this project IS), the agent voice/behavior, and rules that are '
      + 'UNCONDITIONALLY true in every session. Move everything else OUT:\n\n'
      + "1. Every conditional rule ('when X, do Y' — domain-scoped rules, tool-specific rules, "
      + 'incident lessons) goes to _dream_context/knowledge/patterns/<slug>.md, one file per '
      + 'coherent rule CLUSTER (not one per bullet), original wording preserved verbatim with an '
      + "'un-distilled, moved from core/0.soul.md by migration 0.23.0' note; honest frontmatter "
      + '(title, description = the rule in one sentence, tags).\n'
      + '2. Reference/inventory sections (a RAG corpus index, API inventories, link lists) go to '
      + '_dream_context/knowledge/<slug>.md as reference docs.\n'
      + '3. NOTHING IS DISCARDED: every moved block keeps its full text. The soul keeps a pointer '
      + 'line only where it is genuinely load-bearing.\n\n'
      + 'Target: core/0.soul.md at or under 4,000 chars. Verify with `dreamcontext doctor` '
      + '(core file sizes + snapshot size) before recording. Record completion with: '
      + 'dreamcontext migrations record --version 0.23.0 --step split-soul-into-patterns '
      + '--executor agent --files <every file you wrote> --summary "<what moved where>".',
  },
};
