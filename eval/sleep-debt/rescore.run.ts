/**
 * `npm run verify:sleep-debt`: prints the before/after sleep-debt table for this machine's real
 * transcripts. Read-only. Deliberately outside `npm test` (its glob is `tests/**`): it depends on
 * whatever `~/.claude/projects` holds, so it is evidence, not a gate.
 *
 * DC_RESCORE_ROOT overrides the `_dream_context/` dir; DC_RESCORE_HISTORY picks the history entry
 * (0 = the newest consolidation).
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { formatRescoreTable, rescoreSessions } from './rescore.js';

const DEFAULT_ROOT = fileURLToPath(new URL('../../_dream_context', import.meta.url));

describe('sleep-debt rescore (real transcripts, read-only)', () => {
  it('prints the before/after table', () => {
    const historyIndex = Number(process.env.DC_RESCORE_HISTORY ?? '0');
    const result = rescoreSessions({
      contextRoot: process.env.DC_RESCORE_ROOT || DEFAULT_ROOT,
      historyIndex: Number.isInteger(historyIndex) && historyIndex >= 0 ? historyIndex : 0,
    });
    process.stdout.write(`\n${formatRescoreTable(result)}\n\n`);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
