/**
 * Named presentation layouts (task super-sahnesinde-adli-sunum-duzenleri…, plan-r2 D2-D5, D9,
 * D10, R2-E1/E2/E3): `present` takes 1-8 cards and a layout; the cards pick one when none is
 * given; the store always writes the resolved layout and re-resolves it when a card leaves; the
 * owner's pick for a card set wins over the agent's re-present of the same set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-present-layout-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState, updateSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { createProgram } from '../../src/cli/index.js';

let dir: string;
let root: string;
const SUPER = 'sup-layouts';
const CHILD = 'child-pocket-ledger';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'task', ref: `ref-${id}`, shape: 'square', place: 'float', ...extra });
// A child building a site: its chat, its dev-server page (`of` = the chat) and its live browser.
const chat = card('chat-1', { kind: 'chat', ref: CHILD });
// The server opened the site for that child (`by: 'auto'`): the store keeps `of` only then.
const site = card('web-1', { kind: 'web', ref: 'http://127.0.0.1:5173/', by: 'auto', of: CHILD });
const browser = card('br-1', { kind: 'browser', ref: CHILD });
const agenda = card('agenda-1', { kind: 'agenda', ref: 'agenda' });
const tasks = Array.from({ length: 9 }, (_, i) => card(`t${i}`));

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    containers: [chat, site, browser, agenda, ...tasks],
    children: { [CHILD]: { sessionId: CHILD, brief: 'Pocket Ledger site', adopted: false, startedAt: 1 } },
    ...state,
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-present-layout-'));
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

function req(body: unknown, headers: Record<string, string>): IncomingMessage {
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
async function present(containers: string[], layout?: string) {
  const r = res();
  await handleSuperVerb(req({ containers, ...(layout !== undefined ? { layout } : {}) }, { 'x-dreamcontext-window-token': token }), r, { verb: 'present' });
  return r;
}
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}
async function owner(body: Record<string, unknown>) {
  const r = res();
  await handleSuperLayout(req(body, {}), r, {}, root);
  return r;
}
const onDisk = (): SuperState => JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')) as SuperState;
const message = (r: { json: Record<string, unknown> }) => JSON.stringify(r.json);
const ids = (n: number) => tasks.slice(0, n).map((c) => c.id);

describe('defaults: without --layout the cards pick it', () => {
  it('1 spotlight, 2 compare, 3-4 grid, 5-8 filmstrip', async () => {
    makeVault();
    for (const [n, layout] of [[1, 'spotlight'], [2, 'compare'], [3, 'grid'], [4, 'grid'], [5, 'filmstrip'], [8, 'filmstrip']] as const) {
      const r = await present(ids(n));
      expect(r.status, `${n}`).toBe(200);
      expect(onDisk().view, `${n}`).toEqual({ mode: 'present', cards: ids(n), layout });
      expect(((r.json.result as Record<string, unknown>).view as SuperState['view']).layout).toBe(layout);
    }
  });

  it('a child\'s page with its chat (and browser) is review; another child\'s page is not', async () => {
    makeVault();
    await present([site.id, chat.id]);
    expect(onDisk().view.layout).toBe('review');
    await present([site.id, chat.id, browser.id]);
    expect(onDisk().view.layout).toBe('review');
    await present([browser.id, chat.id]);
    expect(onDisk().view.layout).toBe('review');
    makeVault({ containers: [chat, card('web-2', { kind: 'web', ref: 'http://127.0.0.1:5174/', by: 'auto', of: 'someone-else' })],
      children: { [CHILD]: { sessionId: CHILD, brief: 'a', adopted: false, startedAt: 1 }, 'someone-else': { sessionId: 'someone-else', brief: 'b', adopted: false, startedAt: 1 } } as SuperState['children'] });
    await present(['web-2', chat.id]);
    expect(onDisk().view.layout).toBe('compare');
  });

  it('the agenda counts as a card, never makes review; [child, agenda] is compare', async () => {
    makeVault();
    await present([chat.id, agenda.id]);
    expect(onDisk().view).toEqual({ mode: 'present', cards: [chat.id, agenda.id], layout: 'compare' });
    await present([site.id, chat.id, agenda.id]);
    expect(onDisk().view.layout).toBe('grid');
  });
});

describe('the route refuses what a layout cannot take', () => {
  it('a wrong count names the range; an unknown name lists the five; more than 8 is refused', async () => {
    makeVault();
    let r = await present(ids(3), 'compare');
    expect(r.status).toBe(400);
    expect(message(r)).toContain('compare shows exactly 2 cards');
    r = await present(ids(2), 'spotlight');
    expect(r.status).toBe(400);
    expect(message(r)).toContain('spotlight shows exactly 1 card');
    r = await present(ids(5), 'grid');
    expect(r.status).toBe(400);
    expect(message(r)).toContain('grid shows 2-4 cards');
    r = await present(ids(2), 'carousel');
    expect(r.status).toBe(400);
    expect(message(r)).toContain('spotlight, compare, grid, filmstrip, review');
    r = await present(ids(9));
    expect(r.status).toBe(400);
    expect(r.json.error ?? r.json.code ?? message(r)).toBeTruthy();
    expect(onDisk().view).toEqual({ mode: 'float' });
  });

  it('review on cards that are not one page plus that child\'s chat answers 400', async () => {
    makeVault();
    let r = await present(ids(2), 'review');
    expect(r.status).toBe(400);
    expect(message(r)).toContain('review shows a child');
    r = await present([site.id, chat.id, agenda.id], 'review');
    expect(r.status).toBe(400);
    r = await present([site.id, chat.id], 'review');
    expect(r.status).toBe(200);
    expect(onDisk().view.layout).toBe('review');
  });

  it('an explicit layout that fits is kept: two cards as a grid or a filmstrip', async () => {
    makeVault();
    await present(ids(2), 'grid');
    expect(onDisk().view.layout).toBe('grid');
    await present(ids(2), 'filmstrip');
    expect(onDisk().view.layout).toBe('filmstrip');
    await present([site.id, chat.id], 'compare');
    expect(onDisk().view.layout).toBe('compare');
  });

  it('a 6-card present without --layout round-trips the store as 6 cards in filmstrip', async () => {
    makeVault();
    expect((await present(ids(6))).status).toBe(200);
    resetSuperIndex();
    expect((await readSuperState(root)).view).toEqual({ mode: 'present', cards: ids(6), layout: 'filmstrip' });
  });
});

describe('one resolver: the store writes and re-resolves the layout', () => {
  it('closing, stacking or ending a presented card re-resolves; review whose chat closes becomes compare', async () => {
    makeVault();
    await present([site.id, chat.id, browser.id]);
    expect(onDisk().view.layout).toBe('review');
    await owner({ closed: [chat.id] });
    expect(onDisk().view).toEqual({ mode: 'present', cards: [site.id, browser.id], layout: 'compare' });
    await verb('stack', { container: browser.id });
    expect(onDisk().view).toEqual({ mode: 'present', cards: [site.id], layout: 'spotlight' });
    makeVault();
    await present(ids(5));
    await verb('close', { container: 't0' });
    // Four left: a filmstrip still takes them (the range rule), so it stays a filmstrip.
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['t1', 't2', 't3', 't4'], layout: 'filmstrip' });
  });

  it('a re-resolve drops the owner\'s mark and the chat bar; a layout that still fits keeps both', async () => {
    makeVault({ view: { mode: 'present', cards: ['t0', 't1', 't2'], layout: 'grid', layoutBy: 'owner', chat: 'bar' } });
    await owner({ closed: ['t2'] });
    // A grid left with 2 cards stays a grid (the range rule), the owner's marks with it.
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['t0', 't1'], layout: 'grid', layoutBy: 'owner', chat: 'bar' });
    await owner({ closed: ['t1'] });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['t0'], layout: 'spotlight' });
  });

  it('an old super.json without a layout reads as the default; a hostile layout is replaced', () => {
    const containers = [chat, site, ...tasks.slice(0, 5)];
    const children = { [CHILD]: { sessionId: CHILD, brief: 'a', adopted: false, startedAt: 1 } };
    const read = (view: unknown) => sanitizeSuperState({ ...emptySuperState(), containers, children, view } as unknown).view;
    expect(read({ mode: 'present', cards: ['t0'] })).toEqual({ mode: 'present', cards: ['t0'], layout: 'spotlight' });
    expect(read({ mode: 'present', cards: [site.id, chat.id] })).toEqual({ mode: 'present', cards: [site.id, chat.id], layout: 'review' });
    expect(read({ mode: 'present', cards: ids(5) })).toEqual({ mode: 'present', cards: ids(5), layout: 'filmstrip' });
    expect(read({ mode: 'present', cards: ['t0', 't1'], layout: '<script>', layoutBy: 'agent', chat: 'side' }))
      .toEqual({ mode: 'present', cards: ['t0', 't1'], layout: 'compare' });
    expect(read({ mode: 'half', card: 't0', layout: 'grid' })).toEqual({ mode: 'half', card: 't0' });
  });

  it('a write through updateSuperState re-resolves too (the stack/succession paths)', async () => {
    makeVault({ view: { mode: 'present', cards: [site.id, chat.id], layout: 'review' } });
    const st = await updateSuperState(root, (s) => { s.containers = s.containers.filter((c) => c.id !== chat.id); });
    expect(st.view).toEqual({ mode: 'present', cards: [site.id], layout: 'spotlight' });
  });
});

describe('the owner wins for his card set (D9, D10)', () => {
  it('presentLayout applies only to the same set and marks it his', async () => {
    makeVault();
    await present(ids(3));
    expect((await owner({ presentLayout: { layout: 'filmstrip', cards: ['t2', 't0', 't1'] } })).status).toBe(200);
    expect(onDisk().view).toEqual({ mode: 'present', cards: ids(3), layout: 'filmstrip', layoutBy: 'owner' });
    // A pick for cards no longer presented is ignored.
    await owner({ presentLayout: { layout: 'grid', cards: ['t0', 't1'] } });
    expect(onDisk().view.layout).toBe('filmstrip');
    // A pick the cards cannot take is undone by the store.
    await owner({ presentLayout: { layout: 'review', cards: ids(3) } });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ids(3), layout: 'grid' });
  });

  it('the agent re-presenting the same set (any order, with or without --layout) keeps it: kept owner_layout', async () => {
    makeVault();
    await present(ids(3));
    await owner({ presentLayout: { layout: 'filmstrip', cards: ids(3) } });
    await owner({ chat: { value: 'bar', cards: ids(3) } });
    let r = await present(['t2', 't1', 't0']);
    expect((r.json.result as Record<string, unknown>).kept).toBe('owner_layout');
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['t2', 't1', 't0'], layout: 'filmstrip', layoutBy: 'owner', chat: 'bar' });
    r = await present(ids(3), 'grid');
    expect(r.status).toBe(200);
    expect((r.json.result as Record<string, unknown>).kept).toBe('owner_layout');
    expect(onDisk().view.layout).toBe('filmstrip');
    // Another set is a new presentation: the agent's layout, his marks gone.
    r = await present(ids(2));
    expect((r.json.result as Record<string, unknown>).kept).toBeUndefined();
    expect(onDisk().view).toEqual({ mode: 'present', cards: ids(2), layout: 'compare' });
  });

  it('chat and exit apply only to the same set; an exit also lands over a close still on its way', async () => {
    makeVault();
    await present(ids(1));
    await owner({ chat: { value: 'bar', cards: ['t9'] } });
    expect(onDisk().view.chat).toBeUndefined();
    await owner({ chat: { value: 'bar', cards: ids(1) } });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ids(1), layout: 'spotlight', chat: 'bar' });
    expect(onDisk().view.layoutBy).toBeUndefined();
    await owner({ chat: { value: null, cards: ids(1) } });
    expect(onDisk().view.chat).toBeUndefined();
    await owner({ exit: { cards: ['t5'] } });
    expect(onDisk().view.mode).toBe('present');
    await owner({ exit: { cards: ids(1) } });
    expect(onDisk().view).toEqual({ mode: 'float' });
    await present(ids(3));
    // He closed t2 (not landed yet), then pressed Esc over the two he still saw.
    await owner({ exit: { cards: ['t0', 't1'], closing: ['t2'] } });
    expect(onDisk().view).toEqual({ mode: 'float' });
  });

  it('a malformed whole view from the owner still floats the stage (no 500)', async () => {
    makeVault();
    await present(ids(2));
    for (const view of [null, 'present', 7]) {
      expect((await owner({ view })).status, JSON.stringify(view)).toBe(200);
      expect(onDisk().view).toEqual({ mode: 'float' });
      await present(ids(2));
    }
  });

  it('a whole owner view never carries his layout marks (only the server\'s `by: owner`); malformed fields are ignored', async () => {
    makeVault();
    await owner({ view: { mode: 'present', cards: ids(2), layout: 'grid', layoutBy: 'owner', chat: 'bar', ask: 'q-1', by: 'nobody' } });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ids(2), layout: 'grid', by: 'owner' });
    expect((await owner({ presentLayout: { layout: 'grid', cards: 't0' }, chat: { value: 'side', cards: ids(2) }, exit: 'now' })).status).toBe(200);
    expect(onDisk().view).toEqual({ mode: 'present', cards: ids(2), layout: 'grid', by: 'owner' });
  });
});

describe('the CLI', () => {
  it('present takes --layout and its help names the five and 1-8', () => {
    const present = createProgram().commands.find((c) => c.name() === 'super')!.commands.find((c) => c.name() === 'present')!;
    expect(present.options.map((o) => o.long)).toContain('--layout');
    const help = present.helpInformation();
    for (const name of ['spotlight', 'compare', 'grid', 'filmstrip', 'review', '1-8']) expect(help).toContain(name);
  });
});
