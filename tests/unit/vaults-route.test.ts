import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVaultsGet, handleVaultsPost, handleVaultsDelete } from '../../src/server/routes/vaults.js';

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

function makePostReq(bodyObj: unknown): IncomingMessage {
  const body = JSON.stringify(bodyObj);
  const readable = Readable.from([Buffer.from(body)]);
  return Object.assign(readable, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

function makeDeleteReq(): IncomingMessage {
  return { method: 'DELETE', headers: {} } as unknown as IncomingMessage;
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tmpDir: string;
let contextRoot: string;
let savedHome: string | undefined;

beforeEach(() => {
  // Redirect HOME to a fresh tmpdir so listVaults() reads an empty/controlled registry
  savedHome = process.env.HOME;
  tmpDir = join(tmpdir(), `vaults-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.HOME = tmpDir;
  mkdirSync(tmpDir, { recursive: true });

  // contextRoot = <someProject>/_dream_context
  contextRoot = join(tmpDir, 'project', '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  // Restore HOME
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── GET /api/vaults ──────────────────────────────────────────────────────────

describe('GET /api/vaults', () => {
  it('returns 200 with { vaults: [], current: <dirname(contextRoot)> } when registry absent', async () => {
    const { res, status, body } = makeRes();
    await handleVaultsGet(makeGetReq(), res, {}, contextRoot);

    expect(status()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(Array.isArray(b.vaults)).toBe(true);
    expect((b.vaults as unknown[]).length).toBe(0);
    // current should be the parent of contextRoot
    expect(b.current).toBe(join(tmpDir, 'project'));
  });

  it('returns registered vaults when registry exists', async () => {
    // Seed a vaults.json under the tmpDir HOME
    const dreamcontextDir = join(tmpDir, '.dreamcontext');
    mkdirSync(dreamcontextDir, { recursive: true });
    writeFileSync(
      join(dreamcontextDir, 'vaults.json'),
      JSON.stringify({ vaults: [{ name: 'myproject', path: '/some/path' }] }),
      'utf-8',
    );

    const { res, status, body } = makeRes();
    await handleVaultsGet(makeGetReq(), res, {}, contextRoot);

    expect(status()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(Array.isArray(b.vaults)).toBe(true);
    expect((b.vaults as Array<{ name: string; path: string }>)[0].name).toBe('myproject');
  });

  it('never throws even when registry is malformed JSON', async () => {
    // Write malformed JSON to trigger the graceful fallback
    const dreamcontextDir = join(tmpDir, '.dreamcontext');
    mkdirSync(dreamcontextDir, { recursive: true });
    writeFileSync(join(dreamcontextDir, 'vaults.json'), 'not json {{', 'utf-8');

    const { res, status, body } = makeRes();
    await expect(handleVaultsGet(makeGetReq(), res, {}, contextRoot)).resolves.toBeUndefined();

    expect(status()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(Array.isArray(b.vaults)).toBe(true);
    expect((b.vaults as unknown[]).length).toBe(0);
  });

  it('returns the correct current path regardless of vault count', async () => {
    const { res, status, body } = makeRes();
    const customContextRoot = join(tmpDir, 'nested', 'project', '_dream_context');
    mkdirSync(join(customContextRoot, 'state'), { recursive: true });

    await handleVaultsGet(makeGetReq(), res, {}, customContextRoot);

    expect(status()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(b.current).toBe(join(tmpDir, 'nested', 'project'));
  });
});

// ─── POST /api/vaults ─────────────────────────────────────────────────────────

describe('POST /api/vaults', () => {
  it('200: registers a valid vault and returns the updated list', async () => {
    // Create a valid vault directory with _dream_context/
    const vaultDir = join(tmpDir, 'valid-vault');
    mkdirSync(join(vaultDir, '_dream_context'), { recursive: true });

    const { res, status, body } = makeRes();
    await handleVaultsPost(makePostReq({ name: 'mytest', path: vaultDir }), res, {}, contextRoot);

    expect(status()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(Array.isArray(b.vaults)).toBe(true);
    const vaults = b.vaults as Array<{ name: string; path: string }>;
    expect(vaults.some((v) => v.name === 'mytest')).toBe(true);
  });

  it('400 invalid_body: missing name', async () => {
    const { res, status, body } = makeRes();
    await handleVaultsPost(makePostReq({ path: '/some/path' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_body');
  });

  it('400 invalid_body: missing path', async () => {
    const { res, status, body } = makeRes();
    await handleVaultsPost(makePostReq({ name: 'test' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_body');
  });

  it('400 invalid_body: blank name', async () => {
    const { res, status, body } = makeRes();
    await handleVaultsPost(makePostReq({ name: '   ', path: '/some/path' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_body');
  });

  it('400 invalid_body: blank path', async () => {
    const { res, status, body } = makeRes();
    await handleVaultsPost(makePostReq({ name: 'test', path: '   ' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_body');
  });

  it('400 invalid_vault: path without _dream_context/', async () => {
    // Create a directory that exists but has no _dream_context/ child
    const bareDir = join(tmpDir, 'bare-dir');
    mkdirSync(bareDir, { recursive: true });

    const { res, status, body } = makeRes();
    await handleVaultsPost(makePostReq({ name: 'bare', path: bareDir }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_vault');
  });

  it('400 invalid_vault: duplicate name', async () => {
    // Create a valid vault and register it first
    const vaultDir = join(tmpDir, 'dup-vault');
    mkdirSync(join(vaultDir, '_dream_context'), { recursive: true });

    // First registration
    const first = makeRes();
    await handleVaultsPost(makePostReq({ name: 'dupname', path: vaultDir }), first.res, {}, contextRoot);
    expect(first.status()).toBe(200);

    // Create a second different vault dir
    const vaultDir2 = join(tmpDir, 'dup-vault-2');
    mkdirSync(join(vaultDir2, '_dream_context'), { recursive: true });

    // Second registration with same name
    const { res, status, body } = makeRes();
    await handleVaultsPost(makePostReq({ name: 'dupname', path: vaultDir2 }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid_vault');
  });
});

// ─── DELETE /api/vaults/:name ─────────────────────────────────────────────────

describe('DELETE /api/vaults/:name', () => {
  it('200: removes an existing vault and returns the updated list', async () => {
    // Register a vault first (seed it directly in the registry)
    const dreamcontextDir = join(tmpDir, '.dreamcontext');
    mkdirSync(dreamcontextDir, { recursive: true });
    writeFileSync(
      join(dreamcontextDir, 'vaults.json'),
      JSON.stringify({ vaults: [{ name: 'to-remove', path: '/some/existing/path' }] }),
      'utf-8',
    );

    const { res, status, body } = makeRes();
    await handleVaultsDelete(makeDeleteReq(), res, { name: 'to-remove' }, contextRoot);

    expect(status()).toBe(200);
    const b = body() as Record<string, unknown>;
    const vaults = b.vaults as Array<{ name: string }>;
    expect(vaults.some((v) => v.name === 'to-remove')).toBe(false);
  });

  it('404 not_found: deleting a non-existent vault name', async () => {
    const { res, status, body } = makeRes();
    await handleVaultsDelete(makeDeleteReq(), res, { name: 'nonexistent' }, contextRoot);
    expect(status()).toBe(404);
    expect((body() as Record<string, unknown>).error).toBe('not_found');
  });
});
