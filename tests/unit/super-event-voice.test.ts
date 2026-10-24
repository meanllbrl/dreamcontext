/**
 * The right event at the right time, in the right voice (Tilki field, 2026-10-21):
 *  - a child whose turn ended while its CLI still runs background work (a `run_in_background`
 *    shell, a Monitor, a background agent: the `background_tasks_changed` roster) is still
 *    working: no `done` until that work ends too, then exactly one;
 *  - a job the Super Agent started in the owner's own turn is one he waits on (`awaited`): its
 *    `done` tells the super to give him the result, and the turn renders in full (ownerBatches);
 *    a job started in an event turn stays silent; the mark lasts until the child is gone, and the
 *    owner's own word through `super send` / `super resume` sets it again;
 *  - every event text keeps the owner's language, and the silent rule means no text at all.
 *
 * Through the REAL registry, inbox and verb handlers, on a fake clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-event-voice-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { STALE_MS, _resetChatRegistry, getChat, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { DONE_SETTLE_MS, STALE_SWEEP_MS, emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import {
  AWAITED_LINE, BACKGROUND_QUIET_MS, BATCH_LAST_LINE, OWNER_VOICE, _resetSuperInbox, _superInboxDrained, attachSuperInbox, markSuperEventTurn,
  startSuperInbox, superBatchText, superEventText, superTurnEnded, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { resetCapacityForTests } from '../../src/lib/super/capacity.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const SUPER = 'sup-1';
let dir: string;
let root: string;

const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: `brief of ${sid}`, adopted: false, startedAt: 1, row: 'working', ...extra });
const roster = (h: ChatHandle, n: number, desc = 'job') => h.observe({
  type: 'system', subtype: 'background_tasks_changed',
  tasks: Array.from({ length: n }, (_, i) => ({ task_id: `bg${i}`, task_type: 'local_bash', description: `${desc} ${i}` })),
});

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await _superInboxDrained();
  }
}
async function advance(ms: number, step = 5_000): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, left));
    await drain();
  }
}

function makeVault(state: Partial<SuperState> | Record<string, unknown>): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
}

async function boot(children: Record<string, Record<string, unknown>>) {
  makeVault({ children: Object.fromEntries(Object.entries(children).map(([sid, extra]) => [sid, child(sid, extra)])) });
  const sup = reg(SUPER, 'super');
  sup.userSent('');
  sup.observe({ type: 'result' });
  const hs = Object.keys(children).map((sid) => { const h = reg(sid); h.userSent('go'); return h; });
  await startSuperInbox([root]);
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const flags = { busy: false };
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => !flags.busy,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  attachSuperInbox(inbox);
  await drain();
  return { sup, hs, delivered, flags };
}

const items = async (kind: string, sid?: string) => (await readSuperState(root)).queue.filter((q) => q.kind === kind && (!sid || q.sessionId === sid));

describe('background work keeps a child working (field: 6 done events in 18 minutes)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'super-event-voice-'));
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    vi.useRealTimers();
    _resetSuperInbox();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the registry reads the CLI roster: how many background tasks run and when that last changed', () => {
    const h = reg('c1');
    h.userSent('go');
    roster(h, 2);
    expect(getChat('c1')?.backgroundTasks).toBe(2);
    const at = getChat('c1')?.backgroundAt;
    expect(typeof at).toBe('string');
    roster(h, 0);
    expect(getChat('c1')?.backgroundTasks).toBe(0);
    h.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: 'garbage' });
    expect(getChat('c1')?.backgroundTasks).toBe(0);
  });

  it('turn ends while a Monitor runs open no done and no super turn; the job is done once its work ends', async () => {
    const { hs, delivered } = await boot({ c1: {} });
    const h = hs[0];
    roster(h, 1);
    // Six check-ins over 18 minutes, as the field child did: each turn ends, the Monitor runs on.
    for (let i = 0; i < 6; i += 1) {
      h.observe({ type: 'result' });
      await advance(3 * 60_000);
      const s = await readSuperState(root);
      expect(s.children.c1.row).toBe('working');
      expect(s.children.c1.settling).toBeUndefined();
      h.observe({ type: 'system', subtype: 'init', session_id: 'conv-1' });
      h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: `still running ${i}` }] } });
    }
    expect(await items('done', 'c1')).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    // The Monitor ends; the CLI opens its notification turn at once and that turn ends.
    roster(h, 0);
    h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'deploy finished' }] } });
    h.observe({ type: 'result' });
    await advance(DONE_SETTLE_MS - 5_000);
    expect(await items('done', 'c1')).toHaveLength(0);
    await advance(10_000);
    expect(await items('done', 'c1')).toHaveLength(1);
    expect((await readSuperState(root)).children.c1.row).toBe('done');
    expect(delivered).toHaveLength(1);
  });

  it('background work that ends with no new turn: done 30 s after it ended, found by the sweep', async () => {
    const { hs, delivered } = await boot({ c1: {} });
    roster(hs[0], 1);
    hs[0].observe({ type: 'result' });
    await advance(5 * 60_000);
    expect(await items('done', 'c1')).toHaveLength(0);
    roster(hs[0], 0);
    await advance(STALE_SWEEP_MS + DONE_SETTLE_MS + 5_000);
    expect(await items('done', 'c1')).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });
});

describe('background work that never ends (a dev server, a persistent Monitor)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'super-event-voice-'));
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    vi.useRealTimers();
    _resetSuperInbox();
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds the row only until BACKGROUND_QUIET_MS of silence; then the job is done (and an awaited one tells him)', async () => {
    const { hs, delivered } = await boot({ dev: { awaited: true } });
    // A server left running (a job with an end holds the row longer: super-owner-wait.test.ts).
    roster(hs[0], 1, 'Start the dev server');
    hs[0].observe({ type: 'result' });
    await advance(BACKGROUND_QUIET_MS - 60_000, 30_000);
    expect(await items('done', 'dev')).toHaveLength(0);
    expect((await readSuperState(root)).children.dev.row).toBe('working');
    await advance(60_000 + STALE_SWEEP_MS + 5_000, 30_000);
    expect(await items('done', 'dev')).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toMatch(/child=dev event=done awaited=owner/);
  });
});

describe('a job the owner waits on', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
    dir = mkdtempSync(join(tmpdir(), 'super-event-voice-'));
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
  });
  afterEach(async () => {
    await drain().catch(() => undefined);
    vi.useRealTimers();
    _resetSuperInbox();
    rmSync(dir, { recursive: true, force: true });
  });

  it('its done tells the super to give him the result, the turn renders in full, and so does every later done of it', async () => {
    const { hs, delivered, flags } = await boot({ waited: { awaited: true }, other: {} });
    // Both finish while the super is busy: one batch carries both.
    flags.busy = true;
    for (const h of hs) h.observe({ type: 'result' });
    await advance(DONE_SETTLE_MS + 5_000);
    flags.busy = false;
    superTurnEnded(SUPER);
    await drain();
    expect(delivered).toHaveLength(1);
    const { text, event } = delivered[0];
    expect(text).toMatch(/child=waited event=done awaited=owner/);
    expect(text).toMatch(/child=other event=done status=/);
    expect(text).toContain(AWAITED_LINE);
    let s = await readSuperState(root);
    expect(s.ownerBatches).toContain(event.batch);
    // The turn that carried it ends: the job is still his (field d8b7741d: the second result
    // after his notes went in arrived as plain `event=done`, and the super stayed silent).
    superTurnEnded(SUPER);
    await drain();
    s = await readSuperState(root);
    expect(s.children.waited.awaited).toBe(true);
    hs[0].userSent('one more thing');
    hs[0].observe({ type: 'result' });
    await advance(DONE_SETTLE_MS + 5_000);
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text).toMatch(/child=waited event=done awaited=owner/);
    expect(delivered[1].text).toContain(AWAITED_LINE);
    expect((await readSuperState(root)).ownerBatches).toContain(delivered[1].event.batch);
  });

  it('a stale stuck is not his result: the mark stays for the real done', async () => {
    const { hs, delivered } = await boot({ slow: { awaited: true } });
    await advance(STALE_MS + STALE_SWEEP_MS + 5_000, 30_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toMatch(/child=slow event=stuck reason=stale awaited=owner/);
    superTurnEnded(SUPER);
    await drain();
    expect((await readSuperState(root)).children.slow.awaited).toBe(true);
    // It recovers and finishes: that result goes to him.
    hs[0].observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'back' }] } });
    await advance(STALE_SWEEP_MS + 1_000);
    expect((await readSuperState(root)).children.slow.row).toBe('working');
    hs[0].observe({ type: 'result' });
    await advance(STALE_SWEEP_MS + DONE_SETTLE_MS + 5_000);
    const last = delivered.at(-1);
    expect(last?.text).toMatch(/child=slow event=done awaited=owner/);
  });

  it('a batch with no awaited job keeps the owner out of it', async () => {
    const { hs, delivered } = await boot({ quiet: {} });
    hs[0].observe({ type: 'result' });
    await advance(DONE_SETTLE_MS + 5_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toMatch(/child=quiet event=done status=/);
    expect(delivered[0].text).not.toContain(AWAITED_LINE);
    expect((await readSuperState(root)).ownerBatches).toEqual([]);
  });
});

describe('delegate marks a job awaited only in the owner\'s own turn', () => {
  let token = '';
  const CHILD_SID = '12345678-1234-4234-8234-123456789abc';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-event-voice-'));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    resetCapacityForTests();
    token = mintWindowToken({
      send: (frame) => {
        setImmediate(() => (frame.subtype === 'window_command'
          ? deliverWindowResult(token, frame.id, { ok: true, result: { delivered: 'sent' } })
          : deliverSuperResult(token, frame.id, { ok: true, result: { sessionId: CHILD_SID } })));
        return true;
      },
      vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
    }).token;
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true }));
  });
  afterEach(() => { _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

  function req(body: unknown): IncomingMessage {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
    return r;
  }
  async function delegate(): Promise<number> {
    const out = { status: 0 } as ServerResponse & { status: number };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: () => void }).end = () => undefined;
    await handleSuperVerb(req({ prompt: 'Check why the student count is low.', brief: 'student count' }), out, { verb: 'delegate' });
    return out.status;
  }

  it('in the owner\'s turn: awaited', async () => {
    expect(await delegate()).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].awaited).toBe(true);
  });

  it('in an event turn: not awaited', async () => {
    markSuperEventTurn(SUPER, true);
    expect(await delegate()).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].awaited).toBeUndefined();
  });

  async function verb(verb: string, body: unknown): Promise<number> {
    const out = { status: 0 } as ServerResponse & { status: number };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: () => void }).end = () => undefined;
    await handleSuperVerb(req(body), out, { verb });
    return out.status;
  }

  it('his word through `super send` in his own turn makes it his again; one sent from an event turn does not', async () => {
    markSuperEventTurn(SUPER, true);
    expect(await delegate()).toBe(200);
    const h = reg(CHILD_SID);
    h.userSent('go');
    expect(await verb('send', { child: CHILD_SID, text: 'and also check March' })).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].awaited).toBeUndefined();
    markSuperEventTurn(SUPER, false);
    expect(await verb('send', { child: CHILD_SID, text: 'the owner says: use the new cohort' })).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].awaited).toBe(true);
  });

  it('a running child `super resume` takes back in his own turn is his again', async () => {
    markSuperEventTurn(SUPER, true);
    expect(await delegate()).toBe(200);
    const h = reg(CHILD_SID);
    h.userSent('go');
    markSuperEventTurn(SUPER, false);
    expect(await verb('resume', { child: CHILD_SID })).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].awaited).toBe(true);
  });
});

describe('the event texts keep the owner\'s language and mean it when they say nothing', () => {
  const s = { ...emptySuperState(), session: SUPER, enabled: true };
  const batch = superBatchText('/tmp/acme/_dream_context', s, [{ id: 'q-d', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: 1 }], 'b-1');
  const handover = superEventText('/tmp/acme/_dream_context', s, { id: 'q-h', sessionId: SUPER, kind: 'handover', state: 'pending', createdAt: 1 });
  const recap = superEventText('/tmp/acme/_dream_context', s, { id: 'q-r', sessionId: SUPER, kind: 'recap', state: 'pending', createdAt: 1 });

  it('every text that reaches the owner names his language, never this note\'s', () => {
    expect(OWNER_VOICE).toContain('in the language the owner writes to you in, never the language of this note');
    for (const text of [batch, handover, recap]) expect(text).toContain(OWNER_VOICE);
  });

  it('the silent rule is no text at all, and says so without room for a one-line note', () => {
    expect(BATCH_LAST_LINE).not.toContain('Write the owner nothing about them');
    expect(BATCH_LAST_LINE).toContain('write no text at all in this turn: no summary, no note, not one line');
    // A steered owner message is still answered.
    expect(BATCH_LAST_LINE).toContain('If the owner writes to you during this turn, answer him normally');
  });
});
