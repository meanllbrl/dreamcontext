/**
 * Structural guard for the Lab request budget: an AUTOMATIC refresh must not
 * force an upstream query.
 *
 * Reported from the provider side on 2026-09-02 — dreamcontext was firing
 * bursts of identical queries at the NeonBI REST API while insights were
 * merely being edited. The cause was `force: true` on paths no user had
 * pressed anything on, which walks straight past the TTL gate in
 * `src/lib/lab/sync.ts` and re-runs every query regardless of age.
 *
 * The rule: `force` belongs to a user action (Sync all, a card's Refresh, a
 * tweak save — the user asked for current numbers). Anything the app decides
 * on its own goes through the engine's freshness gates. The surface that
 * opened this gap (the Reports page) is deleted; its absence is pinned by
 * `lab-reports-removed-lockstep.test.ts`.
 *
 * Source-shape test, like `lab-tweak-resync.test.ts` — this repo runs no DOM
 * harness. It fails loudly if the gate a non-forced run relies on moves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SYNC = join(import.meta.dirname, '../../src/lib/lab/sync.ts');

describe('the TTL gate is what a non-forced run relies on', () => {
  it('sync.ts still skips a fresh insight when force is unset', () => {
    const source = readFileSync(SYNC, 'utf-8');
    // If this shape changes, an automatic (unforced) run stops meaning "gated"
    // and this test's premise is gone — fail here rather than silently at runtime.
    expect(source).toContain('const force = normalizeSyncForce(opts.force);');
    expect(source).toMatch(/if \(!force && prior\)/);
    expect(source).toContain("status: 'fresh', reason: 'ttl'");
  });
});
