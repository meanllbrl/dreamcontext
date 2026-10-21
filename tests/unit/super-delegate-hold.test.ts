/**
 * The machine hold (orchestration plan r5 D11, AC "Machine facts"): when THIS machine is short
 * of room, `super delegate` and `delegate --from` are held with reason `machine`, the job is
 * kept in the pool and NEVER started (no window frame), the owner's one sentence names the
 * limits and how many sessions to close. Today's two measurements are held AND hard. A null
 * fact never holds alone. Nobody overrides a hold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-hold-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { MAX_FILE_BYTES, SUPER_STATE_REL, SuperStoreRefused, readSuperState, resetSuperIndex, updateSuperState } from '../../src/lib/super/store.js';
import { MAX_LIVE_CHILDREN, MAX_POOL, MAX_POOL_PROMPT, MAX_QUEUE, emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { disableSuper } from '../../src/lib/super/handover.js';
import {
  machineHoldLine, machineRoom, resetCapacityForTests, setCapacityFactsForTests, type CapacityFacts,
} from '../../src/lib/super/capacity.js';
import { DEV_SERVER_LINE, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
let token = '';
const frames: Array<Record<string, unknown>> = [];
type Answer = { ok: true; result: unknown } | { ok: false; error: string };
let answer: Answer = { ok: true, result: { sessionId: '12345678-1234-4234-8234-123456789abc' } };
let hold: Promise<void> | null = null;
const CHILD_SID = '12345678-1234-4234-8234-123456789abc';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-pool-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  frames.length = 0;
  answer = { ok: true, result: { sessionId: CHILD_SID } };
  hold = null;
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  resetCapacityForTests();
  token = mintWindowToken({
    send: (frame) => {
      frames.push(frame);
      const a = answer;
      void (hold ?? Promise.resolve()).then(() => setImmediate(() => deliverSuperResult(token, frame.id, a)));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super',
  }).token;
});
afterEach(() => { _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

function write(state: Record<string, unknown> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, ...state }));
}
function req(body: unknown, withToken = true): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...(withToken ? { 'x-dreamcontext-window-token': token } : {}) }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown> = {}, withToken = true) {
  const r = res();
  await handleSuperVerb(req(body, withToken), r, { verb: name });
  return r;
}
const result = (r: { json: Record<string, unknown> }) => r.json.result as Record<string, unknown>;
const commands = () => frames.filter((f) => f.subtype === 'super_command');
function fillCap(): void {
  const ids = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `live-${i}`);
  write({ children: Object.fromEntries(ids.map((id) => [id, { sessionId: id, brief: '', adopted: false, startedAt: 1 }])) });
  for (const id of ids) registerChat({ sessionId: id, conversationId: null, vault: 'acme', mode: 'basic' }).userSent('busy');
}


/** The owner's reading on 2026-10-20 and the one taken while planning (sysctl + df). */
const OWNER_READING: CapacityFacts = { availMemGb: 1.9, diskFreeGb: 6.7, load1: 6, totalMemGb: 16, swapUsedGb: 18.5, swapTotalGb: 21.5, claudeSessions: 25, heavySteps: 0 };
const PLAN_READING: CapacityFacts = { availMemGb: 2.4, diskFreeGb: 8, load1: 5, totalMemGb: 16, swapUsedGb: 18.4, swapTotalGb: 19.0, claudeSessions: 27, heavySteps: 2 };
const ROOMY: CapacityFacts = { availMemGb: 9, diskFreeGb: 120, load1: 1, totalMemGb: 16, swapUsedGb: 1, swapTotalGb: 8, claudeSessions: 4, heavySteps: 0 };

afterEach(() => {
  setCapacityFactsForTests({ availMemGb: 12, diskFreeGb: 200, load1: 1, totalMemGb: 32, swapUsedGb: 0, swapTotalGb: 4, claudeSessions: 1, heavySteps: 0 });
  rmSync(join(process.env.HOME!, '.dreamcontext', 'agent-ui.json'), { force: true });
});

describe('machineRoom on today\'s measurements', () => {
  it('both readings are not ok and hard', () => {
    for (const f of [OWNER_READING, PLAN_READING]) {
      const r = machineRoom(f, { platform: 'darwin' });
      expect(r.ok).toBe(false);
      expect(r.hard).toBe(true);
    }
  });

  it('the owner\'s sentence names the limits and how many sessions to close', () => {
    const h = machineHoldLine(machineRoom(OWNER_READING, { platform: 'darwin' }));
    expect(h.closeSessions).toBe(16);
    expect(h.line).toMatch(/25 Claude sessions/);
    expect(h.line).toMatch(/swap is 86 %/);
    expect(h.line).toMatch(/6\.7 GB disk free/);
    expect(h.line).toMatch(/closing 16 session\(s\) would make room/);
  });
});

describe('delegate on a machine short of room', () => {
  for (const [name, facts] of [['the owner\'s reading', OWNER_READING], ['the planning reading', PLAN_READING]] as const) {
    it(`${name}: held, reason machine, hard, kept in the pool, never started`, async () => {
      write();
      setCapacityFactsForTests(facts);
      const r = await verb('delegate', { prompt: 'Fix the avatar crash.', brief: 'avatar crash', mode: 'basic', model: 'sonnet', effort: 'medium' });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ error: 'held', reason: 'machine', hard: true, kept: true, held: true });
      expect((r.json.reasons as Array<{ limit: string }>).map((x) => x.limit)).toEqual(expect.arrayContaining(['sessions', 'swap', 'disk']));
      expect(String(r.json.message)).toMatch(/no room for another session/);
      expect(commands()).toHaveLength(0);
      const st = await readSuperState(root);
      expect(st.pool).toEqual([expect.objectContaining({ id: r.json.pooled, held: true, model: 'sonnet', effort: 'medium' })]);
      expect(Object.keys(st.children)).toEqual([]);
    });
  }

  it('delegate --from is held the same way and the row stays as it is', async () => {
    write();
    const id = result(await verb('pool-add', { prompt: 'Later: the billing route.', brief: 'billing' })).pooled as string;
    setCapacityFactsForTests(OWNER_READING);
    const r = await verb('delegate', { from: id });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'held', reason: 'machine', pooled: id });
    expect(commands()).toHaveLength(0);
    expect((await readSuperState(root)).pool.map((p) => p.id)).toEqual([id]);
  });

  it('a soft limit alone holds (sessions >= RAM/1.6), and the answer is not hard', async () => {
    write();
    setCapacityFactsForTests({ ...ROOMY, claudeSessions: 10 });
    const r = await verb('delegate', { prompt: 'Fix the theme.' });
    expect(r.json).toMatchObject({ error: 'held', reason: 'machine', hard: false, closeSessions: 1 });
    expect(commands()).toHaveLength(0);
  });

  it('light mode on holds', async () => {
    write();
    setCapacityFactsForTests(ROOMY);
    mkdirSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ lightMode: 'on' }));
    const r = await verb('delegate', { prompt: 'Fix the theme.' });
    expect(r.json).toMatchObject({ error: 'held', reason: 'machine' });
    expect((r.json.reasons as Array<{ limit: string }>).map((x) => x.limit)).toEqual(['light']);
  });

  it('room: the child starts; null facts never hold alone (fail open)', async () => {
    write();
    setCapacityFactsForTests(ROOMY);
    expect((await verb('delegate', { prompt: 'Fix the theme.' })).status).toBe(200);
    write();
    setCapacityFactsForTests({ availMemGb: 9, diskFreeGb: null, load1: 1, totalMemGb: 16, swapUsedGb: null, swapTotalGb: null, claudeSessions: null, heavySteps: null });
    expect((await verb('delegate', { prompt: 'Fix the settings.' })).status).toBe(200);
  });

  it('ten parallel delegates start at most 8: the cap check and the in-flight count are one step (end review r1)', async () => {
    write();
    // A big machine, so only the cap can hold (in-flight calls count as sessions too).
    // A cold measurement takes time: every call waits on it together, as on a real machine.
    setCapacityFactsForTests({ ...ROOMY, totalMemGb: 64, claudeSessions: 1 }, { delayMs: 30 });
    let n = 0;
    answer = { ok: true, result: { sessionId: CHILD_SID } };
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => verb('delegate', { prompt: `Job ${i}.` }).then((r) => { n++; return r; })));
    expect(n).toBe(10);
    expect(rs.filter((r) => r.json.error === 'held').length).toBe(2);
    expect(commands().length).toBe(8);
  });

  it('a burst within the facts\' minute counts the children it just started (end review r1)', async () => {
    const now = Date.now();
    const kid = (i: number) => [`k-${i}`, { sessionId: `k-${i}`, brief: '', adopted: false, startedAt: now - 1000 }];
    write({ children: Object.fromEntries([kid(1), kid(2)]) });
    // 16 GB -> room for 9 sessions; ps saw 8 a moment ago, and two children started since.
    setCapacityFactsForTests({ ...ROOMY, claudeSessions: 8 });
    const r = await verb('delegate', { prompt: 'One more.' });
    expect(r.json).toMatchObject({ error: 'held', reason: 'machine' });
    write({ children: Object.fromEntries([kid(1)]) });
    expect((await verb('delegate', { prompt: 'One more.' })).status).toBe(200);
  });

  it('the cap still answers reason cap', async () => {
    fillCap();
    setCapacityFactsForTests(ROOMY);
    const r = await verb('delegate', { prompt: 'One more.' });
    expect(r.json).toMatchObject({ error: 'held', reason: 'cap' });
  });
});

describe('delegate --mcp (lean children, plan r5 D14)', () => {
  const claudeJson = () => join(process.env.HOME!, '.claude.json');
  beforeEach(() => {
    writeFileSync(claudeJson(), JSON.stringify({ mcpServers: { whatsapp: { command: 'w' }, fathom: { command: 'f' } } }));
    setCapacityFactsForTests(ROOMY);
  });
  afterEach(() => { rmSync(claudeJson(), { force: true }); });

  it('a known server: the window is told the set, and the child record keeps it (Resume reads it)', async () => {
    write();
    const r = await verb('delegate', { prompt: 'Send "Standup at 10" to Ayla on WhatsApp.', brief: 'whatsapp send', mcp: 'whatsapp' });
    expect(r.status).toBe(200);
    expect(commands()[0].args).toMatchObject({ mcp: ['whatsapp'] });
    expect((await readSuperState(root)).children[CHILD_SID]).toMatchObject({ mcp: ['whatsapp'] });
  });

  it('no --mcp: the window is told an empty set (the child starts with no user server)', async () => {
    write();
    expect((await verb('delegate', { prompt: 'Fix the theme.' })).status).toBe(200);
    expect(commands()[0].args).toMatchObject({ mcp: [] });
    expect((await readSuperState(root)).children[CHILD_SID].mcp).toBeUndefined();
  });

  it('an unknown or malformed name is refused, naming the known ones; nothing starts', async () => {
    write();
    const r = await verb('delegate', { prompt: 'x', mcp: 'posthog' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'unknown_mcp', known: ['whatsapp', 'fathom'] });
    expect((await verb('delegate', { prompt: 'x', mcp: '__proto__' })).json.error).toBe('invalid_args');
    expect((await verb('pool-add', { prompt: 'x', mcp: 'posthog' })).json.error).toBe('unknown_mcp');
    expect(commands()).toHaveLength(0);
  });

  it('a pooled job keeps its set and starts with it', async () => {
    write();
    const id = result(await verb('pool-add', { prompt: 'Later: the meeting notes.', mcp: 'fathom' })).pooled as string;
    expect((await readSuperState(root)).pool[0]).toMatchObject({ mcp: ['fathom'] });
    expect((await verb('delegate', { from: id })).status).toBe(200);
    expect(commands()[0].args).toMatchObject({ mcp: ['fathom'] });
  });

  it('super state lists the servers it can grant, names only', async () => {
    write();
    expect(result(await verb('state'))).toMatchObject({ mcpServers: ['whatsapp', 'fathom'] });
  });
});
