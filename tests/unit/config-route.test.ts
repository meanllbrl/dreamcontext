import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleConfigGet, handleConfigUpdate } from '../../src/server/routes/config.js';
import { writeSetupConfig, readSetupConfig } from '../../src/lib/setup-config.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';

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

  return {
    res,
    status: () => statusCode,
    body: () => responseBody,
  };
}

function makeGetReq(): IncomingMessage {
  return { method: 'GET', headers: {} } as unknown as IncomingMessage;
}

function makePatchReq(bodyObj: unknown): IncomingMessage {
  const body = JSON.stringify(bodyObj);
  const readable = Readable.from([Buffer.from(body)]);
  return Object.assign(readable, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

function makeRawBodyReq(raw: string): IncomingMessage {
  const readable = Readable.from([Buffer.from(raw)]);
  return Object.assign(readable, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

// contextRoot = <tmpDir>/_dream_context
let tmpDir: string;
let contextRoot: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `cfg-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── GET /api/config ──────────────────────────────────────────────────────────

describe('GET /api/config', () => {
  it('returns { config: null } when no config file exists', async () => {
    const { res, status, body } = makeRes();
    await handleConfigGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect((body() as Record<string, unknown>).config).toBeNull();
  });

  it('returns the seeded config when present', async () => {
    const seed: SetupConfig = {
      platforms: ['claude'],
      packs: ['engineering'],
      multiProduct: false,
      setupVersion: '1.0.0',
      disableNativeMemory: true,
    };
    writeSetupConfig(tmpDir, seed);

    const { res, status, body } = makeRes();
    await handleConfigGet(makeGetReq(), res, {}, contextRoot);
    expect(status()).toBe(200);
    const config = (body() as Record<string, unknown>).config as SetupConfig;
    expect(config.platforms).toEqual(['claude']);
    expect(config.packs).toEqual(['engineering']);
    expect(config.setupVersion).toBe('1.0.0');
  });
});

// ─── PATCH /api/config ────────────────────────────────────────────────────────

describe('PATCH /api/config', () => {
  it('200: valid platforms update', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ platforms: ['claude'] }), res, {}, contextRoot);
    expect(status()).toBe(200);
    const config = (body() as Record<string, unknown>).config as SetupConfig;
    expect(config.platforms).toEqual(['claude']);
  });

  it('200: valid packs update', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: ['engineering'] }), res, {}, contextRoot);
    expect(status()).toBe(200);
    const config = (body() as Record<string, unknown>).config as SetupConfig;
    expect(config.packs).toEqual(['engineering']);
  });

  it('200: empty packs array is valid (clears packs)', async () => {
    writeSetupConfig(tmpDir, { platforms: ['claude'], packs: ['engineering'], multiProduct: false, setupVersion: '1.0.0', disableNativeMemory: true });
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: [] }), res, {}, contextRoot);
    expect(status()).toBe(200);
    const config = (body() as Record<string, unknown>).config as SetupConfig;
    expect(config.packs).toEqual([]);
  });

  it('400 invalid_platforms: unknown platform id', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ platforms: ['mars'] }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_platforms');
  });

  it('400 invalid_platforms: platforms not an array', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ platforms: 'claude' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_platforms');
  });

  it('400 invalid_packs: array containing null', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: [null] }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_packs');
  });

  it('400 invalid_packs: array containing object', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: [{}] }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_packs');
  });

  it('400 invalid_packs: array containing number', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: [123] }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_packs');
  });

  it('400 invalid_packs: array containing empty string', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: [''] }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_packs');
  });

  it('400 invalid_packs: packs is not an array', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: 'notarray' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_packs');
  });

  it('400 invalid_body: non-JSON body', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makeRawBodyReq('not json {{'), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_body');
  });

  it('400 no_changes: body with no recognized keys', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ unrelated: 'value' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('no_changes');
  });

  it('allow-list: unknown fields in body are ignored and do not appear in config', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(
      makePatchReq({ platforms: ['claude'], setupVersion: '9.9.9', multiProduct: ['rogue'] }),
      res,
      {},
      contextRoot,
    );
    expect(status()).toBe(200);
    const config = (body() as Record<string, unknown>).config as SetupConfig;
    // setupVersion and multiProduct must NOT be overwritten by the body
    expect(config.setupVersion).not.toBe('9.9.9');
    expect(config.multiProduct).not.toEqual(['rogue']);
  });

  it('no prototype pollution: __proto__ in body does not affect Object.prototype', async () => {
    // Attempt prototype pollution via JSON body
    const { res } = makeRes();
    await handleConfigUpdate(
      makeRawBodyReq(JSON.stringify({ __proto__: { polluted: true }, platforms: ['claude'] })),
      res,
      {},
      contextRoot,
    );
    // Object.prototype must not be polluted
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('persists the update to disk and subsequent GET returns it', async () => {
    const patchRes = makeRes();
    await handleConfigUpdate(makePatchReq({ packs: ['engineering'] }), patchRes.res, {}, contextRoot);
    expect(patchRes.status()).toBe(200);

    const getRes = makeRes();
    await handleConfigGet(makeGetReq(), getRes.res, {}, contextRoot);
    const config = (getRes.body() as Record<string, unknown>).config as SetupConfig;
    expect(config.packs).toEqual(['engineering']);
  });
});

// ─── PATCH /api/config — disableNativeMemory ───────────────────────────────────

describe('PATCH /api/config — disableNativeMemory', () => {
  const settingsPath = () => join(tmpDir, '.claude', 'settings.json');

  it('200: accepts disableNativeMemory:false and persists it', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ disableNativeMemory: false }), res, {}, contextRoot);
    expect(status()).toBe(200);
    const config = (body() as Record<string, unknown>).config as SetupConfig;
    expect(config.disableNativeMemory).toBe(false);
  });

  it('reflects the toggle into .claude/settings.json (autoMemoryEnabled is the inverse)', async () => {
    const r1 = makeRes();
    await handleConfigUpdate(makePatchReq({ disableNativeMemory: true }), r1.res, {}, contextRoot);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf-8')).autoMemoryEnabled).toBe(false);

    const r2 = makeRes();
    await handleConfigUpdate(makePatchReq({ disableNativeMemory: false }), r2.res, {}, contextRoot);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf-8')).autoMemoryEnabled).toBe(true);
  });

  it('400 invalid_disable_native_memory: non-boolean value', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ disableNativeMemory: 'yes' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_disable_native_memory');
  });

  it('disableNativeMemory alone is a valid change (not no_changes)', async () => {
    const { res, status } = makeRes();
    await handleConfigUpdate(makePatchReq({ disableNativeMemory: true }), res, {}, contextRoot);
    expect(status()).toBe(200);
  });
});
