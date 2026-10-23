/**
 * The owner's presentation gestures never race the agent (plan-r2 D9, R2-E3, R3(b)/(d)): each
 * travels set-guarded (`presentLayout`, `chat`, `exit` name the cards he saw). The window shows
 * the patch at once and re-applies it over pushes until `patchEchoed` says the push carries it;
 * a push that presents ANOTHER card set reads as echoed, so the stale pick is dropped, never laid
 * over the agent's new set. The server applies the same fields only to the same set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-layout-race-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, resetSuperIndex } from '../../src/lib/super/store.js';
import { PRESENT_LAYOUTS, emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { applyLayoutPatch, patchEchoed, type LayoutPatch } from '../../dashboard/src/components/sleepy/super/superLayout.js';
import type { SuperContainer, SuperView } from '../../dashboard/src/lib/superTypes.js';

const CHILD = 'child-race';
const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'task', ref: `ref-${id}`, shape: 'square', place: 'float', ...extra });
const tasks = Array.from({ length: 8 }, (_, i) => card(`t${i}`));
const chat = card('chat-1', { kind: 'chat', ref: CHILD });
const site = card('web-1', { kind: 'web', ref: 'http://127.0.0.1:5173/', by: 'auto', of: CHILD });
const containers = [...tasks, chat, site];
const ids = (n: number) => tasks.slice(0, n).map((c) => c.id);
const staged = (view: SuperView) => ({ containers, groups: [], view });
// What the server stores for this patch (the window's mirror of its semantics, pinned against the
// route below and in super-present-layout.test.ts).
const server = (st: ReturnType<typeof staged>, patch: LayoutPatch) => applyLayoutPatch(st, patch);

describe('the window: a pending owner gesture over the agent\'s pushes', () => {
  it('a pick, a bar toggle or an exit followed by a push with another card set is dropped, never re-applied', () => {
    const before = staged({ mode: 'present', cards: ids(3), layout: 'grid' });
    const gestures: LayoutPatch[] = [
      { presentLayout: { layout: 'filmstrip', cards: ids(3) } },
      { chat: { value: 'bar', cards: ids(3) } },
      { exit: { cards: ids(3), closing: [] } },
    ];
    const pushed = staged({ mode: 'present', cards: ['t5', 't6'], layout: 'compare' });
    for (const g of gestures) {
      expect(patchEchoed(before, g), JSON.stringify(g)).toBe(false);
      expect(patchEchoed(pushed, g), JSON.stringify(g)).toBe(true);
      // Even applied over the new set, it changes nothing there.
      expect(applyLayoutPatch(pushed, g).view, JSON.stringify(g)).toEqual(pushed.view);
    }
  });

  it('patchEchoed(server(patch), patch) holds for every preset, the bar toggle, an 8-card filmstrip and an old record', () => {
    const cases: [SuperView, LayoutPatch][] = [];
    for (const layout of PRESENT_LAYOUTS) {
      const cards = layout === 'spotlight' ? ids(1) : layout === 'review' ? [site.id, chat.id] : ids(2);
      cases.push([{ mode: 'present', cards, layout: layout === 'spotlight' ? 'spotlight' : 'compare' }, { presentLayout: { layout, cards } }]);
    }
    cases.push([{ mode: 'present', cards: ids(1), layout: 'spotlight' }, { chat: { value: 'bar', cards: ids(1) } }]);
    cases.push([{ mode: 'present', cards: ids(1), layout: 'spotlight', chat: 'bar' }, { chat: { value: null, cards: ids(1) } }]);
    cases.push([{ mode: 'present', cards: ids(8), layout: 'filmstrip' }, { presentLayout: { layout: 'filmstrip', cards: [...ids(8)].reverse() } }]);
    cases.push([{ mode: 'present', cards: ids(8), layout: 'filmstrip' }, { exit: { cards: ids(8), closing: [] } }]);
    // An old record (no layout): the window resolves it exactly like the store.
    cases.push([{ mode: 'present', cards: ids(5) }, { presentLayout: { layout: 'filmstrip', cards: ids(5) } }]);
    cases.push([{ mode: 'present', cards: ids(2) }, { view: { mode: 'present', cards: ids(3) } }]);
    for (const [view, patch] of cases) {
      const after = server(staged(view), patch);
      expect(patchEchoed(after, patch), JSON.stringify([view, patch])).toBe(true);
    }
    // The 8-card filmstrip really holds 8.
    expect(server(staged({ mode: 'present', cards: ids(8) }), {}).view).toEqual({ mode: 'present', cards: ids(8), layout: 'filmstrip' });
  });

  it('a removal re-resolves on the window with the store\'s rules (range and review identity)', () => {
    const review = staged({ mode: 'present', cards: [site.id, chat.id], layout: 'review', layoutBy: 'owner', chat: 'bar' });
    expect(applyLayoutPatch(review, { closed: [chat.id] }).view).toEqual({ mode: 'present', cards: [site.id], layout: 'spotlight' });
    const grid = staged({ mode: 'present', cards: ids(3), layout: 'grid', layoutBy: 'owner' });
    expect(applyLayoutPatch(grid, { closed: ['t2'] }).view).toEqual({ mode: 'present', cards: ids(2), layout: 'grid', layoutBy: 'owner' });
  });

  it('a close then Esc: the exit names the close still on its way, and lands either order', () => {
    const st = staged({ mode: 'present', cards: ids(3), layout: 'grid' });
    const exit: LayoutPatch = { exit: { cards: ids(2), closing: ['t2'] } };
    expect(applyLayoutPatch(st, exit).view).toEqual({ mode: 'float' });
    const closedFirst = applyLayoutPatch(st, { closed: ['t2'] });
    expect(applyLayoutPatch(closedFirst, exit).view).toEqual({ mode: 'float' });
  });
});

describe('the server: the same fields, the same set rule', () => {
  let dir: string;
  let root: string;
  let token = '';
  const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-layout-race-'));
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    process.env.DREAMCONTEXT_DESKTOP = '1';
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-race', enabled: true, containers,
      children: { [CHILD]: { sessionId: CHILD, brief: 'a', adopted: false, startedAt: 1 } },
    }));
    token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: 'sup-race', mode: 'super' }).token;
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
  function res(): ServerResponse & { status: number } {
    const out = { status: 0 } as ServerResponse & { status: number };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: () => void }).end = () => {};
    return out;
  }
  const present = (cards: string[]) => handleSuperVerb(req({ containers: cards }, { 'x-dreamcontext-window-token': token }), res(), { verb: 'present' });
  const owner = (body: Record<string, unknown>) => handleSuperLayout(req(body, {}), res(), {}, root);
  const onDisk = (): SuperState => JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')) as SuperState;

  it('a pick for the old set that lands after the agent presented another is ignored', async () => {
    await present(ids(3));
    await present(['t5', 't6']);
    await owner({ presentLayout: { layout: 'filmstrip', cards: ids(3) } });
    expect(onDisk().view).toEqual({ mode: 'present', cards: ['t5', 't6'], layout: 'compare' });
  });

  it('a bar toggle racing present: both orders end on the agent\'s set, the bar only on the set he saw', async () => {
    await present(ids(1));
    await Promise.all([owner({ chat: { value: 'bar', cards: ids(1) } }), present(['t5', 't6'])]);
    expect(onDisk().view.cards).toEqual(['t5', 't6']);
    expect(onDisk().view.chat).toBeUndefined();
    await present(ids(1));
    await owner({ chat: { value: 'bar', cards: ids(1) } });
    await present(ids(1));
    expect(onDisk().view).toEqual({ mode: 'present', cards: ids(1), layout: 'spotlight', chat: 'bar' });
  });
});
