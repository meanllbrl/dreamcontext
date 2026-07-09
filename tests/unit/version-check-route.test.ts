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

/** Write .config.json declaring which packs this project opted into. */
function writeConfigFile(tmpDir: string, packs: string[]): void {
  const dir = join(tmpDir, '_dream_context', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.config.json'),
    JSON.stringify({ platforms: ['claude'], packs, setupVersion: '9.9.9' }, null, 2) + '\n',
    'utf-8',
  );
}

/** Simulate a pack installed on disk (its SKILL.md exists for the claude platform). */
function installSkillOnDisk(tmpDir: string, name: string): void {
  const dir = join(tmpDir, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`, 'utf-8');
}

// contextRoot = <tmpDir>/_dream_context
let tmpDir: string;
let contextRoot: string;
let prevDesktopEnv: string | undefined;

beforeEach(() => {
  tmpDir = join(tmpdir(), `vc-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  // Neutralize an ambient DREAMCONTEXT_DESKTOP (a desktop dev may have it exported,
  // and the app sets it at runtime) so the not-desktop nudge tests are hermetic.
  // The "suppresses when DESKTOP=1" test sets and restores it explicitly.
  prevDesktopEnv = process.env.DREAMCONTEXT_DESKTOP;
  delete process.env.DREAMCONTEXT_DESKTOP;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (prevDesktopEnv === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
  else process.env.DREAMCONTEXT_DESKTOP = prevDesktopEnv;
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

  it('does NOT surface a DECLINED catalog pack as newPacks (regression: permanent false "Update available")', async () => {
    // Catalog offers two optional packs; the project opted into only one and has
    // it installed on disk. The declined pack must never show as "new" — else the
    // header badge nags "Update available" forever on a fully up-to-date vault.
    const cache: VersionCache = {
      checkedAt: Date.now() - 60 * 60 * 1000,
      latestCli: '0.0.1', // installed >= this → no CLI nudge, isolates pack logic
      availablePacks: ['engineering', 'meta-marketing'],
      ttlHours: 24,
    };
    writeCacheFile(tmpDir, cache);
    writeConfigFile(tmpDir, ['engineering']); // opted into engineering, DECLINED meta-marketing
    installSkillOnDisk(tmpDir, 'engineering'); // and it's installed on disk

    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);

    const payload = body() as { newPacks: string[]; nudge: string | null };
    expect(payload.newPacks).toEqual([]); // meta-marketing (declined) excluded
    expect(payload.nudge).toBeNull(); // no "new packs" prose either
  });

  it('DOES surface an opted-in pack that is missing on disk as newPacks (genuine update gap)', async () => {
    // engineering is opted into but NOT installed on disk → a real `dreamcontext
    // update` gap that should still nudge. meta-marketing (declined) stays hidden.
    const cache: VersionCache = {
      checkedAt: Date.now() - 60 * 60 * 1000,
      latestCli: '0.0.1',
      availablePacks: ['engineering', 'meta-marketing'],
      ttlHours: 24,
    };
    writeCacheFile(tmpDir, cache);
    writeConfigFile(tmpDir, ['engineering']); // opted in but NOT installed on disk

    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);

    const payload = body() as { newPacks: string[]; nudge: string | null };
    expect(payload.newPacks).toEqual(['engineering']);
    expect(payload.nudge).toContain('engineering');
    expect(payload.nudge).not.toContain('meta-marketing');
  });

  it('surfaces no pack nudge when the project has no config (no opted-in universe)', async () => {
    const cache: VersionCache = {
      checkedAt: Date.now() - 60 * 60 * 1000,
      latestCli: '0.0.1',
      availablePacks: ['engineering', 'meta-marketing'],
      ttlHours: 24,
    };
    writeCacheFile(tmpDir, cache);
    // no .config.json written

    const { res, status, body } = makeRes();
    await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);

    const payload = body() as { newPacks: string[]; nudge: string | null };
    expect(payload.newPacks).toEqual([]);
    expect(payload.nudge).toBeNull();
  });

  it('suppresses the CLI nudge when DREAMCONTEXT_DESKTOP=1 (app context)', async () => {
    const prev = process.env.DREAMCONTEXT_DESKTOP;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    try {
      const cache: VersionCache = {
        checkedAt: Date.now() - 60 * 60 * 1000,
        latestCli: '99.99.99', // far ahead → would normally nudge
        availablePacks: [],
        ttlHours: 24,
      };
      writeCacheFile(tmpDir, cache);

      const { res, status, body } = makeRes();
      await handleVersionCheckGet(makeGetReq(), res, {}, contextRoot);
      expect(status()).toBe(200);

      const payload = body() as { fresh: boolean; nudge: string | null };
      expect(payload.fresh).toBe(true);
      // In-app: the manual "run dreamcontext upgrade" line is suppressed → null
      expect(payload.nudge).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
      else process.env.DREAMCONTEXT_DESKTOP = prev;
    }
  });
});
