/**
 * Docs-in-lockstep for the Must Sleep tiers. The hook injects three different
 * headers past Must Sleep (required / deep cycle / overdue) and stays silent in
 * spawned sessions; the skill and its sleep reference are what an agent reads to
 * know what each header asks of it. A header renamed in `hook.ts` without the docs,
 * or a tier edge moved without the tables, would leave agents following a
 * directive the documentation no longer describes. Mirror-with-drift-test pattern:
 * the code is the source of truth, this test fails the moment the docs drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MUST_SLEEP_TIER_HEADERS } from '../../src/cli/commands/hook.js';
import { DEFAULT_SLEEP_THRESHOLDS } from '../../src/lib/sleep-consolidation.js';

const repo = new URL('../../', import.meta.url).pathname;
const read = (p: string): string => readFileSync(join(repo, p), 'utf-8');

const DOCS = ['skill/SKILL.md', 'skill/references/sleep.md'] as const;

describe('Must Sleep tier docs stay in lockstep with the hook', () => {
  const t = DEFAULT_SLEEP_THRESHOLDS;
  // The table rows the docs must carry, derived from the thresholds the tiers run on.
  const rows = [
    `| ${t.mustSleep}–${t.deepAuthority - 1} |`,
    `| ${t.deepAuthority}–${t.cooldownOverride - 1} |`,
    `| ${t.cooldownOverride}+ |`,
  ];

  for (const doc of DOCS) {
    describe(doc, () => {
      const text = read(doc);

      it.each(Object.entries(MUST_SLEEP_TIER_HEADERS))('names the %s header verbatim', (_tier, header) => {
        expect(text, `${doc} is missing ${header}`).toContain(header);
      });

      it.each(rows)('carries the tier row %s', (row) => {
        expect(text, `${doc} is missing the table row starting ${row}`).toContain(row);
      });

      it('no longer documents a single open-ended 60+ Must Sleep row', () => {
        expect(text).not.toContain(`| ${t.mustSleep}+ |`);
      });

      it('states the spawned-session rule', () => {
        expect(text).toContain('Spawned sessions carry no debt');
        expect(text).toContain('`spawn` marker');
      });
    });
  }

  it('sleep.md places the deep cycle at the deep-authority line, not the stale 45', () => {
    const text = read('skill/references/sleep.md');
    expect(text).toContain(`starts at debt **${t.deepAuthority}**`);
    expect(text).not.toContain('starts at debt **45**');
  });
});
