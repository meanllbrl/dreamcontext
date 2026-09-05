/**
 * The COST of the experiment, read off the build rather than asserted about the source.
 *
 * `openui-view.test.ts` proves the imports are arranged so the tree CAN be split. That is a
 * statement about source. This file checks what the bundler actually emitted, because the
 * promise made to a user who never turns the mode on — "you pay nothing" — is a property of
 * the build output and of nothing else.
 *
 * SKIPS rather than fails when there is no build: a fresh clone has no `dashboard/dist`, and
 * a test that demands one would fail for a reason unrelated to what it measures. Run
 * `npm run build` (the ROOT one — see the verification note in the checkout-safety pattern)
 * and it becomes real.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS = 'dashboard/dist/assets';
const built = existsSync(ASSETS);
const files = built ? readdirSync(ASSETS) : [];
const read = (f: string) => readFileSync(join(ASSETS, f), 'utf-8');

/** The main entry chunk — the one every user downloads. */
const mainChunk = files.filter((f) => /^index-.*\.js$/.test(f))
  .sort((a, b) => statSync(join(ASSETS, b)).size - statSync(join(ASSETS, a)).size)[0];
const openUiChunks = files.filter((f) => /^OpenUiRenderer-.*\.js$/.test(f));

describe.skipIf(!built)('dream-ui — a user who never enables it pays nothing', () => {
  it('emits the renderer as its OWN chunk', () => {
    expect(openUiChunks.length).toBe(1);
  });

  it('keeps the library OUT of the chunk everyone downloads', () => {
    const main = read(mainChunk);
    // recharts is the heaviest thing OpenUI drags in and appears nowhere else in this app,
    // so it is the cleanest single witness for "the tree did not leak into the entry".
    expect(main).not.toContain('recharts');
    expect(main).not.toContain('openui-card');
    // Checked by FINGERPRINT, not by counting occurrences. A count bound looks precise and
    // is not: the string "openui" legitimately appears in the entry chunk wherever the
    // SETTING does — the i18n strings, the coercer, the live-setting hook in `OpenUiView`
    // (which is the seam and deliberately not lazy), and the <option>. A first version of
    // this assertion capped the count at 12, hit 14 the moment a settings string was
    // reworded, and would have been "fixed" by raising the number rather than by looking.
    // These four names come from the library's own runtime and cannot appear unless it did.
    for (const fingerprint of ['recharts', 'openui-card', 'openui-markdown-renderer', 'defaultChartPalette', 'RadialChart']) {
      expect(main, `${fingerprint} leaked into the entry chunk`).not.toContain(fingerprint);
    }
  });

  it('the split chunk is where the weight actually is', () => {
    // MEASURED 2026-09-05: ~2.07MB raw / ~587KB gzip. Asserted as a floor rather than a
    // ceiling: if this ever came back small, the tree moved somewhere else — most likely
    // into the entry chunk, which is the failure this file exists to catch.
    const size = statSync(join(ASSETS, openUiChunks[0])).size;
    expect(size).toBeGreaterThan(1_000_000);
  });

  it('the entry chunk still references it lazily', () => {
    // The dynamic edge itself: the entry names the chunk it will fetch on demand. Without
    // this the chunk could exist and never be reachable.
    expect(read(mainChunk)).toContain(openUiChunks[0]);
  });
});
