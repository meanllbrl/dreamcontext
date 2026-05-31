import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compareVersions,
  isCacheFresh,
  buildNudge,
  refreshVersionCache,
  readVersionCache,
  type VersionCache,
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
