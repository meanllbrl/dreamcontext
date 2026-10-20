/**
 * `super end` and `super resume` through the real route (task super-agent-bir-alt-sohbeti-…):
 *
 *  - end parks the child with `end` (the window closes its tab, so no relaunch restores it) via
 *    the ONE park primitive (`parkChat`), then records it ended: card gone, open queue items
 *    done, a done `ended` item (who, when, last brief), out of the event index.
 *  - working / asking / background work refuse it (409, nothing changes); `--force` passes the
 *    owner's word down; the owner's own (adopted) chat needs `--force`; unknown ids are 404.
 *  - `--idle` lists, `--idle --yes` ends the listed ones.
 *  - resume reopens the same conversation through the window with the recorded mode, model and
 *    effort, clears `endedAt` and brings the card back; `send` to an ended child is refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-end-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, superIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperEnd, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { _resetChatParkForTests, registerParkable, type ParkOptions, type ParkOutcome } from '../../src/server/chat-park.js';

let dir: string;
let root: string;
const SUPER = 'sup-1';
const frames: Array<Record<string, unknown>> = [];
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const card = (sid: string) => ({ id: `chat-${sid}`, kind: 'chat' as const, ref: sid, shape: 'tall' as const, place: 'float' as const });

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: {
      c1: { sessionId: 'c1', brief: 'db work', adopted: false, startedAt: 1, mode: 'develop', model: 'haiku', effort: 'low' },
      c2: { sessionId: 'c2', brief: 'docs', adopted: false, startedAt: 2 },
      own: { sessionId: 'own', brief: 'the owner\'s chat', adopted: true, startedAt: 3 },
    },
    containers: [card('c1'), card('c2'), card('own')],
    ...state,
  }));
  token = mintWindowToken({
    send: (frame) => {
      frames.push(frame);
      if (typeof frame.id === 'string') setImmediate(() => deliverSuperResult(token, frame.id, { ok: true, result: { sessionId: 'c1' } }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
  }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-end-'));
  frames.length = 0;
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  _resetChatParkForTests();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  _resetChatParkForTests();
  rmSync(dir, { recursive: true, force: true });
});

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}

/** A running child: registered in the chat registry and as a parkable whose answer we pick. */
function live(sid: string, o: { busy?: boolean; asking?: boolean; background?: number; answer?: ParkOutcome } = {}) {
  const calls: Array<{ reason: string; opts?: ParkOptions }> = [];
  const h: ChatHandle = registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic' });
  registerParkable({
    id: sid, kind: 'chat', projectRoot: dir,
    exempt: () => null, busy: () => !!o.busy, asking: () => !!o.asking,
    backgroundTasks: () => o.background ?? 0, idleSince: () => 0, focusedAt: () => 0,
    park: async (reason, opts) => { calls.push({ reason, opts }); return o.answer ?? 'parked'; },
  });
  return { h, calls };
}

describe('super end', () => {
  it('ends an idle child through the park primitive with `end`, and records it ended', async () => {
    makeVault({ queue: [{ id: 'q-1', sessionId: 'c1', kind: 'idle', state: 'pending', createdAt: 1 }] });
    const c1 = live('c1');
    const r = await verb('end', { children: ['c1'] });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ ended: ['c1'] });
    expect(c1.calls).toEqual([{ reason: 'super-end', opts: { end: true, force: false } }]);
    const s = await readSuperState(root);
    expect(typeof s.children.c1.endedAt).toBe('number');
    expect(s.containers.map((k) => k.ref)).toEqual(['c2', 'own']);
    expect(s.queue.find((q) => q.id === 'q-1')?.state).toBe('done');
    expect(s.queue.find((q) => q.kind === 'ended')).toMatchObject({ sessionId: 'c1', state: 'done', brief: 'db work' });
    // Out of the event index: no idle/gone turn will ever be queued for it.
    expect(superIndex(root).children.has('c1')).toBe(false);
    expect(superIndex(root).children.has('c2')).toBe(true);
  });

  it.each([
    [{ busy: true }, 'busy'],
    [{ asking: true }, 'asking'],
  ] as const)('refuses a child that is %o (409 %s) and changes nothing', async (o, reason) => {
    makeVault();
    const c1 = live('c1', o);
    const r = await verb('end', { children: ['c1'] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(reason);
    expect(c1.calls).toEqual([]);
    expect((await readSuperState(root)).children.c1.endedAt).toBeUndefined();
  });

  it('names the background work that would die', async () => {
    makeVault();
    live('c1', { background: 2 });
    const r = await verb('end', { children: ['c1'] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'background', background: 2 });
    expect(String(r.json.message)).toMatch(/2 background tasks/);
  });

  it('a window refusal (the owner is in that tab) is a 409 with its reason', async () => {
    makeVault();
    live('c1', { answer: 'focused' });
    const r = await verb('end', { children: ['c1'] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('focused');
    expect((await readSuperState(root)).children.c1.endedAt).toBeUndefined();
  });

  it('--force passes the owner\'s word down: a working child is ended', async () => {
    makeVault();
    const c1 = live('c1', { busy: true });
    const r = await verb('end', { children: ['c1'], force: true });
    expect(r.status).toBe(200);
    expect(c1.calls).toEqual([{ reason: 'super-end', opts: { end: true, force: true } }]);
  });

  it('the owner\'s own chat needs --force; unknown ids and the super itself are 404', async () => {
    makeVault();
    const own = live('own');
    const r = await verb('end', { children: ['own'] });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('adopted');
    expect(own.calls).toEqual([]);
    expect((await verb('end', { children: ['own'], force: true })).status).toBe(200);
    expect((await verb('end', { children: ['nope'] })).status).toBe(404);
    expect((await verb('end', { children: [SUPER] })).status).toBe(404);
    expect((await verb('end', { children: ['__proto__'] })).status).toBe(404);
  });

  it('a child with no process is recorded ended without a park', async () => {
    makeVault();
    const r = await verb('end', { children: ['c2'] });
    expect(r.status).toBe(200);
    expect((await readSuperState(root)).children.c2.endedAt).toBeTypeOf('number');
  });

  it('--idle lists the children you started (never the owner\'s), --idle --yes ends them', async () => {
    makeVault();
    const list = await verb('end', { idle: true });
    expect(list.status).toBe(200);
    const result = list.json.result as { idle: Array<{ child: string }>; ownersChats: Array<{ child: string }> };
    expect(result.idle.map((x) => x.child).sort()).toEqual(['c1', 'c2']);
    expect(result.ownersChats.map((x) => x.child)).toEqual(['own']);
    expect((await readSuperState(root)).children.c1.endedAt).toBeUndefined();
    const done = await verb('end', { idle: true, yes: true });
    expect((done.json.result as { ended: string[] }).ended.sort()).toEqual(['c1', 'c2']);
    expect((await readSuperState(root)).children.own.endedAt).toBeUndefined();
  });

  it('super state shows an ended child as ended', async () => {
    makeVault();
    await verb('end', { children: ['c2'] });
    const st = await verb('state', {});
    const row = (st.json.result as { status: Array<{ sessionId: string; status: string }> }).status.find((x) => x.sessionId === 'c2');
    expect(row?.status).toBe('ended');
  });
});

describe('super resume', () => {
  function transcript(sid: string): void {
    const proj = join(process.env.HOME as string, '.claude', 'projects', 'acme');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${sid}.jsonl`), '{}\n');
  }

  it('reopens an ended child through the window with its recorded mode, model and effort', async () => {
    makeVault();
    transcript('c1');
    await verb('end', { children: ['c1'] });
    frames.length = 0;
    const r = await verb('resume', { child: 'c1' });
    expect(r.status).toBe(200);
    const cmd = frames.find((f) => f.subtype === 'super_command');
    expect(cmd).toMatchObject({ verb: 'resume', args: { child: 'c1', mode: 'develop', model: 'haiku', effort: 'low', title: 'db work' } });
    const s = await readSuperState(root);
    expect(s.children.c1.endedAt).toBeUndefined();
    expect(s.containers.some((k) => k.kind === 'chat' && k.ref === 'c1')).toBe(true);
  });

  it('refuses a child with no transcript, and an unknown child', async () => {
    makeVault();
    await verb('end', { children: ['c2'] });
    expect((await verb('resume', { child: 'c2' })).json.error).toBe('no_transcript');
    expect((await verb('resume', { child: 'nope' })).status).toBe(404);
  });

  it('send to an ended child is refused with the way back', async () => {
    makeVault();
    await verb('end', { children: ['c2'] });
    const r = await verb('send', { child: 'c2', text: 'hi' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('ended');
    expect(String(r.json.message)).toMatch(/super resume/);
  });
});

describe('the owner ends a child from its card (POST /api/super/end)', () => {
  async function ownerEnd(child: string) {
    const r = res();
    await handleSuperEnd(req({ child }, { origin: 'http://127.0.0.1:4173' }), r, {}, root);
    return r;
  }

  it('records it ended like `super end` (his window already closed the tab), even his own chat', async () => {
    makeVault();
    const r = await ownerEnd('own');
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.children.own.endedAt).toBeTypeOf('number');
    expect(s.containers.some((k) => k.ref === 'own')).toBe(false);
    expect(s.queue.find((q) => q.kind === 'ended')).toMatchObject({ sessionId: 'own', brief: 'the owner\'s chat' });
  });

  it('an unknown id or the super itself is 404; outside the desktop app it is 403', async () => {
    makeVault();
    expect((await ownerEnd('nope')).status).toBe(404);
    expect((await ownerEnd(SUPER)).status).toBe(404);
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await ownerEnd('c1')).status).toBe(403);
  });
});
