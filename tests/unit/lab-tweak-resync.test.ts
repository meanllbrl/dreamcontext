/**
 * Structural guard for issue #235 and its sequel: saving a tweak must RE-FETCH,
 * and the surface must report what the re-fetch actually DID.
 *
 * A tweak can change the window a metric is computed over, so a surface that
 * PATCHes `/lab/:slug/tweaks` and stops there leaves the tile rendering the
 * pre-tweak cache — the control moved, the number didn't, and nothing on screen
 * says so. That was #235.
 *
 * The sequel, reported 2026-08-26 on the funnel overview ("custom range yükleme
 * kısmı çok verimsiz ve çalışmıyor"): `POST /lab/sync` answers **200 with a
 * populated `failed[]`** when the adapter throws. Two of the four surfaces
 * chained the sync but never read the body, so a window that failed to load
 * toasted "Custom range applied." over the numbers from the window the user had
 * just left. Fixed by fusing the two calls into ONE mutation (`useApplyTweaks`),
 * which makes the divergence unrepresentable — there is a single success path
 * and it has already read `results[0]`.
 *
 * These are source-shape tests rather than render tests (this repo runs no DOM
 * harness). They fail loudly if a new surface re-opens either gap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../dashboard/src/components/lab');
const HOOKS = join(import.meta.dirname, '../../dashboard/src/hooks/useLab.ts');

const TWEAK_SAVERS = [
  'InsightCard.tsx',
  'InsightDetailPanel.tsx',
  'funnel/FunnelDetailPage.tsx',
  'funnel/FunnelOverviewPage.tsx',
];

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf-8');
}

/** The text from an `applyTweaks.mutate(` call to the end of its options object.
 *  Crude but sufficient: every call site in this codebase passes them inline. */
function mutationBlocks(source: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('applyTweaks.mutate(', from);
    if (at === -1) return out;
    // Walk to the matching close paren so a second call site can't bleed in.
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

describe('the save and the re-fetch are ONE mutation (#235)', () => {
  it('useApplyTweaks PATCHes then syncs inside a single mutationFn', () => {
    const source = readFileSync(HOOKS, 'utf-8');
    const at = source.indexOf('export function useApplyTweaks()');
    expect(at, 'useLab must export useApplyTweaks').toBeGreaterThan(-1);
    const body = source.slice(at, at + 2000);
    expect(body).toContain('api.patch');
    expect(body).toContain("'/lab/sync'");
    // The mutation itself reads the per-insight row, so no caller can skip it.
    expect(body).toContain("status === 'failed'");
  });

  it('no Lab surface can PATCH tweaks without the sync riding along', () => {
    for (const file of TWEAK_SAVERS) {
      const source = read(file);
      // The old split hook is gone; a reintroduced bare PATCH is the regression.
      expect(source, `${file} must not reach for the split tweak hook`).not.toContain('useUpdateTweaks');
      expect(source, `${file} must not PATCH /tweaks directly`).not.toMatch(/api\.patch\([^)]*tweaks/);
      expect(source, `${file} must save through useApplyTweaks`).toContain('useApplyTweaks');
    }
  });

  for (const file of TWEAK_SAVERS) {
    it(`${file}: every applyTweaks.mutate reads the sync OUTCOME`, () => {
      const source = read(file);
      const blocks = mutationBlocks(source);
      expect(blocks.length, `${file} saves no tweaks at all`).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain('onSuccess');
        // Claiming success without destructuring `synced` is exactly the bug.
        expect(block, `a save in ${file} claims success without reading \`synced\``).toContain('synced');
      }
    });
  }
});

describe('the RangeControl hands off to a save that re-syncs', () => {
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
  // chart" regression would hide, so the walk follows the handoff.
  for (const file of TWEAK_SAVERS) {
    it(`${file}: the mount names a handler that applies`, () => {
      const source = read(file);
      expect(source, `${file} must mount the shared RangeControl`).toContain('<RangeControl');
      const handler = rangeHandler(source);
      expect(handler, `${file}: RangeControl needs an onApply={handler}`).toBeTruthy();
      const body = handlerBody(source, handler!);
      expect(body, `${file}: onApply handler "${handler}" is not defined in this file`).not.toBe('');
      const saves = /applyTweaks\.mutate\(/.test(body) || /applyTweaksAndSync\(/.test(body) || /applyAndReport\(/.test(body);
      expect(saves, `${file}: a range change must apply the tweaks (#235)`).toBe(true);
    });
  }

  it('every surface names the outcome instead of claiming a refresh that failed', () => {
    for (const file of TWEAK_SAVERS) {
      expect(read(file), `${file} needs a distinct message for a failed re-fetch`)
        .toMatch(/but the re-?fetch failed|but the refresh failed/);
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

describe('a failed window is visible on the page, not only in a toast', () => {
  // `syncInsight`'s failure path KEEPS the prior funnel payload, so the table
  // keeps answering for a window the control no longer shows. A toast fades; the
  // mismatch does not.
  for (const file of ['funnel/FunnelOverviewPage.tsx', 'funnel/FunnelDetailPage.tsx']) {
    it(`${file} renders cache.error`, () => {
      const source = read(file);
      expect(source).toContain('cache?.error');
      expect(source).toContain('Last fetch failed');
    });
  }
});

describe('clearing a custom window returns to the preset it MASKED', () => {
  // Writing from/to does not clear the `range` enum, so the manifest still holds
  // the user's preset. Hardcoding a fallback (`last_30_days`) instead threw
  // `Tweak "range" must be one of: …` on every curated enum that omits it — the
  // Clear button was dead and the custom window could not be escaped.
  it('RangeControl clears with active.masked, never a hardcoded range', () => {
    const source = read('RangeControl.tsx');
    const at = source.indexOf('const clearCustom = ');
    expect(at, 'RangeControl must define clearCustom').toBeGreaterThan(-1);
    const body = source.slice(at, source.indexOf('\n\n', at));
    expect(body).toContain('active.masked');
    expect(body, 'clearCustom must not hardcode a preset the manifest may reject')
      .not.toContain('ENGINE_FALLBACK_RANGE');
  });
});
