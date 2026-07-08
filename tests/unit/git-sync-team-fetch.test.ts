import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTeamFetch } from '../../src/lib/git-sync/team-fetch.js';
import type { SyncResult } from '../../src/lib/git-sync/sync-engine.js';

/** Build a fake home with a vaults.json registry pointing at real project dirs. */
function makeHome(vaults: { name: string; path: string }[]): string {
  const home = mkdtempSync(join(tmpdir(), 'dc-home-'));
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults }), 'utf-8');
  return home;
}

function makeVault(mode: 'full-repo' | 'in-tree', enabled?: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-vault-'));
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  const brainRepo: Record<string, unknown> = { mode };
  if (typeof enabled === 'boolean') brainRepo.enabled = enabled;
  writeFileSync(
    join(root, '_dream_context', 'state', '.config.json'),
    JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true, brainRepo }),
    'utf-8',
  );
  return root;
}

describe('git-sync/team-fetch — runTeamFetch', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const p of created.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it('skips disabled and in-tree vaults server-side; pull-only fetches enabled full-repo vaults', async () => {
    const enabledVault = makeVault('full-repo', true);
    const disabledVault = makeVault('full-repo', false);
    const inTreeVault = makeVault('in-tree', true);
    created.push(enabledVault, disabledVault, inTreeVault);
    const home = makeHome([
      { name: 'enabled', path: enabledVault },
      { name: 'disabled', path: disabledVault },
      { name: 'intree', path: inTreeVault },
    ]);
    created.push(home);

    const syncCalls: string[] = [];
    const fakeSync = (async (opts: { cwd: string; mode: string }): Promise<SyncResult> => {
      syncCalls.push(opts.mode);
      return { action: 'pulled', scrub: { blocks: [], warns: [] }, pulledUpdates: 2 };
    }) as unknown as typeof import('../../src/lib/git-sync/sync-engine.js').runBrainSync;

    const results = await runTeamFetch({ home, runBrainSyncImpl: fakeSync });

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.enabled.action).toBe('pulled');
    expect(byName.enabled.pulledUpdates).toBe(2);
    expect(byName.disabled.skipped).toBe('disabled');
    expect(byName.intree.skipped).toBe('in-tree');
    // Only the enabled full-repo vault reached the sync engine, and pull-only.
    expect(syncCalls).toEqual(['pull-only']);
  });

  it('restricts to a single vault when { vault } is given', async () => {
    const a = makeVault('full-repo', true);
    const b = makeVault('full-repo', true);
    created.push(a, b);
    const home = makeHome([{ name: 'a', path: a }, { name: 'b', path: b }]);
    created.push(home);

    const syncCalls: string[] = [];
    const fakeSync = (async (opts: { cwd: string }): Promise<SyncResult> => {
      syncCalls.push(opts.cwd);
      return { action: 'noop', scrub: { blocks: [], warns: [] } };
    }) as unknown as typeof import('../../src/lib/git-sync/sync-engine.js').runBrainSync;

    const results = await runTeamFetch({ home, vault: 'b', runBrainSyncImpl: fakeSync });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('b');
    expect(syncCalls.length).toBe(1);
  });

  it('captures a single vault failure without aborting the loop', async () => {
    const a = makeVault('full-repo', true);
    created.push(a);
    const home = makeHome([{ name: 'a', path: a }]);
    created.push(home);

    const fakeSync = (async (): Promise<SyncResult> => { throw new Error('boom'); }) as unknown as typeof import('../../src/lib/git-sync/sync-engine.js').runBrainSync;
    const results = await runTeamFetch({ home, runBrainSyncImpl: fakeSync });
    expect(results[0].action).toBe('error');
    expect(results[0].error).toMatch(/boom/);
  });
});
