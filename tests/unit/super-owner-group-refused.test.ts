/**
 * Plan super-v3 D5 / K9, criterion v3-14: only the Super makes groups. The owner's window door
 * answers a `group` patch with 409 `group_by_super` before anything is written (the phone door's
 * twin is in super-remote.test.ts), `applyOwnerLayout` never applies one, and the Super's own
 * `super group` and `super present <group>` still work. Fictional project "acme".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/group-refused-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperContainer } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { OWNER_GROUP_REFUSAL, applyOwnerLayout, handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-group-refused';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;
const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer => ({ id, kind: 'chat', ref: `ref-${id}`, shape: 'tall', place: 'float', ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'group-refused-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, containers: [card('chat-a'), card('chat-b'), card('task-c', { kind: 'task', shape: 'square' })] }));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
});
afterEach(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
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
  (out as unknown as { setHeader: () => void }).setHeader = () => {};
  return out;
}
const layout = async (body: Record<string, unknown>) => { const r = res(); await handleSuperLayout(req(body), r, {}, root); return r; };
const verb = async (name: string, body: Record<string, unknown>) => { const r = res(); await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name }); return r; };

describe('the owner\'s window door', () => {
  it('a group patch is refused with 409 group_by_super and nothing is written, even with other gestures in it', async () => {
    const before = readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    const r = await layout({ group: { id: 'grp-mine', cards: ['chat-a', 'chat-b'] }, cards: [{ id: 'task-c', pos: { x: 0.2, y: 0.2 } }] });
    expect(r.status).toBe(OWNER_GROUP_REFUSAL.status);
    expect(r.json.error).toBe('group_by_super');
    expect(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).toBe(before);
  });

  it('applyOwnerLayout never applies a group, whoever calls it', () => {
    const s = { ...emptySuperState(), containers: [card('chat-a'), card('chat-b')] };
    applyOwnerLayout(s, { group: { id: 'grp-mine', cards: ['chat-a', 'chat-b'] } });
    expect(s.groups).toEqual([]);
  });

  it('his other gestures still work: a drop, and taking a card out of the Super\'s group', async () => {
    await verb('group', { containers: ['chat-a', 'chat-b'], name: 'Pricing' });
    const g = (await readSuperState(root)).groups[0];
    const r = await layout({ leave: ['chat-a'], cards: [{ id: 'chat-a', place: 'float', pos: { x: 0.1, y: 0.5 } }] });
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.groups.find((x) => x.id === g.id)?.cards ?? []).not.toContain('chat-a');
  });
});

describe('the Super still groups', () => {
  it('super group makes one; super present <group> shows its cards', async () => {
    const r = await verb('group', { containers: ['chat-a', 'task-c'], name: 'Acme' });
    expect(r.status).toBe(200);
    const id = (r.json.result as { group: { id: string } }).group.id;
    const p = await verb('present', { containers: [id] });
    expect(p.status).toBe(200);
    const v = (await readSuperState(root)).view;
    expect(v.mode).toBe('present');
  });
});
