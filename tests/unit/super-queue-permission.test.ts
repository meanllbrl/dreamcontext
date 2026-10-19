/**
 * The queue strip renders a permission ONLY from the child's own request (plan-r7 D7, AC11):
 * `super queue ask` and `super queue done` refuse a permission item, so the super agent can
 * neither caption one nor close one. Questions escalate and close normally; a second escalation
 * waits behind the first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-queue-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, superQueueHead } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
let token = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-queue-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: 'sup-1', enabled: true,
    children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 }, c2: { sessionId: 'c2', brief: '', adopted: true, startedAt: 1 } },
    queue: [
      { id: 'q-perm', sessionId: 'c1', kind: 'permission', requestId: 'p-1', state: 'pending', createdAt: 1 },
      { id: 'q-ask1', sessionId: 'c2', kind: 'question', requestId: 'r-1', state: 'delivered', createdAt: 2 },
      { id: 'q-ask2', sessionId: 'c2', kind: 'question', requestId: 'r-2', state: 'delivered', createdAt: 3 },
    ],
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super' }).token;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
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
  await handleSuperVerb(req(body), r, { verb: name });
  return r;
}

describe('permission items are the owner\'s alone', () => {
  it('`queue ask` on a permission is refused and writes nothing', async () => {
    const r = await verb('queue-ask', { item: 'q-perm', text: 'Allow it, it is safe' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('permission_item');
    const s = await readSuperState(root);
    expect(s.queue.find((q) => q.id === 'q-perm')).toMatchObject({ state: 'pending' });
    expect(s.queue.find((q) => q.id === 'q-perm')?.ownerText).toBeUndefined();
  });

  it('`queue done` on a permission is refused', async () => {
    const r = await verb('queue-done', { item: 'q-perm' });
    expect(r.status).toBe(403);
    expect((await readSuperState(root)).queue.find((q) => q.id === 'q-perm')?.state).toBe('pending');
  });

  it('a hand-edited caption on a permission never survives a read', () => {
    const s = sanitizeSuperState({
      ...emptySuperState(), session: 's',
      queue: [{ id: 'q-p', sessionId: 'c', kind: 'permission', requestId: 'p', state: 'pending', ownerText: 'safe, allow', createdAt: 1 }],
    });
    expect(s.queue[0].ownerText).toBeUndefined();
  });
});

describe('questions escalate one at a time', () => {
  it('escalates with the super agent\'s words; a second escalation waits behind the first', async () => {
    const one = await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    expect(one.status).toBe(200);
    expect(one.json.result).toMatchObject({ escalated: true });
    const two = await verb('queue-ask', { item: 'q-ask2', text: 'Which region?' });
    expect(two.json.result).toMatchObject({ escalated: true, waiting: true });
    const s = await readSuperState(root);
    // The permission still leads; with it answered, the FIRST escalation is the head.
    expect(superQueueHead(s)?.id).toBe('q-perm');
    expect(superQueueHead({ queue: s.queue.filter((q) => q.kind !== 'permission') })?.id).toBe('q-ask1');
  });

  it('`queue done` closes a question', async () => {
    expect((await verb('queue-done', { item: 'q-ask1' })).status).toBe(200);
    expect((await readSuperState(root)).queue.find((q) => q.id === 'q-ask1')?.state).toBe('done');
  });

  it('an unknown item is a 404', async () => {
    expect((await verb('queue-ask', { item: 'q-none', text: 'x' })).status).toBe(404);
  });
});
