/**
 * Structural guard for issue #235: saving a tweak must RE-FETCH.
 *
 * A tweak can change the window a metric is computed over, so a surface that PATCHes
 * `/lab/:slug/tweaks` and stops there leaves the tile rendering the pre-tweak cache — the
 * control moved, the number didn't, and nothing on screen says so. The funnel views always
 * chained PATCH → sync; the generic card and the detail panel only PATCHed and toasted
 * "tweaks saved.", which is how "day filters don't work" got reported.
 *
 * This is a source-shape test rather than a render test (this repo runs no DOM harness): for
 * every Lab surface that saves tweaks, the mutation's success path has to reach `sync.mutate`.
 * It fails loudly if a new surface adds a save without the re-fetch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../dashboard/src/components/lab');

const TWEAK_SAVERS = [
  'InsightCard.tsx',
  'InsightDetailPanel.tsx',
  'funnel/FunnelDetailPage.tsx',
  'funnel/FunnelOverviewPage.tsx',
];

/** The text from a `updateTweaks.mutate(` call to the end of its options object. Crude but
 *  sufficient: every call site in this codebase passes the options inline. */
function mutationBlocks(source: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('updateTweaks.mutate(', from);
    if (at === -1) return out;
    // Walk to the matching close paren so a second call site can't bleed into this block.
    let depth = 0;
    let i = source.indexOf('(', at);
    for (; i < source.length; i++) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push(source.slice(at, i + 1));
    from = i + 1;
  }
}

describe('Lab tweak saves re-sync (#235)', () => {
  for (const file of TWEAK_SAVERS) {
    it(`${file}: every updateTweaks.mutate chains a sync on success`, () => {
      const source = readFileSync(join(ROOT, file), 'utf-8');
      const blocks = mutationBlocks(source);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain('onSuccess');
        // Either the sync is inline in the success arm, or it is a named helper whose whole
        // job is to run it (`runSync` / `applyTweaksAndSync`) — both are the same chain.
        const chains = /sync\.mutate\(/.test(block) || /runSync\(/.test(block);
        expect(chains, `no re-fetch after saving tweaks in ${file}`).toBe(true);
      }
    });
  }

  it('the shared helper names the outcome instead of claiming a refresh that failed', () => {
    for (const file of ['InsightCard.tsx', 'InsightDetailPanel.tsx']) {
      const source = readFileSync(join(ROOT, file), 'utf-8');
      expect(source).toContain('tweaks saved, but the refresh failed');
    }
  });
});
