import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleConfigUpdate } from '../../src/server/routes/config.js';
import { readSetupConfig, writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';

/**
 * P2.4 — PATCH /api/config accepts `shareable` via the strict-pick allow-list
 * (boolean else 400) + the no_changes guard chain; no other field is widened.
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

function makePatchReq(bodyObj: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(bodyObj))]), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

const BASE: SetupConfig = {
  platforms: ['claude'],
  packs: [],
  multiProduct: false,
  setupVersion: '1.0.0',
  disableNativeMemory: true,
};

let tmpDir: string;
let contextRoot: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `cfg-share-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeSetupConfig(tmpDir, BASE);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('PATCH /api/config — shareable (federation P2.4)', () => {
  it('persists shareable:true', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ shareable: true }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().config.shareable).toBe(true);
    expect(readSetupConfig(tmpDir)?.shareable).toBe(true);
  });

  it('persists shareable:false', async () => {
    writeSetupConfig(tmpDir, { ...BASE, shareable: true });
    const { res, status } = makeRes();
    await handleConfigUpdate(makePatchReq({ shareable: false }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(readSetupConfig(tmpDir)?.shareable).toBe(false);
  });

  it('rejects a non-boolean shareable (400 invalid_shareable)', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ shareable: 'yes' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_shareable');
    expect(readSetupConfig(tmpDir)?.shareable).toBeUndefined();
  });

  it('an empty body still hits the no_changes guard (shareable is in the chain)', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({}), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('no_changes');
  });

  it('ignores unrelated/unknown fields (strict-pick) but honours shareable', async () => {
    const { res, status } = makeRes();
    await handleConfigUpdate(
      makePatchReq({ shareable: true, sneaky: 'value', setupVersion: '9.9.9' }),
      res, {}, contextRoot,
    );
    expect(status()).toBe(200);
    const cfg = readSetupConfig(tmpDir);
    expect(cfg?.shareable).toBe(true);
    // setupVersion is NOT in the allow-list — it must be untouched.
    expect(cfg?.setupVersion).toBe('1.0.0');
  });
});
