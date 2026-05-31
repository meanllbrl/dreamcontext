import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVersionCheckGet } from '../../src/server/routes/version-check.js';
import type { VersionCache } from '../../src/lib/version-check.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let statusCode = 0;
  let responseBody: unknown = null;

  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) {
      try { responseBody = JSON.parse(data); } catch { responseBody = data; }
    },
    setHeader() {},
  } as unknown as ServerResponse;

  return { res, status: () => statusCode, body: () => responseBody };
}

function makeGetReq(): IncomingMessage {
  return { method: 'GET', headers: {} } as unknown as IncomingMessage;
}

function writeCacheFile(tmpDir: string, cache: VersionCache): void {
  const dir = join(tmpDir, '_dream_context', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.version-check.json'), JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

// contextRoot = <tmpDir>/_dream_context
let tmpDir: string;
let contextRoot: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `vc-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/version-check', () => {
  it('returns { cache: null, fresh: false, nudge: null } when no cache file exists', async () => {
    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    const payload = body() as { cache: unknown; fresh: boolean; nudge: unknown };
    expect(payload.cache).toBeNull();
    expect(payload.fresh).toBe(false);
    expect(payload.nudge).toBeNull();
  });

  it('returns fresh:true and non-null nudge when cache is fresh and CLI is behind', async () => {
    const cache: VersionCache = {
      checkedAt: Date.now() - 60 * 60 * 1000, // 1h ago — within TTL
      latestCli: '99.99.99', // far ahead so nudge is guaranteed
      availablePacks: [],
      ttlHours: 24,
    };
    writeCacheFile(tmpDir, cache);

    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);

    const payload = body() as { cache: VersionCache; fresh: boolean; nudge: string | null };
    expect(payload.fresh).toBe(true);
    expect(payload.cache).not.toBeNull();
    expect(payload.nudge).not.toBeNull();
    expect(payload.nudge).toContain('99.99.99');
  });

  it('returns fresh:true and nudge:null when cache is fresh and CLI is current', async () => {
    // Use an obviously old version as "latest" so our installed version is >= it
    const cache: VersionCache = {
      checkedAt: Date.now() - 60 * 60 * 1000,
      latestCli: '0.0.1', // installed should always be >= this
      availablePacks: [],
      ttlHours: 24,
    };
    writeCacheFile(tmpDir, cache);

    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);

    const payload = body() as { cache: VersionCache; fresh: boolean; nudge: string | null };
    expect(payload.fresh).toBe(true);
    // nudge should be null (installed >= 0.0.1, no new packs)
    expect(payload.nudge).toBeNull();
  });

  it('returns fresh:false when cache is stale', async () => {
    const cache: VersionCache = {
      checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago — past TTL
      latestCli: '99.99.99',
      availablePacks: [],
      ttlHours: 24,
    };
    writeCacheFile(tmpDir, cache);

    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);

    const payload = body() as { cache: VersionCache; fresh: boolean; nudge: string | null };
    expect(payload.fresh).toBe(false);
    // Stale cache → buildNudge receives null → nudge is null
    expect(payload.nudge).toBeNull();
    // Cache data is still returned (for display purposes)
    expect(payload.cache).not.toBeNull();
  });

  it('returns 200 benign payload (never 500) when cache file is malformed JSON', async () => {
    const dir = join(tmpDir, '_dream_context', 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.version-check.json'), 'not valid json {{', 'utf-8');

    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);

    const payload = body() as { cache: unknown; fresh: boolean; nudge: unknown };
    // readVersionCache returns null on malformed JSON
    expect(payload.cache).toBeNull();
    expect(payload.fresh).toBe(false);
    expect(payload.nudge).toBeNull();
  });
});
