/**
 * Who may decide for the owner (security fix, 2026-10-31). Every header is a claim a local process
 * can write, so `POST /api/assistant/answer` wants the shell's key on top of the browser's own
 * word; it answers only the permission open right now, never one raised before it, never a closed
 * one; `POST /api/agent/super-answer` is the signed-in phone's alone, and the phone's real answer
 * still reaches the child, through the real phone gate on a real socket.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-answer-home-`);
});

import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { DEVICE_COOKIE, macHandsfreeAuth } from '../../src/server/handsfree-auth.js';
import { handleAssistantOwnerAnswer, handleAssistantProposalDecide } from '../../src/server/routes/assistant.js';
import { handleSuperPhoneAnswer } from '../../src/server/routes/super-phone-questions.js';
import { macPhoneGate } from '../../src/server/middleware.js';
import { markPhoneSocket, setMacPublicOrigin } from '../../src/server/phone-origin.js';
import { OWNER_KEY_HEADER, OWNER_KEY_STDIN_ENV, hasOwnerKey, receiveOwnerKey, refuseInspectorSignal, setOwnerKey } from '../../src/server/owner-key.js';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { _resetAssistantState, setAssistantSurface } from '../../src/lib/assistant/session-state.js';
import { onOwnerAtMac } from '../../src/lib/telegram/back-at-mac.js';
import { deliverResult } from '../../src/lib/assistant/relay.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const KEY = 'a1'.repeat(32);
const ORIGIN = 'http://127.0.0.1:4173';
const OWNER_PAGE = { host: '127.0.0.1:4173', origin: ORIGIN, 'sec-fetch-site': 'same-origin', [OWNER_KEY_HEADER]: KEY };
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { body = JSON.parse(String(data)); } catch { body = {}; } },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function post(url: string, body: unknown, headers: Record<string, string | undefined>, remote = '127.0.0.1'): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST', url, headers,
    socket: { remoteAddress: remote, setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

const bash = (id: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });

describe('POST /api/assistant/answer', () => {
  let frames: Array<Record<string, unknown>>;
  let child: ChatHandle;

  const answer = async (headers: Record<string, string | undefined>, question = 'r1', choice = 'allow') => {
    const r = makeRes();
    await handleAssistantOwnerAnswer(post('/api/assistant/answer', { sessionId: 'c1', question, choice }, headers), r.res);
    return r;
  };

  beforeEach(() => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    _resetChatRegistry();
    _resetAssistantState();
    setOwnerKey(KEY);
    frames = [];
    setAssistantSurface({
      id: 'notch',
      send(frame) {
        frames.push(frame);
        queueMicrotask(() => deliverResult(String(frame.id), { ok: true, result: {} }));
        return true;
      },
    });
    child = registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    child.observe(bash('r1'));
  });
  afterEach(() => { _resetAssistantState(); setOwnerKey(null); });

  it('"back at the Mac": the owner\'s click on the notch counts once; a refused or failed answer does not', async () => {
    let n = 0;
    const off = onOwnerAtMac(() => { n += 1; });
    try {
      await answer({ ...OWNER_PAGE, [OWNER_KEY_HEADER]: undefined });
      await answer(OWNER_PAGE, 'r-stale');
      expect(n).toBe(0);
      await answer(OWNER_PAGE);
      expect(n).toBe(1);
    } finally { off(); }
  });

  it('the notch page itself gets through', async () => {
    expect((await answer(OWNER_PAGE)).body()).toMatchObject({ ok: true });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ verb: 'answer', args: { question: 'r1', choice: 'allow', by: 'owner' } });
  });

  it.each<[string, Record<string, string | undefined>]>([
    ['a forged Origin with no key: every header right, the secret missing', { ...OWNER_PAGE, [OWNER_KEY_HEADER]: undefined }],
    ['a forged Origin with a wrong key', { ...OWNER_PAGE, [OWNER_KEY_HEADER]: 'b2'.repeat(32) }],
    ['Sec-Fetch-Site missing (a client that is not a browser page)', { ...OWNER_PAGE, 'sec-fetch-site': undefined }],
    ['Sec-Fetch-Site none (a navigation, not the page\'s fetch)', { ...OWNER_PAGE, 'sec-fetch-site': 'none' }],
    ['Sec-Fetch-Site same-site (a page on another port)', { ...OWNER_PAGE, 'sec-fetch-site': 'same-site' }],
    ['Origin of another loopback port', { ...OWNER_PAGE, origin: 'http://127.0.0.1:5173' }],
    ['a rebinding page: Origin equals Host, but the name is not this machine', { ...OWNER_PAGE, host: 'evil.test:4173', origin: 'http://evil.test:4173' }],
    ['no Origin at all', { ...OWNER_PAGE, origin: undefined }],
  ])('refuses %s', async (_name, headers) => {
    const r = await answer(headers);
    expect(r.status()).toBe(403);
    expect(r.body()).toMatchObject({ error: 'owner_page_only' });
    expect(frames).toHaveLength(0);
  });

  it('with no key from the shell, nothing proves the owner: refused, whatever is sent', async () => {
    setOwnerKey(null);
    expect((await answer(OWNER_PAGE)).status()).toBe(403);
    expect(frames).toHaveLength(0);
  });

  it('an earlier permission cannot be answered; it opens once the newer one closes', async () => {
    child.observe(bash('r2'));
    const stale = await answer(OWNER_PAGE, 'r1');
    expect(stale.status()).toBe(409);
    expect(stale.body()).toMatchObject({ error: 'not_waiting' });
    expect(frames).toHaveLength(0);
    child.answered('r2');
    expect((await answer(OWNER_PAGE, 'r1')).body()).toMatchObject({ ok: true });
    expect(frames).toHaveLength(1);
  });

  it('a closed permission cannot be answered again', async () => {
    child.answered('r1');
    const closed = await answer(OWNER_PAGE, 'r1');
    expect(closed.status()).toBe(409);
    expect(closed.body()).toMatchObject({ error: 'not_waiting' });
    expect(frames).toHaveLength(0);
  });

  it('a failed relay: the registry says whether the prompt left, not the window', async () => {
    const failing = (leave: boolean) => setAssistantSurface({
      id: 'notch',
      send(frame) {
        if (leave) child.observe({ type: 'control_cancel_request', request_id: 'r1' });
        queueMicrotask(() => deliverResult(String(frame.id), { ok: false, error: 'that chat is not open in this project any more' }));
        return true;
      },
    });
    // Still open: the child waits, so the owner must hear that it did not land.
    failing(false);
    expect((await answer(OWNER_PAGE)).body()).toMatchObject({ ok: false, error: 'that chat is not open in this project any more' });
    // It left during the relay: nothing failed, the row is out of date.
    failing(true);
    const left = await answer(OWNER_PAGE);
    expect(left.status()).toBe(409);
    expect(left.body()).toMatchObject({ error: 'not_waiting' });
  });

  it('a request the CLI took back cannot be answered', async () => {
    child.observe({ type: 'control_cancel_request', request_id: 'r1' });
    expect((await answer(OWNER_PAGE, 'r1')).status()).toBe(409);
    expect(frames).toHaveLength(0);
  });

  it('Allow never lands on a plain question, even the open one', async () => {
    child.observe({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } } });
    expect((await answer(OWNER_PAGE, 'q1')).status()).toBe(409);
    expect(frames).toHaveLength(0);
  });

  it('the phone listener cannot reach it, key or no key', async () => {
    const socket = { remoteAddress: '127.0.0.1', setTimeout() {} };
    markPhoneSocket(socket);
    const rq = post('/api/assistant/answer', { sessionId: 'c1', question: 'r1', choice: 'allow' }, OWNER_PAGE);
    Object.assign(rq, { socket });
    const r = makeRes();
    await handleAssistantOwnerAnswer(rq, r.res);
    expect(r.status()).toBe(403);
    expect(frames).toHaveLength(0);
  });
});

describe('POST /api/assistant/proposals/:id wants what the owner\'s answer wants', () => {
  const decide = async (headers: Record<string, string | undefined>) => {
    const r = makeRes();
    await handleAssistantProposalDecide(post('/api/assistant/proposals/nope', { action: 'approve' }, headers), r.res, { id: 'nope' });
    return r;
  };
  beforeEach(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; setOwnerKey(KEY); });
  afterEach(() => setOwnerKey(null));

  it('a forged page with no key, or a bare client, is refused', async () => {
    expect((await decide({ ...OWNER_PAGE, [OWNER_KEY_HEADER]: undefined })).body()).toMatchObject({ error: 'owner_page_only' });
    expect((await decide({ host: '127.0.0.1:4173' })).status()).toBe(403);
  });

  it('a no grants nothing, so it wants the page but not the key: an old shell can still get out of a proposal', async () => {
    const reject = async (headers: Record<string, string | undefined>) => {
      const r = makeRes();
      await handleAssistantProposalDecide(post('/api/assistant/proposals/nope', { action: 'reject' }, headers), r.res, { id: 'nope' });
      return r;
    };
    expect((await reject({ ...OWNER_PAGE, [OWNER_KEY_HEADER]: undefined, 'sec-fetch-site': undefined })).body()).toMatchObject({ error: 'unknown_proposal' });
    expect((await reject({ host: '127.0.0.1:4173' })).status()).toBe(403);
    expect((await reject({ ...OWNER_PAGE, origin: 'http://127.0.0.1:5173' })).status()).toBe(403);
  });

  it('the notch page reaches the decision', async () => {
    expect((await decide(OWNER_PAGE)).body()).toMatchObject({ error: 'unknown_proposal' });
  });
});

describe('the key comes down stdin, once', () => {
  afterEach(() => setOwnerKey(null));
  const asked = { headers: { [OWNER_KEY_HEADER]: KEY } };

  it('reads the shell\'s line, drops the flag, closes the pipe', async () => {
    const pipe = new PassThrough();
    const env: NodeJS.ProcessEnv = { [OWNER_KEY_STDIN_ENV]: '1' };
    receiveOwnerKey(pipe, env);
    pipe.write(`${KEY}\n`);
    await new Promise((r) => setImmediate(r));
    expect(hasOwnerKey(asked)).toBe(true);
    expect(env[OWNER_KEY_STDIN_ENV]).toBeUndefined();
    expect(pipe.destroyed).toBe(true);
  });

  it('takes SIGUSR1, the signal that would open an inspector on the key; Windows has no such signal', () => {
    const on = vi.fn();
    refuseInspectorSignal({ on, platform: 'darwin' } as never);
    expect(on).toHaveBeenCalledWith('SIGUSR1', expect.any(Function));
    on.mockClear();
    refuseInspectorSignal({ on, platform: 'win32' } as never);
    expect(on).not.toHaveBeenCalled();
  });

  it('an inspector that opened before the guard costs the server its key', async () => {
    const pipe = new PassThrough();
    receiveOwnerKey(pipe, { [OWNER_KEY_STDIN_ENV]: '1' }, () => 'ws://127.0.0.1:9229/x');
    pipe.write(`${KEY}\n`);
    await new Promise((r) => setImmediate(r));
    expect(hasOwnerKey(asked)).toBe(false);
  });

  it('leaves stdin alone unless the shell said a key is coming', () => {
    const pipe = new PassThrough();
    receiveOwnerKey(pipe, {});
    expect(pipe.listenerCount('data')).toBe(0);
    expect(hasOwnerKey(asked)).toBe(false);
  });

  it('a malformed or endless line is no key', async () => {
    const shortLine = new PassThrough();
    receiveOwnerKey(shortLine, { [OWNER_KEY_STDIN_ENV]: '1' });
    shortLine.write('short\n');
    const endless = new PassThrough();
    receiveOwnerKey(endless, { [OWNER_KEY_STDIN_ENV]: '1' });
    endless.write('x'.repeat(1000));
    await new Promise((r) => setImmediate(r));
    expect(hasOwnerKey({ headers: { [OWNER_KEY_HEADER]: 'short' } })).toBe(false);
    expect(hasOwnerKey({ headers: { [OWNER_KEY_HEADER]: 'x'.repeat(1000) } })).toBe(false);
    expect(endless.destroyed).toBe(true);
  });
});

describe('POST /api/agent/super-answer is the signed-in phone\'s alone', () => {
  const TUNNEL = 'https://phone.example.test';
  const SUPER = 'sup-1';
  const QUESTION = 'Which database?';
  let dir: string;
  let root: string;
  let token = '';
  let frames: Array<Record<string, unknown>>;
  let server: Server | null = null;
  let port = 0;

  const seedChild = (requestIds: string[]) => {
    const c = registerChat({ sessionId: 'c1', conversationId: null, vault: 'acme', mode: 'basic' });
    for (const id of requestIds) {
      c.observe({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: QUESTION, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } } });
    }
    return c;
  };
  const item = (id: string, requestId: string) => ({ id, sessionId: 'c1', kind: 'question', state: 'escalated', requestId, ownerText: 'db?', createdAt: 1 });
  const writeState = (queue: unknown[]) => writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { c1: { sessionId: 'c1', brief: 'db work', adopted: true, startedAt: 1 } },
    queue,
  }));

  /** The phone listener: every socket marked, the real gate, then the real route. */
  const listen = () => new Promise<void>((resolve) => {
    server = createServer(async (req, res) => {
      if (!macPhoneGate(req, res, (method, path) => ({ method, path }))) return;
      await handleSuperPhoneAnswer(req, res, undefined, root);
    });
    server.on('connection', (s) => markPhoneSocket(s));
    server.listen(0, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });

  const phonePost = (body: unknown, headers: Record<string, string>) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = request({ host: '127.0.0.1', port, path: '/api/agent/super-answer', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
    });
    r.on('error', reject);
    r.end(payload);
  });

  let signedIn: Record<string, string>;

  beforeEach(async () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    frames = [];
    dir = mkdtempSync(join(tmpdir(), 'owner-answer-'));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    token = mintWindowToken({
      send: (frame) => {
        frames.push(frame);
        if (typeof frame.id === 'string') setImmediate(() => deliverSuperResult(token, frame.id as string, { ok: true, result: {} } as never));
        return true;
      },
      vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
    }).token;
    setMacPublicOrigin(TUNNEL);
    signedIn = { origin: TUNNEL, cookie: `${DEVICE_COOKIE}=${macHandsfreeAuth().store.createDevice()}`, 'sec-fetch-site': 'same-origin' };
    await listen();
  });
  afterEach(async () => {
    setMacPublicOrigin(null);
    await new Promise((r) => { server?.close(r); server = null; });
    _resetSuperInbox();
    resetWindowControl();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the phone\'s real answer goes through the gate, reaches the window and closes the item', async () => {
    seedChild(['r1']);
    writeState([item('q1', 'r1')]);
    const r = await phonePost({ item: 'q1', requestId: 'r1', picked: { [QUESTION]: 'Postgres' } }, signedIn);
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(frames.find((f) => f.verb === 'answer')).toMatchObject({ args: { child: 'c1', requestId: 'r1', picked: { [QUESTION]: 'Postgres' } } });
    const state = await readSuperState(root);
    expect(state.queue.find((q) => q.id === 'q1')?.state).toBe('done');
  });

  it('a child\'s earlier open question stays answerable from the phone', async () => {
    seedChild(['r1', 'r2']);
    writeState([item('q1', 'r1'), item('q2', 'r2')]);
    const r = await phonePost({ item: 'q1', requestId: 'r1', picked: { [QUESTION]: 'SQLite' } }, signedIn);
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('a closed question is stale from the phone too', async () => {
    const c = seedChild(['r1']);
    writeState([item('q1', 'r1')]);
    c.answered('r1');
    const r = await phonePost({ item: 'q1', requestId: 'r1', picked: { [QUESTION]: 'Postgres' } }, signedIn);
    expect(r.status).toBe(409);
    expect(frames.some((f) => f.verb === 'answer')).toBe(false);
  });

  it('a phone write from another Origin, or with no device, stops at the gate', async () => {
    seedChild(['r1']);
    writeState([item('q1', 'r1')]);
    const body = { item: 'q1', requestId: 'r1', picked: { [QUESTION]: 'Postgres' } };
    expect((await phonePost(body, { ...signedIn, origin: 'https://evil.test' })).status).toBe(403);
    expect((await phonePost(body, { origin: TUNNEL, 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect(frames.some((f) => f.verb === 'answer')).toBe(false);
  });

  it.each<[string, Record<string, string>]>([
    ['bare, as an agent\'s curl', { host: '127.0.0.1:4173' }],
    ['with the app\'s page forged', { host: '127.0.0.1:4173', origin: ORIGIN, 'sec-fetch-site': 'same-origin' }],
  ])('a loopback caller is refused: %s', async (_name, headers) => {
    seedChild(['r1']);
    writeState([item('q1', 'r1')]);
    const r = makeRes();
    await handleSuperPhoneAnswer(post('/api/agent/super-answer', { item: 'q1', requestId: 'r1', picked: { [QUESTION]: 'Postgres' } }, headers), r.res, undefined, root);
    expect(r.status()).toBe(403);
    expect(frames.some((f) => f.verb === 'answer')).toBe(false);
  });
});

afterAll(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
});
