/**
 * A remote screen only WATCHES a Super child (hands-free sekmeler W1, AC11/AC12), through the
 * REAL phone listener and chat upgrade, against a live child the Mac window holds (a mocked CLI).
 *
 *  - every phone open naming a child of a handed-over project — plain resume, sessionId,
 *    reattach=1, reattach=passive, an upper-case id — becomes a watch-only mirror: the Mac holder
 *    keeps its socket (no 4409), nothing is superseded or respawned, and nothing the phone sends
 *    reaches the child, while its stream comes down;
 *  - a child that is not live is refused; after a take-back the phone opens it as today;
 *  - a hand-over write still in flight already counts (the socket gate reads it);
 *  - the in-flight count is back at zero once every socket closed; Return closes child mirrors.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-child-watch-home-`);
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4252;
}
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => { const c = new FakeChild(); spawned.push(c); return c as unknown as import('node:child_process').ChildProcess; }),
  };
});
vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return { ...real, listClaudeAccounts: vi.fn(() => []) };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return { ...real, readAccountRejections: vi.fn(() => ({})) };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});

const http = (await import('node:http')).default;
const net = await import('node:net');
const { mkdirSync, rmSync, writeFileSync, promises: fsp } = await import('node:fs');
const { join } = await import('node:path');
const { default: WebSocket } = await import('ws');
const {
  buildRouter, makeRequestHandler, mainLaptopGate, attachMainListenerBackstop, setMainServerForTests, startPhoneListener, stopPhoneListener,
} = await import('../../src/server/index.js');
const { DEVICE_COOKIE, HandsfreeAuth, hashPassphrase, setMacHandsfreeAuthForTests } = await import('../../src/server/handsfree-auth.js');
const { setMacProbeNonce, setMacExposedVaults, setMacPublicOrigin } = await import('../../src/server/phone-origin.js');
const { addVault } = await import('../../src/lib/vaults.js');
const { startChatSession, phoneHolds, phoneOpeningCountForTests, notePhoneOpening, releasePhoneSessions, tagDeviceSocket } = await import('../../src/server/routes/agent-chat.js');
const { findLiveChat } = await import('../../src/server/routes/agent-chat-live.js');
const { SUPER_STATE_REL, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { _resetSuperInbox } = await import('../../src/lib/super/inbox.js');
const { enableSuper } = await import('../../src/lib/super/handover.js');
const { MAC_CLOSE_HANDED_OVER, MAC_CLOSE_TAKEN_OVER } = await import('../../src/lib/handsfree/mac/contract.js');

const ORIGIN = 'https://quiet-lake-1234.trycloudflare.com';
const PROJECT = 'watch-proj';
const SUPER = '11111111-2222-4333-8444-555555555555';
const CHILD = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const OTHER = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
let dir: string;
let project: string;
let root: string;
let main: import('node:http').Server;
let phonePort: number;
let cookie: string;
let macAuth: InstanceType<typeof HandsfreeAuth>;

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  ping = vi.fn(function (this: FakeWs) { this.emit('pong'); });
}

beforeAll(async () => {
  dir = process.env.HOME as string;
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  project = join(dir, PROJECT);
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  addVault(PROJECT, project);
  macAuth = new HandsfreeAuth({ dir: join(dir, 'mac') });
  mkdirSync(join(dir, 'mac'), { recursive: true });
  macAuth.store.setPassphrase(await hashPassphrase('alpha bravo charlie delta echo foxtrot'));
  cookie = `${DEVICE_COOKIE}=${macAuth.store.createDevice('MacBook · Chrome')}`;
  setMacHandsfreeAuthForTests(macAuth);
  const router = buildRouter();
  main = http.createServer(makeRequestHandler({ gate: (req, res) => mainLaptopGate(req, res, null), router, dashboardDir: dir, contextRoot: null }));
  attachMainListenerBackstop(main);
  await new Promise<void>((r) => main.listen(0, '127.0.0.1', () => r()));
  setMainServerForTests({ server: main, router, dashboardDir: dir, contextRoot: null });
  phonePort = (await startPhoneListener()).port;
});
afterAll(async () => {
  await stopPhoneListener();
  await new Promise<void>((r) => main.close(() => r()));
  setMainServerForTests(null);
  setMacHandsfreeAuthForTests(null);
  setMacPublicOrigin(null);
  setMacProbeNonce(null);
  setMacExposedVaults([]);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  spawned.length = 0;
  setMacPublicOrigin(ORIGIN);
  setMacProbeNonce('probe-nonce-1');
  setMacExposedVaults([PROJECT]);
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
});
afterEach(() => {
  for (const c of spawned) { c.emit('exit', 0, null); c.emit('close', 0, null); }
  _resetSuperInbox();
});

async function seed(enabled: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled,
    children: { [CHILD]: { sessionId: CHILD, brief: 'job', adopted: true, startedAt: 1 } }, ...extra,
  }));
  resetSuperIndex();
  await readSuperState(root);
}

/** The child running, held by the Mac window's socket. */
function startChild(id = CHILD): { mac: FakeWs; child: FakeChild } {
  const mac = new FakeWs();
  startChatSession(mac as unknown as import('ws').WebSocket, project, {
    bypass: false, sessionId: id, resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: 'basic' as never, vault: PROJECT,
  });
  return { mac, child: spawned[spawned.length - 1] };
}

interface Opened { ws: import('ws').WebSocket; frames: Array<Record<string, unknown>>; closed: Promise<number>; status: number }

/** A phone's chat socket through the phone listener: its handshake status, frames and close code. */
function open(query: string): Promise<Opened> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${phonePort}/api/agent/chat?vault=${PROJECT}&${query}`, { headers: { cookie, origin: ORIGIN } });
    const frames: Array<Record<string, unknown>> = [];
    let closedWith: (c: number) => void = () => {};
    const closed = new Promise<number>((r) => { closedWith = r; });
    ws.on('message', (d) => { try { frames.push(JSON.parse(String(d))); } catch { /* a raw line */ } });
    ws.on('close', (code) => closedWith(code));
    ws.on('unexpected-response', (_req, res) => { resolve({ ws, frames, closed, status: res.statusCode ?? 0 }); });
    ws.on('error', () => { /* the status or close says it */ });
    ws.on('open', () => resolve({ ws, frames, closed, status: 101 }));
  });
}

const watchOnly = (o: Opened) => o.frames.some((f) => f.type === '_meta' && f.subtype === 'reattached' && f.watchOnly === true);
const userWrites = (c: FakeChild) => c.stdin.write.mock.calls.map(([x]) => String(x)).filter((x) => x.includes('"type":"user"'));

describe('a phone open of a Super child is a watch-only mirror (AC12)', () => {
  for (const q of [`resume=${CHILD}`, `sessionId=${CHILD}`, `resume=${CHILD}&reattach=1`, `resume=${CHILD}&reattach=passive`, `resume=${CHILD.toUpperCase()}&reattach=1`]) {
    it(`${q}: watches; the Mac holder keeps the chat; nothing respawns`, async () => {
      await seed(true);
      const { mac } = startChild();
      const o = await open(q);
      expect(o.status).toBe(101);
      await vi.waitFor(() => expect(watchOnly(o)).toBe(true));
      expect(mac.close).not.toHaveBeenCalled();
      expect(mac.close).not.toHaveBeenCalledWith(MAC_CLOSE_TAKEN_OVER, expect.anything());
      expect(findLiveChat(CHILD)?.holder?.()).toBe(mac);
      expect(spawned).toHaveLength(1);
      o.ws.close();
      await o.closed;
      await vi.waitFor(() => expect(phoneOpeningCountForTests()).toBe(0));
    });
  }

  it('the stream comes down; nothing the phone sends reaches the child; the Mac\'s own words still do (AC11)', async () => {
    await seed(true);
    const { mac, child } = startChild();
    const o = await open(`resume=${CHILD}&reattach=passive`);
    await vi.waitFor(() => expect(watchOnly(o)).toBe(true));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } })}\n`));
    await vi.waitFor(() => expect(o.frames.some((f) => f.type === 'assistant')).toBe(true));
    const before = child.stdin.write.mock.calls.length;
    o.ws.send(JSON.stringify({ type: 'user', text: 'from the remote screen' }));
    o.ws.send(JSON.stringify({ type: 'control_response', response: { request_id: 'r', behavior: 'allow' } }));
    o.ws.send(JSON.stringify({ type: 'answer', requestId: 'r', behavior: 'allow' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(child.stdin.write.mock.calls.length).toBe(before);
    // The Super's `send` travels as an owner message through the Mac window's own tab socket.
    mac.emit('message', Buffer.from(JSON.stringify({ type: 'user', text: 'from the Super' })));
    await vi.waitFor(() => expect(userWrites(child).some((w) => w.includes('from the Super'))).toBe(true));
    expect(userWrites(child).some((w) => w.includes('from the remote screen'))).toBe(false);
    o.ws.close();
  });

  it('a child that is not live is refused before the handshake', async () => {
    await seed(true);
    const o = await open(`resume=${CHILD}&reattach=passive`);
    expect(o.status).toBe(403);
    expect(spawned).toHaveLength(0);
  });

  it('after a take-back the phone opens a former child as today (no watch)', async () => {
    await seed(false);
    startChild();
    const o = await open(`resume=${CHILD}&reattach=passive`);
    expect(o.status).toBe(101);
    await new Promise((r) => setTimeout(r, 200));
    expect(watchOnly(o)).toBe(false);
    o.ws.close();
  });

  it('a hand-over still being written already counts: reattach=1 and a plain resume watch, the Mac holder gets no 4409', async () => {
    await seed(false, { children: {} });
    const { mac } = startChild(OTHER);
    // Hand over OTHER while the record's commit is held.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const real = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (...a: Parameters<typeof fsp.rename>) => { await gate; return real(...a); });
    const writing = enableSuper(root, { adopt: [OTHER], titles: {} });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    for (const q of [`resume=${OTHER}&reattach=1`, `resume=${OTHER}`]) {
      const o = await open(q);
      expect(o.status).toBe(101);
      await vi.waitFor(() => expect(watchOnly(o)).toBe(true));
      await new Promise((r) => setTimeout(r, 100));
      expect(mac.close).not.toHaveBeenCalled();
      expect(spawned).toHaveLength(1);
      o.ws.close();
    }
    release();
    await writing;
    spy.mockRestore();
  });

  it('Return closes a child\'s watch (and every remote socket)', async () => {
    await seed(true);
    startChild();
    const o = await open(`resume=${CHILD}&reattach=passive`);
    await vi.waitFor(() => expect(watchOnly(o)).toBe(true));
    releasePhoneSessions();
    expect(await o.closed).toBe(4401);
  });

  it('"Hepsini çıkar" / a new password (every device signed out) closes a child\'s watch with 4401 (AC17)', async () => {
    await seed(true);
    startChild();
    const o = await open(`resume=${CHILD}&reattach=passive`);
    await vi.waitFor(() => expect(watchOnly(o)).toBe(true));
    macAuth.store.revokeAllLocal();
    expect(await o.closed).toBe(4401);
    // Signed in again for the tests after this one.
    cookie = `${DEVICE_COOKIE}=${macAuth.store.createDevice('MacBook · Chrome')}`;
  });

  it('the take-back closes a child\'s watch (4410: the client is decided again)', async () => {
    await seed(true);
    startChild();
    const o = await open(`resume=${CHILD}&reattach=passive`);
    await vi.waitFor(() => expect(watchOnly(o)).toBe(true));
    findLiveChat(CHILD)?.closeMirrors?.();
    expect(await o.closed).toBe(4410);
  });
});

describe('phone-held: ONE definition', () => {
  it('a phone holder socket, or a phone open in flight; a laptop holder or a watcher is not', async () => {
    await seed(false, { children: {} });
    const { mac } = startChild(OTHER);
    expect(phoneHolds(OTHER)).toBe(false);
    const release = notePhoneOpening([OTHER.toUpperCase()]);
    expect(phoneHolds(OTHER)).toBe(true);
    release();
    release();
    expect(phoneHolds(OTHER)).toBe(false);
    tagDeviceSocket(mac, { store: 'mac', idHash: 'dev' });
    expect(phoneHolds(OTHER)).toBe(true);
  });

  it('4403 is the close a watch falls back to', () => {
    expect(MAC_CLOSE_HANDED_OVER).toBe(4403);
    void net;
  });
});
