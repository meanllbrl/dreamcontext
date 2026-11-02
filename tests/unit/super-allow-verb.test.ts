/**
 * `super allow`: the Super of THAT child answers its Bypass child's residual permission; every other
 * caller and every other permission is refused (task super-bypass-taki-cocugunun-…, owner
 * 2026-11-02). The phone's own Allow/Deny (POST /api/agent/super-permission) answers a permission
 * that waits for the owner, only from a signed-in phone socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { handleSuperPhonePermission } from '../../src/server/routes/super-phone-questions.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';

let dir: string;
let vaultA: string;
let vaultB: string;
const savedEnv = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };
const CHILD = 'child-a';
const kid = (sid: string) => ({ sessionId: sid, brief: '', adopted: true, startedAt: 1 });

function makeVault(name: string, state: Record<string, unknown>): string {
  const root = join(dir, name, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), ...state }));
  return root;
}
const permItem = (o: Partial<SuperQueueItem> = {}): SuperQueueItem => ({ id: 'q-perm1', sessionId: CHILD, kind: 'permission', requestId: 'perm-1', state: 'delivered', createdAt: 1, toSuper: true, ...o });

function req(o: { headers?: Record<string, string>; body?: unknown; phone?: boolean } = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  const socket = { remoteAddress: '127.0.0.1' };
  if (o.phone) markPhoneSocket(socket);
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...(o.headers ?? {}) }, socket, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(o.body === undefined ? '' : JSON.stringify(o.body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { setHeader: () => void }).setHeader = () => undefined;
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

/** Window frames each token received; `answerWith` settles each super_command as the window would. */
const frames: Array<{ token: string; frame: { subtype: string; id: string; verb: string; args: Record<string, unknown> } }> = [];
let answerWith: { ok: true } | { ok: false; error: string } = { ok: true };
const token = (contextRoot: string, sessionId: string, mode: string, vault = 'acme') => {
  const t = mintWindowToken({
    send: (f: unknown) => {
      const frame = f as { subtype: string; id: string; verb: string; args: Record<string, unknown> };
      frames.push({ token: t, frame });
      setImmediate(() => deliverSuperResult(t, frame.id, answerWith));
      return true;
    },
    vault, contextRoot, sessionId, mode,
  }).token;
  return t;
};
const askPermission = (sid: string, bypass: boolean, requestId = 'perm-1') => {
  const h = registerChat({ sessionId: sid, conversationId: sid, vault: 'acme', mode: 'basic', bypass });
  h.userSent('go');
  h.observe({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 'tu-1' } });
  return h;
};
async function allow(headers: Record<string, string>, body: Record<string, unknown> = { child: CHILD, requestId: 'perm-1' }) {
  const r = res();
  await handleSuperVerb(req({ headers, body }), r, { verb: 'allow' });
  return r;
}
const H = (t: string) => ({ 'x-dreamcontext-window-token': t });

beforeEach(() => {
  resetWindowControl();
  resetSuperIndex();
  _resetChatRegistry();
  _resetSuperInbox();
  frames.length = 0;
  answerWith = { ok: true };
  dir = mkdtempSync(join(tmpdir(), 'super-allow-'));
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  vaultA = makeVault('acme', { session: 'sess-a', enabled: true, children: { [CHILD]: kid(CHILD) }, queue: [permItem()] });
  vaultB = makeVault('beta', { session: 'sess-b', enabled: true, children: { 'child-b': kid('child-b') } });
});
afterEach(() => {
  vi.useRealTimers();
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedEnv.DESKTOP;
  rmSync(dir, { recursive: true, force: true });
});

describe('super allow: who may call it', () => {
  it('a plain local curl (no window token) → 401, nothing written', async () => {
    askPermission(CHILD, true);
    expect((await allow({})).status).toBe(401);
    expect(frames).toEqual([]);
  });

  it('the child itself, or any other non-Super chat of the vault → 403', async () => {
    askPermission(CHILD, true);
    expect((await allow(H(token(vaultA, CHILD, 'develop')))).status).toBe(403);
    expect((await allow(H(token(vaultA, 'other', 'super')))).status).toBe(403);
    expect(frames).toEqual([]);
  });

  it('another vault\'s Super, naming this child → 403 not_your_child', async () => {
    askPermission(CHILD, true);
    const r = await allow(H(token(vaultB, 'sess-b', 'super', 'beta')));
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('not_your_child');
    expect(frames).toEqual([]);
  });
});

describe('super allow: which permission', () => {
  it('a child NOT in Bypass → 403 owner_only (its permissions stay the owner\'s)', async () => {
    askPermission(CHILD, false);
    const r = await allow(H(token(vaultA, 'sess-a', 'super')));
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('owner_only');
    expect(frames).toEqual([]);
  });

  it('a request the child no longer asks → 409 stale_request', async () => {
    const h = askPermission(CHILD, true);
    h.observe({ type: 'control_cancel_request', request_id: 'perm-1' });
    const r = await allow(H(token(vaultA, 'sess-a', 'super')));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('stale_request');
  });

  it('one already handed to the owner → 409 escalated', async () => {
    vaultA = makeVault('acme', { session: 'sess-a', enabled: true, children: { [CHILD]: kid(CHILD) }, queue: [permItem({ toSuper: undefined, state: 'escalated' })] });
    askPermission(CHILD, true);
    const r = await allow(H(token(vaultA, 'sess-a', 'super')));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('escalated');
    expect(frames).toEqual([]);
  });

  it('its own Bypass child\'s open request: relayed as the window\'s `allow`, the item closes', async () => {
    askPermission(CHILD, true);
    const t = token(vaultA, 'sess-a', 'super');
    const r = await allow(H(t));
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ child: CHILD, requestId: 'perm-1', answered: 'allow' });
    const commands = frames.filter((f) => f.frame.subtype === 'super_command');
    expect(commands).toHaveLength(1);
    expect(commands[0].frame).toMatchObject({ subtype: 'super_command', verb: 'allow', args: { child: CHILD, requestId: 'perm-1', behavior: 'allow' } });
    expect((await readSuperState(vaultA)).queue[0].state).toBe('done');
  });

  it('--deny carries the reason to the child', async () => {
    askPermission(CHILD, true);
    const r = await allow(H(token(vaultA, 'sess-a', 'super')), { child: CHILD, requestId: 'perm-1', deny: true, why: 'outside its worktree' });
    expect(r.json.result).toMatchObject({ answered: 'deny' });
    expect(frames.find((f) => f.frame.subtype === 'super_command')?.frame.args).toMatchObject({ behavior: 'deny', message: 'Denied by the Super Agent: outside its worktree' });
  });
});

describe('the phone\'s Allow / Deny (POST /api/agent/super-permission)', () => {
  const ownerItem = () => makeVault('acme', { session: 'sess-a', enabled: true, children: { [CHILD]: kid(CHILD) }, queue: [permItem({ toSuper: undefined, state: 'pending' })] });

  it('refused from anything but a signed-in phone socket', async () => {
    ownerItem();
    askPermission(CHILD, false);
    token(vaultA, 'sess-a', 'super');
    const r = res();
    await handleSuperPhonePermission(req({ body: { item: 'q-perm1', requestId: 'perm-1', choice: 'allow' } }), r, {}, vaultA);
    expect(r.status).toBe(403);
    expect(frames).toEqual([]);
  });
});
