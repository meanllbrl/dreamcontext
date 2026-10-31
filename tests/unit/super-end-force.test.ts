/**
 * `super end` answers `ended` only once the child's process is gone. Field 2026-10-31: a forced
 * end closed the tab, the closed socket only DRAINED the child (stdin EOF, SIGTERM five minutes
 * later), so a running `claude -p` kept editing its worktree while `super end` answered `ended`
 * twice and the row went done.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-succ-home-`);
});

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { cutProcessGroups } from '../../src/lib/automations/runner.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, containerIdFor } from '../../src/lib/super/inbox.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { _resetChatParkForTests, registerParkable, type ParkOutcome } from '../../src/server/chat-park.js';
import { markLiveChatDraining, registerLiveChat, stopLiveChat, unregisterLiveChat, type LiveChatEntry } from '../../src/server/routes/agent-chat-live.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';

const entries: LiveChatEntry[] = [];

function entry(sid: string, cut?: () => Promise<void>): LiveChatEntry {
  const e: LiveChatEntry = {
    conversationId: sid, projectRoot: '/p', busy: true, turnStartedAt: 1, lastTurnEndedAt: null,
    adopt: () => false, supersede: () => () => undefined, ...(cut ? { cut } : {}),
  };
  entries.push(e);
  registerLiveChat(e);
  return e;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('stopLiveChat', () => {
  afterEach(() => { for (const e of entries.splice(0)) unregisterLiveChat(e); });

  it('kills a real process that keeps working past stdin EOF, and answers once it is gone', async () => {
    const proc = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const pid = proc.pid!;
    const exited = new Promise<void>((r) => proc.once('close', () => r()));
    proc.stdin!.end();   // the drain: EOF, and it works on regardless
    const e = entry('real', async () => { await cutProcessGroups([pid], 2000); await exited; });
    proc.once('close', () => unregisterLiveChat(e));
    markLiveChatDraining(e);
    expect(alive(pid)).toBe(true);
    expect(await stopLiveChat('real')).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('answers true when nothing runs that conversation', async () => {
    expect(await stopLiveChat('nobody')).toBe(true);
  });

  it('a child that leaves within the grace is never cut', async () => {
    const cut = vi.fn(async () => undefined);
    const e = entry('leaves', cut);
    setTimeout(() => unregisterLiveChat(e), 10);
    expect(await stopLiveChat('leaves', { graceMs: 2000 })).toBe(true);
    expect(cut).not.toHaveBeenCalled();
  });

  it('answers false when the cut never finishes', async () => {
    entry('stuck', () => new Promise<void>(() => undefined));
    expect(await stopLiveChat('stuck', { timeoutMs: 20 })).toBe(false);
  });

  it('answers false when the cut returns but the child is still registered', async () => {
    entry('survivor', async () => undefined);
    expect(await stopLiveChat('survivor')).toBe(false);
  });
});

describe('super end waits for the process', () => {
  let dir: string;
  let root: string;
  let token: string;
  const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

  function req(body: unknown): IncomingMessage {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
    return r;
  }
  async function end(body: Record<string, unknown>) {
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    await handleSuperVerb(req(body), out, { verb: 'end' });
    return out;
  }
  /** A working child. `parked` does what the real park does: off the park list, draining. */
  function working(sid: string, answer: ParkOutcome, cut: () => Promise<void>) {
    const chat = registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic' });
    const e = entry(sid, cut);
    const off = registerParkable({
      id: sid, kind: 'chat', projectRoot: dir,
      exempt: () => null, busy: () => true, asking: () => false,
      backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0,
      park: async () => {
        if (answer === 'parked') { off(); markLiveChatDraining(e); }
        return answer;
      },
    });
    return { gone: () => { unregisterLiveChat(e); chat.exited(); } };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-succ-'));
    _resetChatRegistry(); resetSuperIndex(); _resetSuperInbox(); resetWindowControl(); _resetChatParkForTests();
    process.env.DREAMCONTEXT_DESKTOP = '1';
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    const child = { sessionId: 'c1', brief: 'c1 work', adopted: false, startedAt: 1 };
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-1', enabled: true, children: { c1: child },
      containers: [{ id: containerIdFor('chat', 'c1'), kind: 'chat', ref: 'c1', shape: 'tall', place: 'float' }],
    }));
    token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super' }).token;
  });
  afterEach(() => {
    for (const e of entries.splice(0)) unregisterLiveChat(e);
    if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
    rmSync(dir, { recursive: true, force: true });
  });

  it('--force on a working child cuts it and says ended only after it exited', async () => {
    let finishCut: () => void = () => undefined;
    const cut = vi.fn(() => new Promise<void>((r) => { finishCut = r; }));
    const c = working('c1', 'parked', cut);
    let answered = false;
    const pending = end({ children: ['c1'], force: true }).then((r) => { answered = true; return r; });
    await vi.waitFor(() => expect(cut).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(answered).toBe(false);
    expect((await readSuperState(root)).children.c1.endedAt).toBeUndefined();
    c.gone();
    finishCut();
    const r = await pending;
    expect(r.json.result ?? r.json).toMatchObject({ ended: ['c1'], refused: [] });
    expect((await readSuperState(root)).children.c1.endedAt).toBeTypeOf('number');
  });

  it('a second end of a child still draining cuts it too, not `already`', async () => {
    const chat = registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    const cut = vi.fn(async () => { unregisterLiveChat(e); chat.exited(); });
    const e = entry('c1', cut);
    markLiveChatDraining(e);   // the first end closed the tab: no parkable is left
    const r = await end({ children: ['c1'], force: true });
    expect(r.json.result ?? r.json).toMatchObject({ ended: ['c1'] });
    expect(cut).toHaveBeenCalledTimes(1);
  });

  it('--force stops a child whose window never answered', async () => {
    const c = working('c1', 'no_answer', async () => { c.gone(); });
    const r = await end({ children: ['c1'], force: true });
    expect(r.json.result ?? r.json).toMatchObject({ ended: ['c1'] });
  });

  it('without --force an unanswered window keeps the child alive and unended', async () => {
    const chat = registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    const cut = vi.fn(async () => undefined);
    entry('c1', cut);
    registerParkable({
      id: 'c1', kind: 'chat', projectRoot: dir,
      exempt: () => null, busy: () => false, asking: () => false,
      backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0,
      park: async () => 'no_answer',
    });
    const r = await end({ children: ['c1'] });
    expect(r.status).toBe(409);
    expect(cut).not.toHaveBeenCalled();
    chat.exited();
  });

  it('a window refusal under --force is still a refusal (a phone holds it)', async () => {
    const cut = vi.fn(async () => undefined);
    working('c1', 'refused', cut);
    const r = await end({ children: ['c1'], force: true });
    expect(r.status).toBe(409);
    expect(cut).not.toHaveBeenCalled();
    expect((await readSuperState(root)).children.c1.endedAt).toBeUndefined();
  });

  it('a survivor refuses `still_running` and the row stays open', async () => {
    working('c1', 'parked', async () => undefined);
    const r = await end({ children: ['c1'], force: true });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.json)).toContain('still_running');
    expect((await readSuperState(root)).children.c1.endedAt).toBeUndefined();
  });
});
