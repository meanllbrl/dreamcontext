/**
 * `super delegate` warns when the job falls in a READY AI Team member's field (`teamHint`), and
 * still starts the child (owner, 2026-10-29: warn, never block). No hint for a typo fix, for a
 * team-less project, for a member that is not ready, or for a pooled job (`--from`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-hint-home-`);
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
  dir = mkdtempSync(join(tmpdir(), 'super-hint-'));
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


import { cpSync } from 'node:fs';
import { dirname as dirOf } from 'node:path';
import { getAutomation as getSlot } from '../../src/lib/automations/store.js';
import { approveAutomation as approve } from '../../src/lib/automations/registry.js';
import { ORBIT_FIXTURE, TEAM_OVERLAY } from '../../eval/super-team-routing/setup.js';

/** The eval's Orbit fixture under acme/, its team approved in the test HOME (Atlas not). */
function orbit(team: boolean): void {
  cpSync(ORBIT_FIXTURE, dirOf(root), { recursive: true });
  if (team) {
    cpSync(TEAM_OVERLAY, dirOf(root), { recursive: true });
    for (const slug of ['ledger', 'probe', 'lookout']) approve(dirOf(root), getSlot(root, slug)!, new Date());
  }
  write();
}

describe('super delegate and the AI Team', () => {
  it('a member\'s field: the child starts AND the answer names the member and how to hand it over', async () => {
    orbit(true);
    const r = await verb('delegate', { prompt: 'Run the signup funnel test end to end and report what broke.', brief: 'signup funnel test', mode: 'basic' });
    expect(r.status).toBe(200);
    expect(commands()).toHaveLength(1);
    const hint = String(result(r).teamHint);
    expect(hint).toMatch(/^<untrusted-project-output vault="acme">Probe: You are Probe/);
    expect(hint).toContain(`(\`probe\`) may own this field. A small read of one source is yours, not a member's; a diagnosis, draft, send or several sources is its job: then \`dreamcontext super end ${CHILD_SID}\` and \`dreamcontext super team ask probe "<the job>"\``);
  });

  it('no hint for a typo fix, a member waiting for approval, a team-less project, or a pooled job', async () => {
    orbit(true);
    expect(result(await verb('delegate', { prompt: 'Fix the typo in the onboarding title.', brief: 'typo', mode: 'basic' }))).not.toHaveProperty('teamHint');
    expect(result(await verb('delegate', { prompt: "Rewrite the pricing funnel's first three screens.", brief: 'pricing screens', mode: 'basic' }))).not.toHaveProperty('teamHint');
    const id = result(await verb('pool-add', { prompt: 'Run the signup funnel test end to end.', brief: 'funnel test', mode: 'basic' })).pooled as string;
    expect(result(await verb('delegate', { from: id }))).not.toHaveProperty('teamHint');
  });

  it('a team-less project never gets one', async () => {
    orbit(false);
    expect(result(await verb('delegate', { prompt: "What's this month's revenue? Run the signup funnel test.", brief: 'revenue', mode: 'basic' }))).not.toHaveProperty('teamHint');
  });
});
