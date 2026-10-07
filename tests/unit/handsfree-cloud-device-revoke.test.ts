// AC3: an already-open device chat socket, and the child it drives, never outlive the device.
// Revoke-all, a password change and a single logout close the device's sockets with 4401 and
// cut their children; every frame re-checks the device (defence in depth).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid: number;
  constructor(pid: number) { super(); this.pid = pid; }
}

const spawned: FakeChild[] = [];
let nextPid = 515000;

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild(nextPid++);
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const { startChatSession, tagCloudDeviceSocket, DEVICE_REVOKED_CLOSE } = await import('../../src/server/routes/agent-chat.js');
const { writeClaudeAccounts } = await import('../../src/lib/claude-accounts.js');
const { setCloudPhaseSource, setCloudTripRootsSource } = await import('../../src/server/cloud-mode.js');
const { HandsfreeAuth, DEVICE_TTL_MS, hashPassphrase, setHandsfreeAuthForTests, sha256Hex, handleHandsfreeLogout } = await import('../../src/server/handsfree-auth.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const ENV_KEYS = ['HOME', 'DREAMCONTEXT_CLOUD', 'DREAMCONTEXT_DESKTOP'];
const saved: Record<string, string | undefined> = {};
let home: string;
let now: number;
let auth: InstanceType<typeof HandsfreeAuth>;
let killSpy: ReturnType<typeof vi.spyOn>;
let groupSignals: Array<[number, string]>;

/** process.kill stand-in: records group signals; a group dies at its first signal. */
function fakeKill() {
  const dead = new Set<number>();
  groupSignals = [];
  return vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0 || sig === undefined) {
      if (dead.has(Math.abs(pid))) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }
    groupSignals.push([pid, String(sig)]);
    dead.add(Math.abs(pid));
    return true;
  }) as typeof process.kill);
}

/** A cloud chat session driven by a socket of `deviceId`. */
function openFor(deviceId: string, sessionId: string): { ws: FakeWs; child: FakeChild } {
  const ws = new FakeWs();
  tagCloudDeviceSocket(ws, sha256Hex(deviceId));
  const project = join(home, 'proj');
  const before = spawned.length;
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: false, sessionId, resumeId: '', model: '', effort: '', mode: 'basic', account: '', initialPrompt: '', deferPrompt: false,
  });
  // A legitimate trip chat really started (r17: outside a trip root it is refused with cloud_not_trip).
  expect(JSON.stringify(ws.send.mock.calls)).not.toContain('cloud_not_trip');
  expect(spawned.length).toBe(before + 1);
  return { ws, child: spawned[spawned.length - 1] };
}

const revokedWith = (ws: FakeWs) => ws.close.mock.calls.some((c) => c[0] === DEVICE_REVOKED_CLOSE);
const cutGroup = (child: FakeChild) => groupSignals.some(([pid, sig]) => pid === -child.pid && sig === 'SIGTERM');
const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'hf-revoke-'));
  process.env.HOME = home;
  delete process.env.DREAMCONTEXT_DESKTOP;
  mkdirSync(join(home, 'proj'), { recursive: true });
  // The registry arrives with the global set (the cloud server never writes it itself).
  writeClaudeAccounts([{ id: 'acc', accountUuid: '', email: 'a@example.invalid', organizationUuid: '', organizationName: '', tier: 'max', configDir: join(home, '.dreamcontext', 'claude-accounts', 'acc'), preferred: true }], home);
  process.env.DREAMCONTEXT_CLOUD = '1';
  setCloudPhaseSource(() => 'active');
  // The chats below are the trip's own: `proj` is the trip root (r17 runs cloud agents only there).
  setCloudTripRootsSource(() => [join(home, 'proj')]);
  now = Date.now();
  auth = new HandsfreeAuth({ dir: join(home, 'dc-server'), now: () => now });
  mkdirSync(join(home, 'dc-server'), { recursive: true });
  auth.store.installVerifiers({ generation: 1, passphrase: await hashPassphrase('a b c d e f'), transferSha256: sha256Hex('t') });
  setHandsfreeAuthForTests(auth);
  spawned.length = 0;
  killSpy = fakeKill();
});

afterEach(() => {
  killSpy.mockRestore();
  setHandsfreeAuthForTests(null);
  setCloudPhaseSource(() => 'sealed');
  setCloudTripRootsSource(() => []);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe('AC3: live device sockets follow the device store', () => {
  it('(a) revoke-all closes an open device socket with 4401 and cuts its child', async () => {
    const a = openFor(auth.store.createDevice(), '6f1c2e9a-a001-4a5b-8c9d-0123456789ab');
    expect(revokedWith(a.ws)).toBe(false);
    expect(auth.store.revokeAllDevices(2).ok).toBe(true);
    await flush();
    expect(revokedWith(a.ws)).toBe(true);
    expect(cutGroup(a.child)).toBe(true);
  });

  it('(b) a password change (installVerifiers changed:true) does the same', async () => {
    const a = openFor(auth.store.createDevice(), '6f1c2e9a-a002-4a5b-8c9d-0123456789ab');
    const r = auth.store.installVerifiers({ generation: 2, passphrase: await hashPassphrase('g h i j k l'), transferSha256: sha256Hex('t') });
    expect(r).toMatchObject({ ok: true, changed: true });
    await flush();
    expect(revokedWith(a.ws)).toBe(true);
    expect(cutGroup(a.child)).toBe(true);
  });

  it('(c)+(e) a single logout closes only that device\'s sockets; the other device keeps working', async () => {
    const idA = auth.store.createDevice();
    const idB = auth.store.createDevice();
    const a = openFor(idA, '6f1c2e9a-a003-4a5b-8c9d-0123456789ab');
    const b = openFor(idB, '6f1c2e9a-a004-4a5b-8c9d-0123456789ab');
    // The phone's own POST /api/handsfree/logout (the handler at handsfree-auth.ts).
    const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() } as unknown as import('node:http').ServerResponse;
    handleHandsfreeLogout({ headers: { cookie: `__Host-dc_hf_session=${idA}` } } as unknown as import('node:http').IncomingMessage, res);
    await flush();
    expect(revokedWith(a.ws)).toBe(true);
    expect(cutGroup(a.child)).toBe(true);
    expect(revokedWith(b.ws)).toBe(false);
    expect(cutGroup(b.child)).toBe(false);
    b.ws.emit('message', JSON.stringify({ type: 'interrupt' }));
    await flush();
    expect(revokedWith(b.ws)).toBe(false);
  });

  it('(d) a frame from a device that expired between notifications is refused with 4401', async () => {
    const a = openFor(auth.store.createDevice(), '6f1c2e9a-a005-4a5b-8c9d-0123456789ab');
    const writesBefore = a.child.stdin.write.mock.calls.length;
    now += DEVICE_TTL_MS + 1; // no store change, no notification: only the per-frame check sees it
    a.ws.emit('message', JSON.stringify({ type: 'user', text: 'run rm -rf' }));
    await flush();
    expect(revokedWith(a.ws)).toBe(true);
    expect(cutGroup(a.child)).toBe(true);
    const userFrames = a.child.stdin.write.mock.calls.slice(writesBefore).filter((c) => String(c[0]).includes('run rm -rf'));
    expect(userFrames).toEqual([]);
  });

  it('a laptop socket is never tagged and never revoked', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    const ws = new FakeWs();
    startChatSession(ws as unknown as import('ws').WebSocket, join(home, 'proj'), {
      bypass: false, sessionId: '6f1c2e9a-a006-4a5b-8c9d-0123456789ab', resumeId: '', model: '', effort: '', mode: 'basic', account: '', initialPrompt: '', deferPrompt: false,
    });
    auth.store.revokeAllDevices(3);
    await flush();
    expect(revokedWith(ws)).toBe(false);
  });
});
