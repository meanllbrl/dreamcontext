/**
 * A group seen whole (owner 2026-10-27: "I click the group, one picture, close it, back to the
 * group, the next one…"): one action shows every card of a group in the presentation layout,
 * one action goes back to the group.
 *
 *  - `groupPresentCards`: the group's known cards, in order, at most MAX_FILMSTRIP;
 *  - `presentedGroup`: the group a presentation shows whole ("back to the group");
 *  - `super present <grp-…>`: the Super opens a group straight into that view;
 *  - the panel's double-click window (`isDoubleOpen`);
 *  - every kind of group (owner 2026-10-28: "files too, everything"): PDFs, files, tasks, mixed.
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
import { LANDSCAPE_ASPECT, MAX_FILMSTRIP, defaultLayout as serverDefault, emptySuperState, groupPresentCards, presentedGroup, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { DOUBLE_OPEN_MS, isDoubleOpen, openAllHint, openAllLabel } from '../../dashboard/src/components/sleepy/super/GroupPanel.js';
import { PRESENT_KEY_OWNERS } from '../../dashboard/src/components/sleepy/super/StageParts.js';
import { planStage, stageItems } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import { MAX_KEPT_FRAMES, MAX_LIVE_IFRAMES, autoFrames, keptWebIds } from '../../dashboard/src/components/sleepy/super/webBudget.js';
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
      const many = Array.from({ length: MAX_FILMSTRIP + 3 }, (_, i) => img(`image-${i}`));
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

  it('a group of 10 is presented whole (no 8-card cap since 2026-10-29); a layout that does not fit is refused', async () => {
    const many = Array.from({ length: 10 }, (_, i) => img(`image-${i}`));
    makeVault({ containers: many, groups: [{ id: 'grp-many', name: 'many', cards: many.map((c) => c.id), place: 'float' }] });
    const r = await present({ containers: ['grp-many'] });
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', layout: 'filmstrip' });
    expect(s.view.cards).toEqual(many.map((c) => c.id));
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

// ── Every kind of group (owner 2026-10-28: "files too, everything"): a group opens whole
//    whatever its cards are, in the layout its cards pick, and "back to the group" finds it. ──
const card = (id: string, kind: SuperContainer['kind'], ref: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind, ref, shape: 'square', place: 'float', ...extra });
const pdfs = [card('pdf-a', 'pdf', 'docs/spec.pdf'), card('pdf-b', 'pdf', 'docs/terms.pdf'), card('pdf-c', 'pdf', 'docs/invoice.pdf')];
// A file card: a `web` card on a project file (.html; a .pdf or a picture has its own kind).
const files = [card('web-report', 'web', 'docs/report.html'), card('web-pricing', 'web', 'docs/pricing.html')];
const tasks = ['ledger-export', 'ledger-import', 'ledger-sync', 'ledger-audit'].map((s) => card(`task-${s}`, 'task', s));
const mixed = [
  card('image-x', 'image', 'shots/home.png'), card('pdf-x', 'pdf', 'docs/spec.pdf'), card('video-x', 'video', 'clips/demo.mp4'),
  card('web-x', 'web', 'docs/report.html'), card('task-x', 'task', 'ledger-export'), card('knowledge-x', 'knowledge', 'pricing-notes'),
  card('insight-x', 'insight', 'weekly-active-users'), card('whiteboard-x', 'whiteboard', 'flows'),
];
const KIND_CASES: { name: string; cards: SuperContainer[]; layout: string; state?: Partial<SuperState> }[] = [
  { name: 'a PDF group (3: a grid)', cards: pdfs, layout: 'grid' },
  { name: 'a file group (2: compare)', cards: files, layout: 'compare' },
  { name: 'a task group (4: a grid)', cards: tasks, layout: 'grid' },
  { name: 'a mixed group (8 kinds: a filmstrip)', cards: mixed, layout: 'filmstrip' },
  { name: 'a mixed group of 3 (picture, file, task: a grid)', cards: [mixed[0], mixed[3], mixed[4]], layout: 'grid' },
  { name: 'a finished child\'s chat with its site (review)', cards: [card('chat-kid', 'chat', 'kid-1'), card('web-kid', 'web', 'http://localhost:5173/', { by: 'auto', of: 'kid-1' })], layout: 'review',
    state: { children: { 'kid-1': { sessionId: 'kid-1', brief: 'the ledger site', adopted: true, startedAt: 1 } } } },
];

describe('landscape pictures default to a filmstrip (owner 2026-10-29), the same on both sides', () => {
  const pic = (aspect?: number): SuperContainer => img(`image-${aspect}`, aspect === undefined ? {} : { aspect });
  it('2+ pictures all at least LANDSCAPE_ASPECT wide: filmstrip; square, portrait, unknown or mixed: as before', () => {
    const cases: [SuperContainer[], string][] = [
      [[pic(16 / 9), pic(1.6)], 'filmstrip'],
      [[pic(16 / 9), pic(16 / 9), pic(4 / 3)], 'filmstrip'],
      [[pic(16 / 9)], 'spotlight'],
      [[pic(1), pic(1)], 'compare'],
      [[pic(0.46), pic(0.46), pic(0.46)], 'grid'],
      [[pic(16 / 9), pic(0.46), pic(16 / 9)], 'grid'],
      [[pic(), pic(), pic()], 'grid'],
      [[pic(16 / 9), { ...pic(16 / 9), id: 'pdf-x', kind: 'pdf' }], 'compare'],
    ];
    for (const [cards, want] of cases) {
      expect(serverDefault(cards)).toBe(want);
      expect(client.defaultLayout(cards)).toBe(want);
    }
    expect(LANDSCAPE_ASPECT).toBe(client.LANDSCAPE_ASPECT);
  });
});

describe('every kind of group opens whole', () => {
  it('the layout the cards pick, the same on both sides of the wire', () => {
    for (const { cards, layout } of KIND_CASES) {
      expect(serverDefault(cards)).toBe(layout);
      expect(client.defaultLayout(cards)).toBe(layout);
      const g = { id: 'grp-k', cards: cards.map((c) => c.id) };
      for (const f of [presentedGroup, client.presentedGroup]) expect(f([...g.cards].reverse(), [g], cards)?.id).toBe('grp-k');
    }
  });

  it('the stage draws every card of a mixed group at once, none covering another', () => {
    for (const { cards } of KIND_CASES) {
      const groups = [{ id: 'grp-k', name: 'k', cards: cards.map((c) => c.id), place: 'float' as const }];
      const view = { mode: 'present' as const, cards: cards.map((c) => c.id) };
      const plan = planStage(stageItems(cards, groups, view), view, { width: 1384, height: 844 });
      const shown = cards.map((c) => plan.cards[c.id]);
      expect(shown.every((p) => p && (p.where === 'present' || p.where === 'thumb'))).toBe(true);
      const rects = shown.map((p) => p!.rect);
      const overlap = (a: typeof rects[number], b: typeof rects[number]) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
      expect(rects.some((a, i) => rects.some((b, j) => i < j && overlap(a, b)))).toBe(false);
      // The group's own tile stays a group (its cards never leave it).
      expect(plan.cards['grp-k']).toBeDefined();
    }
  });

  it('a group bigger than a filmstrip says which cards open: "Open first 8"', () => {
    const t = (k: string) => ({ 'super.group.openAll': 'Open all', 'super.group.openFirst': 'Open first {n}', 'super.group.openAllHint': 'all', 'super.group.openFirstHint': '{total}: first {n}' } as Record<string, string>)[k] ?? k;
    expect(openAllLabel(t, 3)).toBe('Open all');
    expect(openAllLabel(t, MAX_FILMSTRIP)).toBe('Open all');
    expect(openAllLabel(t, 11)).toBe('Open all');
    expect(openAllLabel(t, MAX_FILMSTRIP + 1)).toBe(`Open first ${MAX_FILMSTRIP}`);
    expect(openAllHint(t, MAX_FILMSTRIP + 1)).toBe(`${MAX_FILMSTRIP + 1}: first ${MAX_FILMSTRIP}`);
    expect(openAllHint(t, 2)).toBe('all');
  });
});

describe('a group of pages and PDFs shown whole', () => {
  it('every page it presents loads (no card behind Load); any other presentation keeps the budget of two', () => {
    expect(autoFrames(false, 4)).toBe(MAX_LIVE_IFRAMES);
    expect(autoFrames(true, 1)).toBe(MAX_LIVE_IFRAMES);
    expect(autoFrames(true, 3)).toBe(3);
    expect(autoFrames(true, 9)).toBe(MAX_KEPT_FRAMES);
    const shown = ['web-a', 'web-b', 'web-c', 'web-d'];
    const auto = autoFrames(true, shown.length);
    // Two dev-server pages parked off the stage keep their frames too (a reload loses work).
    const parked = ['web-dev1', 'web-dev2'];
    const kept = keptWebIds(parked, shown, [...parked, ...shown], auto, MAX_KEPT_FRAMES + auto - MAX_LIVE_IFRAMES);
    for (const id of [...shown, ...parked]) expect(kept.has(id)).toBe(true);
    expect(keptWebIds([], shown, shown).size).toBe(MAX_LIVE_IFRAMES);
  });

  it('a PDF card\'s own viewer does not swallow Esc: only a full-window viewer does', () => {
    const owners = PRESENT_KEY_OWNERS.split(',').map((x) => x.trim());
    expect(owners).not.toContain('.pdf-viewer');
    expect(owners).toContain('.pdf-viewer:not(.pdf-viewer--embedded)');
    expect(owners).toContain('.image-viewer');
  });
});

describe('super present <group> of any kind', () => {
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

  for (const { name, cards, layout, state } of KIND_CASES) {
    it(`${name}: all its cards, in group order; they stay in the group`, async () => {
      const ids = cards.map((c) => c.id);
      makeVault({ ...state, containers: cards, groups: [{ id: 'grp-kind', name: 'kind', cards: ids, place: 'float' }] });
      const r = await present({ containers: ['grp-kind'] });
      expect(r.status).toBe(200);
      const s = await readSuperState(root);
      expect(s.view).toMatchObject({ mode: 'present', cards: ids, layout });
      expect(s.groups.find((g) => g.id === 'grp-kind')?.cards).toEqual(ids);
    });
  }

  it('a mixed group in Others comes back on the stage, and a layout its cards take is kept', async () => {
    const three = [mixed[1], mixed[3], mixed[4]].map((c) => ({ ...c, place: 'others' as const }));
    makeVault({ containers: three, groups: [{ id: 'grp-mix', name: 'mix', cards: three.map((c) => c.id), place: 'others' }] });
    expect((await present({ containers: ['grp-mix'], layout: 'filmstrip' })).status).toBe(200);
    const s = await readSuperState(root);
    expect(s.groups[0].place).toBe('float');
    expect(s.view).toMatchObject({ mode: 'present', cards: three.map((c) => c.id), layout: 'filmstrip' });
  });
});

// ── `super open image … --present` (owner 2026-10-29: "why do you create the group but not
//    present it"): media shown as a result open AND present in one call. ──
describe('super open … --present', () => {
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
  async function open(body: Record<string, unknown>) {
    const r = res();
    await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: 'open' });
    return r;
  }
  const shots = ['d3-work', 'd3-busy', 'd3-calm', 'd3-dark'].map((n) => `tmp/shots/${n}.png`);
  function withShots(state: Partial<SuperState> = {}): void {
    makeVault(state);
    mkdirSync(join(dir, 'acme', 'tmp', 'shots'), { recursive: true });
    for (const f of shots) writeFileSync(join(dir, 'acme', f), '');
  }

  it('4 pictures open as one group AND are presented whole (a grid); the reply carries the view', async () => {
    withShots();
    const r = await open({ kind: 'image', refs: shots, present: true });
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.groups).toHaveLength(1);
    const ids = s.groups[0].cards;
    expect(ids).toHaveLength(4);
    expect(s.view).toMatchObject({ mode: 'present', cards: ids, layout: 'grid' });
    const out = r.json.result as Record<string, unknown>;
    expect(out.view).toMatchObject({ mode: 'present', cards: ids });
    expect(out.presented).toMatchObject({ cards: ids });
    expect((out.presented as Record<string, unknown>).kept).toBeUndefined();
  });

  it('without --present the group only floats (unchanged)', async () => {
    withShots();
    const r = await open({ kind: 'image', refs: shots });
    expect(r.status).toBe(200);
    expect((await readSuperState(root)).view.mode).toBe('float');
    expect((r.json.result as Record<string, unknown>).presented).toBeUndefined();
  });

  it('--no-group --present presents the cards themselves; one picture is a spotlight', async () => {
    withShots();
    const r = await open({ kind: 'image', refs: shots.slice(0, 2), group: false, present: true });
    expect(r.status).toBe(200);
    let s = await readSuperState(root);
    expect(s.groups).toHaveLength(0);
    expect(s.view).toMatchObject({ mode: 'present', layout: 'compare' });
    expect(s.view.cards).toHaveLength(2);
    expect((await open({ kind: 'image', ref: shots[3], group: false, present: true })).status).toBe(200);
    s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', layout: 'spotlight' });
  });

  it('the owner\'s own layout for the same cards is kept (kept: owner_layout)', async () => {
    withShots();
    await open({ kind: 'image', refs: shots, present: true });
    let s = await readSuperState(root);
    const ids = s.groups[0].cards;
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...s, view: { mode: 'present', cards: ids, layout: 'filmstrip', layoutBy: 'owner' } }));
    resetSuperIndex();
    const r = await open({ kind: 'image', refs: shots, present: true });
    expect(r.status).toBe(200);
    expect((r.json.result as Record<string, unknown>).presented).toMatchObject({ kept: 'owner_layout' });
    s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', layout: 'filmstrip', layoutBy: 'owner' });
  });

  // A PNG's header alone: what image-aspect.ts reads for the shape.
  const png = (w: number, h: number): Buffer => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };

  it('landscape pictures (16:9) present as a filmstrip, not a grid; portrait ones keep the grid', async () => {
    withShots();
    for (const f of shots) writeFileSync(join(dir, 'acme', f), png(1600, 900));
    expect((await open({ kind: 'image', refs: shots, present: true })).status).toBe(200);
    let s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', layout: 'filmstrip' });
    // The strip keeps the order they were opened in.
    expect(s.view.cards).toEqual(s.groups[0].cards);
    const tall = ['p1', 'p2', 'p3'].map((n) => `tmp/shots/${n}.png`);
    for (const f of tall) writeFileSync(join(dir, 'acme', f), png(390, 844));
    expect((await open({ kind: 'image', refs: tall, group: false, present: true })).status).toBe(200);
    s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', layout: 'grid' });
  });

  it('--present is media only, and a boolean', async () => {
    withShots();
    expect((await open({ kind: 'task', ref: 'ledger-export', present: true })).status).toBe(400);
    expect((await open({ kind: 'image', ref: shots[0], present: 'yes' })).status).toBe(400);
  });
});
