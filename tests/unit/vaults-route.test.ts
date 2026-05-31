import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVaultsGet } from '../../src/server/routes/vaults.js';

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
