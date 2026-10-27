/**
 * The machine never holds a delegate (owner, 2026-10-21; this replaced the machine hold of
 * orchestration plan r5 D11): only the cap of MAX_LIVE_CHILDREN live children does. On the most
 * loaded machine ever measured here the child still starts; `super state` shows the machine's
 * facts and the lines it crossed (`machine.notes`) as information, and the cap (`limits`).
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
  machineNotes, machineRoom, resetCapacityForTests, setCapacityFactsForTests, setPowerFactsForTests, type CapacityFacts,
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
  it('both readings cross hard lines (the park sweep\'s signal)', () => {
    for (const f of [OWNER_READING, PLAN_READING]) {
      const r = machineRoom(f, { platform: 'darwin' });
      expect(r.ok).toBe(false);
      expect(r.hard).toBe(true);
    }
  });

  it('the notes name every line crossed, and nothing about closing sessions', () => {
    const notes = machineNotes(machineRoom(OWNER_READING, { platform: 'darwin' }));
    expect(notes).toEqual([
      '25 Claude processes are running on this machine (about 10 fit its RAM)',
      'swap is 86 % full (line 75 %); removing worktrees or files frees disk, not memory',
      '6.7 GB disk free (line 8 GB)',
      '1.9 GB memory free (line 2 GB); removing worktrees or files frees disk, not memory',
    ]);
    expect(notes.join(' ')).not.toMatch(/clos/);
  });
});

describe('the machine never holds a delegate', () => {
  for (const [name, facts] of [['the owner\'s reading', OWNER_READING], ['the planning reading', PLAN_READING]] as const) {
    it(`${name} (hard lines crossed): the child starts`, async () => {
      write();
      setCapacityFactsForTests(facts);
      const r = await verb('delegate', { prompt: 'Fix the avatar crash.', brief: 'avatar crash', mode: 'basic', model: 'sonnet', effort: 'medium' });
      expect(r.status).toBe(200);
      expect(r.json.error).toBeUndefined();
      expect(commands()).toHaveLength(1);
      const st = await readSuperState(root);
      expect(st.pool).toEqual([]);
      expect(Object.keys(st.children)).toEqual([CHILD_SID]);
    });
  }

  it('delegate --from on that machine starts the pooled job and removes its row', async () => {
    write();
    const id = result(await verb('pool-add', { prompt: 'Later: the billing route.', brief: 'billing' })).pooled as string;
    setCapacityFactsForTests(OWNER_READING);
    const r = await verb('delegate', { from: id });
    expect(r.status).toBe(200);
    expect(commands()).toHaveLength(1);
    expect((await readSuperState(root)).pool).toEqual([]);
  });

  it('soft lines and light mode never hold either', async () => {
    write();
    setCapacityFactsForTests({ ...ROOMY, claudeSessions: 30, availMemGb: 0.5, diskFreeGb: 12, swapUsedGb: 7, swapTotalGb: 8 });
    mkdirSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ lightMode: 'on' }));
    expect((await verb('delegate', { prompt: 'Fix the theme.' })).status).toBe(200);
  });

  it('null facts start too', async () => {
    write();
    setCapacityFactsForTests({ availMemGb: 9, diskFreeGb: null, load1: 1, totalMemGb: 16, swapUsedGb: null, swapTotalGb: null, claudeSessions: null, heavySteps: null });
    expect((await verb('delegate', { prompt: 'Fix the settings.' })).status).toBe(200);
  });

  it(`${MAX_LIVE_CHILDREN + 2} parallel delegates on an overloaded machine start exactly ${MAX_LIVE_CHILDREN}: the cap check and the in-flight count are one step`, async () => {
    write();
    // The cap is the only hold, even on the owner's reading. A cold measurement takes time.
    setCapacityFactsForTests(OWNER_READING, { delayMs: 30 });
    answer = { ok: true, result: { sessionId: CHILD_SID } };
    const rs = await Promise.all(Array.from({ length: MAX_LIVE_CHILDREN + 2 }, (_, i) => verb('delegate', { prompt: `Job ${i}.` })));
    const held = rs.filter((r) => r.json.error === 'held');
    expect(held.length).toBe(2);
    for (const r of held) expect(r.json).toMatchObject({ reason: 'cap', max: MAX_LIVE_CHILDREN });
    expect(commands().length).toBe(MAX_LIVE_CHILDREN);
  });

  it('the cap answers reason cap, keeps the job in the pool, and names the number', async () => {
    fillCap();
    setCapacityFactsForTests(ROOMY);
    const r = await verb('delegate', { prompt: 'One more.' });
    expect(r.json).toMatchObject({ error: 'held', reason: 'cap', kept: true, live: MAX_LIVE_CHILDREN, max: MAX_LIVE_CHILDREN });
    expect(String(r.json.message)).toContain(`at most ${MAX_LIVE_CHILDREN}`);
    expect(r.json.hard).toBeUndefined();
    expect(r.json.reasons).toBeUndefined();
    expect(commands()).toHaveLength(0);
  });

  it('super state shows the machine as information: its facts, the lines crossed (notes), and the cap', async () => {
    write();
    setCapacityFactsForTests(OWNER_READING);
    const st = result(await verb('state'));
    expect(st.limits).toEqual({ maxChildren: MAX_LIVE_CHILDREN });
    expect(st.machine).toMatchObject({ swapUsedGb: 18.5, claudeSessions: 25 });
    expect((st.machine as { notes: string[] }).notes).toEqual(machineNotes(machineRoom(OWNER_READING, { lightMode: false })));
    setCapacityFactsForTests(ROOMY);
    expect((result(await verb('state')).machine as { notes: string[] }).notes).toEqual([]);
  });
});

describe('the field case (Tilki 2026-10-21): swap 78 % and light mode on', () => {
  // 16 GB, swap 3.1 of 4 GB (78 %), 8 children starting, Auto light mode switched on by the battery.
  const TILKI: CapacityFacts = { availMemGb: 6, diskFreeGb: 44, load1: 5.3, totalMemGb: 16, swapUsedGb: 3.1, swapTotalGb: 4, claudeSessions: 2, heavySteps: 0 };
  afterEach(() => setPowerFactsForTests(null));

  it('delegate starts the child (no machine hold), and state explains light mode without asking for anything', async () => {
    write();
    setCapacityFactsForTests(TILKI);
    setPowerFactsForTests({ onBattery: true, batteryPercent: 18, lowPowerMode: false });
    mkdirSync(join(process.env.HOME!, '.dreamcontext'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ lightMode: 'auto' }));
    const r = await verb('delegate', { prompt: 'Roll out the coaching rules.', brief: 'coaching', mode: 'basic', model: 'sonnet', effort: 'medium' });
    expect(r.status).toBe(200);
    expect(r.json.error).toBeUndefined();
    expect(commands()).toHaveLength(1);
    const machine = result(await verb('state')).machine as { notes: string[]; claudeSessions: number; claudeSessionsMeans: string };
    expect(machine.claudeSessions).toBe(2);
    expect(machine.claudeSessionsMeans).toMatch(/processes named claude.*not the number of children/);
    const light = machine.notes.find((n) => n.startsWith('light mode is on'))!;
    expect(light).toMatch(/Auto turned it on: the Mac runs on battery at 18 %/);
    expect(light).toMatch(/turns itself off when the Mac is plugged in or charged/);
    expect(light).toMatch(/nothing needs switching off/);
    expect(machine.notes.find((n) => n.startsWith('swap is 78 %'))).toMatch(/frees disk, not memory/);
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
    // The stores keep names sorted (mcp-store.ts), so the known list reads alphabetically.
    expect(r.json).toMatchObject({ error: 'unknown_mcp', known: ['fathom', 'whatsapp'] });
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
    expect(result(await verb('state'))).toMatchObject({ mcpServers: ['fathom', 'whatsapp'] });
  });
});
