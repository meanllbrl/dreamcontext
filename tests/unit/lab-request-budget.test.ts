/**
 * Structural guard for the Lab request budget: an AUTOMATIC refresh must not
 * force an upstream query.
 *
 * Reported from the provider side on 2026-09-02 — dreamcontext was firing
 * bursts of identical queries at the NeonBI REST API while insights and reports
 * were merely being edited. The cause was `force: true` on paths no user had
 * pressed anything on: opening a report started a job over EVERY slug in it
 * with force set, which walks straight past the TTL gate in
 * `src/lib/lab/sync.ts` (`if (!opts.force && !windowOverride && …)`) and re-runs
 * every query behind the report regardless of age.
 *
 * The rule this test enforces: `force` belongs to a user action (Sync all, a
 * card's Refresh, a tweak save — the user asked for current numbers). Anything
 * the app decides on its own goes through the engine's freshness gates. Note
 * that `force: false` must be EXPLICIT: both `useStartLabSyncJob` and
 * `POST /api/lab/sync-jobs` default force to true when it is omitted, so an
 * automatic caller that says nothing inherits a forced refetch.
 *
 * Source-shape tests, like `lab-tweak-resync.test.ts` — this repo runs no DOM
 * harness. They fail loudly if a new automatic surface re-opens the gap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPORT_PAGE = join(
  import.meta.dirname,
  '../../dashboard/src/components/lab/reports/ReportPage.tsx',
);
const SYNC = join(import.meta.dirname, '../../src/lib/lab/sync.ts');

/** Each `startJob.mutate(` call, from the call to its matching close paren. */
function mutationBlocks(source: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('startJob.mutate(', from);
    if (at === -1) return out;
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

describe('a report opening is not a request for a refetch', () => {
  const source = readFileSync(REPORT_PAGE, 'utf-8');
  const blocks = mutationBlocks(source);

  it('starts at least one job (the page still refreshes what is stale)', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it.each(blocks.map((b, i) => [i, b] as const))(
    'startJob.mutate call %i sends force: false explicitly',
    (_i, block) => {
      // Explicit, because omitting `force` means TRUE on both the hook and the route.
      expect(block).toContain('force: false');
      expect(block).not.toMatch(/force:\s*true/);
    },
  );

  it('never posts to /lab/sync directly — the page owns no second engine', () => {
    expect(source).not.toContain("'/lab/sync'");
  });
});

describe('the TTL gate is what a non-forced run relies on', () => {
  it('sync.ts still skips a fresh insight when force is unset', () => {
    const source = readFileSync(SYNC, 'utf-8');
    // If this shape changes, `force: false` above stops meaning "gated" and
    // this test's premise is gone — fail here rather than silently at runtime.
    expect(source).toMatch(/if \(!opts\.force && !windowOverride && prior\?\.fetchedAt\)/);
    expect(source).toContain("status: 'fresh'");
  });
});
