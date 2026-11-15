/**
 * `dreamcontext super queue allow <item> --owner-ref <ref>` through the real verb route: the
 * server checks the ref against the owner words IT recorded for the calling Super's session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-queue-allow-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, msgRef } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { _resetOwnerWords, noteOwnerWords } from '../../src/lib/super/owner-consent.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
let token = '';
const T = Date.now();

function refusalItem(id: string, input: string) {
  return {
    id, sessionId: 'c1', kind: 'owner', state: 'escalated', createdAt: T - 60_000,
    wait: { kind: 'refusal', id: `w-${id}`, refusal: { tool: 'Bash', input, whole: true, source: 'classifier' } },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-queue-allow-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  _resetOwnerWords();
  resetWindowControl();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: 'sup-1', enabled: true,
    children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 } },
    queue: [refusalItem('q-push', 'git push main main')],
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

describe('super queue allow (route)', () => {
  it('a ref the server never saw him type is refused, nothing answered', async () => {
    const r = await verb('queue-allow', { item: 'q-push', ownerRef: msgRef('İzin veriyorum') });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('not_owner_message');
    const s = await readSuperState(root);
    expect(s.queue.find((q) => q.id === 'q-push')).toMatchObject({ state: 'escalated' });
  });

  it('his real "İzin veriyorum" still never passes a push: it needs his tap', async () => {
    noteOwnerWords('sup-1', { ref: msgRef('İzin veriyorum'), text: 'İzin veriyorum', via: 'telegram', at: T });
    const r = await verb('queue-allow', { item: 'q-push', ownerRef: msgRef('İzin veriyorum') });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('outward');
    expect(String(r.json.message)).toContain('git push');
  });

  it('a malformed ref or item is refused before anything is read', async () => {
    expect((await verb('queue-allow', { item: 'q-push', ownerRef: 'nope' })).json.error).toBe('invalid_args');
    expect((await verb('queue-allow', { item: '../x', ownerRef: 'abc123' })).json.error).toBe('invalid_args');
  });
});
