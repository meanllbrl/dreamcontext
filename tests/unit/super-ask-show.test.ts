/**
 * A picture question presents its option pictures on the Super stage by itself and puts them
 * back after the answer (task a-picture-question…, D1-D9):
 *
 *  - which cards: `--show` > the option previews' project pictures > the recent set; ≤ 8;
 *  - `settleAskShows` on every write: presented at the head (never over the owner's own view),
 *    put back on any close (the stage floats, the pictures to Others, a group as its tile);
 *  - the routes: `ask` / `queue ask` answer `show`, refuse without opening a card, mirror new
 *    pictures to a watching phone once; the owner's layout POST stamps `by: owner`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-ask-show-home-`);
});

const mirror = vi.hoisted(() => ({ frames: [] as string[] }));
vi.mock('../../src/server/routes/agent-chat-live.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/routes/agent-chat-live.js')>();
  return { ...real, findLiveChat: (id: string) => (id === 'sup-askshow' ? { mirrorFrame: (f: string) => { mirror.frames.push(f); } } : real.findLiveChat(id)) };
});

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, readPendingQuestion, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState, sanitizeView } from '../../src/lib/super/store.js';
import {
  MAX_CONTAINERS, SUPER_STATE_VERSION, emptySuperState, imagesInPreviews, presentCards, resolvePresent,
  type AskShow, type SuperContainer, type SuperGroup, type SuperQueueItem, type SuperState,
} from '../../src/lib/super/types.js';
import { recentAskCards, recordAskShow, settleAskShows } from '../../src/lib/super/ask-show.js';
import { decodeEntities, openImageCards, resolvePreviewImages } from '../../src/lib/super/ask-show-src.js';
import { _resetSuperInbox, superQueueHead } from '../../src/lib/super/inbox.js';
import { applySignal } from '../../src/lib/super/proactive.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const img = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'image', ref: `pics/${id}.png`, shape: 'square', place: 'float', ...extra });
const ask = (id: string, extra: Partial<SuperQueueItem> = {}): SuperQueueItem =>
  ({ id, sessionId: 'sup', kind: 'ask', state: 'escalated', createdAt: 10, ...extra });
const stage = (over: Partial<SuperState> = {}): SuperState => ({ ...emptySuperState(), session: 'sup', enabled: true, ...over });
const settle = (s: SuperState) => { settleAskShows(s, superQueueHead(s)); return s; };
const entry = (item: string, cards: string[], extra: Partial<AskShow> = {}): AskShow => ({ item, cards, opened: cards, via: 'preview', ...extra });

// ─── Which pictures (pure) ─────────────────────────────────────────────────────

describe('imagesInPreviews', () => {
  it('every <img src> of every question, in option order, deduped, with its label; srcset is not read', () => {
    const out = imagesInPreviews([
      { options: [{ label: 'A', preview: '<div><img src="a.png" srcset="x.png 2x"></div>' }, { label: 'B', preview: "<img alt='b' src='b.png'>" }] },
      { options: [{ label: 'C', preview: '<img src=c.png><img src="a.png">' }, { label: 'D' }] },
    ]);
    expect(out).toEqual([{ src: 'a.png', label: 'A' }, { src: 'b.png', label: 'B' }, { src: 'c.png', label: 'C' }]);
  });
  it('at most 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => `<img src="p${i}.png">`).join('');
    expect(imagesInPreviews([{ options: [{ label: 'x', preview: many }] }])).toHaveLength(8);
  });
});

describe('resolvePreviewImages (a real project on disk)', () => {
  let project: string;
  let outside: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'super-ask-show-proj-'));
    outside = mkdtempSync(join(tmpdir(), 'super-ask-show-out-'));
    mkdirSync(join(project, 'mock'), { recursive: true });
    for (const f of ['mock/a.png', 'mock/b.png', 'mock/notes.txt']) writeFileSync(join(project, f), 'x');
    writeFileSync(join(outside, 'x.png'), 'x');
    symlinkSync(join(outside, 'x.png'), join(project, 'mock/link.png'));
  });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

  it('keeps project pictures (./, absolute inside, deduped) and lists everything else as skipped', async () => {
    const srcs = [
      './mock/a.png', 'mock/a.png', join(project, 'mock/b.png'),
      '../x.png', join(outside, 'x.png'), 'file:///etc/x.png', 'https://example.com/x.png', 'data:image/png;base64,AAAA',
      '//host/x.png', '&#46;&#46;/x.png', 'mock/link.png', 'mock/missing.png', 'mock/notes.txt',
    ];
    const r = await resolvePreviewImages(project, project, srcs.map((src, i) => ({ src, label: `L${i}` })));
    expect(r.found).toEqual([{ ref: 'mock/a.png', label: 'L0' }, { ref: 'mock/b.png', label: 'L2' }]);
    // 8 at most are looked at: the first 8 srcs.
    expect(r.skipped).toEqual(['../x.png', join(outside, 'x.png'), 'file:///etc/x.png', 'https://example.com/x.png', 'data:image/png;base64,AAAA']);
    const rest = await resolvePreviewImages(project, project, srcs.slice(8).map((src) => ({ src, label: '' })));
    expect(rest.found).toEqual([]);
    expect(rest.skipped).toEqual(srcs.slice(8));
  });
  it('a child worktree outside the project: its picture is skipped and reported', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'super-ask-show-wt-'));
    writeFileSync(join(wt, 'shot.png'), 'x');
    const r = await resolvePreviewImages(project, wt, [{ src: 'shot.png', label: 'A' }]);
    expect(r).toEqual({ found: [], skipped: ['shot.png'] });
    rmSync(wt, { recursive: true, force: true });
  });
  it('entities are decoded', () => {
    expect(decodeEntities('a&amp;b&#46;&#x2e;')).toBe('a&b..');
  });
});

describe('recentAskCards', () => {
  const now = 1_000_000_000;
  it('a child: the pictures shown for it in the last 10 minutes', () => {
    const s = stage({
      children: { c1: { sessionId: 'c1', brief: '', adopted: false, startedAt: 1 } },
      containers: [img('image-a', { forChild: 'c1', forAt: now - 60_000 }), img('image-b', { forChild: 'c1', forAt: now - 11 * 60_000 }), img('image-c')],
    });
    expect(recentAskCards(s, { child: 'c1' }, now)).toEqual(['image-a']);
  });
  it('the super: its last set (the group) within 10 minutes, nothing after', () => {
    const s = stage({ containers: [img('image-a'), img('image-b')], groups: [{ id: 'grp-x', name: 'Images', cards: ['image-a', 'image-b'], place: 'float' }] });
    expect(recentAskCards(s, { chain: { at: now - 1000, card: 'image-a', group: 'grp-x' } }, now)).toEqual(['image-a', 'image-b']);
    expect(recentAskCards(s, { chain: { at: now - 11 * 60_000, card: 'image-a', group: 'grp-x' } }, now)).toEqual([]);
    expect(recentAskCards(s, { chain: undefined }, now)).toEqual([]);
  });
});

// ─── settleAskShows (pure) ─────────────────────────────────────────────────────

describe('settleAskShows: presenting', () => {
  it('presents the head question\'s cards with view.ask', () => {
    const s = settle(stage({ containers: [img('image-a'), img('image-b')], queue: [ask('q1')], askShows: [entry('q1', ['image-a', 'image-b'])] }));
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-a', 'image-b'], ask: 'q1' });
    expect(s.askShows?.[0].presented).toBe(true);
  });
  it('waits behind a permission, then presents when it clears', () => {
    const s = stage({
      containers: [img('image-a'), img('image-b')],
      queue: [{ id: 'p1', sessionId: 'c1', kind: 'permission', state: 'pending', createdAt: 1 }, ask('q1')],
      askShows: [entry('q1', ['image-a', 'image-b'])],
    });
    settle(s);
    expect(s.view.mode).toBe('float');
    expect(s.askShows?.[0].presented).toBeUndefined();
    s.queue[0].state = 'done';
    settle(s);
    expect(s.view).toMatchObject({ mode: 'present', ask: 'q1' });
  });
  it('a second question\'s set waits for the first to close, then presents', () => {
    const s = stage({
      containers: [img('image-a'), img('image-b'), img('image-c'), img('image-d')],
      queue: [ask('q1', { createdAt: 1 }), { id: 'q2', sessionId: 'c1', kind: 'question', state: 'escalated', createdAt: 2 }],
      askShows: [entry('q1', ['image-a', 'image-b']), entry('q2', ['image-c', 'image-d'])],
    });
    settle(s);
    expect(s.view.cards).toEqual(['image-a', 'image-b']);
    s.queue[0].state = 'done';
    settle(s);
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-c', 'image-d'], ask: 'q2' });
    expect(s.containers.filter((c) => c.place === 'others').map((c) => c.id)).toEqual(['image-a', 'image-b']);
  });
  it('the owner\'s own view is never replaced: skipped, and never later', () => {
    for (const view of [{ mode: 'half' as const, card: 'task-x', by: 'owner' as const }, { mode: 'present' as const, cards: ['task-x', 'task-y'], layout: 'compare' as const, layoutBy: 'owner' as const }]) {
      const s = settle(stage({
        containers: [img('image-a'), img('image-b'), { id: 'task-x', kind: 'task', ref: 'x', shape: 'square', place: 'float' }, { id: 'task-y', kind: 'task', ref: 'y', shape: 'square', place: 'float' }],
        view, queue: [ask('q1')], askShows: [entry('q1', ['image-a', 'image-b'])],
      }));
      expect(s.view).toEqual(view);
      expect(s.askShows?.[0].skipped).toBe('owner_layout');
      s.view = { mode: 'float' };
      settle(s);
      expect(s.view.mode).toBe('float');
    }
  });
  it('his layout on the SAME cards is kept and the set adopted', () => {
    const s = settle(stage({
      containers: [img('image-a'), img('image-b')],
      view: { mode: 'present', cards: ['image-b', 'image-a'], layout: 'grid', layoutBy: 'owner' },
      queue: [ask('q1')], askShows: [entry('q1', ['image-a', 'image-b'])],
    }));
    expect(s.view).toMatchObject({ layout: 'grid', layoutBy: 'owner', ask: 'q1' });
  });
  it('no card left: nothing presented, the entry dropped', () => {
    const s = settle(stage({ queue: [ask('q1')], askShows: [entry('q1', ['image-gone'])] }));
    expect(s.view.mode).toBe('float');
    expect(s.askShows).toBeUndefined();
  });
  it('a repeat queue ask replaces the cards, keeps what it opened, and presents again', () => {
    const s = stage({ containers: [img('image-a'), img('image-b'), img('image-c')], queue: [ask('q1')], askShows: [entry('q1', ['image-a', 'image-b'])] });
    settle(s);
    recordAskShow(s, 'q1', ['image-c', 'image-b'], ['image-c'], 'preview');
    expect(s.askShows?.[0].opened.sort()).toEqual(['image-a', 'image-b', 'image-c']);
    settle(s);
    expect(s.view.cards).toEqual(['image-c', 'image-b']);
    s.queue[0].state = 'done';
    settle(s);
    // image-a, opened by the first ask, is not lost to the sweep.
    expect(s.containers.every((c) => c.place === 'others')).toBe(true);
  });
  it('at most 4 entries: the oldest goes', () => {
    const items = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const s = settle(stage({ containers: [img('image-a')], queue: items.map((id, i) => ask(id, { createdAt: i })), askShows: items.map((id) => entry(id, ['image-a'])) }));
    expect(s.askShows?.map((e) => e.item)).toEqual(['q2', 'q3', 'q4', 'q5']);
  });
});

describe('settleAskShows: putting back', () => {
  const grouped = (over: Partial<SuperState> = {}) => stage({
    containers: [img('image-a'), img('image-b'), img('image-c')],
    groups: [{ id: 'grp-q', name: 'Images', cards: ['image-a', 'image-b', 'image-c'], place: 'float' }],
    queue: [ask('q1')], askShows: [entry('q1', ['image-a', 'image-b', 'image-c'])], ...over,
  });
  for (const [path, close] of [
    ['his answer (ask done)', (s: SuperState) => { s.queue[0].state = 'done'; }],
    ['the item removed (stale sweep, fresh session, MAX_QUEUE trim)', (s: SuperState) => { s.queue = []; }],
  ] as const) {
    it(`${path}: the stage floats and the GROUP goes to Others as its tile`, () => {
      const s = settle(grouped());
      expect(s.view.mode).toBe('present');
      close(s);
      settle(s);
      expect(s.view).toEqual({ mode: 'float' });
      expect(s.groups[0].place).toBe('others');
      expect(s.askShows).toBeUndefined();
    });
  }
  it('a child question closing (question done) puts its pictures back too', () => {
    const s = settle(stage({ containers: [img('image-a'), img('image-b')], queue: [{ id: 'q1', sessionId: 'c1', kind: 'question', state: 'escalated', createdAt: 1 }], askShows: [entry('q1', ['image-a', 'image-b'])] }));
    s.queue[0].state = 'done';
    settle(s);
    expect(s.containers.map((c) => c.place)).toEqual(['others', 'others']);
  });
  it('a partly shared group: the moving cards leave it, the other stays', () => {
    const s = grouped({
      containers: [img('image-a'), img('image-b'), img('image-x')],
      groups: [{ id: 'grp-q', name: 'Images', cards: ['image-a', 'image-b', 'image-x'], place: 'float' }],
      askShows: [entry('q1', ['image-a', 'image-b'])],
    });
    settle(s);
    s.queue = [];
    settle(s);
    expect(s.groups[0].cards).toEqual(['image-x']);
    expect(s.groups[0].place).toBe('float');
    expect(s.containers.filter((c) => c.place === 'others').map((c) => c.id)).toEqual(['image-a', 'image-b']);
  });
  it('a group the owner placed is left whole', () => {
    const s = settle(grouped({ groups: [{ id: 'grp-q', name: 'Images', cards: ['image-a', 'image-b', 'image-c'], place: 'float', pos: { x: 0.2, y: 0.2 } } as SuperGroup] }));
    s.queue = [];
    settle(s);
    expect(s.groups[0].place).toBe('float');
    expect(s.containers.every((c) => c.place === 'float')).toBe(true);
  });
  it('owner-placed, owner-sized, still shown, by:auto and non-picture cards never move', () => {
    const s = stage({
      containers: [
        img('image-pos', { pos: { x: 0.5, y: 0.5 } }), img('image-size', { sizeBy: 'owner', size: 'large' }), img('image-shown'), img('image-auto', { by: 'auto' }),
        { id: 'agenda-x', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float' }, { id: 'browser-c1', kind: 'browser', ref: 'c1', shape: 'square', place: 'float' }, img('image-go'),
      ],
      queue: [ask('q1')],
      askShows: [entry('q1', ['image-pos', 'image-size', 'image-shown', 'image-auto', 'agenda-x', 'browser-c1', 'image-go'])],
    });
    settle(s);
    s.queue = [];
    // The Super presents another set before the close: its cards stay shown.
    s.view = { mode: 'present', cards: ['image-shown', 'browser-c1'], layout: 'compare' };
    settle(s);
    expect(s.containers.filter((c) => c.place === 'others').map((c) => c.id)).toEqual(['image-go']);
    // The view was no longer the question's: left alone.
    expect(s.view.cards).toEqual(['image-shown', 'browser-c1']);
  });
  it('a card named by --show that existed before (not opened, not for a job) stays where it was', () => {
    const s = settle(stage({ containers: [img('image-a'), img('image-b')], queue: [ask('q1')], askShows: [{ item: 'q1', cards: ['image-a', 'image-b'], opened: ['image-b'], via: 'show' }] }));
    s.queue = [];
    settle(s);
    expect(s.containers.find((c) => c.id === 'image-a')?.place).toBe('float');
    expect(s.containers.find((c) => c.id === 'image-b')?.place).toBe('others');
  });
  it('the view floats only when it shows that question', () => {
    const s = settle(stage({ containers: [img('image-a'), img('image-b')], queue: [ask('q1')], askShows: [entry('q1', ['image-a', 'image-b'])] }));
    s.view = { mode: 'half', card: 'image-a' };
    s.queue = [];
    settle(s);
    expect(s.view).toEqual({ mode: 'half', card: 'image-a' });
  });
});

describe('presentCards and the stored view', () => {
  it('a same-set Super present keeps the question; another set drops it', () => {
    const s = stage({ containers: [img('image-a'), img('image-b'), img('image-c')], view: { mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare', ask: 'q1' } });
    presentCards(s, ['image-b', 'image-a']);
    expect(s.view.ask).toBe('q1');
    presentCards(s, ['image-a', 'image-c']);
    expect(s.view.ask).toBeUndefined();
  });
  it('sanitizeView and resolvePresent keep ask and by; a malformed askShows is dropped', () => {
    const cs = [img('image-a'), img('image-b')];
    expect(sanitizeView({ mode: 'present', cards: ['image-a', 'image-b'], ask: 'q1', by: 'owner' }, cs)).toMatchObject({ ask: 'q1', by: 'owner' });
    expect(sanitizeView({ mode: 'half', card: 'image-a', by: 'owner' }, cs)).toEqual({ mode: 'half', card: 'image-a', by: 'owner' });
    expect(resolvePresent({ cards: ['image-a'], ask: 'BAD ID!' }, cs)?.ask).toBeUndefined();
    const s = sanitizeSuperState({
      v: SUPER_STATE_VERSION, containers: cs,
      askShows: [{ item: 'q1', cards: ['image-a', 'image-zz'], opened: 'x', via: 'preview' }, { item: 'q2', cards: [], via: 'nope' }, 'junk', { item: 'Q!', cards: [], opened: [], via: 'show' }],
    });
    expect(s.askShows).toEqual([{ item: 'q1', cards: ['image-a'], opened: [], via: 'preview' }]);
  });
  it('a child\'s dev server never replaces a question\'s presentation (proactive showAuto)', () => {
    const s = stage({
      children: { c1: { sessionId: 'c1', brief: '', adopted: false, startedAt: 1 } },
      containers: [img('image-a'), img('image-b')], view: { mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare', ask: 'q1' },
    });
    applySignal(s, 'c1', { kind: 'devserver', url: 'http://localhost:5173/' }, 1);
    expect(s.view).toMatchObject({ mode: 'present', ask: 'q1' });
  });
});

describe('readPendingQuestion carries every question\'s option pictures', () => {
  it('images from all questions, raw', () => {
    const q = readPendingQuestion({
      type: 'control_request', request_id: 'r1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [
        { question: 'A?', options: [{ label: 'One', preview: '<img src="a.png">' }] },
        { question: 'B?', options: [{ label: 'Two', preview: '<img src="b.png">' }, null] },
      ] } },
    });
    expect(q?.images).toEqual([{ src: 'a.png', label: 'One' }, { src: 'b.png', label: 'Two' }]);
  });
});

describe('openImageCards: room', () => {
  it('room for 2 of 3: the last is cut; none: all cut', () => {
    const full = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `task-${i}`, kind: 'task' as const, ref: `t${i}`, shape: 'square' as const, place: 'others' as const, pos: { x: 0.1, y: 0.1 } }));
    const s = stage({ containers: full(MAX_CONTAINERS - 2) });
    const r = openImageCards(s, [{ ref: 'a.png' }, { ref: 'b.png' }, { ref: 'c.png' }], { now: 5 });
    expect(r.cut).toBe(1);
    expect(r.ids).toHaveLength(2);
    expect(r.made).toEqual(r.ids);
    const t = stage({ containers: full(MAX_CONTAINERS) });
    expect(openImageCards(t, [{ ref: 'a.png' }], { now: 5 })).toMatchObject({ ids: [], cut: 1 });
    expect(t.containers).toHaveLength(MAX_CONTAINERS);
  });
});

// ─── The routes ────────────────────────────────────────────────────────────────

let dir: string;
let root: string;
let project: string;
const SUPER = 'sup-askshow';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function makeVault(over: Partial<SuperState> = {}): void {
  project = join(dir, 'acme');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(project, 'mock'), { recursive: true });
  for (const f of ['a', 'b', 'c', 'd']) writeFileSync(join(project, `mock/${f}.png`), Buffer.from('89504e470d0a1a0a0000000d4948445200000640000003c0', 'hex'));
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...over }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-ask-show-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  mirror.frames = [];
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
  // A verb's answer is `{ ok, result }`; a refusal is `{ error, … }`.
  if (r.json.result && typeof r.json.result === 'object') r.json = r.json.result as Record<string, unknown>;
  return r;
}
async function layout(body: Record<string, unknown>) {
  const r = res();
  await handleSuperLayout(req(body), r, {}, root);
  return r;
}
const pictureAsk = (srcs: string[]) => ({
  ask: { title: 'Mockups', questions: [{ question: 'Which one?', options: srcs.map((src, i) => ({ label: `Option ${i + 1}`, preview: `<img src="${src}">` })) }] },
});
type Show = { cards: string[]; via?: string; state: string; reason?: string; cut?: number; skipped?: string[] };

describe('super ask presents its pictures and answers show', () => {
  it('previews → cards opened, grouped, presented with view.ask; the phone gets the new pictures once', async () => {
    makeVault();
    const r = await verb('ask', pictureAsk(['mock/a.png', './mock/b.png', 'https://x.test/c.png']));
    expect(r.status).toBe(200);
    const show = r.json.show as Show;
    expect(show).toMatchObject({ via: 'preview', state: 'presented', skipped: ['https://x.test/c.png'] });
    expect(show.cards).toHaveLength(2);
    const s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', cards: show.cards, ask: r.json.item });
    expect(s.containers.filter((c) => c.kind === 'image').map((c) => [c.ref, c.title, c.aspect])).toEqual([['mock/a.png', 'Option 1', 1.667], ['mock/b.png', 'Option 2', 1.667]]);
    expect(s.groups).toHaveLength(1);
    expect(mirror.frames).toHaveLength(1);
    expect(JSON.parse(mirror.frames[0]).items.map((i: { ref: string }) => i.ref)).toEqual(['mock/a.png', 'mock/b.png']);
  });
  it('the owner answers (any close): the stage floats, the group goes to Others', async () => {
    makeVault();
    const r = await verb('ask', pictureAsk(['mock/a.png', 'mock/b.png', 'mock/c.png']));
    expect(r.status).toBe(200);
    expect((await verb('queue-done', { item: r.json.item })).status).toBe(200);
    const s = await readSuperState(root);
    expect(s.view).toEqual({ mode: 'float' });
    expect(s.groups[0].place).toBe('others');
    expect(s.askShows).toBeUndefined();
  });
  it('--no-show: nothing opened or presented', async () => {
    makeVault();
    const r = await verb('ask', { ...pictureAsk(['mock/a.png', 'mock/b.png']), noShow: true });
    expect(r.json.show).toMatchObject({ state: 'none', reason: 'no_show' });
    expect((await readSuperState(root)).containers).toHaveLength(0);
    expect(mirror.frames).toHaveLength(0);
  });
  it('--show names cards: they are presented; an unknown card or the agenda is refused', async () => {
    makeVault({ containers: [img('image-a'), img('image-b'), { id: 'agenda-x', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float' }] });
    expect((await verb('ask', { text: 'Which?', show: ['image-zz'] })).status).toBe(404);
    expect((await verb('ask', { text: 'Which?', show: ['agenda-x'] })).status).toBe(400);
    const r = await verb('ask', { text: 'Which?', show: ['image-a', 'image-b'] });
    expect(r.json.show).toMatchObject({ via: 'show', state: 'presented', cards: ['image-a', 'image-b'] });
  });
  it('the Super forgot everything: its last picture set within 10 minutes (recent)', async () => {
    makeVault();
    expect((await verb('open', { kind: 'image', refs: ['mock/a.png', 'mock/b.png'] })).status).toBe(200);
    const r = await verb('ask', { text: 'Which one?', options: ['A', 'B'] });
    expect(r.json.show).toMatchObject({ via: 'recent', state: 'presented' });
    expect((r.json.show as Show).cards).toHaveLength(2);
  });
  it('an owner view: answered skipped (owner_layout), his view untouched', async () => {
    makeVault({ containers: [{ id: 'task-x', kind: 'task', ref: 'x', shape: 'square', place: 'float' }] });
    expect((await layout({ view: { mode: 'half', card: 'task-x' } })).status).toBe(200);
    expect((await readSuperState(root)).view).toEqual({ mode: 'half', card: 'task-x', by: 'owner' });
    const r = await verb('ask', pictureAsk(['mock/a.png', 'mock/b.png']));
    expect(r.json.show).toMatchObject({ state: 'skipped', reason: 'owner_layout' });
    expect((await readSuperState(root)).view).toEqual({ mode: 'half', card: 'task-x', by: 'owner' });
  });
  it('room for 2 of 3: cut 1, the 2 presented; `open` with no room still refuses whole', async () => {
    const tasks = Array.from({ length: MAX_CONTAINERS - 2 }, (_, i) => ({ id: `task-${i}`, kind: 'task', ref: `t${i}`, shape: 'square', place: 'others', pos: { x: 0.1, y: 0.1 } }));
    makeVault({ containers: tasks as SuperContainer[] });
    expect((await verb('open', { kind: 'image', refs: ['mock/a.png', 'mock/b.png', 'mock/c.png'] })).status).toBe(409);
    const r = await verb('ask', pictureAsk(['mock/a.png', 'mock/b.png', 'mock/c.png']));
    expect(r.json.show).toMatchObject({ state: 'presented', cut: 1 });
    expect((r.json.show as Show).cards).toHaveLength(2);
  });
  it('a second ask refused by ask_open opens no card and mirrors nothing', async () => {
    makeVault({ queue: [ask('q-open', { sessionId: SUPER })] });
    const r = await verb('ask', pictureAsk(['mock/a.png', 'mock/b.png']));
    expect(r.json.error).toBe('ask_open');
    expect((await readSuperState(root)).containers).toHaveLength(0);
    expect(mirror.frames).toHaveLength(0);
  });
  it('a full queue: the store trims the oldest, never the new ask (queue_full stays a guard, apart from ask_open)', async () => {
    const queue = Array.from({ length: 200 }, (_, i) => ({ id: `q-${i}`, sessionId: 'c1', kind: 'stuck', state: 'pending', createdAt: i + 1 }));
    makeVault({ queue: queue as SuperQueueItem[] });
    const r = await verb('ask', pictureAsk(['mock/a.png', 'mock/b.png']));
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.queue.some((q) => q.id === r.json.item)).toBe(true);
    expect(s.queue.some((q) => q.id === 'q-0')).toBe(false);
  });
  it('an entry whose item left the queue (a MAX_QUEUE trim, a sweep) is put back on the next write', () => {
    const s = settle(stage({ containers: [img('image-a'), img('image-b')], queue: [ask('q1')], askShows: [entry('q1', ['image-a', 'image-b'])] }));
    s.queue = [];
    settle(s);
    expect(s.containers.map((c) => c.place)).toEqual(['others', 'others']);
  });
});

describe('super queue ask: a child\'s pictures', () => {
  it('the child\'s own AskUserQuestion previews; its answer puts them back', async () => {
    makeVault({
      children: { c1: { sessionId: 'c1', brief: 'mockups', adopted: false, startedAt: 1 } },
      queue: [{ id: 'q-c1', sessionId: 'c1', kind: 'question', requestId: 'r1', state: 'delivered', createdAt: 1 }],
    });
    const h = registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    h.observe({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A', preview: '<img src="mock/a.png">' }, { label: 'B', preview: '<img src="mock/b.png">' }] }] } } });
    const r = await verb('queue-ask', { item: 'q-c1', text: 'Which mockup?' });
    expect(r.json.show).toMatchObject({ via: 'preview', state: 'presented' });
    let s = await readSuperState(root);
    expect(s.view).toMatchObject({ mode: 'present', ask: 'q-c1' });
    expect(s.containers.every((c) => c.forChild === 'c1')).toBe(true);
    // The child answered (queue done by any path).
    await verb('queue-done', { item: 'q-c1' });
    s = await readSuperState(root);
    expect(s.view.mode).toBe('float');
    expect(s.groups[0]?.place ?? s.containers[0].place).toBe('others');
  });
  it('a worktree child\'s preview outside the project is skipped and reported; its --for pictures are the fallback', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'super-ask-show-wt-'));
    writeFileSync(join(wt, 'shot.png'), 'x');
    makeVault({
      children: { c1: { sessionId: 'c1', brief: 'mockups', adopted: false, startedAt: 1, worktree: wt } },
      queue: [{ id: 'q-c1', sessionId: 'c1', kind: 'question', requestId: 'r1', state: 'delivered', createdAt: 1 }],
    });
    expect((await verb('open', { kind: 'image', refs: ['mock/a.png', 'mock/b.png'], for: 'c1' })).status).toBe(200);
    const h = registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    h.observe({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A', preview: '<img src="shot.png">' }] }] } } });
    const r = await verb('queue-ask', { item: 'q-c1', text: 'Which?' });
    expect(r.json.show).toMatchObject({ via: 'recent', skipped: ['shot.png'], state: 'presented' });
    rmSync(wt, { recursive: true, force: true });
  });
});

describe('the owner\'s layout POST', () => {
  it('a raw present view: stamped by owner, its question dropped; his same-set layout pick keeps it; exit floats', async () => {
    makeVault({ containers: [img('image-a'), img('image-b')], view: { mode: 'present', cards: ['image-a', 'image-b'], layout: 'compare', ask: 'q1' } });
    expect((await layout({ presentLayout: { cards: ['image-a', 'image-b'], layout: 'grid' } })).status).toBe(200);
    expect((await readSuperState(root)).view).toMatchObject({ layout: 'grid', layoutBy: 'owner', ask: 'q1' });
    await layout({ view: { mode: 'present', cards: ['image-a', 'image-b'], ask: 'q1' } });
    const v = (await readSuperState(root)).view;
    expect(v.by).toBe('owner');
    expect(v.ask).toBeUndefined();
    await layout({ exit: { cards: ['image-a', 'image-b'], closing: [] } });
    expect((await readSuperState(root)).view).toEqual({ mode: 'float' });
  });
});
