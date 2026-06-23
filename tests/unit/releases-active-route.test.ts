import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleActiveVersionGet, handleActiveVersionSet } from '../../src/server/routes/changelog.js';
import { getExistingReleases } from '../../src/lib/release-discovery.js';

/**
 * GET/PUT /api/releases/active — the active planning version ("current sprint")
 * surfaced to the dashboard. Net-new routes (the active version was previously
 * CLI-only). The handlers operate on a per-request contextRoot.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) {
      try { responseBody = JSON.parse(data); } catch { responseBody = data; }
    },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(payload), {
    method,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let root: string;

function writeReleases(entries: unknown[]): void {
  writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify(entries, null, 2));
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  root = join(tmpdir(), `dc-activever-${stamp}`, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeReleases([]);
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('GET /api/releases/active', () => {
  it('returns null when no active version is set', async () => {
    const { res, status, body } = makeRes();
    await handleActiveVersionGet(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body()).toEqual({ active: null });
  });
});

describe('PUT /api/releases/active', () => {
  it('sets an existing planning version as current', async () => {
    writeReleases([
      { id: 'rel_1', version: 'S7', date: '', summary: '', breaking: false, status: 'planning', features: [], tasks: [], changelog: [] },
    ]);
    const { res, status, body } = makeRes();
    await handleActiveVersionSet(makeReq('PUT', { version: 'S7' }), res, {}, root);
    expect(status()).toBe(200);
    expect(body()).toEqual({ active: 'S7' });

    const get = makeRes();
    await handleActiveVersionGet(makeReq('GET'), get.res, {}, root);
    expect(get.body()).toEqual({ active: 'S7' });
  });

  it('lazily creates a planning entry for an unregistered sprint, then marks it current', async () => {
    const { res, status, body } = makeRes();
    await handleActiveVersionSet(makeReq('PUT', { version: 'S3' }), res, {}, root);
    expect(status()).toBe(200);
    expect(body()).toEqual({ active: 'S3' });

    const releases = getExistingReleases(root);
    const created = releases.find(r => r.version === 'S3');
    expect(created).toBeDefined();
    expect(created?.status).toBe('planning');
  });

  it('rejects making a released version current (409)', async () => {
    writeReleases([
      { id: 'rel_x', version: 'v0.8.8', date: '2026-06-21', summary: '', breaking: false, status: 'released', features: [], tasks: [], changelog: [] },
    ]);
    const { res, status, body } = makeRes();
    await handleActiveVersionSet(makeReq('PUT', { version: 'v0.8.8' }), res, {}, root);
    expect(status()).toBe(409);
    expect(body().error).toBe('already_released');
  });

  it('clears the active version when given null', async () => {
    writeReleases([
      { id: 'rel_1', version: 'S7', date: '', summary: '', breaking: false, status: 'planning', features: [], tasks: [], changelog: [] },
    ]);
    // set then clear
    await handleActiveVersionSet(makeReq('PUT', { version: 'S7' }), makeRes().res, {}, root);

    const { res, status, body } = makeRes();
    await handleActiveVersionSet(makeReq('PUT', { version: null }), res, {}, root);
    expect(status()).toBe(200);
    expect(body()).toEqual({ active: null });

    const get = makeRes();
    await handleActiveVersionGet(makeReq('GET'), get.res, {}, root);
    expect(get.body()).toEqual({ active: null });
  });

  it('rejects a non-string, non-null version (400)', async () => {
    const { res, status, body } = makeRes();
    await handleActiveVersionSet(makeReq('PUT', { version: 42 }), res, {}, root);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_version');
  });
});
