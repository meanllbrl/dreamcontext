/**
 * Session roster generation (AC5, AC8 permission rule): GET returns `generation` (absent = 0);
 * a PUT with a stale `baseGeneration` gets 409 `roster_stale` with the stored surface; a PUT
 * without one is accepted only while nothing was ever merged (generation 0); a PUT keeps the
 * generation; `writeMergedRosterSurface` bumps it; the permission mode is never inherited from
 * the stored file. Plus the cloud's worker-run file I/O (a planted symlink is never followed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleAgentSessionsGet, handleAgentSessionsPut, readRosterSurface, rosterBaseAccepted, writeMergedRosterSurface,
  writeMergedRosterSurfaceAsync, RosterBusyError, type SavedMeta,
} from '../../src/server/routes/agent-sessions.js';
import { acquireFileLock, releaseFileLock } from '../../src/lib/file-lock.js';
import { workerAppendLine, workerReadText, workerWriteAtomic, type WorkerRun } from '../../src/lib/session-titles.js';

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
  it('GET reports 0 for a roster that never went through a Return (and for no file)', async () => {
    expect((await get()).generation).toBe(0);
    writeFileSync(join(contextRoot, 'state', '.agent-sessions.json'), JSON.stringify({ sessions: [tab('A')], chatPermissionMode: 'auto' }));
    expect(await get()).toMatchObject({ generation: 0, sessions: [expect.objectContaining({ title: 'A' })] });
  });

  it('a legacy PUT (no baseGeneration) is accepted at 0, and keeps 0', async () => {
    const r = await put({ sessions: [tab('A')] });
    expect(r).toEqual({ status: 200, body: { ok: true, generation: 0 } });
    expect(readRosterSurface(contextRoot).generation).toBe(0);
  });

  it('writeMergedRosterSurface bumps the generation and stores the merged surface', () => {
    expect(writeMergedRosterSurface(contextRoot, { sessions: [tab('phone tab')], activePane: 0, chatPermissionMode: 'auto' })).toBe(1);
    expect(writeMergedRosterSurface(contextRoot, { sessions: [tab('again')], chatPermissionMode: 'auto' })).toBe(2);
    const s = readRosterSurface(contextRoot);
    expect(s.generation).toBe(2);
    expect(s.sessions.map((m) => m.title)).toEqual(['again']);
  });

  it('after a merge: a legacy PUT and a stale base get 409 roster_stale with the stored surface; the right base is accepted and keeps the generation', async () => {
    writeMergedRosterSurface(contextRoot, { sessions: [tab('from the phone', { sessionId: '11111111-2222-4333-8444-555555555555' })], chatPermissionMode: 'auto' });

    const legacy = await put({ sessions: [tab('pre-trip tab')] });
    expect(legacy.status).toBe(409);
    expect(legacy.body).toMatchObject({ error: 'roster_stale', surface: { generation: 1, chatPermissionMode: 'auto', sessions: [expect.objectContaining({ title: 'from the phone', bound: false })] } });

    const stale = await put({ sessions: [tab('pre-trip tab')], baseGeneration: 0 });
    expect(stale.status).toBe(409);
    expect(readRosterSurface(contextRoot).sessions[0].title).toBe('from the phone');

    const ok = await put({ sessions: [tab('after reload')], baseGeneration: 1 });
    expect(ok).toEqual({ status: 200, body: { ok: true, generation: 1 } });
    expect(await get()).toMatchObject({ generation: 1, sessions: [expect.objectContaining({ title: 'after reload' })] });
  });

  it('the merge writer never blocks: busy lock -> RosterBusyError at once; the async one waits it out', async () => {
    const lock = join(contextRoot, 'state', '.agent-sessions.json.lock');
    expect(acquireFileLock(lock, Date.now(), 10_000)).toBe(true);
    const t0 = Date.now();
    expect(() => writeMergedRosterSurface(contextRoot, { sessions: [], chatPermissionMode: 'auto' })).toThrow(RosterBusyError);
    expect(Date.now() - t0).toBeLessThan(200);
    await expect(writeMergedRosterSurfaceAsync(contextRoot, { sessions: [], chatPermissionMode: 'auto' }, { waitMs: 60 })).rejects.toBeInstanceOf(RosterBusyError);
    // The event loop keeps turning while it waits, and it lands once the lock is released.
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    setTimeout(() => releaseFileLock(lock), 100);
    expect(await writeMergedRosterSurfaceAsync(contextRoot, { sessions: [tab('merged')], chatPermissionMode: 'auto' })).toBe(1);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
    expect(readRosterSurface(contextRoot)).toMatchObject({ generation: 1, sessions: [expect.objectContaining({ title: 'merged' })] });
  });

  it('a roster lock left by a DEAD process is reclaimed at once (PUT and merge), a live owner\'s is not', async () => {
    const lock = join(contextRoot, 'state', '.agent-sessions.json.lock');
    const dead = spawn('/usr/bin/true');
    await new Promise((r) => dead.once('exit', r));
    writeFileSync(lock, JSON.stringify({ pid: dead.pid, at: Date.now() }) + '\n');
    const t0 = Date.now();
    expect(await put({ sessions: [tab('A')] })).toEqual({ status: 200, body: { ok: true, generation: 0 } });
    expect(Date.now() - t0).toBeLessThan(1_000);
    writeFileSync(lock, JSON.stringify({ pid: dead.pid, at: Date.now() }) + '\n');
    expect(writeMergedRosterSurface(contextRoot, { sessions: [], chatPermissionMode: 'auto' })).toBe(1);
    // A live owner (this test's own child) keeps it.
    const live = spawn('/bin/sleep', ['30']);
    try {
      writeFileSync(lock, JSON.stringify({ pid: live.pid, at: Date.now() }) + '\n');
      expect(() => writeMergedRosterSurface(contextRoot, { sessions: [], chatPermissionMode: 'auto' })).toThrow(RosterBusyError);
    } finally {
      live.kill('SIGKILL');
      rmSync(lock, { force: true });
    }
  });

  it('a non-number base is stale (never coerced)', () => {
    expect(rosterBaseAccepted('1', 1)).toBe(false);
    expect(rosterBaseAccepted(1, 1)).toBe(true);
    expect(rosterBaseAccepted(undefined, 0)).toBe(true);
    expect(rosterBaseAccepted(undefined, 3)).toBe(false);
  });

  it('the permission mode is never inherited from the stored file', async () => {
    writeMergedRosterSurface(contextRoot, { sessions: [], chatPermissionMode: 'bypass' });
    expect(readRosterSurface(contextRoot).chatPermissionMode).toBe('bypass');
    // A PUT that does not re-assert it reads as auto, whatever was stored.
    expect((await put({ sessions: [], baseGeneration: 1 })).status).toBe(200);
    expect(readRosterSurface(contextRoot).chatPermissionMode).toBe('auto');
    // And the merge writes exactly what it is given (the laptop's value), never the stored one.
    writeMergedRosterSurface(contextRoot, { sessions: [], chatPermissionMode: 'bypass' });
    writeMergedRosterSurface(contextRoot, { sessions: [], chatPermissionMode: 'nonsense' as never });
    expect(readRosterSurface(contextRoot).chatPermissionMode).toBe('auto');
  });

  it('refuses a non-agent host (403)', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const r = await put({ sessions: [] });
    expect(r.status).toBe(403);
  });
});

describe('cloud roster I/O as the worker', () => {
  /** Runs the worker scripts as this user — the shape of the cloud's `workerRunner`. */
  const localRun: WorkerRun = (cmd, args, opts) => new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    c.stdout.on('data', (d: Buffer) => out.push(d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, stdout: Buffer.concat(out) }));
    // A script may exit before reading stdin (e.g. `[ -f "$1" ] || exit 3`): that EPIPE is
    // expected and the exit code already says why — same as the cloud's own runner.
    c.stdin.on('error', () => {});
    c.stdin.end(opts.input ?? Buffer.alloc(0));
  });

  it('writes atomically and reads back; a planted symlink at the path is replaced, its target untouched', async () => {
    const path = join(contextRoot, 'state', '.agent-sessions.json');
    const target = join(scratch, 'outside.txt');
    writeFileSync(target, 'secret');
    symlinkSync(target, path);
    await workerWriteAtomic(localRun, path, '{"sessions":[]}\n');
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('secret');
    expect(await workerReadText(localRun, path)).toBe('{"sessions":[]}\n');
    expect(await workerReadText(localRun, join(contextRoot, 'absent.json'))).toBeNull();
  });

  it('a failed write leaves no temp file behind (and the old file intact)', async () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'cat'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'cat'), 0o755);
    const failingCat: WorkerRun = (cmd, args, opts) => new Promise((resolve, reject) => {
      const c = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      c.on('error', reject);
      c.on('close', (code) => resolve({ code, stdout: Buffer.alloc(0) }));
      c.stdin.on('error', () => {});
      c.stdin.end(opts.input ?? Buffer.alloc(0));
    });
    const dir = join(contextRoot, 'state');
    const path = join(dir, '.agent-sessions.json');
    writeFileSync(path, 'old\n');
    await expect(workerWriteAtomic(failingCat, path, 'new\n')).rejects.toThrow(/worker write failed/);
    expect(readdirSync(dir)).toEqual(['.agent-sessions.json']);
    expect(readFileSync(path, 'utf-8')).toBe('old\n');
  });

  /** A runner whose sh never gets stdin closed (so `cat` blocks), then is signalled as a group
   *  after 300 ms like the cloud runner's timeout; other commands run normally unless `rmNoop`. */
  function killingRun(sig: NodeJS.Signals, rmNoop: boolean): WorkerRun {
    return (cmd, args, opts) => {
      if (cmd === '/bin/rm' && rmNoop) return Promise.resolve({ code: 0, stdout: Buffer.alloc(0) });
      if (cmd !== '/bin/sh') return localRun(cmd, args, opts);
      return new Promise((resolve) => {
        const c = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
        c.stdin.on('error', () => {});
        setTimeout(() => { try { process.kill(-(c.pid as number), sig); } catch { /* gone */ } }, 300);
        c.on('close', (code) => resolve({ code, stdout: Buffer.alloc(0) }));
      });
    };
  }

  it('a TERM-killed write removes its temp file itself (the trap)', async () => {
    const dir = join(contextRoot, 'state');
    await expect(workerWriteAtomic(killingRun('SIGTERM', true), join(dir, '.agent-sessions.json'), 'x')).rejects.toThrow(/worker write failed/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a SIGKILL-ed write (the runner timeout, no trap runs) is cleaned up by the second worker call', async () => {
    const dir = join(contextRoot, 'state');
    await expect(workerWriteAtomic(killingRun('SIGKILL', false), join(dir, '.agent-sessions.json'), 'x')).rejects.toThrow(/worker write failed/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('appends a title record on a fresh line, and refuses a symlinked transcript', async () => {
    const t = join(scratch, 't.jsonl');
    writeFileSync(t, '{"a":1}');
    expect(await workerAppendLine(localRun, t, '{"type":"custom-title"}\n')).toBe(true);
    expect(readFileSync(t, 'utf-8')).toBe('{"a":1}\n{"type":"custom-title"}\n');
    const link = join(scratch, 'l.jsonl');
    symlinkSync(t, link);
    expect(await workerAppendLine(localRun, link, 'x\n')).toBe(false);
    expect(readFileSync(t, 'utf-8')).toBe('{"a":1}\n{"type":"custom-title"}\n');
  });
});
