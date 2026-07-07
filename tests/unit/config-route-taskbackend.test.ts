import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleConfigUpdate } from '../../src/server/routes/config.js';
import { readSetupConfig, writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';

/**
 * Issue #11 M5 — PATCH /api/config taskBackend + clickup block (strict-pick).
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
  tmpDir = join(tmpdir(), `cfg-tb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeSetupConfig(tmpDir, BASE);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('PATCH /api/config — taskBackend + clickup block (strict-pick)', () => {
  it('accepts taskBackend=clickup, derives cloudTaskManagement, and gitignores the derived files', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ taskBackend: 'clickup' }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().config.taskBackend).toBe('clickup');
    expect(body().config.cloudTaskManagement).toBe(true);

    const cfg = readSetupConfig(tmpDir);
    expect(cfg?.taskBackend).toBe('clickup');

    const gi = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gi).toContain('_dream_context/state/*.md');
    expect(gi).toContain('_dream_context/state/.tasks-sync.json');
    expect(gi).toContain('_dream_context/state/.tasks-queue.json');
    expect(gi).toContain('_dream_context/state/.conflicts/');
    expect(gi).toContain('_dream_context/state/.secrets.json');
  });

  it('rejects an unknown taskBackend value', async () => {
    const { res, status, body } = makeRes();
    await handleConfigUpdate(makePatchReq({ taskBackend: 'jira' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_task_backend');
    expect(readSetupConfig(tmpDir)?.taskBackend).toBeUndefined();
  });

  it('validates the clickup block strictly (string ids, changelogTarget=comments only)', async () => {
    const ok = makeRes();
    await handleConfigUpdate(
      makePatchReq({ taskBackend: 'clickup', clickup: { teamId: 't1', spaceId: 's1', listId: 'l1', changelogTarget: 'comments' } }),
      ok.res, {}, contextRoot,
    );
    expect(ok.status()).toBe(200);
    expect(readSetupConfig(tmpDir)?.clickup).toEqual({
      teamId: 't1', spaceId: 's1', listId: 'l1', changelogTarget: 'comments',
    });

    const badId = makeRes();
    await handleConfigUpdate(makePatchReq({ clickup: { listId: 42 } }), badId.res, {}, contextRoot);
    expect(badId.status()).toBe(400);
    expect(badId.body().error).toBe('invalid_clickup');

    const badTarget = makeRes();
    await handleConfigUpdate(makePatchReq({ clickup: { changelogTarget: 'description' } }), badTarget.res, {}, contextRoot);
    expect(badTarget.status()).toBe(400);
  });

  it('partial clickup PATCH merges over the existing block (ids are not dropped)', async () => {
    const first = makeRes();
    await handleConfigUpdate(
      makePatchReq({ taskBackend: 'clickup', clickup: { teamId: 't1', spaceId: 's1', listId: 'l1' } }),
      first.res, {}, contextRoot,
    );
    expect(first.status()).toBe(200);

    const second = makeRes();
    await handleConfigUpdate(makePatchReq({ clickup: { listId: 'l2' } }), second.res, {}, contextRoot);
    expect(second.status()).toBe(200);
    expect(readSetupConfig(tmpDir)?.clickup).toMatchObject({ teamId: 't1', spaceId: 's1', listId: 'l2' });
  });

  it('cloudTaskManagement=false flips the backend back to local', async () => {
    const on = makeRes();
    await handleConfigUpdate(makePatchReq({ taskBackend: 'clickup' }), on.res, {}, contextRoot);
    expect(on.status()).toBe(200);

    const off = makeRes();
    await handleConfigUpdate(makePatchReq({ cloudTaskManagement: false }), off.res, {}, contextRoot);
    expect(off.status()).toBe(200);
    expect(readSetupConfig(tmpDir)?.taskBackend).toBe('local');
    expect(readSetupConfig(tmpDir)?.cloudTaskManagement).toBe(false);
  });

  it('never echoes secrets: the config payload cannot smuggle a token into .config.json', async () => {
    const { res, status } = makeRes();
    await handleConfigUpdate(
      makePatchReq({ taskBackend: 'clickup', clickup: { teamId: 't', token: 'pk_evil_inline' } }),
      res, {}, contextRoot,
    );
    expect(status()).toBe(200);
    const raw = readFileSync(join(contextRoot, 'state', '.config.json'), 'utf-8');
    expect(raw).not.toContain('pk_evil_inline'); // strict-pick drops unknown keys
  });

  it('the prior allow-list still works untouched (platforms/disableNativeMemory)', async () => {
    const { res, status } = makeRes();
    await handleConfigUpdate(makePatchReq({ platforms: ['claude'], disableNativeMemory: false }), res, {}, contextRoot);
    expect(status()).toBe(200);
    const cfg = readSetupConfig(tmpDir);
    expect(cfg?.platforms).toEqual(['claude']);
    expect(cfg?.disableNativeMemory).toBe(false);
    expect(existsSync(join(tmpDir, '.gitignore'))).toBe(false); // no backend flip → no gitignore write
  });
});
