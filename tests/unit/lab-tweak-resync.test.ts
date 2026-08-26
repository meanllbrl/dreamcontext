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

  /** The `onApply={...}` handler a surface hands to its RangeControl. */
  function rangeHandler(source: string): string | null {
    const at = source.indexOf('<RangeControl');
    if (at === -1) return null;
    const m = /onApply=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(source.slice(at, at + 600));
    return m ? m[1] : null;
  }

  /** A named handler's body: from its `const <name> = ` to the blank line that
   *  ends the declaration. Same crudeness as mutationBlocks, same reason. */
  function handlerBody(source: string, name: string): string {
    const at = source.indexOf(`const ${name} = `);
    if (at === -1) return '';
    const end = source.indexOf('\n\n', at);
    return source.slice(at, end === -1 ? source.length : end);
  }

  // The RangeControl writes nothing itself — it hands the tweak patch back to the
  // surface. That indirection is exactly where a "the pills don't refresh the
  // chart" regression would hide, so the walk follows the handoff: every mount
  // must name a handler, and that handler must be one of the saves checked above.
  for (const file of TWEAK_SAVERS) {
    it(`${file}: the RangeControl hands off to a tweak save that re-syncs`, () => {
      const source = readFileSync(join(ROOT, file), 'utf-8');
      expect(source, `${file} must mount the shared RangeControl`).toContain('<RangeControl');
      const handler = rangeHandler(source);
      expect(handler, `${file}: RangeControl needs an onApply={handler}`).toBeTruthy();
      const body = handlerBody(source, handler!);
      expect(body, `${file}: onApply handler "${handler}" is not defined in this file`).not.toBe('');
      const saves = /updateTweaks\.mutate\(/.test(body) || /applyTweaksAndSync\(/.test(body);
      expect(saves, `${file}: a range change must PATCH the tweaks (#235)`).toBe(true);
    });
  }

  it('the shared helper names the outcome instead of claiming a refresh that failed', () => {
    for (const file of ['InsightCard.tsx', 'InsightDetailPanel.tsx']) {
      const source = readFileSync(join(ROOT, file), 'utf-8');
      expect(source).toContain('tweaks saved, but the refresh failed');
    }
  });

  // Breakdown rides the SAME chain: the generic card/panel mount the
  // RangeControl off the registry's `supportsWindow`, so "data follows the
  // control" for a breakdown insight reduces to its entry declaring the window.
  // A future entry edit that drops the flag would silently detach the pivot
  // from the date-range pills — pin it.
  it('the breakdown registry entry declares supportsWindow (data follows the control)', () => {
    const source = readFileSync(join(ROOT, 'chartRegistry.ts'), 'utf-8');
    const entry = /breakdown: \{([\s\S]*?)\n  \},/.exec(source);
    expect(entry, 'chartRegistry.ts must have a breakdown entry').toBeTruthy();
    expect(entry![1]).toContain('supportsWindow: true');
    // And it stays a slide-over render: no `routed` flag means the guarded
    // InsightCard/InsightDetailPanel are the ONLY surfaces that save its tweaks.
    expect(entry![1]).not.toContain('routed');
  });
});
