import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleConnectionsList,
  handleConnectionsCreate,
  handleConnectionsDelete,
} from '../../src/server/routes/connections.js';
import { addVault } from '../../src/lib/vaults.js';
import { listConnections } from '../../src/lib/connections.js';

/**
 * P2.2 — connections route. The route handlers call addConnection without an
 * injectable home, so they read the real vault registry. We point HOME at a
 * temp dir for the duration of each test so listVaults() resolves our fixtures.
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

function makeReq(method: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, {
    method,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let tmpHome: string;
let base: string;
let curContextRoot: string;
let originalHome: string | undefined;

/** Register a project under `base` and return its context root. */
function makeVault(name: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  addVault(name, projectRoot); // default home === tmpHome (HOME override)
  return join(projectRoot, '_dream_context');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `dc-connroute-home-${stamp}`);
  base = join(tmpdir(), `dc-connroute-base-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(base, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  curContextRoot = makeVault('cur');
  makeVault('peer');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe('POST /api/connections (strict-pick)', () => {
  it('creates a connection and returns the updated list', async () => {
    const { res, status, body } = makeRes();
    await handleConnectionsCreate(
      makeReq('POST', { vault: 'peer', direction: 'both', topics: ['auth'] }),
      res, {}, curContextRoot,
    );
    expect(status()).toBe(200);
    expect(body().connections).toHaveLength(1);
    expect(body().connections[0]).toMatchObject({ vault: 'peer', direction: 'both', topics: ['auth'] });
    expect(listConnections(curContextRoot)).toHaveLength(1);
  });

  it('rejects an invalid direction (400 invalid_direction)', async () => {
    const { res, status, body } = makeRes();
    await handleConnectionsCreate(
      makeReq('POST', { vault: 'peer', direction: 'sideways' }),
      res, {}, curContextRoot,
    );
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_direction');
    expect(listConnections(curContextRoot)).toHaveLength(0);
  });

  it('rejects a self-connect (400 self_connect)', async () => {
    const { res, status, body } = makeRes();
    await handleConnectionsCreate(
      makeReq('POST', { vault: 'cur', direction: 'both' }),
      res, {}, curContextRoot,
    );
    expect(status()).toBe(400);
    expect(body().error).toBe('self_connect');
  });

  it('rejects an unknown vault (400 invalid_vault)', async () => {
    const { res, status, body } = makeRes();
    await handleConnectionsCreate(
      makeReq('POST', { vault: 'ghost', direction: 'out' }),
      res, {}, curContextRoot,
    );
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_vault');
  });

  it('strict-pick: a crafted __proto__ / extra-field body cannot pollute', async () => {
    const { res, status } = makeRes();
    const malicious = JSON.parse(
      '{"vault":"peer","direction":"out","__proto__":{"polluted":true},"status":"stale","last_synced_at":"hacked"}',
    );
    await handleConnectionsCreate(makeReq('POST', malicious), res, {}, curContextRoot);
    expect(status()).toBe(200);
    // Prototype not polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Smuggled status/watermark dropped — a fresh active connection is written.
    const conn = listConnections(curContextRoot)[0];
    expect(conn.status).toBe('active');
    expect(conn.last_synced_at).toBeNull();
  });
});

describe('GET /api/connections', () => {
  it('lists the current vault connections', async () => {
    await handleConnectionsCreate(
      makeReq('POST', { vault: 'peer', direction: 'out' }),
      makeRes().res, {}, curContextRoot,
    );
    const { res, status, body } = makeRes();
    await handleConnectionsList(makeReq('GET'), res, {}, curContextRoot);
    expect(status()).toBe(200);
    expect(body().connections).toHaveLength(1);
    expect(body().connections[0].vault).toBe('peer');
  });
});

describe('DELETE /api/connections/:vault', () => {
  it('removes an existing connection and returns the updated list', async () => {
    await handleConnectionsCreate(
      makeReq('POST', { vault: 'peer', direction: 'out' }),
      makeRes().res, {}, curContextRoot,
    );
    const { res, status, body } = makeRes();
    await handleConnectionsDelete(makeReq('DELETE'), res, { vault: 'peer' }, curContextRoot);
    expect(status()).toBe(200);
    expect(body().connections).toHaveLength(0);
    expect(listConnections(curContextRoot)).toHaveLength(0);
  });

  it('404s when the connection does not exist', async () => {
    const { res, status, body } = makeRes();
    await handleConnectionsDelete(makeReq('DELETE'), res, { vault: 'nope' }, curContextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });
});
