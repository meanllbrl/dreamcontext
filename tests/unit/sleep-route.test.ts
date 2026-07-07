import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSleepUpdate } from '../../src/server/routes/sleep.js';
import { readSleepState } from '../../src/cli/commands/sleep.js';

/**
 * PATCH /api/sleep — debt + recall_mode (validated against the fixed mode list).
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
  const readable = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
  return Object.assign(readable, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let tmpDir: string;
let contextRoot: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `sleep-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('PATCH /api/sleep — recall_mode + debt', () => {
  it('accepts a valid recall_mode, persists it, and records a field change', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'hybrid' }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().recall_mode).toBe('hybrid');

    const state = readSleepState(contextRoot);
    expect(state.recall_mode).toBe('hybrid');
    const change = state.dashboard_changes.find((c) => c.field?.includes('recall_mode'));
    expect(change).toBeDefined();
    expect(change?.fields).toContainEqual({ field: 'recall_mode', from: 'haiku', to: 'hybrid' });
  });

  it.each(['haiku', 'raw', 'hybrid', 'off'] as const)('accepts recall_mode=%s', async (mode) => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: mode }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().recall_mode).toBe(mode);
  });

  it('rejects an unknown recall_mode with 400 invalid_value and persists nothing', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'bm42' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_value');
    expect(readSleepState(contextRoot).recall_mode).toBe('haiku'); // default untouched
  });

  it('rejects a non-string recall_mode', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 42 }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_value');
  });

  it('an invalid recall_mode blocks the whole PATCH — a valid debt in the same body is not persisted', async () => {
    const { res, status } = makeRes();
    await handleSleepUpdate(makePatchReq({ debt: 5, recall_mode: 'nope' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(readSleepState(contextRoot).debt).toBe(0);
  });

  it('debt updates still work (with a field change recorded)', async () => {
    const { res, status, body } = makeRes();
    await handleSleepUpdate(makePatchReq({ debt: 7 }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().debt).toBe(7);

    const state = readSleepState(contextRoot);
    expect(state.debt).toBe(7);
    expect(state.dashboard_changes.some((c) => c.fields?.some((f) => f.field === 'debt' && f.to === 7))).toBe(true);
  });

  it('setting the same recall_mode again records no field change', async () => {
    const first = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'raw' }), first.res, {}, contextRoot);
    const before = readSleepState(contextRoot).dashboard_changes.length;

    const second = makeRes();
    await handleSleepUpdate(makePatchReq({ recall_mode: 'raw' }), second.res, {}, contextRoot);
    expect(second.status()).toBe(200);
    expect(readSleepState(contextRoot).dashboard_changes.length).toBe(before);
  });
});
