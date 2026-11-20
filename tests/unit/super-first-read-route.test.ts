/**
 * The first-read start (plan ilk-acilis C15, S1): each refusal writes nothing and keeps the offer;
 * a start writes the claim exactly where the child's start is recorded; a first read is never
 * pooled; the routes refuse anything but the owner's window with the shell's key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-first-read-home-`);
});

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { resetCapacityForTests } from '../../src/lib/super/capacity.js';
import {
  _setDelegateWaitsForTests, handleSuperFirstReadGet, handleSuperFirstReadPost, setFirstReadDepsForTests, startFirstRead, usageLimitedNow,
} from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { _setOpenLogHomeForTests } from '../../src/lib/window-open-log.js';
import { firstReadLockHeld, releaseFirstReadLock, takeFirstReadLock } from '../../src/lib/super/delegating.js';
import { readFirstReadClaim, FIRST_READ_PROMPT } from '../../src/lib/first-read.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';

const KEY = 'first-read-owner-key-0123456789abcdefghij';
const until = async (cond: () => Promise<boolean> | boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('condition never held');
};

describe('usageLimitedNow', () => {
  const now = 1_000_000_000;
  it('limited only by a fresh window at 100% or locked, not yet reset', () => {
    expect(usageLimitedNow({ fetchedAtMs: now - 1000, limits: [{ percent: 100, resetsAt: now + 1 } as never] }, now)).toBe(true);
    expect(usageLimitedNow({ fetchedAtMs: now - 1000, limits: [{ percent: 40, resetsAt: now + 1, lockedReason: 'x' } as never] }, now)).toBe(true);
    expect(usageLimitedNow({ fetchedAtMs: now - 1000, limits: [{ percent: 100, resetsAt: now - 1 } as never] }, now)).toBe(false);
    expect(usageLimitedNow({ fetchedAtMs: now - 2 * 60 * 60_000, limits: [{ percent: 100, resetsAt: now + 1 } as never] }, now)).toBe(false);
    expect(usageLimitedNow({ fetchedAtMs: null, limits: [] }, now)).toBe(false);
  });
});

describe('startFirstRead', () => {
  let dir: string;
  let root: string;
  let token = '';
  const frames: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-first-read-'));
    root = join(dir, 'Orbit', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    frames.length = 0;
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    resetCapacityForTests();
    _setDelegateWaitsForTests({ answerMs: 60, graceMs: 10, lateMs: 300 });
    _setOpenLogHomeForTests(dir);
    // A quiet Super that was never sent anything still holds its window token (minted at spawn).
    token = mintWindowToken({ send: (f) => { frames.push(f); return true; }, vault: 'Orbit', contextRoot: root, sessionId: 'sup-1', mode: 'super' }).token;
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true }));
    setFirstReadDepsForTests({ eligible: () => true, claudeReady: async () => true, usage: () => ({ fetchedAtMs: null, limits: [] }), now: Date.now });
  });
  afterEach(() => {
    releaseFirstReadLock(root);
    setFirstReadDepsForTests(null);
    _setDelegateWaitsForTests(null);
    _setOpenLogHomeForTests(null);
    resetWindowControl();
    rmSync(dir, { recursive: true, force: true });
  });

  const commands = () => frames.filter((f) => f.subtype === 'super_command');
  const project = () => join(dir, 'Orbit');
  const answer = (sessionId: string) => {
    const id = commands()[0].id;
    setTimeout(() => deliverSuperResult(token, id, { ok: true, result: { sessionId, got: Date.now() } }), 5);
  };
  async function nothingWritten() {
    expect(readFirstReadClaim(project())).toBeNull();
    expect(firstReadLockHeld(root)).toBe(false);
    expect((await readSuperState(root)).pool).toEqual([]);
  }

  it('starts the read with the fixed prompt, Opus and medium, and writes the claim at the start', async () => {
    const p = startFirstRead(root);
    await until(() => commands().length === 1);
    const args = commands()[0].args as Record<string, unknown>;
    // Server text only (S4): the delegate core's own preamble, then the fixed prompt.
    expect(String(args.prompt).endsWith(FIRST_READ_PROMPT)).toBe(true);
    expect(args).toMatchObject({ model: 'opus', effort: 'medium', title: 'Reading Orbit' });
    // The first-read ticket rides the frame's crew field: the server decides the spawn (C15a).
    expect(typeof args.crewTicket).toBe('string');
    answer('read-1');
    const r = await p;
    expect(r).toMatchObject({ ok: true, child: 'read-1' });
    expect(readFirstReadClaim(project())?.job).toBe('read-1');
    expect((await readSuperState(root)).children['read-1']).toMatchObject({ firstRead: true });
    expect(firstReadLockHeld(root)).toBe(false);
  });

  it('each refusal writes nothing and names its reason', async () => {
    setFirstReadDepsForTests({ eligible: () => false });
    expect(await startFirstRead(root)).toMatchObject({ ok: false, error: 'not_eligible' });
    setFirstReadDepsForTests({ eligible: () => true, claudeReady: async () => false });
    expect(await startFirstRead(root)).toMatchObject({ ok: false, error: 'claude_not_ready' });
    setFirstReadDepsForTests({ eligible: () => true, claudeReady: async () => true, usage: () => ({ fetchedAtMs: Date.now(), limits: [{ percent: 100, resetsAt: Date.now() + 60_000 } as never] }) });
    expect(await startFirstRead(root)).toMatchObject({ ok: false, error: 'limited' });
    setFirstReadDepsForTests({ eligible: () => true, claudeReady: async () => true, usage: () => ({ fetchedAtMs: null, limits: [] }) });
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: false }));
    resetSuperIndex();
    expect(await startFirstRead(root)).toMatchObject({ ok: false, error: 'super_off' });
    expect(commands()).toHaveLength(0);
    await nothingWritten();
  });

  it('a read in flight refuses a second one (a live first-read child, or the lock)', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-1', enabled: true,
      children: { 'read-0': { sessionId: 'read-0', brief: 'Reading Orbit', adopted: false, startedAt: 1, row: 'working', firstRead: true } },
    }));
    resetSuperIndex();
    expect(await startFirstRead(root)).toMatchObject({ ok: false, error: 'in_flight' });
    expect(commands()).toHaveLength(0);
  });

  it('works again once the cause clears (limit lifted)', async () => {
    setFirstReadDepsForTests({ eligible: () => true, claudeReady: async () => true, usage: () => ({ fetchedAtMs: Date.now(), limits: [{ percent: 100, resetsAt: Date.now() + 60_000 } as never] }) });
    expect(await startFirstRead(root)).toMatchObject({ ok: false, error: 'limited' });
    setFirstReadDepsForTests({ eligible: () => true, claudeReady: async () => true, usage: () => ({ fetchedAtMs: null, limits: [] }) });
    const p = startFirstRead(root);
    await until(() => commands().length === 1);
    answer('read-2');
    expect(await p).toMatchObject({ ok: true });
    expect(readFirstReadClaim(project())?.job).toBe('read-2');
  });

  it('a window refusal writes nothing, is never pooled, and releases the lock', async () => {
    const p = startFirstRead(root);
    await until(() => commands().length === 1);
    deliverSuperResult(token, commands()[0].id, { ok: false, error: 'tabs_full' });
    const r = await p;
    expect(r.ok).toBe(false);
    await nothingWritten();
  });

  it('no answer in time: unconfirmed keeps the lock; a late landing still writes the claim', async () => {
    const p = startFirstRead(root);
    await until(() => commands().length === 1);
    const r = await p;
    expect(r.ok === true ? r.pending : r.error).toBeTruthy();
    expect(firstReadLockHeld(root)).toBe(true);
    // A second press meanwhile cannot start another read.
    expect(await startFirstRead(root)).toMatchObject({ ok: false, error: 'in_flight' });
    deliverSuperResult(token, commands()[0].id, { ok: true, result: { sessionId: 'read-late', got: Date.now() } });
    await until(() => readFirstReadClaim(project()) !== null);
    expect(readFirstReadClaim(project())?.job).toBe('read-late');
    expect(firstReadLockHeld(root)).toBe(false);
    expect((await readSuperState(root)).pool).toEqual([]);
  });
});

describe('first-read routes (S1)', () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-first-read-r-'));
    root = join(dir, 'Orbit', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    process.env.DREAMCONTEXT_DESKTOP = '1';
    setOwnerKey(KEY);
    setFirstReadDepsForTests({ eligible: () => true });
  });
  afterEach(() => {
    setOwnerKey(null);
    setFirstReadDepsForTests(null);
    delete process.env.DREAMCONTEXT_DESKTOP;
    rmSync(dir, { recursive: true, force: true });
  });

  function req(headers: Record<string, string>): IncomingMessage {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(); });
    return r;
  }
  function res() {
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { setHeader: () => void }).setHeader = () => {};
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    return out;
  }

  it('GET answers only {pending, starting} to the owner window with the key', async () => {
    const out = res();
    await handleSuperFirstReadGet(req({ [OWNER_KEY_HEADER]: KEY }), out, {}, root);
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ pending: true, starting: false });
    // A start in flight (the lock): the window keeps "Reading started" instead of re-offering.
    expect(takeFirstReadLock(root, 60_000)).toBe(true);
    const held = res();
    await handleSuperFirstReadGet(req({ [OWNER_KEY_HEADER]: KEY }), held, {}, root);
    expect(held.json).toEqual({ pending: true, starting: true });
    releaseFirstReadLock(root);
  });

  it('refuses no key (a local curl), a cross-site Origin and another loopback port, for GET and POST', async () => {
    const bad = [
      {},
      { [OWNER_KEY_HEADER]: 'nope' },
      { [OWNER_KEY_HEADER]: KEY, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { [OWNER_KEY_HEADER]: KEY, origin: 'http://127.0.0.1:5173' },
    ];
    for (const h of bad) {
      const g = res();
      await handleSuperFirstReadGet(req(h), g, {}, root);
      expect(g.status, `GET ${JSON.stringify(h)}`).toBe(403);
      expect(JSON.stringify(g.json)).not.toContain(dir);
      const p = res();
      await handleSuperFirstReadPost(req(h), p, {}, root);
      expect(p.status, `POST ${JSON.stringify(h)}`).toBe(403);
    }
    expect(existsSync(join(root, 'state', '.config.json')) ? readFileSync(join(root, 'state', '.config.json'), 'utf-8') : '').not.toContain('firstRead');
  });
});
