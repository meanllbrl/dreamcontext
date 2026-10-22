/**
 * Pictures opened together are ONE group on the stage (owner 2026-10-22: five before/after
 * mockups landed as five scattered tiles around the centre chat).
 *
 *  - `super open image a b c` (2+ refs, no --group): one new group, named for the folder the
 *    pictures share, else "Images" (numbered when the name is taken);
 *  - one picture per call, one call after another within IMAGE_CHAIN_MS: it joins the previous
 *    picture's group, or forms one with a lone previous picture; a 2+ call is always its own set;
 *  - the chain breaks when the window passes or the owner moved the previous picture (ungrouped,
 *    stacked, closed, shown side by side); `--no-group` leaves the cards alone and ends the chain;
 *    `--group <name>` keeps its own meaning;
 *  - one picture alone stays one card; other kinds are never grouped by themselves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-image-group-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IMAGE_CHAIN_MS, freshGroupName, imageGroupBase, planImageGroup } from '../../src/lib/super/image-group.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { GROUP_ID_RE, emptySuperState, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-imggroup';
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
  dir = mkdtempSync(join(tmpdir(), 'super-image-group-'));
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


const open = (refs: string[], extra: Record<string, unknown> = {}) =>
  verb('open', refs.length === 1 ? { kind: 'image', ref: refs[0], ...extra } : { kind: 'image', refs, ...extra });
let clock = 1_800_000_000_000;
const tick = (ms: number) => { clock += ms; };

beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => clock); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the name and the plan (pure)', () => {
  it('the shared folder names the group; a generic or mixed folder says "Images"', () => {
    expect(imageGroupBase(['tmp/mockups/a.png', 'tmp/mockups/b.png'])).toBe('mockups');
    expect(imageGroupBase(['tmp/a.png', 'tmp/b.png'])).toBe('Images');
    expect(imageGroupBase(['_dream_context/tmp/agent-drops/a.png'])).toBe('Images');
    expect(imageGroupBase(['a.png', 'b.png'])).toBe('Images');
    expect(imageGroupBase(['docs/x/a.png', 'docs/y/b.png'])).toBe('Images');
    expect(freshGroupName([{ name: 'Images' }, { name: 'Images 2' }], 'Images')).toBe('Images 3');
    expect(freshGroupName([{ name: 'Tasks' }], 'Images')).toBe('Images');
  });

  it('one picture with no chain stands alone; a stale chain is no chain', () => {
    const s = { ...emptySuperState(), containers: [{ id: 'image-x', kind: 'image', ref: 'a.png', shape: 'square', place: 'float' } as SuperContainer] };
    expect(planImageGroup(s, ['image-y'], ['b.png'], undefined, 0)).toBeNull();
    expect(planImageGroup(s, ['image-y'], ['b.png'], { at: 0, card: 'image-x', group: null }, IMAGE_CHAIN_MS + 1)).toBeNull();
    expect(planImageGroup(s, ['image-y'], ['b.png'], { at: 0, card: 'image-x', group: null }, IMAGE_CHAIN_MS))
      .toEqual({ make: { cards: ['image-x', 'image-y'], name: 'Images' } });
  });
});

describe('super open image groups pictures by itself', () => {
  it('three in one call are one group on the stage, named for their folder', async () => {
    makeVault({ containers: [] });
    const r = await open(['tmp/mockups/a.png', 'tmp/mockups/b.png', 'tmp/mockups/c.png']);
    expect(r.status).toBe(200);
    const res = r.json.result as { group: { id: string; name: string; cards: string[] }; autoGroup: boolean };
    expect(res.autoGroup).toBe(true);
    expect(res.group.name).toBe('mockups');
    expect(res.group.cards).toHaveLength(3);
    const s = await state();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ place: 'float', cards: res.group.cards });
  });

  it('separate calls within the window join one group; the first picture alone is one card', async () => {
    makeVault({ containers: [] });
    const first = await open(['tmp/before.png']);
    expect((first.json.result as { group?: unknown }).group).toBeUndefined();
    expect((await state()).groups).toHaveLength(0);
    tick(5_000);
    const second = await open(['tmp/after.png']);
    const g = (second.json.result as { group: { id: string; name: string; cards: string[] } }).group;
    expect(g.name).toBe('Images');
    expect(g.cards).toHaveLength(2);
    tick(30_000);
    await open(['tmp/after-phone.png']);
    const s = await state();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].id).toBe(g.id);
    expect(s.groups[0].cards).toHaveLength(3);
  });

  it('a set named in one call is its own group, even right after another picture; singles then join it', async () => {
    makeVault({ containers: [] });
    await open(['before/a.png']);
    tick(1_000);
    await open(['before/b.png']);
    tick(1_000);
    await open(['after/a.png', 'after/b.png', 'after/c.png']);
    tick(1_000);
    await open(['after/d.png']);
    const s = await state();
    expect(s.groups.map((g) => [g.name, g.cards.length])).toEqual([['before', 2], ['after', 4]]);
  });

  it('after the window a picture starts afresh', async () => {
    makeVault({ containers: [] });
    await open(['a.png']);
    tick(IMAGE_CHAIN_MS + 1);
    await open(['b.png']);
    expect((await state()).groups).toHaveLength(0);
  });

  it('an owner who ungrouped or stacked the previous pictures broke the chain', async () => {
    makeVault({ containers: [] });
    const r = await open(['a.png', 'b.png']);
    const gid = (r.json.result as { group: { id: string } }).group.id;
    expect((await verb('ungroup', { targets: [gid] })).status).toBe(200);
    tick(1_000);
    await open(['c.png']);
    expect((await state()).groups).toHaveLength(0);

    await open(['d.png']);
    expect((await verb('stack', { container: (await state()).containers.find((k) => k.ref === 'd.png')!.id })).status).toBe(200);
    tick(1_000);
    await open(['e.png']);
    expect((await state()).groups).toHaveLength(0);
  });

  it('a picture shown side by side is not pulled into a group', async () => {
    makeVault({ containers: [] });
    await open(['a.png']);
    const id = (await state()).containers[0].id;
    expect((await verb('half', { container: id })).status).toBe(200);
    await open(['b.png']);
    expect((await state()).groups).toHaveLength(0);
  });

  it('--no-group leaves them alone and ends the chain; --group keeps its own name', async () => {
    makeVault({ containers: [] });
    await open(['a.png', 'b.png'], { group: false });
    expect((await state()).groups).toHaveLength(0);
    await open(['c.png']);
    expect((await state()).groups).toHaveLength(0);

    const named = await open(['d.png', 'e.png'], { group: 'Before / after' });
    expect((named.json.result as { autoGroup?: boolean; group: { name: string } }).group.name).toBe('Before / after');
    expect((named.json.result as { autoGroup?: boolean }).autoGroup).toBeUndefined();
    // A picture right after an explicit group joins it.
    await open(['f.png']);
    const s = await state();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ name: 'Before / after' });
    expect(s.groups[0].cards).toHaveLength(3);
  });

  it('a taken name gets a number, and other kinds are never grouped by themselves', async () => {
    makeVault({ containers: [] });
    await open(['a.png', 'b.png']);
    tick(IMAGE_CHAIN_MS + 1);
    await open(['c.png', 'd.png']);
    expect((await state()).groups.map((g) => g.name)).toEqual(['Images', 'Images 2']);

    makeVault();
    expect((await verb('open', { kind: 'knowledge', refs: ['alpha', 'beta'] })).status).toBe(200);
    expect((await state()).groups).toHaveLength(0);
  });
});
