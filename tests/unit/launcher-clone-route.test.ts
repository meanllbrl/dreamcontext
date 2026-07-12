import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleLauncherGithubRepos,
  handleLauncherClone,
  handleLauncherCloneStatus,
  handleLauncherCloneCancel,
} from '../../src/server/routes/launcher.js';

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, url: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, {
    method,
    url,
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

let tmpHome: string;
let base: string;
let originalHome: string | undefined;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `dc-launcher-clone-home-${stamp}`);
  base = join(tmpdir(), `dc-launcher-clone-base-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(base, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.DREAMCONTEXT_DESKTOP;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

// ─── Desktop gate ────────────────────────────────────────────────────────────────

describe('launcher clone routes — desktop gate', () => {
  it('403s GET /launcher/github/repos outside the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status, body } = makeRes();
    await handleLauncherGithubRepos(makeReq('GET', '/api/launcher/github/repos'), res, {}, null);
    expect(status()).toBe(403);
    expect(body().error).toBe('desktop_only');
  });

  it('403s POST /launcher/clone outside the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status, body } = makeRes();
    await handleLauncherClone(
      makeReq('POST', '/api/launcher/clone', { url: 'acme/api', parentDir: base }),
      res,
      {},
      null,
    );
    expect(status()).toBe(403);
    expect(body().error).toBe('desktop_only');
  });
});

// ─── Token gate ──────────────────────────────────────────────────────────────────

describe('launcher clone routes — token gate', () => {
  it('401s no_token on GET /launcher/github/repos when nobody is signed in', async () => {
    const { res, status, body } = makeRes();
    await handleLauncherGithubRepos(makeReq('GET', '/api/launcher/github/repos?q=x'), res, {}, null);
    expect(status()).toBe(401);
    expect(body().error).toBe('no_token');
  });

  it('401s no_token on POST /launcher/clone when nobody is signed in', async () => {
    const { res, status, body } = makeRes();
    await handleLauncherClone(
      makeReq('POST', '/api/launcher/clone', { url: 'acme/api', parentDir: base }),
      res,
      {},
      null,
    );
    expect(status()).toBe(401);
    expect(body().error).toBe('no_token');
  });
});

// ─── Clone input validation (all BEFORE any network/git call) ─────────────────────

describe('launcher clone routes — /clone validation', () => {
  it('400s invalid_body when url or parentDir is missing', async () => {
    process.env.GH_TOKEN = 'ghp_test';
    const { res, status, body } = makeRes();
    await handleLauncherClone(makeReq('POST', '/api/launcher/clone', { url: 'acme/api' }), res, {}, null);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });

  it('400s clone_failed for a non-GitHub URL', async () => {
    process.env.GH_TOKEN = 'ghp_test';
    const { res, status, body } = makeRes();
    await handleLauncherClone(
      makeReq('POST', '/api/launcher/clone', { url: 'ext::sh -c whoami', parentDir: base }),
      res,
      {},
      null,
    );
    expect(status()).toBe(400);
    expect(body().error).toBe('clone_failed');
  });

  it('400s clone_failed for a relative parentDir', async () => {
    process.env.GH_TOKEN = 'ghp_test';
    const { res, status, body } = makeRes();
    await handleLauncherClone(
      makeReq('POST', '/api/launcher/clone', { url: 'acme/api', parentDir: 'not/absolute' }),
      res,
      {},
      null,
    );
    expect(status()).toBe(400);
    expect(body().error).toBe('clone_failed');
    expect(body().message).toMatch(/absolute/i);
  });

  it('400s clone_failed when the destination folder already exists', async () => {
    process.env.GH_TOKEN = 'ghp_test';
    mkdirSync(join(base, 'api'));
    const { res, status, body } = makeRes();
    await handleLauncherClone(
      makeReq('POST', '/api/launcher/clone', { url: 'acme/api', parentDir: base }),
      res,
      {},
      null,
    );
    expect(status()).toBe(400);
    expect(body().error).toBe('clone_failed');
    expect(body().message).toMatch(/already exists/i);
  });
});

// ─── Clone job status + cancel ────────────────────────────────────────────────────

describe('launcher clone routes — /clone/status and /clone/cancel', () => {
  it('403s both outside the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const a = makeRes();
    await handleLauncherCloneStatus(makeReq('GET', '/api/launcher/clone/status?id=x'), a.res, {}, null);
    expect(a.status()).toBe(403);
    const b = makeRes();
    await handleLauncherCloneCancel(makeReq('POST', '/api/launcher/clone/cancel', { id: 'x' }), b.res, {}, null);
    expect(b.status()).toBe(403);
  });

  it('reports state unknown for an expired/unknown job id', async () => {
    const { res, status, body } = makeRes();
    await handleLauncherCloneStatus(makeReq('GET', '/api/launcher/clone/status?id=ghost'), res, {}, null);
    expect(status()).toBe(200);
    expect(body().state).toBe('unknown');
  });

  it('400s cancel without an id', async () => {
    const { res, status, body } = makeRes();
    await handleLauncherCloneCancel(makeReq('POST', '/api/launcher/clone/cancel', {}), res, {}, null);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });

  it('cancel of an unknown/finished job is an idempotent no-op', async () => {
    const { res, status, body } = makeRes();
    await handleLauncherCloneCancel(makeReq('POST', '/api/launcher/clone/cancel', { id: 'ghost' }), res, {}, null);
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true, canceled: false });
  });
});
