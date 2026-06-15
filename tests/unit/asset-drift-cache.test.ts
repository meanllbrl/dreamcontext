/**
 * Pure tests for the used-asset drift cache (src/lib/asset-drift-cache.ts):
 * read/write round-trip, corrupt/partial rejection, and the confident-clean
 * gate that decides whether the SessionStart drift nag may be suppressed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readAssetDriftCache,
  writeAssetDriftCache,
  cacheConfidentlyClean,
  assetDriftCachePath,
  type AssetDriftCache,
} from '../../src/lib/asset-drift-cache.js';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-asset-drift-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

let contextRoot: string;

beforeEach(() => {
  // contextRoot stands in for `_dream_context`; the cache lives under state/.
  contextRoot = join(makeTmpDir(), '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(contextRoot, { recursive: true, force: true });
});

const SAMPLE: AssetDriftCache = {
  cliVersion: '0.9.0',
  setupVersion: '0.8.0',
  usedAssetsChanged: false,
  checkedAt: 1_700_000_000_000,
};

describe('asset-drift cache round-trip', () => {
  it('returns null when no cache file exists', () => {
    expect(readAssetDriftCache(contextRoot)).toBeNull();
  });

  it('writes under state/.asset-drift.json and reads back identically', () => {
    writeAssetDriftCache(contextRoot, SAMPLE);
    expect(assetDriftCachePath(contextRoot).endsWith('/state/.asset-drift.json')).toBe(true);
    expect(readAssetDriftCache(contextRoot)).toEqual(SAMPLE);
  });

  it('rejects corrupt JSON as null (never throws)', () => {
    writeAssetDriftCache(contextRoot, SAMPLE);
    writeFileSync(assetDriftCachePath(contextRoot), '{not json', 'utf-8');
    expect(readAssetDriftCache(contextRoot)).toBeNull();
  });

  it('rejects a partial record missing required fields', () => {
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(assetDriftCachePath(contextRoot), JSON.stringify({ cliVersion: '0.9.0' }), 'utf-8');
    expect(readAssetDriftCache(contextRoot)).toBeNull();
  });
});

describe('cacheConfidentlyClean — fail-open gate', () => {
  const clean: AssetDriftCache = { ...SAMPLE, usedAssetsChanged: false };

  it('true only when versions match AND nothing changed', () => {
    expect(cacheConfidentlyClean(clean, '0.9.0', '0.8.0')).toBe(true);
  });

  it('false when the cache is absent', () => {
    expect(cacheConfidentlyClean(null, '0.9.0', '0.8.0')).toBe(false);
  });

  it('false when used assets DID change (real update available)', () => {
    expect(cacheConfidentlyClean({ ...clean, usedAssetsChanged: true }, '0.9.0', '0.8.0')).toBe(false);
  });

  it('false when the cli version moved since the verdict (stale cache)', () => {
    expect(cacheConfidentlyClean(clean, '0.9.1', '0.8.0')).toBe(false);
  });

  it('false when the setup version moved since the verdict (update ran)', () => {
    expect(cacheConfidentlyClean(clean, '0.9.0', '0.9.0')).toBe(false);
  });
});
