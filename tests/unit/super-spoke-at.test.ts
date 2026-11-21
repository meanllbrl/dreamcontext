/**
 * Plan super-v3 K3: the server stamps `SuperChild.spokeAt` when the Super speaks to a child
 * (`brief`, `read`; `send`, `answer` and `allow` stamp inside their own writes), so the window
 * knows the job it is talking about. The stamp survives a read, a bad value is dropped, and
 * the remote view never carries it. Fictional project "acme".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/spoke-at-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { superRemoteView } from '../../src/lib/super/remote-view.js';

const SUPER = 'sup-spoke';
const KID = '42345678-1234-4234-8234-123456789abc';
const OTHER = '52345678-1234-4234-8234-123456789abc';
let dir: string;
let root: string;
let token = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spoke-at-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  const kid = (id: string) => ({ sessionId: id, brief: 'Acme job', adopted: false, startedAt: 1, row: 'working' });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, children: { [KID]: kid(KID), [OTHER]: kid(OTHER) } }));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
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
  (out as unknown as { setHeader: () => void }).setHeader = () => {};
  return out;
}
const verb = async (name: string, body: Record<string, unknown>) => { const r = res(); await handleSuperVerb(req(body), r, { verb: name }); return r; };

describe('spokeAt', () => {
  it('brief stamps the child it names, and only that one', async () => {
    const t0 = Date.now();
    expect((await verb('brief', { child: KID, line: 'Acme pricing page, step 2' })).status).toBe(200);
    const s = await readSuperState(root);
    expect(s.children[KID].spokeAt).toBeGreaterThanOrEqual(t0);
    expect(s.children[OTHER].spokeAt).toBeUndefined();
  });

  it('read stamps it too, even when the child has no transcript yet', async () => {
    const r = await verb('read', { child: OTHER });
    expect(r.status).toBe(404);
    expect((await readSuperState(root)).children[OTHER].spokeAt).toBeGreaterThan(0);
  });

  it('the newest stamp names the job the Super talks about', async () => {
    await verb('brief', { child: KID, line: 'first' });
    await new Promise((d) => setTimeout(d, 5));
    await verb('brief', { child: OTHER, line: 'second' });
    const s = await readSuperState(root);
    expect(s.children[OTHER].spokeAt!).toBeGreaterThan(s.children[KID].spokeAt!);
  });

  it('a bad stored value is dropped; the remote view never carries it', () => {
    const raw = JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8'));
    raw.children[KID].spokeAt = 'soon';
    raw.children[OTHER].spokeAt = 77;
    const s = sanitizeSuperState(raw);
    expect(s.children[KID].spokeAt).toBeUndefined();
    expect(s.children[OTHER].spokeAt).toBe(77);
    expect(JSON.stringify(superRemoteView(s, 'acme', null, false, {}))).not.toContain('spokeAt');
  });
});
