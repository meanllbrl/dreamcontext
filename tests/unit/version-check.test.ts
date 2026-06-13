import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compareVersions,
  isCacheFresh,
  buildNudge,
  refreshVersionCache,
  readVersionCache,
  autoUpgradeEnabled,
  shouldAutoUpgrade,
  shouldSuppressCliNudge,
  maybeAutoUpgrade,
  readAutoUpgradeMarker,
  writeAutoUpgradeMarker,
  type VersionCache,
  type AutoUpgradeMarker,
} from '../../src/lib/version-check.js';

// ─── compareVersions ─────────────────────────────────────────────────────────

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns -1 when a is behind b', () => {
    expect(compareVersions('0.4.9', '0.5.0')).toBe(-1);
  });

  it('returns 1 when a is ahead of b', () => {
    expect(compareVersions('0.5.0', '0.4.9')).toBe(1);
  });

  it('handles multi-digit segments: 0.10.0 > 0.9.0', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
  });

  it('ignores pre-release suffixes: 1.0.0-beta equals 1.0.0', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-rc.2')).toBe(0);
  });

  it('handles the 0.0.0 sentinel — equal to itself', () => {
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
    expect(compareVersions('0.0.0', '0.0.1')).toBe(-1);
    expect(compareVersions('0.1.0', '0.0.0')).toBe(1);
  });

  it('handles version strings with different number of segments', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2', '2.0.0')).toBe(0);
  });
});

// ─── isCacheFresh ─────────────────────────────────────────────────────────────

describe('isCacheFresh', () => {
  it('returns true within the 24h TTL', () => {
    const cache: VersionCache = {
      checkedAt: Date.now() - 60 * 60 * 1000, // 1h ago
      latestCli: '0.5.0',
      availablePacks: [],
      ttlHours: 24,
    };
    expect(isCacheFresh(cache)).toBe(true);
  });

  it('returns false past the 24h TTL', () => {
    const cache: VersionCache = {
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago
      latestCli: '0.5.0',
      availablePacks: [],
      ttlHours: 24,
    };
    expect(isCacheFresh(cache)).toBe(false);
  });

  it('returns false (not throws) for null cache', () => {
    expect(isCacheFresh(null)).toBe(false);
  });

  it('returns false for malformed checkedAt (not a number)', () => {
    const cache = {
      checkedAt: 'not-a-number' as unknown as number,
      latestCli: '0.5.0',
      availablePacks: [],
      ttlHours: 24,
    };
    expect(isCacheFresh(cache)).toBe(false);
  });

  it('returns false for NaN checkedAt', () => {
    const cache: VersionCache = {
      checkedAt: NaN,
      latestCli: '0.5.0',
      availablePacks: [],
      ttlHours: 24,
    };
    expect(isCacheFresh(cache)).toBe(false);
  });

  it('falls back to 24h TTL when ttlHours is missing/malformed', () => {
    const freshCache = {
      checkedAt: Date.now() - 60 * 60 * 1000, // 1h ago
      latestCli: '0.5.0',
      availablePacks: [],
      ttlHours: undefined as unknown as number,
    };
    expect(isCacheFresh(freshCache)).toBe(true);

    const staleCache = {
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago
      latestCli: '0.5.0',
      availablePacks: [],
      ttlHours: undefined as unknown as number,
    };
    expect(isCacheFresh(staleCache)).toBe(false);
  });

  it('accepts a custom nowMs parameter', () => {
    const base = 1_000_000_000_000; // arbitrary timestamp
    const cache: VersionCache = {
      checkedAt: base - 60 * 60 * 1000, // 1h before base
      latestCli: '0.5.0',
      availablePacks: [],
      ttlHours: 24,
    };
    expect(isCacheFresh(cache, base)).toBe(true);
    expect(isCacheFresh(cache, base + 24 * 60 * 60 * 1000)).toBe(false);
  });
});

// ─── AC8: buildNudge behavior unchanged by drift feature ─────────────────────

describe("version-check unit", () => {
  const cache06: VersionCache = {
    checkedAt: Date.now(),
    latestCli: '0.6.0',
    availablePacks: [],
    ttlHours: 24,
  };

  it("buildNudge behavior unchanged by drift feature", () => {
    // outdated CLI -> Update Available
    const outdated = buildNudge('0.5.0', cache06, [], []);
    expect(outdated).not.toBeNull();
    expect(outdated).toContain('## Update Available');

    // current -> null
    const current06: VersionCache = { ...cache06, latestCli: '0.5.0' };
    const current = buildNudge('0.5.0', current06, [], []);
    expect(current).toBeNull();
  });
});

// ─── buildNudge ───────────────────────────────────────────────────────────────

describe('buildNudge', () => {
  const freshCache: VersionCache = {
    checkedAt: Date.now(),
    latestCli: '0.6.0',
    availablePacks: [],
    ttlHours: 24,
  };

  it('returns null when cache is null', () => {
    expect(buildNudge('0.5.0', null, [], [])).toBeNull();
  });

  it('returns null when latestCli is null (offline)', () => {
    const offlineCache: VersionCache = { ...freshCache, latestCli: null };
    expect(buildNudge('0.5.0', offlineCache, [], [])).toBeNull();
  });

  it('returns null when CLI is up-to-date AND no new packs', () => {
    const upToDate: VersionCache = { ...freshCache, latestCli: '0.5.0' };
    expect(buildNudge('0.5.0', upToDate, [], [])).toBeNull();
  });

  it('returns null when CLI is ahead (no regression nudge)', () => {
    const older: VersionCache = { ...freshCache, latestCli: '0.4.0' };
    expect(buildNudge('0.5.0', older, [], [])).toBeNull();
  });

  it('contains both installed and latest version when behind', () => {
    const result = buildNudge('0.5.0', freshCache, [], []);
    expect(result).not.toBeNull();
    expect(result).toContain('0.5.0');
    expect(result).toContain('0.6.0');
  });

  it('contains dreamcontext upgrade instruction when behind', () => {
    const result = buildNudge('0.5.0', freshCache, [], []);
    expect(result).not.toBeNull();
    expect(result).toContain('dreamcontext upgrade');
  });

  it('contains ## Update Available heading when behind', () => {
    const result = buildNudge('0.5.0', freshCache, [], []);
    expect(result).not.toBeNull();
    expect(result).toContain('## Update Available');
  });

  it('names new packs when new packs exist (up-to-date CLI)', () => {
    const upToDateWithNewPack: VersionCache = { ...freshCache, latestCli: '0.5.0' };
    const result = buildNudge('0.5.0', upToDateWithNewPack, ['existing-pack'], ['existing-pack', 'new-awesome-pack']);
    expect(result).not.toBeNull();
    expect(result).toContain('new-awesome-pack');
  });

  it('contains both CLI and packs lines when both apply', () => {
    const behindWithNewPacks: VersionCache = {
      ...freshCache,
      latestCli: '0.6.0',
    };
    const result = buildNudge(
      '0.5.0',
      behindWithNewPacks,
      ['existing-pack'],
      ['existing-pack', 'brand-new-pack'],
    );
    expect(result).not.toBeNull();
    // CLI upgrade line
    expect(result).toContain('0.5.0');
    expect(result).toContain('0.6.0');
    expect(result).toContain('dreamcontext upgrade');
    // New pack line
    expect(result).toContain('brand-new-pack');
  });

  it('returns null when installed has all catalog packs and CLI is current', () => {
    const exact: VersionCache = { ...freshCache, latestCli: '0.5.0' };
    expect(buildNudge('0.5.0', exact, ['pack-a', 'pack-b'], ['pack-a', 'pack-b'])).toBeNull();
  });
});

// ─── refreshVersionCache ─────────────────────────────────────────────────────

describe('refreshVersionCache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ac-vc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '_dream_context', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes latestCli: null and does NOT throw when runner throws', () => {
    const failingRunner = () => { throw new Error('npm: command not found'); };
    expect(() => refreshVersionCache(tmpDir, { runner: failingRunner })).not.toThrow();

    const cache = readVersionCache(tmpDir);
    expect(cache).not.toBeNull();
    expect(cache?.latestCli).toBeNull();
  });

  it('stores the version string returned by the runner', () => {
    const goodRunner = (_args: string[]) => '0.7.3\n';
    refreshVersionCache(tmpDir, { runner: goodRunner });

    const cache = readVersionCache(tmpDir);
    expect(cache).not.toBeNull();
    expect(cache?.latestCli).toBe('0.7.3');
  });

  it('writes latestCli: null when runner returns non-version string', () => {
    const badRunner = (_args: string[]) => 'not-a-version';
    refreshVersionCache(tmpDir, { runner: badRunner });

    const cache = readVersionCache(tmpDir);
    expect(cache?.latestCli).toBeNull();
  });

  it('stores catalogPackNames in availablePacks', () => {
    const runner = (_args: string[]) => '1.0.0';
    refreshVersionCache(tmpDir, {
      runner,
      catalogPackNames: ['pack-a', 'pack-b'],
    });

    const cache = readVersionCache(tmpDir);
    expect(cache?.availablePacks).toEqual(['pack-a', 'pack-b']);
  });

  it('writes valid checkedAt timestamp', () => {
    const before = Date.now();
    const runner = (_args: string[]) => '1.0.0';
    refreshVersionCache(tmpDir, { runner });
    const after = Date.now();

    const cache = readVersionCache(tmpDir);
    expect(cache?.checkedAt).toBeGreaterThanOrEqual(before);
    expect(cache?.checkedAt).toBeLessThanOrEqual(after);
  });

  it('cache file is created at expected path', () => {
    refreshVersionCache(tmpDir, { runner: () => '1.0.0' });
    const expectedPath = join(tmpDir, '_dream_context', 'state', '.version-check.json');
    const raw = readFileSync(expectedPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ─── buildNudge suppressCliNudge (auto-upgrade) ──────────────────────────────

describe('buildNudge with suppressCliNudge', () => {
  const cache06: VersionCache = {
    checkedAt: Date.now(),
    latestCli: '0.6.0',
    availablePacks: [],
    ttlHours: 24,
  };

  it('returns null when only the CLI is outdated and the CLI nudge is suppressed', () => {
    const result = buildNudge('0.5.0', cache06, [], [], { suppressCliNudge: true });
    expect(result).toBeNull();
  });

  it('still emits the new-packs line when CLI nudge is suppressed', () => {
    const result = buildNudge('0.5.0', cache06, ['have'], ['have', 'new-pack'], { suppressCliNudge: true });
    expect(result).not.toBeNull();
    expect(result).toContain('new-pack');
    expect(result).not.toContain('dreamcontext upgrade');
  });

  it('emits the CLI line normally when not suppressed', () => {
    const result = buildNudge('0.5.0', cache06, [], [], { suppressCliNudge: false });
    expect(result).toContain('dreamcontext upgrade');
  });
});

// ─── autoUpgradeEnabled (default ON) ──────────────────────────────────────────

describe('autoUpgradeEnabled', () => {
  it('is enabled by default (no env)', () => {
    expect(autoUpgradeEnabled({})).toBe(true);
  });
  it('is disabled when opted out with "0"', () => {
    expect(autoUpgradeEnabled({ DREAMCONTEXT_AUTO_UPGRADE: '0' })).toBe(false);
  });
  it('is disabled by the master kill-switch', () => {
    expect(autoUpgradeEnabled({ DREAMCONTEXT_VERSION_CHECK: '0' })).toBe(false);
  });
  it('stays enabled for any non-"0" value', () => {
    expect(autoUpgradeEnabled({ DREAMCONTEXT_AUTO_UPGRADE: '1' })).toBe(true);
    expect(autoUpgradeEnabled({ DREAMCONTEXT_AUTO_UPGRADE: 'yes' })).toBe(true);
  });
});

// ─── shouldSuppressCliNudge (in-flight window) ────────────────────────────────

describe('shouldSuppressCliNudge', () => {
  const hour = 60 * 60 * 1000;

  it('suppresses while an attempt for the current target is fresh (< 1h)', () => {
    const marker: AutoUpgradeMarker = { attemptedFor: '0.6.0', at: 1000 };
    expect(shouldSuppressCliNudge('0.6.0', marker, {}, 1000 + 60_000)).toBe(true);
  });

  it('does NOT suppress once the in-flight window has elapsed (likely failed)', () => {
    const marker: AutoUpgradeMarker = { attemptedFor: '0.6.0', at: 1000 };
    expect(shouldSuppressCliNudge('0.6.0', marker, {}, 1000 + hour + 1)).toBe(false);
  });

  it('does NOT suppress when the marker is for a different target', () => {
    const marker: AutoUpgradeMarker = { attemptedFor: '0.5.0', at: 1000 };
    expect(shouldSuppressCliNudge('0.6.0', marker, {}, 1000 + 60_000)).toBe(false);
  });

  it('does NOT suppress when there is no marker', () => {
    expect(shouldSuppressCliNudge('0.6.0', null, {}, 1000)).toBe(false);
  });

  it('does NOT suppress when auto-upgrade is opted out', () => {
    const marker: AutoUpgradeMarker = { attemptedFor: '0.6.0', at: 1000 };
    expect(shouldSuppressCliNudge('0.6.0', marker, { DREAMCONTEXT_AUTO_UPGRADE: '0' }, 1000 + 60_000)).toBe(false);
  });

  it('does NOT suppress when target is null', () => {
    const marker: AutoUpgradeMarker = { attemptedFor: '0.6.0', at: 1000 };
    expect(shouldSuppressCliNudge(null, marker, {}, 1000)).toBe(false);
  });
});

// ─── shouldAutoUpgrade (PURE gate) ────────────────────────────────────────────

describe('shouldAutoUpgrade', () => {
  const cache = (latestCli: string | null): VersionCache => ({
    checkedAt: 0,
    latestCli,
    availablePacks: [],
    ttlHours: 24,
  });

  it('returns target version when outdated (env explicitly enabled)', () => {
    expect(shouldAutoUpgrade('0.5.0', cache('0.6.0'), { DREAMCONTEXT_AUTO_UPGRADE: '1' })).toBe('0.6.0');
  });

  it('returns target version when env is absent (default ON)', () => {
    expect(shouldAutoUpgrade('0.5.0', cache('0.6.0'), {})).toBe('0.6.0');
  });

  it('returns target for any value other than "0" (default ON unless opted out)', () => {
    expect(shouldAutoUpgrade('0.5.0', cache('0.6.0'), { DREAMCONTEXT_AUTO_UPGRADE: 'true' })).toBe('0.6.0');
  });

  it('returns null when explicitly opted out with "0"', () => {
    expect(shouldAutoUpgrade('0.5.0', cache('0.6.0'), { DREAMCONTEXT_AUTO_UPGRADE: '0' })).toBeNull();
  });

  it('returns null when the master kill-switch is set', () => {
    expect(
      shouldAutoUpgrade('0.5.0', cache('0.6.0'), {
        DREAMCONTEXT_VERSION_CHECK: '0',
      }),
    ).toBeNull();
  });

  it('returns null when already current', () => {
    expect(shouldAutoUpgrade('0.6.0', cache('0.6.0'), {})).toBeNull();
  });

  it('returns null when installed is ahead of latest', () => {
    expect(shouldAutoUpgrade('0.7.0', cache('0.6.0'), {})).toBeNull();
  });

  it('returns null when cache is null', () => {
    expect(shouldAutoUpgrade('0.5.0', null, {})).toBeNull();
  });

  it('returns null when latestCli is null (offline)', () => {
    expect(shouldAutoUpgrade('0.5.0', cache(null), {})).toBeNull();
  });
});

// ─── maybeAutoUpgrade (orchestration) ─────────────────────────────────────────

describe('maybeAutoUpgrade', () => {
  const optedIn = { DREAMCONTEXT_AUTO_UPGRADE: '1' };
  const cache = (latestCli: string | null): VersionCache => ({
    checkedAt: 0,
    latestCli,
    availablePacks: [],
    ttlHours: 24,
  });

  it('spawns the upgrade and returns a notice on first outdated call', () => {
    const calls: string[][] = [];
    let written: AutoUpgradeMarker | null = null;
    const notice = maybeAutoUpgrade('/root', '0.5.0', cache('0.6.0'), optedIn, {
      spawner: (cmd, args) => calls.push([cmd, ...args]),
      readMarker: () => written,
      writeMarker: (_root, m) => { written = m; },
      now: 1000,
    });

    expect(calls).toEqual([['npm', 'install', '-g', 'dreamcontext@latest']]);
    expect(written).toEqual({ attemptedFor: '0.6.0', at: 1000 });
    expect(notice).toContain('0.5.0');
    expect(notice).toContain('0.6.0');
  });

  it('does NOT spawn when explicitly opted out (=0)', () => {
    const calls: string[][] = [];
    const notice = maybeAutoUpgrade('/root', '0.5.0', cache('0.6.0'), { DREAMCONTEXT_AUTO_UPGRADE: '0' }, {
      spawner: (cmd, args) => calls.push([cmd, ...args]),
      readMarker: () => null,
      writeMarker: () => {},
    });
    expect(calls).toEqual([]);
    expect(notice).toBeNull();
  });

  it('spawns by default when env is absent (default ON)', () => {
    const calls: string[][] = [];
    const notice = maybeAutoUpgrade('/root', '0.5.0', cache('0.6.0'), {}, {
      spawner: (cmd, args) => calls.push([cmd, ...args]),
      readMarker: () => null,
      writeMarker: () => {},
      now: 1000,
    });
    expect(calls.length).toBe(1);
    expect(notice).not.toBeNull();
  });

  it('claims the slot (writes marker) BEFORE spawning, even if the spawn throws', () => {
    // Race mitigation: the marker is written first so a near-simultaneous second
    // process backs off. A throwing spawn must still leave the marker recorded.
    let written: AutoUpgradeMarker | null = null;
    expect(() =>
      maybeAutoUpgrade('/root', '0.5.0', cache('0.6.0'), optedIn, {
        spawner: () => { throw new Error('npm not found'); },
        readMarker: () => written,
        writeMarker: (_root, m) => { written = m; },
        now: 1000,
      }),
    ).not.toThrow();
    // Marker was claimed before the spawn threw → recorded.
    expect(written).toEqual({ attemptedFor: '0.6.0', at: 1000 });
  });

  it('is idempotent — suppresses a second attempt for the same target within cooldown', () => {
    const calls: string[][] = [];
    const marker: AutoUpgradeMarker = { attemptedFor: '0.6.0', at: 1000 };
    const notice = maybeAutoUpgrade('/root', '0.5.0', cache('0.6.0'), optedIn, {
      spawner: (cmd, args) => calls.push([cmd, ...args]),
      readMarker: () => marker,
      writeMarker: () => {},
      now: 1000 + 60_000, // 1 minute later, well within 24h
    });
    expect(calls).toEqual([]);
    expect(notice).toBeNull();
  });

  it('re-attempts the same target after the 24h cooldown', () => {
    const calls: string[][] = [];
    const marker: AutoUpgradeMarker = { attemptedFor: '0.6.0', at: 1000 };
    const dayMs = 24 * 60 * 60 * 1000;
    const notice = maybeAutoUpgrade('/root', '0.5.0', cache('0.6.0'), optedIn, {
      spawner: (cmd, args) => calls.push([cmd, ...args]),
      readMarker: () => marker,
      writeMarker: () => {},
      now: 1000 + dayMs + 1,
    });
    expect(calls.length).toBe(1);
    expect(notice).not.toBeNull();
  });

  it('attempts again when a NEW target version appears, even within cooldown', () => {
    const calls: string[][] = [];
    const marker: AutoUpgradeMarker = { attemptedFor: '0.6.0', at: 1000 };
    const notice = maybeAutoUpgrade('/root', '0.5.0', cache('0.7.0'), optedIn, {
      spawner: (cmd, args) => calls.push([cmd, ...args]),
      readMarker: () => marker,
      writeMarker: () => {},
      now: 1000 + 60_000,
    });
    expect(calls.length).toBe(1);
    expect(notice).toContain('0.7.0');
  });
});

// ─── auto-upgrade marker round-trip ───────────────────────────────────────────

describe('auto-upgrade marker', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `dc-aumark-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no marker file exists', () => {
    expect(readAutoUpgradeMarker(tmpDir)).toBeNull();
  });

  it('round-trips a written marker', () => {
    writeAutoUpgradeMarker(tmpDir, { attemptedFor: '0.6.0', at: 12345 });
    expect(readAutoUpgradeMarker(tmpDir)).toEqual({ attemptedFor: '0.6.0', at: 12345 });
  });

  it('returns null for a malformed marker', () => {
    const path = join(tmpDir, '_dream_context', 'state', '.auto-upgrade.json');
    mkdirSync(join(tmpDir, '_dream_context', 'state'), { recursive: true });
    writeFileSync(path, '{ not valid json', 'utf-8');
    expect(readAutoUpgradeMarker(tmpDir)).toBeNull();
  });
});
