// Mac mode, server side of AC8 (takeover without ping-pong) and AC11 (revocation by SOCKET).
// A chat child runs in this process for the desktop window; the phone adopts it through the
// same registry. Ownership follows the socket bound RIGHT NOW: a phone socket makes its device
// the owner, a desktop socket clears it. Automatic (passive) opens never evict a live holder.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawned: FakeChild[] = [];
let nextPid = 616000;

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = nextPid++;
  args: unknown[] = [];
  print(obj: unknown): void { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((...args: unknown[]) => {
      const child = new FakeChild();
      child.args = args;
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const { startChatSession, tagDeviceSocket, passiveAdopt, releasePhoneSessions, DEVICE_REVOKED_CLOSE } = await import('../../src/server/routes/agent-chat.js');
const { findLiveChat } = await import('../../src/server/routes/agent-chat-live.js');
const { HandsfreeAuth, hashPassphrase, setMacHandsfreeAuthForTests, sha256Hex } = await import('../../src/server/handsfree-auth.js');
const { HOLDER_PROBE_MS, MAC_CLOSE_TAKEN_OVER } = await import('../../src/lib/handsfree/mac/contract.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  /** A live client answers pings; a half-open one (network gone without a FIN) never does. */
  alive = true;
  send = vi.fn();
  close = vi.fn((code?: number) => { void code; if (this.readyState === 1) { this.readyState = 3; this.emit('close'); } });
  ping = vi.fn(() => { if (this.alive) queueMicrotask(() => this.emit('pong')); });
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  drop(): void { this.readyState = 3; this.emit('close'); }
  frames(): Array<Record<string, unknown>> {
    return this.send.mock.calls.map(([raw]) => { try { return JSON.parse(String(raw)) as Record<string, unknown>; } catch { return {}; } });
  }
  closedWith(code: number): boolean { return this.close.mock.calls.some((c) => c[0] === code); }
}
const asWs = (ws: FakeWs) => ws as unknown as import('ws').WebSocket;

let dir: string;
let mac: InstanceType<typeof HandsfreeAuth>;
let killSpy: ReturnType<typeof vi.spyOn>;
let groupSignals: Array<[number, string]>;
const flush = () => new Promise((r) => setTimeout(r, 20));
/** Chat children only (an account probe like `claude auth status` is not a chat spawn). */
const chatSpawns = () => spawned.filter((c) => JSON.stringify(c.args).includes('stream-json')).length;
const cut = (child: FakeChild) => groupSignals.some(([pid, sig]) => pid === -child.pid && sig === 'SIGTERM');
const adoptions = (ws: FakeWs) => ws.frames().filter((f) => f.subtype === 'reattached' && f.adopted === true).length;

function phoneSocket(deviceId: string): FakeWs {
  const ws = new FakeWs();
  tagDeviceSocket(ws, { store: 'mac', idHash: sha256Hex(deviceId) });
  return ws;
}

/** A pinned chat the DESKTOP window started (its socket is untagged). */
function desktopChat(opts: { prompt?: string } = {}): { ws: FakeWs; child: FakeChild; id: string } {
  const ws = new FakeWs();
  const id = randomUUID();
  startChatSession(asWs(ws), join(dir, 'proj'), {
    bypass: false, sessionId: id, resumeId: '', model: '', effort: '', mode: 'basic', account: '',
    initialPrompt: opts.prompt ?? '', deferPrompt: false,
  });
  return { ws, child: spawned[spawned.length - 1], id };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phone-own-'));
  mac = new HandsfreeAuth({ dir });
  mac.store.setPassphrase(await hashPassphrase('a b c d e f'));
  setMacHandsfreeAuthForTests(mac);
  spawned.length = 0;
  const dead = new Set<number>();
  groupSignals = [];
  killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0 || sig === undefined) {
      if (dead.has(Math.abs(pid))) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }
    groupSignals.push([pid, String(sig)]);
    dead.add(Math.abs(pid));
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  for (const c of spawned) c.emit('close', 0);
  killSpy.mockRestore();
  setMacHandsfreeAuthForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('AC8 takeover (server side)', () => {
  it('the phone adopts a running desktop chat with zero spawns; the desktop socket gets 4409; output flows to the phone', () => {
    const d = desktopChat({ prompt: 'long job' });
    const phone = phoneSocket(mac.store.createDevice());
    expect(findLiveChat(d.id)!.adopt(asWs(phone), 'takeover')).toBe(true);
    expect(chatSpawns()).toBe(1);
    expect(d.ws.closedWith(MAC_CLOSE_TAKEN_OVER)).toBe(true);
    expect(d.ws.terminate).not.toHaveBeenCalled();
    expect(phone.frames()).toContainEqual({ type: '_meta', subtype: 'reattached', adopted: true, busy: true });
    d.child.print({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still running' }] } });
    expect(phone.frames().some((f) => f.type === 'assistant')).toBe(true);
    // "Buraya al" adopts it back: the phone is the one told 4409 now.
    const desk2 = new FakeWs();
    expect(findLiveChat(d.id)!.adopt(asWs(desk2), 'takeover')).toBe(true);
    expect(phone.closedWith(MAC_CLOSE_TAKEN_OVER)).toBe(true);
    expect(chatSpawns()).toBe(1);
  });

  it('a passive open against a LIVE holder evicts nobody: the new socket is closed 4409', async () => {
    const d = desktopChat();
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    // The desktop reloads / reconnects on its backoff: passive, the phone still answers pings.
    const desk2 = new FakeWs();
    expect(await passiveAdopt(findLiveChat(d.id)!, asWs(desk2))).toBe('taken');
    expect(desk2.closedWith(MAC_CLOSE_TAKEN_OVER)).toBe(true);
    expect(phone.close).not.toHaveBeenCalled();
    expect(phone.terminate).not.toHaveBeenCalled();
  });

  it('both clients connected: repeated passive opens never move the chat (adoption count stays 1)', async () => {
    const d = desktopChat();
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    for (let i = 0; i < 6; i++) {
      const again = new FakeWs();
      expect(await passiveAdopt(findLiveChat(d.id)!, asWs(again))).toBe('taken');
      expect(adoptions(again)).toBe(0);
    }
    expect(adoptions(phone)).toBe(1);
    expect(phone.readyState).toBe(1);
  });

  it('a holder whose network dropped WITHOUT a FIN gets no pong: the passive open adopts after HOLDER_PROBE_MS, no 4409', async () => {
    vi.useFakeTimers();
    try {
      const d = desktopChat();
      const phone = phoneSocket(mac.store.createDevice());
      findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
      phone.alive = false; // half-open: still "open" to the server, never answers
      const phone2 = phoneSocket(mac.store.createDevice());
      const p = passiveAdopt(findLiveChat(d.id)!, asWs(phone2));
      await vi.advanceTimersByTimeAsync(HOLDER_PROBE_MS - 1);
      expect(adoptions(phone2)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe('adopted');
      expect(adoptions(phone2)).toBe(1);
      expect(phone2.closedWith(MAC_CLOSE_TAKEN_OVER)).toBe(false);
      expect(phone.terminate).toHaveBeenCalled();
      expect(chatSpawns()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a detached child is adopted at once by a passive open (no probe)', async () => {
    const d = desktopChat();
    d.ws.drop();
    const phone = phoneSocket(mac.store.createDevice());
    expect(await passiveAdopt(findLiveChat(d.id)!, asWs(phone))).toBe('adopted');
    expect(adoptions(phone)).toBe(1);
  });

  it('two passive opens fired at once against a half-open holder: exactly one adopts, no live holder evicted', async () => {
    const d = desktopChat();
    d.ws.alive = false;
    const a = new FakeWs();
    const b = phoneSocket(mac.store.createDevice());
    const results = await Promise.all([passiveAdopt(findLiveChat(d.id)!, asWs(a)), passiveAdopt(findLiveChat(d.id)!, asWs(b))]);
    expect(results.filter((r) => r === 'adopted')).toHaveLength(1);
    expect(results.filter((r) => r === 'taken')).toHaveLength(1);
    const winner = results[0] === 'adopted' ? a : b;
    expect(winner.readyState).toBe(1);
    expect(winner.close).not.toHaveBeenCalled();
    // Only the dead holder was put down; the ping probe shared one ping.
    expect(d.ws.terminate).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('a frame the client sends DURING the probe is held and reaches the chat after the adopt (never dropped)', async () => {
    const d = desktopChat();
    d.ws.alive = false; // half-open holder: the probe waits its full HOLDER_PROBE_MS
    const phone = phoneSocket(mac.store.createDevice());
    const p = passiveAdopt(findLiveChat(d.id)!, asWs(phone));
    await new Promise((r) => setTimeout(r, 50));
    phone.emit('message', JSON.stringify({ type: 'user', text: 'typed during the probe' }));
    expect(await p).toBe('adopted');
    await flush();
    await flush();
    expect(d.child.stdin.write.mock.calls.some((c) => String(c[0]).includes('typed during the probe'))).toBe(true);
  }, 10_000);

  it('a protocol error on the passive socket (during the probe, and after its 4409) never throws', async () => {
    const d = desktopChat();
    d.ws.alive = false;
    const probing = new FakeWs();
    const p = passiveAdopt(findLiveChat(d.id)!, asWs(probing));
    expect(() => probing.emit('error', new Error('MASK must be set'))).not.toThrow();
    probing.drop();
    expect(await p).toBe('aborted');
    const live = desktopChat();
    const loser = new FakeWs();
    expect(await passiveAdopt(findLiveChat(live.id)!, asWs(loser))).toBe('taken');
    expect(() => loser.emit('error', new Error('invalid UTF-8'))).not.toThrow();
  }, 10_000);

  it('a new socket that dies during the probe aborts without adopting', async () => {
    const d = desktopChat();
    d.ws.alive = false;
    const late = new FakeWs();
    const p = passiveAdopt(findLiveChat(d.id)!, asWs(late));
    late.drop();
    expect(await p).toBe('aborted');
    expect(d.ws.terminate).not.toHaveBeenCalled();
  }, 10_000);
});

describe('AC11 revocation by socket (server side)', () => {
  it('phone holds a running turn → revoke-all: 4401 at once and the turn is cut', async () => {
    const d = desktopChat({ prompt: 'job' });
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    mac.store.revokeAllLocal();
    await flush();
    expect(phone.closedWith(DEVICE_REVOKED_CLOSE)).toBe(true);
    expect(cut(d.child)).toBe(true);
  });

  it('after "Buraya al" the desktop holds it: revoke-all leaves the desktop socket and its child alone, even though the phone started the turn', async () => {
    const d = desktopChat();
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    phone.emit('message', JSON.stringify({ type: 'user', text: 'phone-started turn' }));
    await flush();
    const desk = new FakeWs();
    findLiveChat(d.id)!.adopt(asWs(desk), 'takeover');
    mac.store.revokeAllLocal();
    await flush();
    expect(desk.close).not.toHaveBeenCalled();
    expect(cut(d.child)).toBe(false);
    expect(findLiveChat(d.id)).not.toBeNull();
  });

  it('a phone that disconnects after sending a prompt, then revoke-all: the DETACHED turn is cut', async () => {
    const d = desktopChat({ prompt: 'job' });
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    phone.drop();
    mac.store.revokeAllLocal();
    await flush();
    expect(cut(d.child)).toBe(true);
  });

  it('an IDLE phone-held chat: 4401, nothing cut, the desktop can adopt it back', async () => {
    const d = desktopChat();
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    mac.store.revokeAllLocal();
    await flush();
    expect(phone.closedWith(DEVICE_REVOKED_CLOSE)).toBe(true);
    expect(cut(d.child)).toBe(false);
    const desk = new FakeWs();
    expect(await passiveAdopt(findLiveChat(d.id)!, asWs(desk))).toBe('adopted');
  });

  it('a revoked phone that never answers the close frame cannot drive the idle chat afterwards', async () => {
    const d = desktopChat();
    const phone = phoneSocket(mac.store.createDevice());
    // A script, not a browser: close() is ignored, the socket stays OPEN and keeps sending.
    phone.close = vi.fn() as never;
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    mac.store.revokeAllLocal();
    await flush();
    expect(phone.close).toHaveBeenCalledWith(DEVICE_REVOKED_CLOSE, expect.any(String));
    const before = d.child.stdin.write.mock.calls.length;
    phone.emit('message', JSON.stringify({ type: 'user', text: 'after revoke' }));
    await flush();
    await flush();
    expect(d.child.stdin.write.mock.calls.slice(before).some((c) => String(c[0]).includes('after revoke'))).toBe(false);
    // The chat detached and stays adoptable by the desktop; the socket is terminated soon after.
    const desk = new FakeWs();
    expect(await passiveAdopt(findLiveChat(d.id)!, asWs(desk))).toBe('adopted');
    await new Promise((r) => setTimeout(r, 1100));
    expect(phone.terminate).toHaveBeenCalled();
  });

  it('a password change clears every Mac device and acts like revoke-all', async () => {
    const d = desktopChat({ prompt: 'job' });
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    mac.store.setPassphrase(await hashPassphrase('g h i j k l'));
    await flush();
    expect(mac.store.listDevices()).toEqual([]);
    expect(phone.closedWith(DEVICE_REVOKED_CLOSE)).toBe(true);
    expect(cut(d.child)).toBe(true);
  });

  it('Return (planned): phone sockets close 4401, children DETACH and stay alive; the following revoke cuts nothing', async () => {
    const d = desktopChat({ prompt: 'job' });
    const phone = phoneSocket(mac.store.createDevice());
    findLiveChat(d.id)!.adopt(asWs(phone), 'takeover');
    expect(releasePhoneSessions()).toBe(1);
    mac.store.revokeAllLocal();
    await flush();
    expect(phone.closedWith(DEVICE_REVOKED_CLOSE)).toBe(true);
    expect(cut(d.child)).toBe(false);
    expect(d.child.stdin.end).not.toHaveBeenCalled();
    // The desktop reattaches the very same child.
    const desk = new FakeWs();
    expect(await passiveAdopt(findLiveChat(d.id)!, asWs(desk))).toBe('adopted');
    expect(chatSpawns()).toBe(1);
  });
});
