/**
 * One job, one owner (task bir-isin-tek-sahibi-olur-…): `super delegate --succeeds <old>` passes
 * the old child's card, brief and task to the successor and ends the old child (told to stop
 * first when busy); `super state` warns about a succeeded child still running and two live
 * children on one task.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-succ-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, containerIdFor } from '../../src/lib/super/inbox.js';
import { SUCCESSOR_STOP_TEXT, ownershipWarnings, succeedChild } from '../../src/lib/super/succession.js';
import { endSucceededChild, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { _resetChatParkForTests, registerParkable, type ParkOutcome } from '../../src/server/chat-park.js';

const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: `${sid} work`, adopted: false, startedAt: 1, ...extra });
const card = (sid: string) => ({ id: containerIdFor('chat', sid), kind: 'chat' as const, ref: sid, shape: 'tall' as const, place: 'float' as const });

describe('succeedChild (pure)', () => {
  function state(): SuperState {
    return {
      ...emptySuperState(), session: 'sup', enabled: true,
      children: { old: child('old', { task: 'ship-it' }) as SuperState['children'][string], nw: child('nw', { brief: '' }) },
      containers: [card('old'), card('other'), card('nw')],
      groups: [{ id: 'grp-a', name: 'a', cards: [card('old').id, card('other').id], place: 'float' }],
      view: { mode: 'half', card: card('old').id },
    };
  }

  it('moves the card (place, group, view slot), the brief and the task to the successor', () => {
    const s = state();
    const id = succeedChild(s, 'old', 'nw');
    expect(id).toBe(containerIdFor('chat', 'nw'));
    expect(s.containers.map((k) => k.ref)).toEqual(['nw', 'other']);
    expect(s.groups[0].cards).toEqual([id, card('other').id]);
    expect(s.view.card).toBe(id);
    expect(s.children.nw.brief).toBe('old work');
    expect((s.children.nw as { task?: string }).task).toBe('ship-it');
    expect(s.children.old.succeededBy).toBe('nw');
  });

  it('the worktree and branch pass on, so clean never takes a tree the successor works in', () => {
    const s = state();
    s.children.old.worktree = '/w/app-super-x';
    s.children.old.branch = 'super/x';
    succeedChild(s, 'old', 'nw');
    expect(s.children.nw).toMatchObject({ worktree: '/w/app-super-x', branch: 'super/x' });
  });

  it('a brief given to the successor wins and titles the card', () => {
    const s = state();
    succeedChild(s, 'old', 'nw', { brief: 'continue ship-it' });
    expect(s.containers[0].title).toBe('continue ship-it');
    expect(s.children.nw.brief).toBe('');
  });

  it('no card on the old child: null, so the caller makes one', () => {
    const s = state();
    s.containers = [];
    expect(succeedChild(s, 'old', 'nw')).toBeNull();
    expect(s.children.old.succeededBy).toBe('nw');
  });
});

describe('ownershipWarnings', () => {
  it('two live children on one task, and a succeeded child still running', () => {
    const s = {
      children: {
        a: child('a', { task: 't1' }), b: child('b', { task: 't1' }), c: child('c', { task: 't2' }),
        d: child('d', { succeededBy: 'c' }), e: child('e', { task: 't1' }),
      },
    } as unknown as SuperState;
    const w = ownershipWarnings(s, (sid) => sid !== 'e');
    expect(w).toEqual([
      expect.objectContaining({ kind: 'succeeded-still-live', child: 'd', by: 'c' }),
      expect.objectContaining({ kind: 'same-task', task: 't1', children: ['a', 'b'] }),
    ]);
  });

  it('nothing to say: no warnings', () => {
    expect(ownershipWarnings({ children: { a: child('a', { task: 't1' }) } } as unknown as SuperState, () => true)).toEqual([]);
  });
});

// ── Through the real route ──────────────────────────────────────────────────────────

let dir: string;
let root: string;
let token = '';
const frames: Array<Record<string, unknown>> = [];
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function makeVault(): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: 'sup-1', enabled: true,
    children: { c1: child('c1'), c2: child('c2') },
    containers: [card('c1'), card('c2')],
  }));
  token = mintWindowToken({
    send: (frame) => {
      frames.push(frame);
      const id = frame.id;
      if (frame.subtype === 'super_command') setImmediate(() => deliverSuperResult(token, id, { ok: true, result: { sessionId: 'n1' } }));
      else setImmediate(() => deliverWindowResult(token, id, { ok: true, result: { delivered: 'steered' } }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super',
  }).token;
}

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
function live(sid: string, o: { busy?: boolean; answer?: ParkOutcome } = {}) {
  registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic' });
  registerParkable({
    id: sid, kind: 'chat', projectRoot: dir,
    exempt: () => null, busy: () => !!o.busy, asking: () => false,
    backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0,
    park: async () => o.answer ?? 'parked',
  });
}

describe('super delegate --succeeds', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-succ-'));
    frames.length = 0;
    _resetChatRegistry(); resetSuperIndex(); _resetSuperInbox(); resetWindowControl(); _resetChatParkForTests();
    process.env.DREAMCONTEXT_DESKTOP = '1';
  });
  afterEach(() => {
    if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
    _resetChatParkForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('an idle predecessor is ended and its card is the successor\'s', async () => {
    makeVault();
    live('c1');
    const r = await verb('delegate', { prompt: 'continue the db work', succeeds: 'c1' });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ sessionId: 'n1', container: containerIdFor('chat', 'n1'), predecessor: { child: 'c1', ended: true } });
    const s = await readSuperState(root);
    expect(typeof s.children.c1.endedAt).toBe('number');
    expect(s.children.c1.succeededBy).toBe('n1');
    expect(s.children.n1.brief).toBe('c1 work');
    expect(s.containers.map((k) => k.ref)).toEqual(['n1', 'c2']);
    // Its brief titled the new tab too.
    expect(frames.find((f) => f.verb === 'delegate')?.args).toMatchObject({ title: 'c1 work' });
  });

  it('a busy predecessor is told to stop at once (steered), and super state warns until it ends', async () => {
    makeVault();
    live('c1', { busy: true });
    const r = await verb('delegate', { prompt: 'continue the db work', succeeds: 'c1' });
    expect(r.json.result).toMatchObject({ predecessor: { child: 'c1', ended: false, reason: 'busy', told: 'steered' } });
    expect(frames.find((f) => f.verb === 'send')?.args).toEqual({ tab: 'c1', text: SUCCESSOR_STOP_TEXT });
    const st = await verb('state', {});
    const result = st.json.result as { warnings?: Array<{ kind: string; child?: string }> };
    expect(result.warnings).toEqual([expect.objectContaining({ kind: 'succeeded-still-live', child: 'c1' })]);
  });

  it('a predecessor busy at the handoff is ended at its next idle', async () => {
    makeVault();
    let busy = true;
    registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    registerParkable({
      id: 'c1', kind: 'chat', projectRoot: dir, exempt: () => null, busy: () => busy, asking: () => false,
      backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0, park: async () => 'parked',
    });
    await verb('delegate', { prompt: 'continue', succeeds: 'c1' });
    expect((await readSuperState(root)).children.c1.endedAt).toBeUndefined();
    busy = false;
    expect(await endSucceededChild(root, 'c1')).toBe(true);
    expect(typeof (await readSuperState(root)).children.c1.endedAt).toBe('number');
    // Not succeeded: never ended this way.
    expect(await endSucceededChild(root, 'c2')).toBe(false);
  });

  it('refuses to take over the owner\'s own chat, before any child starts', async () => {
    makeVault();
    const raw = JSON.parse(require('node:fs').readFileSync(join(root, SUPER_STATE_REL), 'utf-8'));
    raw.children.c2.adopted = true;
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(raw));
    resetSuperIndex();
    const r = await verb('delegate', { prompt: 'x', succeeds: 'c2' });
    expect(r.status).toBe(409);
    expect(frames).toHaveLength(0);
  });

  it('refuses a --succeeds that names none of its children, before any child starts', async () => {
    makeVault();
    const r = await verb('delegate', { prompt: 'x', succeeds: 'nope' });
    expect(r.status).toBe(404);
    expect(frames).toHaveLength(0);
  });
});
