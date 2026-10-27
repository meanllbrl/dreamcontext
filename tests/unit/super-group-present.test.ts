/**
 * A group seen whole (owner 2026-10-27: "I click the group, one picture, close it, back to the
 * group, the next one…"): one action shows every card of a group in the presentation layout,
 * one action goes back to the group.
 *
 *  - `groupPresentCards`: the group's known cards, in order, at most MAX_FILMSTRIP;
 *  - `presentedGroup`: the group a presentation shows whole ("back to the group");
 *  - `super present <grp-…>`: the Super opens a group straight into that view;
 *  - the panel's double-click window (`isDoubleOpen`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-group-present-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { MAX_FILMSTRIP, emptySuperState, groupPresentCards, presentedGroup, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { DOUBLE_OPEN_MS, isDoubleOpen } from '../../dashboard/src/components/sleepy/super/GroupPanel.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const img = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'image', ref: `tmp/shots/${id}.png`, shape: 'square', place: 'float', ...extra });

describe('the group a presentation shows (pure, both sides of the wire)', () => {
  const containers = [img('image-a'), img('image-b'), img('image-c'), img('image-d')];
  const g = { id: 'grp-shots', cards: ['image-a', 'image-gone', 'image-b', 'image-c'] };

  it('a group stands for its known cards, in order, at most a filmstrip', () => {
    for (const f of [groupPresentCards, client.groupPresentCards]) {
      expect(f(g, containers)).toEqual(['image-a', 'image-b', 'image-c']);
      const many = Array.from({ length: 11 }, (_, i) => img(`image-${i}`));
      expect(f({ cards: many.map((c) => c.id) }, many)).toHaveLength(MAX_FILMSTRIP);
    }
  });

  it('a presentation of exactly the group is that group, in any order; a part of it is not', () => {
    for (const f of [presentedGroup, client.presentedGroup]) {
      expect(f(['image-c', 'image-a', 'image-b'], [g], containers)?.id).toBe('grp-shots');
      expect(f(['image-a', 'image-b'], [g], containers)).toBeUndefined();
      expect(f(['image-a', 'image-b', 'image-c', 'image-d'], [g], containers)).toBeUndefined();
      expect(f(['image-a'], [{ id: 'grp-x', cards: ['image-a'] }], containers)).toBeUndefined();
    }
  });

  it('the double-click that opened the panel finishes on it: only a 2nd click, only right after opening', () => {
    expect(isDoubleOpen(1000, 1200, 2)).toBe(true);
    expect(isDoubleOpen(1000, 1000 + DOUBLE_OPEN_MS, 2)).toBe(true);
    expect(isDoubleOpen(1000, 1001 + DOUBLE_OPEN_MS, 2)).toBe(false);
    expect(isDoubleOpen(1000, 1200, 1)).toBe(false);
    expect(isDoubleOpen(1000, 900, 2)).toBe(false);
  });
});

let dir: string;
let root: string;
const SUPER = 'sup-grouppresent';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function makeVault(state: Partial<SuperState>): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
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
async function present(body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: 'present' });
  return r;
}

describe('super present <group>', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-group-present-'));
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

  it('a group id presents all its cards (3 pictures: a grid); they stay in the group', async () => {
    makeVault({ containers: [img('image-a'), img('image-b'), img('image-c')], groups: [{ id: 'grp-shots', name: 'shots', cards: ['image-a', 'image-b', 'image-c'], place: 'float' }] });
    const r = await present({ containers: ['grp-shots'] });
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-a', 'image-b', 'image-c'], layout: 'grid' });
    expect(s.groups[0].cards).toEqual(['image-a', 'image-b', 'image-c']);
  });

  it('a group bigger than a filmstrip shows its first 8; a layout that does not fit is refused', async () => {
    const many = Array.from({ length: 10 }, (_, i) => img(`image-${i}`));
    makeVault({ containers: many, groups: [{ id: 'grp-many', name: 'many', cards: many.map((c) => c.id), place: 'float' }] });
    const r = await present({ containers: ['grp-many'] });
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', layout: 'filmstrip' });
    expect(s.view.cards).toEqual(many.slice(0, 8).map((c) => c.id));
    expect((await present({ containers: ['grp-many'], layout: 'compare' })).status).toBe(400);
  });

  it('a group presented from Others comes back on the stage', async () => {
    makeVault({ containers: [img('image-a', { place: 'others' }), img('image-b', { place: 'others' })], groups: [{ id: 'grp-two', name: 'two', cards: ['image-a', 'image-b'], place: 'others' }] });
    expect((await present({ containers: ['grp-two'] })).status).toBe(200);
    const s = await readSuperState(root);
    expect(s.groups[0].place).toBe('float');
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare' });
  });

  it('an unknown group or card is still a 404', async () => {
    makeVault({ containers: [img('image-a')] });
    expect((await present({ containers: ['grp-nope'] })).status).toBe(404);
  });
});
