import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVaultsGet } from '../../src/server/routes/vaults.js';
import { addVault } from '../../src/lib/vaults.js';

/**
 * P2.2 — GET /api/vaults returns {vaults, current}. NET-NEW route. `current` is
 * the registered name of the vault whose path matches dirname(contextRoot).
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

function makeReq(): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: 'GET',
    headers: {},
  }) as unknown as IncomingMessage;
}

let tmpHome: string;
let base: string;
let originalHome: string | undefined;

function makeVault(name: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context'), { recursive: true });
  addVault(name, projectRoot);
  return join(projectRoot, '_dream_context');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `dc-vaultsroute-home-${stamp}`);
  base = join(tmpdir(), `dc-vaultsroute-base-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(base, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe('GET /api/vaults', () => {
  it('returns {vaults, current} with current = the registered current vault', async () => {
    const curRoot = makeVault('cur');
    makeVault('peer');
    const { res, status, body } = makeRes();
    await handleVaultsGet(makeReq(), res, {}, curRoot);
    expect(status()).toBe(200);
    expect(body().vaults.map((v: any) => v.name).sort()).toEqual(['cur', 'peer']);
    expect(body().current).toBe('cur');
  });

  it('current is null when the current project is not registered', async () => {
    makeVault('peer');
    const unregistered = join(base, 'solo', '_dream_context');
    mkdirSync(unregistered, { recursive: true });
    const { res, status, body } = makeRes();
    await handleVaultsGet(makeReq(), res, {}, unregistered);
    expect(status()).toBe(200);
    expect(body().current).toBeNull();
  });
});
