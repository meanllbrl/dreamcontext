/**
 * The first read's end (plan ilk-acilis C16): its done item lets the Super write ONE short
 * message (one allowance per child, the first done item delivered), never a verb that starts
 * work in that turn; any other end writes nothing; the briefing block is derived.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/first-read-done-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AWAITED_LINE, FIRST_READ_DONE_LINE, _openEventTurnForTests, _resetSuperInbox, batchHasFirstReadDone, firstReadDoneItem, superBatchText,
} from '../../src/lib/super/inbox.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_STATE_REL, noteSuperState, resetSuperIndex, superFirstReadRunning } from '../../src/lib/super/store.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { FIRST_READ_BARRED_VERBS, handleSuperVerb } from '../../src/server/routes/super.js';
import { FIRST_READ_LIVE_BLOCK } from '../../src/server/chat-modes.js';

const ROOT = '/tmp/orbit/_dream_context';

function state(child: Partial<SuperState['children'][string]> = {}): SuperState {
  const s = emptySuperState();
  s.session = 'sup-1';
  s.enabled = true;
  s.children.r = { sessionId: 'r', brief: 'Reading Orbit', adopted: false, startedAt: 1, firstRead: true, row: 'done', ...child } as SuperState['children'][string];
  return s;
}
const item = (id: string, kind: SuperQueueItem['kind'] = 'done'): SuperQueueItem => ({ id, sessionId: 'r', kind, state: 'pending', createdAt: 1 });

describe('the done item\'s one-message allowance', () => {
  it('the first done item of a first-read child is awaited and carries the first-read line', () => {
    const s = state();
    expect(firstReadDoneItem(s, item('q-1'))).toBe(true);
    const text = superBatchText(ROOT, s, [item('q-1')], 'b-1');
    expect(text).toContain(AWAITED_LINE);
    expect(text).toContain(FIRST_READ_DONE_LINE);
    expect(text).toMatch(/- item=q-1 child=r event=done awaited=owner first-read/);
    expect(FIRST_READ_DONE_LINE).toMatch(/ONE short message/);
    expect(FIRST_READ_DONE_LINE).toMatch(/no `super delegate`/);
    expect(FIRST_READ_DONE_LINE).not.toMatch(/—/);
  });

  it('only the item that spent it keeps it: a second done delivery gives no extra allowance', () => {
    const s = state({ firstReadAnnounced: 'q-1' });
    expect(firstReadDoneItem(s, item('q-1'))).toBe(true);
    expect(firstReadDoneItem(s, item('q-2'))).toBe(false);
    expect(superBatchText(ROOT, s, [item('q-2')], 'b-2')).not.toContain(FIRST_READ_DONE_LINE);
    expect(superBatchText(ROOT, s, [item('q-2')], 'b-2')).not.toContain(AWAITED_LINE);
  });

  it('any other end (stuck, gone, closed) carries no allowance: the Super writes nothing', () => {
    const s = state();
    for (const kind of ['stuck', 'gone', 'question', 'permission'] as const) {
      expect(firstReadDoneItem(s, item('q-x', kind)), kind).toBe(false);
      expect(superBatchText(ROOT, s, [item('q-x', kind)], 'b-3')).not.toContain(FIRST_READ_DONE_LINE);
    }
    // An ordinary child's done is not a first read.
    const plain = state();
    delete plain.children.r.firstRead;
    expect(firstReadDoneItem(plain, item('q-1'))).toBe(false);
  });

  it('batchHasFirstReadDone reads the delivered batch', () => {
    const s = state();
    s.queue = [{ ...item('q-1'), state: 'delivered', batch: 'b-1' }];
    expect(batchHasFirstReadDone(s, 'b-1')).toBe(true);
    expect(batchHasFirstReadDone(s, 'b-2')).toBe(false);
    expect(batchHasFirstReadDone(s, null)).toBe(false);
  });
});

describe('the derived "running" block', () => {
  beforeEach(() => resetSuperIndex());
  it('the owner message carries it only while the first-read child runs', () => {
    noteSuperState(ROOT, state({ row: 'working' }));
    expect(superFirstReadRunning('sup-1')).toBe(true);
    noteSuperState(ROOT, state({ row: 'done' }));
    expect(superFirstReadRunning('sup-1')).toBe(false);
    // A quit mid-read: the child ended, nothing runs.
    noteSuperState(ROOT, state({ row: 'working', endedAt: 5 }));
    expect(superFirstReadRunning('sup-1')).toBe(false);
    expect(FIRST_READ_LIVE_BLOCK.startsWith('<first-read>')).toBe(true);
    expect(FIRST_READ_LIVE_BLOCK).toMatch(/Do not start another read/);
  });
});

describe('no verb that starts work in the first read\'s result turn', () => {
  let dir: string;
  let root: string;
  let token = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'first-read-done-'));
    root = join(dir, 'Orbit', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    token = mintWindowToken({ send: () => true, vault: 'Orbit', contextRoot: root, sessionId: 'sup-1', mode: 'super' }).token;
    const s = state();
    s.queue = [{ ...item('q-1'), state: 'delivered', batch: 'b-1' }];
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(s));
  });
  afterEach(() => {
    _resetSuperInbox();
    resetWindowControl();
    rmSync(dir, { recursive: true, force: true });
  });

  function req(body: unknown): IncomingMessage {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
    return r;
  }
  async function verb(v: string, body: Record<string, unknown>) {
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { setHeader: () => void }).setHeader = () => {};
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    await handleSuperVerb(req(body), out, { verb: v });
    return out;
  }

  it('refuses delegate, pool, team ask and schedule while that batch is open', async () => {
    _openEventTurnForTests('sup-1', 'b-1', root);
    expect([...FIRST_READ_BARRED_VERBS].sort()).toEqual(['delegate', 'pool-add', 'resume', 'schedule', 'send', 'team-ask']);
    for (const v of FIRST_READ_BARRED_VERBS) {
      const r = await verb(v, { model: 'sonnet', prompt: 'Build the export.' });
      expect(r.status, v).toBe(403);
      expect(r.json.error, v).toBe('first_read_turn');
    }
    // Reading the state is fine in that turn.
    expect((await verb('state', {})).status).toBe(200);
  });

  it('another batch does not refuse them', async () => {
    _openEventTurnForTests('sup-1', 'b-9', root);
    const r = await verb('delegate', { model: 'sonnet', prompt: 'Build the export.' });
    expect(r.json.error).not.toBe('first_read_turn');
  });
});
