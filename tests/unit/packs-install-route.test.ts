/**
 * Route-handler tests for src/server/routes/packs-install.ts — calling the
 * handlers directly with a fake res (no live server). Mirrors the makeRes /
 * temp-dir scaffolding of config-route.test.ts + route-path-traversal.test.ts.
 *
 * Covers plan tests B1–B9.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePackInstall, handlePackUninstall } from '../../src/server/routes/packs-install.js';
import { writeSetupConfig } from '../../src/lib/setup-config.js';

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

function makeReq(method: string): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

// contextRoot = <tmpDir>/_dream_context ; projectRoot = <tmpDir>
let tmpDir: string;
let contextRoot: string;
/** A file placed OUTSIDE tmpDir — a traversal must never reach/touch it. */
let sentinelOutside: string;

beforeEach(() => {
  const raw = join(tmpdir(), `packs-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  tmpDir = realpathSync(raw);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });

  // Sentinel one level above tmpDir's project root; a '../../etc/evil' name must
  // never create or delete anything outside tmpDir.
  sentinelOutside = join(tmpDir, '..', `sentinel-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(sentinelOutside, '# SENTINEL — must never be touched\n', 'utf-8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(sentinelOutside, { force: true });
});

function seedConfig(platforms: 'claude'[]): void {
  writeSetupConfig(tmpDir, {
    platforms,
    packs: [],
    multiProduct: false,
    setupVersion: '1.0.0',
    disableNativeMemory: true,
  });
}

// ─── POST /api/packs/:name/install ────────────────────────────────────────────

describe('POST /api/packs/:name/install', () => {
  it('B1: success → 200, installed non-empty, SKILL.md on disk, manifest written', async () => {
    seedConfig(['claude']);
    const { res, status, body } = makeRes();
    await handlePackInstall(makeReq('POST'), res, { name: 'engineering' }, contextRoot);

    expect(status()).toBe(200);
    const payload = body() as { name: string; installed: string[]; platforms: string[] };
    expect(payload.name).toBe('engineering');
    expect(payload.installed.length).toBeGreaterThan(0);
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', '.install-manifest.json'))).toBe(true);
  });

  it('B2: unknown pack → 404 unknown_pack, nothing created', async () => {
    seedConfig(['claude']);
    const { res, status, body } = makeRes();
    await handlePackInstall(makeReq('POST'), res, { name: 'no-such-pack' }, contextRoot);

    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('unknown_pack');
    expect(existsSync(join(tmpDir, '.claude'))).toBe(false);
  });

  it('B3: traversal name → 400 invalid_name, sentinel outside tmp untouched', async () => {
    seedConfig(['claude']);
    const { res, status, body } = makeRes();
    await handlePackInstall(makeReq('POST'), res, { name: '../../etc/evil' }, contextRoot);

    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_name');
    // Nothing escaped tmpDir.
    expect(existsSync(join(tmpDir, '.claude'))).toBe(false);
    expect(readFileSync(sentinelOutside, 'utf-8')).toContain('SENTINEL');
  });

  it('B4: no config → defaults to claude', async () => {
    // No .config.json seeded.
    const { res, status, body } = makeRes();
    await handlePackInstall(makeReq('POST'), res, { name: 'engineering' }, contextRoot);

    expect(status()).toBe(200);
    expect((body() as { platforms: string[] }).platforms).toEqual(['claude']);
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.agents'))).toBe(false);
  });

});

// ─── DELETE /api/packs/:name ──────────────────────────────────────────────────

describe('DELETE /api/packs/:name', () => {
  it('B6: install then DELETE → 200, removed non-empty, files gone', async () => {
    seedConfig(['claude']);
    await handlePackInstall(makeReq('POST'), makeRes().res, { name: 'engineering' }, contextRoot);
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'SKILL.md'))).toBe(true);

    const { res, status, body } = makeRes();
    await handlePackUninstall(makeReq('DELETE'), res, { name: 'engineering' }, contextRoot);

    expect(status()).toBe(200);
    expect((body() as { removed: string[] }).removed.length).toBeGreaterThan(0);
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering'))).toBe(false);
  });

  it('B7: unknown pack → 404 unknown_pack', async () => {
    seedConfig(['claude']);
    const { res, status, body } = makeRes();
    await handlePackUninstall(makeReq('DELETE'), res, { name: 'no-such-pack' }, contextRoot);

    expect(status()).toBe(404);
    expect((body() as { error: string }).error).toBe('unknown_pack');
  });

  it('B8: traversal name → 400 invalid_name', async () => {
    seedConfig(['claude']);
    const { res, status, body } = makeRes();
    await handlePackUninstall(makeReq('DELETE'), res, { name: '../../etc/evil' }, contextRoot);

    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toBe('invalid_name');
    expect(readFileSync(sentinelOutside, 'utf-8')).toContain('SENTINEL');
  });

  it('B9: idempotent — uninstalling a never-installed valid pack → 200 removed:[]', async () => {
    seedConfig(['claude']);
    const { res, status, body } = makeRes();
    await handlePackUninstall(makeReq('DELETE'), res, { name: 'engineering' }, contextRoot);

    expect(status()).toBe(200);
    expect((body() as { removed: string[] }).removed).toEqual([]);
  });
});
