/**
 * Session roster generation: GET returns `generation` (absent = 0); a PUT with a stale
 * `baseGeneration` gets 409 `roster_stale` with the stored surface; a PUT without one is
 * accepted only at generation 0; a PUT keeps the generation; the permission mode is never
 * inherited from the stored file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleAgentSessionsGet, handleAgentSessionsPut, rosterBaseAccepted, type SavedMeta,
} from '../../src/server/routes/agent-sessions.js';

let scratch: string;
let home: string;
let contextRoot: string;
const realDesktop = process.env.DREAMCONTEXT_DESKTOP;

const tab = (title: string, over: Partial<SavedMeta> = {}): SavedMeta => ({ title, bypass: false, minimized: false, size: 1, ...over });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hf-roster-gen-'));
  home = join(scratch, 'home');
  contextRoot = join(scratch, 'proj', '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
  else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
});

function res(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let code = 0;
  let body: Record<string, unknown> = {};
  const r = {
    writeHead(c: number) { code = c; }, setHeader() {},
    end(d: string) { body = JSON.parse(d); },
  } as unknown as ServerResponse;
  return { res: r, status: () => code, body: () => body };
}

function putReq(body: unknown): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(r, { method: 'PUT', headers: { 'content-type': 'application/json' } });
  return r;
}

async function get(): Promise<Record<string, unknown>> {
  const r = res();
  await handleAgentSessionsGet({} as IncomingMessage, r.res, {}, contextRoot, home);
  expect(r.status()).toBe(200);
  return r.body();
}

async function put(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = res();
  await handleAgentSessionsPut(putReq(body), r.res, {}, contextRoot, home);
  return { status: r.status(), body: r.body() };
}

describe('roster generation', () => {
  const file = () => join(contextRoot, 'state', '.agent-sessions.json');
  /** A stored roster at `generation` (what an older build's merge left on disk). */
  const store = (generation: number, sessions: SavedMeta[], chatPermissionMode = 'auto') =>
    writeFileSync(file(), JSON.stringify({ sessions, chatPermissionMode, generation }));
  const stored = () => JSON.parse(readFileSync(file(), 'utf-8')) as { generation?: number; sessions: SavedMeta[]; chatPermissionMode: string };

  it('GET reports 0 for a roster without a generation (and for no file)', async () => {
    expect((await get()).generation).toBe(0);
    writeFileSync(file(), JSON.stringify({ sessions: [tab('A')], chatPermissionMode: 'auto' }));
    expect(await get()).toMatchObject({ generation: 0, sessions: [expect.objectContaining({ title: 'A' })] });
  });

  it('a legacy PUT (no baseGeneration) is accepted at 0, and keeps 0', async () => {
    const r = await put({ sessions: [tab('A')] });
    expect(r).toEqual({ status: 200, body: { ok: true, generation: 0 } });
    expect(stored().generation ?? 0).toBe(0);
  });

  it('above 0: a legacy PUT and a stale base get 409 roster_stale with the stored surface; the right base is accepted and keeps the generation', async () => {
    store(1, [tab('stored tab', { sessionId: '11111111-2222-4333-8444-555555555555' })]);

    const legacy = await put({ sessions: [tab('old tab')] });
    expect(legacy.status).toBe(409);
    expect(legacy.body).toMatchObject({ error: 'roster_stale', surface: { generation: 1, chatPermissionMode: 'auto', sessions: [expect.objectContaining({ title: 'stored tab', bound: false })] } });

    const stale = await put({ sessions: [tab('old tab')], baseGeneration: 0 });
    expect(stale.status).toBe(409);
    expect(stored().sessions[0].title).toBe('stored tab');

    const ok = await put({ sessions: [tab('after reload')], baseGeneration: 1 });
    expect(ok).toEqual({ status: 200, body: { ok: true, generation: 1 } });
    expect(await get()).toMatchObject({ generation: 1, sessions: [expect.objectContaining({ title: 'after reload' })] });
  });

  it('a roster lock left by a DEAD process is reclaimed at once', async () => {
    const lock = join(contextRoot, 'state', '.agent-sessions.json.lock');
    const dead = spawn('/usr/bin/true');
    await new Promise((r) => dead.once('exit', r));
    writeFileSync(lock, JSON.stringify({ pid: dead.pid, at: Date.now() }) + '\n');
    const t0 = Date.now();
    expect(await put({ sessions: [tab('A')] })).toEqual({ status: 200, body: { ok: true, generation: 0 } });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a non-number base is stale (never coerced)', () => {
    expect(rosterBaseAccepted('1', 1)).toBe(false);
    expect(rosterBaseAccepted(1, 1)).toBe(true);
    expect(rosterBaseAccepted(undefined, 0)).toBe(true);
    expect(rosterBaseAccepted(undefined, 3)).toBe(false);
  });

  it('the permission mode is never inherited from the stored file', async () => {
    store(1, [], 'bypass');
    // A PUT that does not re-assert it reads as auto, whatever was stored.
    expect((await put({ sessions: [], baseGeneration: 1 })).status).toBe(200);
    expect(stored().chatPermissionMode).toBe('auto');
  });

  it('refuses a non-agent host (403)', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const r = await put({ sessions: [] });
    expect(r.status).toBe(403);
  });
});
