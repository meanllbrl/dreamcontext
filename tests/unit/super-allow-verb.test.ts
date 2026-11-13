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
import { WINDOW_TIMEOUT_MS, deliverSuperResult, deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import { _resetChatRegistry, registerChat, registerCrewHandle } from '../../src/lib/assistant/chat-registry.js';
import { permissionAnswerFrame } from '../../src/lib/super/permission-answer.js';
import { pastDeadline } from '../../dashboard/src/components/sleepy/windowVerbs.js';
import { superAllow } from '../../dashboard/src/components/sleepy/super/superAllow.js';
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
      setImmediate(() => (frame.subtype === 'window_command' ? deliverWindowResult : deliverSuperResult)(t, frame.id, answerWith));
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

describe('no window answers (field 2026-11-13: the app in the background)', () => {
  it('super allow: the server answers the open permission itself, with a deadline on the window\'s copy', async () => {
    askPermission(CHILD, true);
    const answered: Array<[string, string, string | undefined]> = [];
    const off = registerCrewHandle(CHILD, {
      sendServerTurn: () => true,
      answerPermission: (requestId, behavior, message) => { answered.push([requestId, behavior, message]); return true; },
    });
    answerWith = { ok: false, error: 'no_window' };
    const before = Date.now();
    const r = await allow(H(token(vaultA, 'sess-a', 'super')));
    off();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.result).toMatchObject({ child: CHILD, requestId: 'perm-1', answered: 'allow', via: 'server' });
    expect(answered).toEqual([['perm-1', 'allow', undefined]]);
    const deadline = frames.find((f) => f.frame.subtype === 'super_command')?.frame.args.deadline as number;
    expect(deadline).toBeGreaterThan(before);
    expect(deadline).toBeLessThan(before + WINDOW_TIMEOUT_MS);
    expect((await readSuperState(vaultA)).queue[0].state).toBe('done');
  });

  it('super allow: no process to answer it either → still 409 no_window, the item stays open', async () => {
    askPermission(CHILD, true);
    answerWith = { ok: false, error: 'no_window' };
    const r = await allow(H(token(vaultA, 'sess-a', 'super')));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('no_window');
    expect((await readSuperState(vaultA)).queue[0].state).not.toBe('done');
  });

  it('super send: a running child gets the words as the server\'s own turn', async () => {
    registerChat({ sessionId: CHILD, conversationId: CHILD, vault: 'acme', mode: 'basic' });
    const turns: string[] = [];
    const off = registerCrewHandle(CHILD, { sendServerTurn: (text) => { turns.push(text); return true; } });
    answerWith = { ok: false, error: 'no_window' };
    const t = token(vaultA, 'sess-a', 'super');
    const r = res();
    await handleSuperVerb(req({ headers: H(t), body: { child: CHILD, text: 'Read the brief' } }), r, { verb: 'send' });
    off();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.result).toMatchObject({ child: CHILD, delivered: 'sent', via: 'server' });
    expect(turns).toEqual(['Read the brief']);
    expect(typeof frames.find((f) => f.frame.verb === 'send')?.frame.args.deadline).toBe('number');
  });
});

describe('the server\'s permission answer frame and the window\'s deadline', () => {
  const line = (o: Record<string, unknown> = {}) => JSON.stringify({
    type: 'control_request', request_id: 'perm-1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, ...o },
  });
  it('an allow runs the call as asked; a deny carries its reason', () => {
    expect(permissionAnswerFrame(line(), 'perm-1', 'allow')).toEqual({ type: 'answer', requestId: 'perm-1', behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(permissionAnswerFrame(line(), 'perm-1', 'deny', 'no')).toEqual({ type: 'answer', requestId: 'perm-1', behavior: 'deny', message: 'no' });
  });
  it('never a question, another request, or a line that is no open permission', () => {
    expect(permissionAnswerFrame(line({ tool_name: 'AskUserQuestion' }), 'perm-1', 'allow')).toBeNull();
    expect(permissionAnswerFrame(line(), 'perm-2', 'allow')).toBeNull();
    expect(permissionAnswerFrame(undefined, 'perm-1', 'allow')).toBeNull();
    expect(permissionAnswerFrame('not json', 'perm-1', 'allow')).toBeNull();
    expect(permissionAnswerFrame(line({ input: null }), 'perm-1', 'allow')).toBeNull();
  });
  it('a window that wakes past the deadline refuses send and allow', () => {
    const past = { deadline: Date.now() - 1 };
    expect(pastDeadline(past)).toBe(true);
    expect(pastDeadline({ deadline: Date.now() + 60_000 })).toBe(false);
    expect(pastDeadline({})).toBe(false);
    const chat = { getModel: () => ({ pending: [{ kind: 'permission', requestId: 'perm-1', input: {} }] as never }), answer: () => true };
    expect(superAllow({ child: CHILD, requestId: 'perm-1', behavior: 'allow', ...past }, () => true, () => chat)).toEqual({ ok: false, error: 'expired' });
    expect(superAllow({ child: CHILD, requestId: 'perm-1', behavior: 'allow' }, () => true, () => chat)).toEqual({ ok: true });
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

describe('super allow from an AI Team member\'s Super (0.40.2 merge)', () => {
  it('closes the item in the member\'s own record, never main\'s', async () => {
    const { createAgent } = await import('../../src/lib/agents/store.js');
    const { withSuperState } = await import('../../src/lib/super/store.js');
    createAgent(vaultA, { slug: 'rota', title: 'Rota', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
    await withSuperState(vaultA, 'main', (s) => { s.queue = []; delete s.children[CHILD]; });
    await withSuperState(vaultA, 'm:rota', (s) => {
      s.session = 'sess-m'; s.enabled = true;
      s.children[CHILD] = kid(CHILD);
      s.queue.push(permItem());
    });
    askPermission(CHILD, true);
    const t = mintWindowToken({
      send: (f: unknown) => { const frame = f as { id: string }; setImmediate(() => deliverSuperResult(t, frame.id, { ok: true })); return true; },
      vault: 'acme', contextRoot: vaultA, sessionId: 'sess-m', mode: 'super', superId: 'm:rota',
    }).token;
    const r = await allow(H(t));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await readSuperState(vaultA, 'm:rota')).queue.find((q) => q.id === 'q-perm1')?.state).toBe('done');
    expect((await readSuperState(vaultA)).queue).toEqual([]);
  });
});
