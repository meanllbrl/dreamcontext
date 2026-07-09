import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  handleLinkedReposList,
  handleLinkedReposLink,
  handleLinkedReposClone,
  handleLinkedReposUnlink,
} from '../../src/server/routes/linked-repos.js';
import { addVault } from '../../src/lib/vaults.js';
import { readSetupConfig } from '../../src/lib/setup-config.js';

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

function makeReq(method: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, { method, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
}

let tmpHome: string;
let base: string;
let originalHome: string | undefined;

/** Register a vault; returns its `_dream_context` path. */
function makeVault(name: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  const config = { platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true };
  writeFileSync(join(projectRoot, '_dream_context', 'state', '.config.json'), JSON.stringify(config), 'utf-8');
  addVault(name, projectRoot);
  return join(projectRoot, '_dream_context');
}

function sh(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A real local git repo with an `origin` remote (for /link real-git validation). */
function makeGitRepo(name: string, origin?: string): string {
  const dir = join(base, `repo-${name}`);
  mkdirSync(dir, { recursive: true });
  sh(dir, ['init']);
  if (origin) sh(dir, ['remote', 'add', 'origin', origin]);
  return dir;
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `dc-linkedrepos-route-home-${stamp}`);
  base = join(tmpdir(), `dc-linkedrepos-route-base-${stamp}`);
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
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

// ─── Desktop gate — 403 for every handler ───────────────────────────────────────

describe('linked-repos routes — desktop gate', () => {
  it('403s GET /linked-repos when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleLinkedReposList(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(403);
  });

  it('403s POST /linked-repos/link when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleLinkedReposLink(makeReq('POST', { name: 'api', path: '/x' }), res, {}, ctx);
    expect(status()).toBe(403);
  });

  it('403s POST /linked-repos/clone when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleLinkedReposClone(makeReq('POST', { name: 'api', confirmed: true }), res, {}, ctx);
    expect(status()).toBe(403);
  });

  it('403s POST /linked-repos/unlink when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleLinkedReposUnlink(makeReq('POST', { name: 'api' }), res, {}, ctx);
    expect(status()).toBe(403);
  });
});

// ─── GET /linked-repos (list) ────────────────────────────────────────────────────

describe('linked-repos routes — list', () => {
  it('returns an empty repos array for a fresh vault', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleLinkedReposList(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().repos).toEqual([]);
  });
});

// ─── POST /linked-repos/link ─────────────────────────────────────────────────────

describe('linked-repos routes — /link', () => {
  it('links a valid local git repo and persists a canonical entry', async () => {
    const ctx = makeVault('cur');
    const repoDir = makeGitRepo('api', 'https://github.com/acme/api.git');
    const { res, status, body } = makeRes();
    await handleLinkedReposLink(makeReq('POST', { name: 'api', path: repoDir }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
    expect(body().entry).toEqual({ name: 'api', gitRemoteUrl: 'https://github.com/acme/api.git' });
  });

  it('STRICT-PICK: extra body fields are ignored, never persisted or echoed', async () => {
    const ctx = makeVault('cur');
    const projectRoot = join(base, 'cur');
    const repoDir = makeGitRepo('api2', 'https://github.com/acme/api2.git');
    const { res, status, body } = makeRes();
    await handleLinkedReposLink(
      makeReq('POST', { name: 'api2', path: repoDir, evil: 'ignored', path2: '/should/not/land' }),
      res,
      {},
      ctx,
    );
    expect(status()).toBe(200);
    expect(Object.keys(body().entry).sort()).toEqual(['gitRemoteUrl', 'name']);
    expect(JSON.stringify(body())).not.toContain('should/not/land');
    const cfg = readSetupConfig(projectRoot);
    expect(JSON.stringify(cfg?.linkedRepos)).not.toContain('evil');
  });

  it('400s with invalid_body when name or path is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleLinkedReposLink(makeReq('POST', { name: 'api' }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });

  it('rejects a non-git directory (S3a)', async () => {
    const ctx = makeVault('cur');
    const plainDir = join(base, 'plain-not-git');
    mkdirSync(plainDir, { recursive: true });
    const { res, status, body } = makeRes();
    await handleLinkedReposLink(makeReq('POST', { name: 'api', path: plainDir }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('link_failed');
    expect(body().message).toMatch(/not a git repo/i);
  });

  it('rejects a git dir whose origin does not match the --url canonical URL (S3b)', async () => {
    const ctx = makeVault('cur');
    const repoDir = makeGitRepo('mismatch', 'https://github.com/acme/real.git');
    const { res, status, body } = makeRes();
    await handleLinkedReposLink(
      makeReq('POST', { name: 'api', path: repoDir, url: 'acme/different' }),
      res,
      {},
      ctx,
    );
    expect(status()).toBe(400);
    expect(body().error).toBe('link_failed');
    expect(body().message).toMatch(/mismatch/i);
  });

  it('origin-absent + --url escape hatch (S3c) succeeds', async () => {
    const ctx = makeVault('cur');
    const repoDir = makeGitRepo('noorigin'); // no origin set
    const { res, status, body } = makeRes();
    await handleLinkedReposLink(
      makeReq('POST', { name: 'api', path: repoDir, url: 'acme/api' }),
      res,
      {},
      ctx,
    );
    expect(status()).toBe(200);
    expect(body().entry.gitRemoteUrl).toBe('https://github.com/acme/api.git');
  });
});

// ─── POST /linked-repos/clone ────────────────────────────────────────────────────

describe('linked-repos routes — /clone', () => {
  it('400s needs_confirm without confirmed:true', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleLinkedReposClone(makeReq('POST', { name: 'api' }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('needs_confirm');
  });

  it('401s no_token when confirmed:true but no GitHub token resolves', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleLinkedReposClone(makeReq('POST', { name: 'api', confirmed: true }), res, {}, ctx);
    expect(status()).toBe(401);
    expect(body().error).toBe('no_token');
  });

  it('400s invalid_body when name is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleLinkedReposClone(makeReq('POST', { confirmed: true }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });
});

// ─── POST /linked-repos/unlink ───────────────────────────────────────────────────

describe('linked-repos routes — /unlink', () => {
  it('removes a linked entry and reports removed:true', async () => {
    const ctx = makeVault('cur');
    const repoDir = makeGitRepo('api3', 'https://github.com/acme/api3.git');
    await handleLinkedReposLink(makeReq('POST', { name: 'api3', path: repoDir }), makeRes().res, {}, ctx);

    const { res, status, body } = makeRes();
    await handleLinkedReposUnlink(makeReq('POST', { name: 'api3' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().removed).toBe(true);
  });

  it('400s invalid_body when name is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleLinkedReposUnlink(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_body');
  });

  it('reports removed:false for an unknown name (never throws)', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleLinkedReposUnlink(makeReq('POST', { name: 'ghost' }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().removed).toBe(false);
  });
});
