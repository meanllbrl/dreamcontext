/**
 * A child delegated without `--effort` must not inherit the owner's global effort (often xhigh)
 * (owner, 2026-10-22; develop medium since 2026-10-24): the server writes a default by mode (basic
 * medium, plan high, develop medium) into the spawn frame AND the child's record. xhigh and max only
 * ever come from an explicit effort.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-effort-home-`);
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
  dir = mkdtempSync(join(tmpdir(), 'super-effort-'));
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

const asked = () => commands()[0].args as Record<string, unknown>;

describe('a child delegated without effort', () => {
  for (const [mode, want] of [['basic', 'medium'], ['plan', 'high'], ['develop', 'medium']] as const) {
    it(`${mode} opens on ${want}, never xhigh, and the record says so`, async () => {
      write();
      const r = await verb('delegate', { prompt: 'Do the work.', brief: 'work', mode, ...(mode !== 'basic' ? {} : {}) });
      expect(r.status).toBe(200);
      expect(asked().effort).toBe(want);
      expect(asked().effort).not.toBe('xhigh');
      const st = await readSuperState(root);
      expect(st.children[CHILD_SID].effort).toBe(want);
    });
  }

  it('a pooled job without effort starts on the default too', async () => {
    write();
    const id = result(await verb('pool-add', { prompt: 'Later work.', brief: 'later', mode: 'plan' })).pooled as string;
    expect((await verb('delegate', { from: id })).status).toBe(200);
    expect(asked().effort).toBe('high');
    expect((await readSuperState(root)).children[CHILD_SID].effort).toBe('high');
  });

  it('an explicit xhigh is kept', async () => {
    write();
    await verb('delegate', { prompt: 'Contract.', brief: 'contract', mode: 'develop', effort: 'xhigh' });
    expect(asked().effort).toBe('xhigh');
    expect((await readSuperState(root)).children[CHILD_SID].effort).toBe('xhigh');
  });
});
