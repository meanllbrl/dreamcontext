/**
 * The Super Agent's "New session" (task super-agent-devrini-…): the owner's route queues ONE solo
 * `[super fresh]` turn; the pump delivers it past the single-question rule; the super's pane then
 * rotates at that turn's result — through its own `super handoff` record, or a fallback record
 * when it wrote none — and the inbox holds every event until the fresh session has answered.
 * Children, pool, cards, groups and view never change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-fresh-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, attachSuperInbox, deliveryBlocker, nextBatch, pumpSuper, startSuperInbox, superEventText,
  superTurnEnded, superView, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import {
  ROTATE_HOLD_MAX_MS, _resetFreshSession, clearFresh, hasFreshLatch, isRotating, markFreshDelivered, startRotating, stopRotating,
} from '../../src/lib/super/fresh-session.js';
import { handleSuperFresh } from '../../src/server/routes/super.js';
import { registerLiveChat, unregisterLiveChat, type LiveChatEntry } from '../../src/server/routes/agent-chat-live.js';
import { handleRotationAtResult, rotationFinished } from '../../src/server/routes/handoff-rotation.js';
import { readHandoffRecord, rotationDecision, writeHandoffRecord, type HandoffRecord } from '../../src/lib/context-watch.js';
import type { HandoffRun } from '../../src/lib/handoff-progress.js';

let dir: string;
let root: string;
const SUPER = 'sup-fresh-1';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const child = (sid: string) => ({ sessionId: sid, brief: `brief of ${sid}`, adopted: true, startedAt: 1 });
const BASE: Partial<SuperState> = {
  children: { c1: child('c1'), c2: child('c2') },
  pool: [{ id: 'p-abc-12345678', title: 'Later', prompt: 'do it later', hash: 'a'.repeat(40), createdAt: 1 }] as unknown as SuperState['pool'],
  containers: [
    { id: 'chat-aaaaaaaaaaaa', kind: 'chat', ref: 'c1', shape: 'tall', place: 'float' },
    { id: 'chat-bbbbbbbbbbbb', kind: 'chat', ref: 'c2', shape: 'tall', place: 'others' },
  ] as SuperState['containers'],
};

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...BASE, ...state }));
}

const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
/** A super chat past its starting grace: it has run one turn. */
const idleSuper = () => { const h = reg(SUPER, 'super'); h.userSent(''); h.observe({ type: 'result' }); return h; };
const askQuestion = (h: ChatHandle, requestId: string) => h.observe({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which database?', options: [{ label: 'postgres' }, { label: 'sqlite' }] }] } },
});

function fakeInbox(over: Partial<SuperInbox> = {}) {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`,
    sessionId: SUPER,
    attached: () => true,
    idle: () => true,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
    ...over,
  };
  return { inbox, delivered };
}

const item = (o: Partial<SuperQueueItem>): SuperQueueItem => ({ id: 'q-x', sessionId: SUPER, kind: 'fresh', state: 'pending', createdAt: 1, ...o });
const W = { timeout: 10_000 };

/** A live super chat (the route's "running" check), and a window channel capturing pushes. */
let liveEntry: LiveChatEntry | null = null;
let frames: Array<Record<string, unknown>> = [];
let releaseToken: (() => void) | null = null;
function superLive(): void {
  liveEntry = { conversationId: SUPER, projectRoot: dir, busy: false, turnStartedAt: null, lastTurnEndedAt: null, adopt: () => false, supersede: () => () => undefined };
  registerLiveChat(liveEntry);
  const minted = mintWindowToken({ vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super', send: (f: Record<string, unknown>) => { frames.push(f); return true; } } as never);
  releaseToken = minted.release;
}

function req(): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(''); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function press() {
  const r = res();
  await handleSuperFresh(req(), r, {}, root);
  return r;
}
const freshItems = async () => (await readSuperState(root)).queue.filter((q) => q.kind === 'fresh');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-fresh-'));
  process.env.DREAMCONTEXT_DESKTOP = '1';
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  _resetFreshSession();
  resetWindowControl();
  frames = [];
});
afterEach(async () => {
  vi.useRealTimers();
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([_superInboxDrained(), new Promise((r) => { cap = setTimeout(r, 8_000); })]);
  clearTimeout(cap);
  if (liveEntry) unregisterLiveChat(liveEntry);
  liveEntry = null;
  releaseToken?.();
  releaseToken = null;
  _resetSuperInbox();
  _resetFreshSession();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/super/fresh', () => {
  it('409 off when not handed over, or the super chat is not running', async () => {
    makeVault({ enabled: false });
    superLive();
    expect((await press()).status).toBe(409);
    makeVault();
    if (liveEntry) unregisterLiveChat(liveEntry);
    const r = await press();
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('off');
    expect(await freshItems()).toHaveLength(0);
  });

  it('queues exactly one solo fresh item for the super session; a second press is refused', async () => {
    makeVault();
    superLive();
    const r = await press();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ queued: true });
    const items = await freshItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: SUPER, state: 'pending' });
    const again = await press();
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('rotating');
    expect(await freshItems()).toHaveLength(1);
  });

  it('409 rotating while the pane rotates', async () => {
    makeVault();
    superLive();
    startRotating(SUPER);
    const r = await press();
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('rotating');
  });

  it('a delivered fresh item nobody owns (a restart) is swept done, and the press queues again', async () => {
    makeVault({ queue: [item({ id: 'q-old', state: 'delivered', batch: 'b-old-1' })] });
    superLive();
    const r = await press();
    expect(r.status).toBe(200);
    const items = await freshItems();
    expect(items.find((q) => q.id === 'q-old')?.state).toBe('done');
    expect(items.filter((q) => q.state === 'pending')).toHaveLength(1);
  });

  it('a delivered fresh item the latch still owns is not swept: the press is refused', async () => {
    makeVault({ queue: [item({ id: 'q-live', state: 'delivered', batch: 'b-live-1' })] });
    superLive();
    markFreshDelivered(SUPER, 'b-live-1');
    expect((await press()).status).toBe(409);
    expect((await freshItems()).find((q) => q.id === 'q-live')?.state).toBe('delivered');
  });
});

describe('the fresh turn', () => {
  it('is solo, after a handover and before a recap', () => {
    const state = { ...emptySuperState(), queue: [
      item({ id: 'q-r', kind: 'recap', createdAt: 1 }), item({ id: 'q-f', kind: 'fresh', createdAt: 3 }),
      item({ id: 'q-q', kind: 'done', sessionId: 'c1', createdAt: 0 }),
    ] } as SuperState;
    expect(nextBatch(state).items.map((q) => q.id)).toEqual(['q-f']);
    state.queue.push(item({ id: 'q-h', kind: 'handover', createdAt: 9 }));
    expect(nextBatch(state).items.map((q) => q.id)).toEqual(['q-h']);
  });

  it('tells the super to write `super handoff` and lists the live children', () => {
    makeVault();
    const s = { ...emptySuperState(), session: SUPER, ...BASE } as SuperState;
    const text = superEventText(root, s, item({ id: 'q-f1' }));
    expect(text.startsWith('[super fresh] item=q-f1 children=2')).toBe(true);
    expect(text).toContain('dreamcontext super handoff --done');
    expect(text).toContain('c1');
  });

  it('goes through while the super\'s own ask is open (the ask closes, its text rides the turn) and a child question is escalated (it stays)', async () => {
    makeVault({ queue: [
      item({ id: 'q-ask', kind: 'ask', state: 'escalated', ownerText: 'Merge to main now?' }),
      item({ id: 'q-cq', kind: 'question', sessionId: 'c1', state: 'escalated', requestId: 'r-1', ownerText: 'Which database?' }),
      item({ id: 'q-f', kind: 'fresh', createdAt: Date.now() }),
    ] });
    // The child is asking before the inbox starts, so its escalated question is still true.
    const c1 = reg('c1');
    askQuestion(c1, 'r-1');
    idleSuper();
    await startSuperInbox([root]);
    // The fresh turn is running: the bridge is busy until its result.
    const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
    const { inbox } = fakeInbox({
      idle: () => delivered.length === 0,
      deliver: async (text, event) => { delivered.push({ text, event }); return true; },
    });
    attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(delivered[0].event.kind).toBe('fresh');
    expect(delivered[0].text).toContain('Merge to main now?');
    expect(delivered[0].text).toContain('Which database?');
    await vi.waitFor(async () => {
      const q = (await readSuperState(root)).queue;
      expect(q.find((x) => x.id === 'q-f')?.state).toBe('delivered');
      expect(q.find((x) => x.id === 'q-ask')?.state).toBe('done');
      expect(q.find((x) => x.id === 'q-cq')?.state).toBe('escalated');
    }, W);
  });

  it('a pure exit before its result sends it straight to done and clears the latch (never re-sent)', async () => {
    makeVault({ queue: [item({ id: 'q-f', createdAt: Date.now() })] });
    await startSuperInbox([root]);
    idleSuper();
    const { inbox, delivered } = fakeInbox();
    const detach = attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    await vi.waitFor(async () => expect((await freshItems())[0].state).toBe('delivered'), W);
    markFreshDelivered(SUPER, 'b');
    detach();
    expect(hasFreshLatch(SUPER)).toBe(false);
    await vi.waitFor(async () => expect((await freshItems())[0].state).toBe('done'), W);
    const next = fakeInbox();
    attachSuperInbox(next.inbox);
    await new Promise((r) => setTimeout(r, 200));
    expect(next.delivered).toHaveLength(0);
  });

  it('a fresh item asked before a rotation that already happened is dropped', async () => {
    const created = Date.now() - 60_000;
    makeVault({ queue: [item({ id: 'q-f', createdAt: created })] });
    writeHandoffRecord(root, SUPER, { task: 'x', title: 'x', at: new Date().toISOString(), contextTokens: null, fromSession: '', tab: SUPER, actedAt: new Date().toISOString() });
    await startSuperInbox([root]);
    idleSuper();
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    await vi.waitFor(async () => expect((await freshItems())[0].state).toBe('done'), W);
    expect(delivered).toHaveLength(0);
  });
});

describe('rotating', () => {
  it('holds every delivery, and its end pushes rotating:false with an empty queue and pumps', async () => {
    makeVault({ queue: [] });
    await startSuperInbox([root]);
    superLive();
    idleSuper();
    const { inbox } = fakeInbox();
    attachSuperInbox(inbox);
    startRotating(SUPER);
    expect(deliveryBlocker(root)).toBe('rotating');
    await vi.waitFor(() => expect(frames.some((f) => f.subtype === 'super_state' && (f.state as { rotating?: boolean }).rotating === true)).toBe(true), W);
    frames = [];
    stopRotating(SUPER);
    expect(deliveryBlocker(root)).not.toBe('rotating');
    await vi.waitFor(() => expect(frames.some((f) => f.subtype === 'super_state' && (f.state as { rotating?: boolean }).rotating === undefined)).toBe(true), W);
  });

  it('a real timer ends it after ROTATE_HOLD_MAX_MS and pushes', { timeout: 15_000 }, async () => {
    makeVault({ queue: [] });
    await startSuperInbox([root]);
    superLive();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    startRotating(SUPER);
    expect(isRotating(SUPER)).toBe(true);
    vi.advanceTimersByTime(ROTATE_HOLD_MAX_MS + 1);
    expect(isRotating(SUPER)).toBe(false);
    vi.useRealTimers();
    await vi.waitFor(() => expect(frames.some((f) => f.subtype === 'super_state')).toBe(true), W);
  });

  it('the view carries it', () => {
    makeVault();
    const s = { ...emptySuperState(), session: SUPER } as SuperState;
    expect(superView(root, s).rotating).toBeUndefined();
    startRotating(SUPER);
    expect(superView(root, s).rotating).toBe(true);
  });

  it('ends only at the continue turn\'s result, never the /clear turn\'s', () => {
    expect(rotationFinished('clearing', 1)).toBe(false);
    expect(rotationFinished('resuming', 2)).toBe(false);
    expect(rotationFinished('resuming', 1)).toBe(true);
    expect(rotationFinished('done', 2)).toBe(true);
    expect(rotationFinished(undefined, 1)).toBe(false);
  });
});

describe('the rotation at a main result', () => {
  type Writes = { texts: string[]; runs: HandoffRun[] };
  function rotate(over: { isSuper?: boolean; isError?: boolean; isLimit?: boolean; pane?: string } = {}): { decision: string } & Writes {
    const w: Writes = { texts: [], runs: [] };
    const decision = handleRotationAtResult({
      contextRoot: root,
      pane: over.pane ?? SUPER,
      isSuper: over.isSuper ?? true,
      frame: { type: 'result', ...(over.isError ? { is_error: true } : {}) },
      isLimit: over.isLimit ?? false,
      observedConversation: 'conv-old',
      lastMainContext: 700_000,
      writeUserTurn: (t) => { w.texts.push(t); },
      startRun: (r) => { w.runs.push(r); },
    });
    return { decision, ...w };
  }
  const superRecord = (o: Partial<HandoffRecord> = {}): HandoffRecord => ({
    task: '.super/handoff', title: 'Super Agent', at: new Date().toISOString(), contextTokens: 780_000, fromSession: 'conv-old', tab: SUPER, kind: 'super', ...o,
  });

  beforeEach(() => { makeVault(); });

  it('the pure decision: limit wins, a record rotates whatever is_error says, the fallback needs a clean result', () => {
    const rec = superRecord();
    expect(rotationDecision({ record: rec, latch: true, isError: false, isLimit: true })).toBe('none');
    expect(rotationDecision({ record: rec, latch: false, isError: true, isLimit: false })).toBe('record');
    expect(rotationDecision({ record: null, latch: true, isError: false, isLimit: false })).toBe('fallback');
    expect(rotationDecision({ record: null, latch: true, isError: true, isLimit: false })).toBe('none');
    expect(rotationDecision({ record: { ...rec, actedAt: 'x' }, latch: false, isError: false, isLimit: false })).toBe('none');
  });

  it('a super record → ONE rotation: /clear, the file prompt, a super run, rotating; never a second', () => {
    writeHandoffRecord(root, SUPER, superRecord());
    markFreshDelivered(SUPER, 'b-1');
    const r = rotate();
    expect(r.decision).toBe('record');
    expect(r.texts[0]).toBe('/clear');
    expect(r.texts[1]).toContain('_dream_context/state/.super/handoff.md');
    expect(r.texts).toHaveLength(2);
    expect(r.runs[0]).toMatchObject({ kind: 'super', stage: 'clearing' });
    expect(isRotating(SUPER)).toBe(true);
    expect(hasFreshLatch(SUPER)).toBe(false);
    expect(readHandoffRecord(root, SUPER)?.actedAt).toBeTruthy();
    expect(rotate().decision).toBe('none');
  });

  it('no record + the fresh latch + a clean result → the fallback record, then the same rotation', () => {
    markFreshDelivered(SUPER, 'b-1');
    const r = rotate();
    expect(r.decision).toBe('fallback');
    const rec = readHandoffRecord(root, SUPER)!;
    expect(rec).toMatchObject({ kind: 'super', task: '.super/handoff', tab: SUPER, contextTokens: 700_000 });
    expect(rec.actedAt).toBeTruthy();
    expect(r.texts[1]).toContain('wrote none this time');
  });

  it('Stop, exit or an errored fresh turn with no record → no rotation now, and none later', () => {
    // Stop / exit clear the latch (the bridge's settleAfterInterrupt and close path).
    markFreshDelivered(SUPER, 'b-1');
    clearFresh(SUPER);
    expect(rotate().decision).toBe('none');
    // An errored result takes (and so drops) the latch without rotating.
    markFreshDelivered(SUPER, 'b-2');
    expect(rotate({ isError: true }).decision).toBe('none');
    expect(hasFreshLatch(SUPER)).toBe(false);
    // The owner's next ordinary turn ends: nothing rotates.
    expect(rotate().decision).toBe('none');
    expect(readHandoffRecord(root, SUPER)).toBeNull();
  });

  it('a limit-refused result does not rotate a record or the fallback; the next good result rotates the record', () => {
    writeHandoffRecord(root, SUPER, superRecord());
    markFreshDelivered(SUPER, 'b-1');
    const refused = rotate({ isLimit: true });
    expect(refused.decision).toBe('none');
    expect(refused.texts).toHaveLength(0);
    expect(readHandoffRecord(root, SUPER)?.actedAt).toBeUndefined();
    expect(hasFreshLatch(SUPER)).toBe(false);
    const next = rotate();
    expect(next.decision).toBe('record');
  });

  it('a refused result, then the owner\'s fresh turn ends clean with no record → the fallback rotates', () => {
    markFreshDelivered(SUPER, 'b-1');
    expect(rotate({ isLimit: true }).decision).toBe('none');
    markFreshDelivered(SUPER, 'b-2');
    expect(rotate().decision).toBe('fallback');
  });

  it('a task pane: its record rotates even on an errored result (unchanged); no latch, no fallback, no rotating hold', () => {
    const pane = 'task-pane-1';
    writeHandoffRecord(root, pane, { task: 'ship-the-thing', title: 'Ship the thing', at: new Date().toISOString(), contextTokens: 300_000, fromSession: 'x', tab: pane });
    const r = rotate({ isSuper: false, isError: true, pane });
    expect(r.decision).toBe('record');
    expect(r.texts[1]).toBe('Handoff: continue task Ship the thing (ship-the-thing). Read _dream_context/state/ship-the-thing.md first, then carry on from its latest changelog entry.');
    expect(r.runs[0].kind).toBeUndefined();
    expect(isRotating(pane)).toBe(false);
    markFreshDelivered(pane, 'b');
    expect(rotate({ isSuper: false, pane }).decision).toBe('none');
  });
});

describe('a whole fresh cycle keeps the stage', () => {
  it('children, pool, containers, groups and view are unchanged', async () => {
    makeVault({ queue: [item({ id: 'q-f', createdAt: Date.now() })] });
    expect((await readSuperState(root)).containers).toHaveLength(2);
    await startSuperInbox([root]);
    // The app's start puts the agenda on the stage (owner 2026-10-22 23:44); the fresh cycle
    // then changes nothing.
    const before = await readSuperState(root);
    expect(before.pool).toHaveLength(1);
    expect(before.containers.map((c) => c.kind)).toEqual(['agenda', ...before.containers.slice(1).map((c) => c.kind)]);
    expect(before.containers).toHaveLength(3);
    idleSuper();
    const { inbox, delivered } = fakeInbox();
    attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    await vi.waitFor(async () => expect((await freshItems())[0].state).toBe('delivered'), W);
    superTurnEnded(SUPER);
    await vi.waitFor(async () => expect((await freshItems())[0].state).toBe('done'), W);
    void pumpSuper(root);
    const after = await readSuperState(root);
    for (const k of ['children', 'pool', 'containers', 'groups', 'view'] as const) expect(after[k]).toEqual(before[k]);
  });
});

describe('the window side', () => {
  it('the button greys while a fresh item is pending or delivered, or the pane rotates', async () => {
    const { freshPending, superBatchOf, superEventPrefix, knownEventKind } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
    const { readSuperStateView } = await import('../../dashboard/src/lib/superTypes.js');
    expect(freshPending({ queue: [] })).toBe(false);
    expect(freshPending({ queue: [item({ state: 'pending' })] })).toBe(true);
    expect(freshPending({ queue: [item({ state: 'delivered' })] })).toBe(true);
    expect(freshPending({ queue: [item({ state: 'done' })] })).toBe(false);
    expect(freshPending({ queue: [], rotating: true })).toBe(true);
    // The pushed view carries `rotating` only as a real true.
    const wire = { ...emptySuperState(), vault: 'acme', session: SUPER, enabled: true };
    expect(readSuperStateView({ ...wire, rotating: true })?.rotating).toBe(true);
    expect(readSuperStateView({ ...wire, rotating: 'yes' })?.rotating).toBeUndefined();
    // The fresh turn draws as an event line, never as a message the owner typed.
    expect(superEventPrefix('fresh')).toBe('[super fresh]');
    expect(knownEventKind('fresh')).toBe(true);
    expect(superBatchOf('[super fresh] item=q-1 children=2\nThe owner pressed New session.')?.kind).toBe('fresh');
  });
});

describe('take-back', () => {
  it('drops a New session not yet delivered, so the next hand-over does not rotate on its own', async () => {
    const { disableSuper } = await import('../../src/lib/super/handover.js');
    makeVault({ queue: [item({ id: 'q-p', state: 'pending' }), item({ id: 'q-d', state: 'delivered' })] });
    await disableSuper(root);
    const q = (await readSuperState(root)).queue;
    expect(q.find((x) => x.id === 'q-p')?.state).toBe('done');
    expect(q.find((x) => x.id === 'q-d')?.state).toBe('delivered');
  });

  it('clears a delivered fresh turn\'s latch, so its clean result does not fall back into a rotation', async () => {
    const { disableSuper } = await import('../../src/lib/super/handover.js');
    makeVault();
    await startSuperInbox([root]);
    markFreshDelivered(SUPER, 'b-1');
    await disableSuper(root);
    expect(hasFreshLatch(SUPER)).toBe(false);
  });
});
