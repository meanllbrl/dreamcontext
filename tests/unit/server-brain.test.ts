import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleBrainStatus,
  handleBrainDiscover,
  handleBrainCreate,
  handleBrainAttach,
  handleBrainSync,
  handleBrainSettingsGet,
  handleBrainSettingsPost,
  handleBrainTeamUpdates,
} from '../../src/server/routes/brain.js';
import { addVault } from '../../src/lib/vaults.js';
import { readSetupConfig, writeBrainLocal } from '../../src/lib/setup-config.js';

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

/** Register a vault with an optional brainRepo config; returns its _dream_context path. */
function makeVault(name: string, brainRepo?: Record<string, unknown>): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  const config: Record<string, unknown> = { platforms: [], packs: [], multiProduct: false, setupVersion: '1', disableNativeMemory: true };
  if (brainRepo) config.brainRepo = brainRepo;
  writeFileSync(join(projectRoot, '_dream_context', 'state', '.config.json'), JSON.stringify(config), 'utf-8');
  addVault(name, projectRoot);
  return join(projectRoot, '_dream_context');
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `dc-brainroute-home-${stamp}`);
  base = join(tmpdir(), `dc-brainroute-base-${stamp}`);
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

describe('brain routes — desktop gate', () => {
  it('403s when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(403);
  });
});

describe('brain routes — status', () => {
  it('reports resolved enabled/source/mode and hasRemote:false for a fresh vault', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainStatus(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().mode).toBe('in-tree');
    expect(body().hasRemote).toBe(false);
    expect(body().source).toBe('derived-unconnected');
    expect(body().enabled).toBe(false);
  });
});

describe('brain routes — create (B4 gate)', () => {
  it('400s when name is missing', async () => {
    const ctx = makeVault('cur');
    const { res, status } = makeRes();
    await handleBrainCreate(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(400);
  });

  it('400s confirmation_required for a PUBLIC create without confirmation (before any network)', async () => {
    const ctx = makeVault('cur');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { res, status, body } = makeRes();
    await handleBrainCreate(makeReq('POST', { name: 'brain', public: true }), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('confirmation_required');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('brain routes — discover (B3 auth)', () => {
  it('400s auth_required when no token is available', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainDiscover(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(400);
    expect(body().error).toBe('auth_required');
  });
});

describe('brain routes — attach (B5 trust gate)', () => {
  it('refuses (ok:false) without confirmation', async () => {
    const ctx = makeVault('cur');
    const { res, status, body } = makeRes();
    await handleBrainAttach(makeReq('POST', { url: 'https://github.com/acme/brain.git', confirmed: false }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().ok).toBe(false);
    expect(body().reason).toMatch(/confirmation/i);
  });
});

describe('brain routes — sync', () => {
  it('returns action:disabled for an unconnected vault (no push, no network)', async () => {
    const ctx = makeVault('cur');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { res, status, body } = makeRes();
    await handleBrainSync(makeReq('POST', {}), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().action).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('brain routes — settings (SW2 master switch)', () => {
  it('GET reports resolved state + source', async () => {
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git' });
    const { res, status, body } = makeRes();
    await handleBrainSettingsGet(makeReq('GET'), res, {}, ctx);
    expect(status()).toBe(200);
    // A configured remote makes the derived default ON.
    expect(body().enabled).toBe(true);
    expect(body().source).toBe('derived-github-connected');
    expect(body().mode).toBe('separate');
  });

  it('POST persists via updateSetupConfig spread — mode/remote preserved, source flips to explicit', async () => {
    const projectRoot = join(base, 'cur');
    const ctx = makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git' });
    const { res, status, body } = makeRes();
    await handleBrainSettingsPost(makeReq('POST', { enabled: false }), res, {}, ctx);
    expect(status()).toBe(200);
    expect(body().enabled).toBe(false);
    expect(body().source).toBe('explicit');
    // The spread preserved the pre-existing brainRepo fields (updateSetupConfig
    // replaces brainRepo wholesale, so a naive patch would have dropped them).
    const config = readSetupConfig(projectRoot);
    expect(config?.brainRepo?.mode).toBe('separate');
    expect(config?.brainRepo?.remote).toBe('https://github.com/acme/brain.git');
    expect(config?.brainRepo?.enabled).toBe(false);
  });
});

describe('brain routes — team/updates (B6 cache-only)', () => {
  it('reads pulledUpdates from brain-local with ZERO network calls', async () => {
    const projectRoot = join(base, 'cur');
    makeVault('cur', { mode: 'separate', remote: 'https://github.com/acme/brain.git' });
    writeBrainLocal(projectRoot, { pulledUpdates: 3, pendingAgentMerge: true });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { res, status, body } = makeRes();
    await handleBrainTeamUpdates(makeReq('GET'), res);
    expect(status()).toBe(200);
    const cur = body().vaults.find((v: any) => v.name === 'cur');
    expect(cur.updates).toBe(3);
    expect(cur.pendingAgentMerge).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
