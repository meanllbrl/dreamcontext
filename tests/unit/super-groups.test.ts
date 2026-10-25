/**
 * Groups on the Super Agent's stage (owner decision 2026-10-20): cards put together as ONE tile.
 *
 *  - the agent's `super group` / `super ungroup` through the real route: two or more cards make a
 *    group standing where its first card stood, a group id among the cards adds to it, `--name`
 *    renames; one group at most per call; unknown cards refused;
 *  - `stack` / `float` take a group; a grouped card stacked or floated alone leaves its group;
 *    `close` never closes a group by its id, and closing a member settles the group (one left = dissolved
 *    into that card, which takes the group's place and spot);
 *  - the owner's layout PATCH: a drop on a card makes a group, a drop on a group joins it, a card
 *    dragged out leaves it, Ungroup dissolves, a `cards` entry may move or stack a group;
 *  - the record read from disk keeps those rules whatever was hand-edited into it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-groups-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { GROUP_ID_RE, emptySuperState, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-groups';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'chat', ref: `ref-${id}`, shape: 'tall', place: 'float', ...extra });

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    containers: [card('chat-a'), card('chat-b'), card('chat-c', { pos: { x: 0.9, y: 0.1 } }), card('task-d', { kind: 'task', shape: 'square' })],
    ...state,
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-groups-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
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
  return out;
}
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}
async function layout(body: Record<string, unknown>) {
  const r = res();
  await handleSuperLayout(req(body), r, {}, root);
  return r;
}
const state = () => readSuperState(root);

describe('super group / ungroup (the agent)', () => {
  it('two or more cards make one group, standing where its first card stood', async () => {
    makeVault();
    const r = await verb('group', { containers: ['chat-c', 'chat-a'], name: 'Formlar' });
    expect(r.status).toBe(200);
    const g = (r.json.result as { group: { id: string } }).group;
    expect(g).toMatchObject({ name: 'Formlar', cards: ['chat-c', 'chat-a'], place: 'float', pos: { x: 0.9, y: 0.1 } });
    expect(GROUP_ID_RE.test(g.id)).toBe(true);
    expect(g.id.startsWith('chat-')).toBe(false);
    const s = await state();
    expect(s.groups).toHaveLength(1);
    // The cards themselves are untouched: membership lives on the group.
    expect(s.containers.map((c) => c.id)).toEqual(['chat-a', 'chat-b', 'chat-c', 'task-d']);
  });

  it('without --name a group is "Group N", the smallest N not taken', async () => {
    makeVault({ groups: [{ id: 'grp-old', name: 'Group 1', cards: ['chat-a', 'chat-b'], place: 'float' }] });
    const r = await verb('group', { containers: ['chat-c', 'task-d'] });
    expect((r.json.result as { group: { name: string } }).group.name).toBe('Group 2');
  });

  it('a group id among the cards adds them to it; --name alone renames it; a card moves out of its old group', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b'], place: 'float' }, { id: 'grp-2', name: 'Two', cards: ['chat-c', 'task-d'], place: 'float' }] });
    expect((await verb('group', { containers: ['grp-1', 'chat-c'] })).status).toBe(200);
    let s = await state();
    expect(s.groups.find((g) => g.id === 'grp-1')?.cards).toEqual(['chat-a', 'chat-b', 'chat-c']);
    // grp-2 was left with one card: dissolved into it.
    expect(s.groups.find((g) => g.id === 'grp-2')).toBeUndefined();
    expect((await verb('group', { containers: ['grp-1'], name: 'Formlar' })).status).toBe(200);
    s = await state();
    expect(s.groups[0].name).toBe('Formlar');
  });

  it('refuses one card, two groups at once, an unknown card, and an empty rename', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b'], place: 'float' }, { id: 'grp-2', name: 'Two', cards: ['chat-c', 'task-d'], place: 'float' }] });
    expect((await verb('group', { containers: ['chat-a'] })).status).toBe(400);
    expect((await verb('group', { containers: ['grp-1', 'grp-2'] })).status).toBe(400);
    expect((await verb('group', { containers: ['chat-a', 'nope'] })).status).toBe(404);
    expect((await verb('group', { containers: ['grp-1'] })).status).toBe(400);
    expect((await state()).groups.map((g) => g.cards)).toEqual([['chat-a', 'chat-b'], ['chat-c', 'task-d']]);
  });

  it('ungroup dissolves a group (its cards take its place, the first its spot) or takes a card out', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b', 'chat-c'], place: 'others', pos: { x: 0.1, y: 0.2 } }] });
    expect((await verb('ungroup', { targets: ['chat-c'] })).status).toBe(200);
    let s = await state();
    expect(s.groups[0].cards).toEqual(['chat-a', 'chat-b']);
    expect(s.containers.find((c) => c.id === 'chat-c')).toMatchObject({ place: 'float' });
    expect(s.containers.find((c) => c.id === 'chat-c')?.pos).toBeUndefined();
    expect((await verb('ungroup', { targets: ['grp-1'] })).status).toBe(200);
    s = await state();
    expect(s.groups).toEqual([]);
    expect(s.containers.find((c) => c.id === 'chat-a')).toMatchObject({ place: 'others', pos: { x: 0.1, y: 0.2 } });
    expect(s.containers.find((c) => c.id === 'chat-b')).toMatchObject({ place: 'others' });
    expect(s.containers.find((c) => c.id === 'chat-b')?.pos).toBeUndefined();
    expect((await verb('ungroup', { targets: ['nope'] })).status).toBe(404);
  });
});

describe('stack / float / close and groups', () => {
  it('stack and float move a whole group; float places it automatically', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b'], place: 'float', pos: { x: 0.3, y: 0.3 } }] });
    expect((await verb('stack', { container: 'grp-1' })).status).toBe(200);
    expect((await state()).groups[0]).toMatchObject({ place: 'others', pos: { x: 0.3, y: 0.3 } });
    expect((await verb('float', { container: 'grp-1' })).status).toBe(200);
    const g = (await state()).groups[0];
    expect(g.place).toBe('float');
    expect(g.pos).toBeUndefined();
  });

  it('a grouped card stacked on its own leaves its group (a group of one dissolves)', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b'], place: 'float', pos: { x: 0.6, y: 0.4 } }] });
    expect((await verb('stack', { container: 'chat-a' })).status).toBe(200);
    const s = await state();
    expect(s.groups).toEqual([]);
    expect(s.containers.find((c) => c.id === 'chat-a')?.place).toBe('others');
    // The card left behind is where the group was.
    expect(s.containers.find((c) => c.id === 'chat-b')).toMatchObject({ place: 'float', pos: { x: 0.6, y: 0.4 } });
  });

  it('a group is never closed; closing a member settles the group', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b', 'chat-c'], place: 'float' }] });
    expect((await verb('close', { container: 'grp-1' })).status).toBe(400);
    expect((await verb('close', { container: 'chat-b' })).status).toBe(200);
    expect((await state()).groups[0].cards).toEqual(['chat-a', 'chat-c']);
  });
});

describe('close --group / --all-groups (the agent)', () => {
  const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: sid, adopted: false, startedAt: 1, ...extra });
  const two = [
    { id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b', 'task-d'], place: 'float' as const },
    { id: 'grp-2', name: 'Two', cards: ['chat-c', 'chat-e'], place: 'others' as const },
  ];
  const withE = { containers: [card('chat-a'), card('chat-b'), card('chat-c'), card('task-d', { kind: 'task', shape: 'square' }), card('chat-e')] };

  it('--group closes every card of the group and the group goes with them', async () => {
    makeVault({ ...withE, groups: two });
    const r = await verb('close', { group: 'grp-1' });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ closed: ['chat-a', 'chat-b', 'task-d'], skipped: [], groups: ['grp-1'] });
    const s = await state();
    expect(s.containers.map((c) => c.id)).toEqual(['chat-c', 'chat-e']);
    expect(s.groups.map((g) => g.id)).toEqual(['grp-2']);
  });

  it('a live job\'s card is skipped and stays; its group settles around it', async () => {
    makeVault({ ...withE, groups: two, children: { 'ref-chat-b': child('ref-chat-b', { row: 'working' }) } });
    const r = await verb('close', { group: 'grp-1' });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ closed: ['chat-a', 'task-d'], skipped: ['chat-b'] });
    const s = await state();
    expect(s.containers.map((c) => c.id)).toEqual(['chat-b', 'chat-c', 'chat-e']);
    // One card left: the group dissolved into it.
    expect(s.groups.map((g) => g.id)).toEqual(['grp-2']);
  });

  it('a group of live jobs only is refused (409 live_child) and nothing closes', async () => {
    makeVault({ ...withE, groups: two, children: { 'ref-chat-c': child('ref-chat-c', { row: 'asking' }), 'ref-chat-e': child('ref-chat-e', { row: 'stuck' }) } });
    const r = await verb('close', { group: 'grp-2' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('live_child');
    expect((await state()).containers).toHaveLength(5);
  });

  it('--all-groups closes every group\'s finished cards; with --others only the groups in Others', async () => {
    makeVault({ ...withE, groups: two, children: { 'ref-chat-e': child('ref-chat-e', { row: 'waiting' }) } });
    const o = await verb('close', { allGroups: true, others: true });
    expect(o.status).toBe(200);
    expect(o.json.result).toMatchObject({ closed: ['chat-c'], skipped: ['chat-e'], groups: ['grp-2'] });
    expect((await state()).containers.map((c) => c.id)).toEqual(['chat-a', 'chat-b', 'task-d', 'chat-e']);
    const a = await verb('close', { allGroups: true });
    expect(a.status).toBe(200);
    expect(a.json.result).toMatchObject({ closed: ['chat-a', 'chat-b', 'task-d'], skipped: [] });
    const s = await state();
    expect(s.containers.map((c) => c.id)).toEqual(['chat-e']);
    expect(s.groups).toEqual([]);
  });

  it('--all-groups with only live cards is a quiet no-op, not a refusal; with no groups it closes nothing', async () => {
    makeVault({ ...withE, groups: [two[1]], children: { 'ref-chat-c': child('ref-chat-c', { row: 'working' }), 'ref-chat-e': child('ref-chat-e', { row: 'working' }) } });
    const r = await verb('close', { allGroups: true });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ closed: [], skipped: ['chat-c', 'chat-e'] });
    expect((await state()).containers).toHaveLength(5);
    makeVault(withE);
    expect((await verb('close', { allGroups: true })).json.result).toMatchObject({ closed: [], skipped: [], groups: [] });
    expect((await state()).containers).toHaveLength(5);
  });

  it('refuses an unknown group, a group with --all-groups, and --others alone', async () => {
    makeVault({ ...withE, groups: two });
    expect((await verb('close', { group: 'grp-nope' })).status).toBe(404);
    expect((await verb('close', { group: 'grp-1', allGroups: true })).status).toBe(400);
    expect((await verb('close', { group: 'grp-1', others: true })).status).toBe(400);
    // A card id named as a group is no group.
    expect((await verb('close', { group: 'chat-a' })).status).toBe(404);
    expect((await state()).containers).toHaveLength(5);
  });
});

describe('the owner\'s layout PATCH', () => {
  it('a card dropped on another makes a group where the target stood; a drop on a group joins it', async () => {
    makeVault();
    let r = await layout({ group: { id: 'grp-own-1', cards: ['chat-c', 'chat-b'], name: 'Grup 1' } });
    expect(r.status).toBe(200);
    let s = await state();
    expect(s.groups).toEqual([{ id: 'grp-own-1', name: 'Grup 1', cards: ['chat-c', 'chat-b'], place: 'float', pos: { x: 0.9, y: 0.1 } }]);
    r = await layout({ group: { id: 'grp-own-1', cards: ['task-d'] } });
    s = await state();
    expect(s.groups[0].cards).toEqual(['chat-c', 'chat-b', 'task-d']);
  });

  it('a card dragged out of a group lands where it was dropped; Ungroup dissolves', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b', 'chat-c'], place: 'float' }] });
    await layout({ leave: ['chat-a'], cards: [{ id: 'chat-a', place: 'float', pos: { x: 0.05, y: 0.5 } }] });
    let s = await state();
    expect(s.groups[0].cards).toEqual(['chat-b', 'chat-c']);
    expect(s.containers.find((c) => c.id === 'chat-a')).toMatchObject({ place: 'float', pos: { x: 0.05, y: 0.5 } });
    await layout({ ungroup: ['grp-1'] });
    s = await state();
    expect(s.groups).toEqual([]);
  });

  it('a cards entry may name a group: dropped somewhere, or put in Others', async () => {
    makeVault({ groups: [{ id: 'grp-1', name: 'One', cards: ['chat-a', 'chat-b'], place: 'float' }] });
    await layout({ cards: [{ id: 'grp-1', pos: { x: 0.25, y: 0.75 } }] });
    expect((await state()).groups[0].pos).toEqual({ x: 0.25, y: 0.75 });
    await layout({ cards: [{ id: 'grp-1', place: 'others' }] });
    expect((await state()).groups[0].place).toBe('others');
  });

  it('a malformed group op is ignored, never half-applied', async () => {
    makeVault();
    await layout({ group: { id: 'not a group id', cards: ['chat-a', 'chat-b'] } });
    await layout({ group: { id: 'grp-x', cards: ['chat-a'] } });
    await layout({ group: 'grp-x' });
    expect((await state()).groups).toEqual([]);
  });
});

describe('the record on disk', () => {
  it('a hand-edited record keeps the rules: one group per card, two cards per group, known cards only', async () => {
    makeVault({
      groups: [
        { id: 'grp-1', name: 'A\u0007b'.repeat(40), cards: ['chat-a', 'chat-b', 'gone'], place: 'sideways' },
        { id: 'grp-2', name: 'Two', cards: ['chat-b', 'chat-c'], place: 'float', pos: { x: 0.4, y: 0.2 } },
        { id: 'grp-1', name: 'dup', cards: ['task-d', 'chat-c'], place: 'float' },
      ] as unknown as SuperState['groups'],
    });
    const s = await state();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ id: 'grp-1', cards: ['chat-a', 'chat-b'], place: 'float' });
    expect(s.groups[0].name.length).toBeLessThanOrEqual(60);
    expect(s.groups[0].name).not.toMatch(/[\u0000-\u001f]/);
    // grp-2 kept only chat-c: dissolved into it, which takes its spot.
    expect(s.containers.find((c) => c.id === 'chat-c')).toMatchObject({ place: 'float', pos: { x: 0.4, y: 0.2 } });
  });

  it('an older record without groups reads as none', async () => {
    makeVault();
    const raw = JSON.parse(JSON.stringify({ ...emptySuperState(), session: SUPER }));
    delete raw.groups;
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(raw));
    expect((await state()).groups).toEqual([]);
  });
});
