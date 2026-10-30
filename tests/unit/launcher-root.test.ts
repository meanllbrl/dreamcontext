/**
 * The new shell's launch (task codex-tarzi-yeni-kabuk W1, AC 3): the launcher window opens on the
 * last project shown, else the most recent; only registered projects whose folder exists.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/components/layout/WindowChrome.js', () => ({ WindowChrome: () => null }));
vi.mock('../../dashboard/src/pages/LauncherPage.js', () => ({ LauncherPage: () => null }));
vi.mock('../../dashboard/src/components/search/ProjectSwitcher.js', () => ({ ProjectSwitcher: () => null }));
vi.mock('../../dashboard/src/components/layout/UpgradeRelaunchBanner.js', () => ({ UpgradeRelaunchBanner: () => null }));
const { launchCandidates } = await import('../../dashboard/src/pages/LauncherRoot.js');

const v = (name: string, lastOpenedAt: string | null, exists = true) => ({ name, lastOpenedAt, exists }) as any;

describe('launch candidates', () => {
  const vaults = [v('acme', '2026-10-01'), v('globex', '2026-10-20'), v('initech', null), v('gone', '2026-10-29', false)];
  it('the last project first, then by recency', () => {
    expect(launchCandidates(vaults, 'acme')).toEqual(['acme', 'globex', 'initech']);
  });
  it('no last project: the most recent', () => {
    expect(launchCandidates(vaults, null)[0]).toBe('globex');
  });
  it('a last project that is gone or unregistered is skipped', () => {
    expect(launchCandidates(vaults, 'gone')[0]).toBe('globex');
    expect(launchCandidates(vaults, 'nope')[0]).toBe('globex');
  });
  it('nothing registered: no candidate (the launcher stays)', () => {
    expect(launchCandidates([], 'acme')).toEqual([]);
  });
});
