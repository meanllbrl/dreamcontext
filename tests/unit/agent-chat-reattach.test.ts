// Socket resilience (agent-chat.ts + agent-chat-live.ts): a pinned chat's `claude` child no
// longer dies with its WebSocket. A dropped socket DETACHES it; the client's reattach ADOPTS
// the same child; a busy child is never reaped for lack of a socket (up to the 4 h cap); an
// idle detached child is reaped after 15 min through the old EOF → linger → kill path. These
// tests pin that lifecycle with a mocked spawn and fake sockets, plus the activity contract
// the cloud's idle clock reads: only turn edges move it — never a reconnect, a reattach, a
// ping or a history replay.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4343;
  print(obj: unknown): void { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const { startChatSession, CLOSE_LINGER_MS, CLOSE_KILL_GRACE_MS, handleAgentChatHistory } = await import(
  '../../src/server/routes/agent-chat.js'
);
const { findLiveChat, liveChatsSnapshot, DETACH_IDLE_MS, DETACH_BUSY_CAP_MS, WS_PING_MS } = await import(
  '../../src/server/routes/agent-chat-live.js'
);

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  /** A live peer answers every ping (the ping test silences it). */
  ping = vi.fn(() => { this.emit('pong'); });
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  /** The socket died (network drop): CLOSED, then the close event. */
  drop(): void { this.readyState = 3; this.emit('close'); }
  frames(): Array<Record<string, unknown>> {
    return this.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
  }
}

const asWs = (ws: FakeWs) => ws as unknown as import('ws').WebSocket;

function startPinned(opts: { prompt?: string } = {}): { ws: FakeWs; child: FakeChild; id: string } {
  const ws = new FakeWs();
  const id = randomUUID();
  startChatSession(asWs(ws), '/tmp/agent-chat-reattach-test', {
    bypass: false, sessionId: id, resumeId: '', model: '', effort: '', mode: 'basic', account: '',
    initialPrompt: opts.prompt ?? '', deferPrompt: false,
  });
  return { ws, child: spawned[spawned.length - 1], id };
}

const snapshotOf = (id: string) => liveChatsSnapshot().find((e) => e.conversationId === id);

describe('agent-chat detach / reattach', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    spawned.length = 0;
  });
  afterEach(() => {
    // End every child a test left alive so the registry starts empty next time.
    for (const c of spawned) c.emit('close', 0);
    vi.useRealTimers();
  });

  it('a dropped socket DETACHES a pinned chat: stdin stays open, nothing is killed, the child stays adoptable', () => {
    const { ws, child, id } = startPinned();
    ws.drop();
    expect(child.stdin.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DETACH_IDLE_MS - 1);
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(findLiveChat(id)).not.toBeNull();
  });

  it('an IDLE detached child is reaped after 15 min through the existing EOF → linger → kill path', () => {
    const { ws, child, id } = startPinned();
    ws.drop();
    vi.advanceTimersByTime(DETACH_IDLE_MS);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(findLiveChat(id)).toBeNull();
    vi.advanceTimersByTime(CLOSE_LINGER_MS);
    expect(child.kill).toHaveBeenLastCalledWith();
    vi.advanceTimersByTime(CLOSE_KILL_GRACE_MS);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('a BUSY detached child is never reaped for lack of a socket — until the 4 h cap', () => {
    const { ws, child } = startPinned({ prompt: 'long job' });
    ws.drop();
    vi.advanceTimersByTime(DETACH_IDLE_MS * 4);
    expect(child.stdin.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DETACH_BUSY_CAP_MS - DETACH_IDLE_MS * 4 - 1);
    expect(child.stdin.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('a turn that ends while detached starts the 15 min idle clock from its end', () => {
    const { ws, child } = startPinned({ prompt: 'job' });
    ws.drop();
    vi.advanceTimersByTime(60 * 60_000);
    child.print({ type: 'result', subtype: 'success', result: 'done' });
    vi.advanceTimersByTime(DETACH_IDLE_MS - 1);
    expect(child.stdin.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('a reattach ADOPTS the same child: no new spawn, output flows to the new socket, the reap is disarmed', () => {
    const { ws, child, id } = startPinned({ prompt: 'job' });
    ws.drop();
    const ws2 = new FakeWs();
    expect(findLiveChat(id)!.adopt(asWs(ws2))).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(ws2.frames()).toContainEqual({ type: '_meta', subtype: 'reattached', adopted: true, busy: true });
    ws.send.mockClear();
    child.print({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } });
    expect(ws2.frames().some((f) => f.type === 'assistant')).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
    // Messages from the new socket reach the same child's stdin.
    ws2.emit('message', JSON.stringify({ type: 'interrupt' }));
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"interrupt"'));
    vi.advanceTimersByTime(DETACH_BUSY_CAP_MS + DETACH_IDLE_MS);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('a permission prompt printed while detached is handed to the adopting socket', () => {
    const { ws, child, id } = startPinned({ prompt: 'job' });
    ws.drop();
    const ask = { type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } };
    child.print(ask);
    const ws2 = new FakeWs();
    findLiveChat(id)!.adopt(asWs(ws2));
    expect(ws2.frames()).toContainEqual(ask);
    // Answered → not replayed again to a later socket.
    ws2.emit('message', JSON.stringify({ type: 'answer', requestId: 'req-1', behavior: 'allow' }));
    ws2.drop();
    const ws3 = new FakeWs();
    findLiveChat(id)!.adopt(asWs(ws3));
    expect(ws3.frames().some((f) => f.type === 'control_request')).toBe(false);
  });

  it('adopting while the old socket still looks open (half-open) terminates the old one', () => {
    const { ws, id } = startPinned();
    const ws2 = new FakeWs();
    findLiveChat(id)!.adopt(asWs(ws2));
    expect(ws.terminate).toHaveBeenCalled();
    // …and the old socket's close no longer detaches the child now bound to ws2.
    expect(findLiveChat(id)).not.toBeNull();
  });

  it('a goodbye (`end`) makes the close drain at once, exactly like a closed tab before', () => {
    const { ws, child, id } = startPinned();
    ws.emit('message', JSON.stringify({ type: 'end' }));
    ws.drop();
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(findLiveChat(id)).toBeNull();
  });

  it('a respawn supersedes: a detached child drains now, an attached one at its close', () => {
    const a = startPinned();
    a.ws.drop();
    findLiveChat(a.id)!.supersede();
    expect(a.child.stdin.end).toHaveBeenCalledTimes(1);

    const b = startPinned();
    findLiveChat(b.id)!.supersede()(true);
    expect(b.child.stdin.end).not.toHaveBeenCalled();
    b.ws.drop();
    expect(b.child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('a REFUSED second open withdraws its supersede: the first pane stays detachable', () => {
    const { ws, child, id } = startPinned();
    // The upgrade handler's order: mark provisionally, try the open, withdraw on refusal.
    const settle = findLiveChat(id)!.supersede();
    const ws2 = new FakeWs();
    let accepted = false;
    startChatSession(asWs(ws2), '/tmp/agent-chat-reattach-test', {
      bypass: false, sessionId: '', resumeId: id, model: '', effort: '', mode: 'basic', account: '',
      initialPrompt: '', deferPrompt: false, onAccepted: () => { accepted = true; },
    });
    expect(accepted).toBe(false);                      // still held by the first pane
    expect(spawned).toHaveLength(1);
    settle(accepted);
    expect(ws2.close).toHaveBeenCalled();             // the second tab got the refusal
    ws.drop();
    expect(child.stdin.end).not.toHaveBeenCalled();    // detached, not drained
    expect(findLiveChat(id)).not.toBeNull();
  });

  it('a REFUSED non-reattach open leaves a detached BUSY child running, and a later reattach adopts it', () => {
    const { ws, child, id } = startPinned({ prompt: 'long job' });
    ws.drop();                                         // detached mid-turn
    const settle = findLiveChat(id)!.supersede();
    expect(child.stdin.end).not.toHaveBeenCalled();    // the drain waits for acceptance
    // The new open is refused (here: an unregistered account — startChatSession's first refusal).
    const ws2 = new FakeWs();
    let accepted = false;
    startChatSession(asWs(ws2), '/tmp/agent-chat-reattach-test', {
      bypass: false, sessionId: '', resumeId: id, model: '', effort: '', mode: 'basic', account: 'no-such-account',
      initialPrompt: '', deferPrompt: false, onAccepted: () => { accepted = true; },
    });
    expect(accepted).toBe(false);
    expect(spawned).toHaveLength(1);
    settle(accepted);
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    // The conversation is held again: an open that would need it is still refused.
    const ws3 = new FakeWs();
    startChatSession(asWs(ws3), '/tmp/agent-chat-reattach-test', {
      bypass: false, sessionId: '', resumeId: id, model: '', effort: '', mode: 'basic', account: '',
      initialPrompt: '', deferPrompt: false,
    });
    expect(spawned).toHaveLength(1);
    // …and the client's reattach adopts the very same child, turn still running.
    const ws4 = new FakeWs();
    expect(findLiveChat(id)!.adopt(asWs(ws4))).toBe(true);
    expect(ws4.frames()).toContainEqual({ type: '_meta', subtype: 'reattached', adopted: true, busy: true });
  });

  it('an ACCEPTED non-reattach open drains a detached BUSY child only once accepted', () => {
    const { ws, child, id } = startPinned({ prompt: 'long job' });
    ws.drop();
    const settle = findLiveChat(id)!.supersede();
    expect(child.stdin.end).not.toHaveBeenCalled();
    settle(true);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(findLiveChat(id)).toBeNull();
  });

  it('an ACCEPTED supersede still drains the old child at its close', () => {
    const { ws, child, id } = startPinned();
    findLiveChat(id)!.supersede()(true);               // the new open was accepted
    ws.drop();
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('keeps ONE pong listener per socket across repeated ping starts and reattaches', () => {
    const { ws, id } = startPinned();
    expect(ws.listenerCount('pong')).toBe(1);
    const ws2 = new FakeWs();
    const entry = findLiveChat(id)!;
    entry.adopt(asWs(ws2));
    entry.adopt(asWs(ws2));
    entry.adopt(asWs(ws2));
    expect(ws2.listenerCount('pong')).toBe(1);
    expect(ws.listenerCount('pong')).toBe(0);          // the abandoned socket keeps none
    ws2.drop();                                        // detach stops pinging
    expect(ws2.listenerCount('pong')).toBe(0);
  });

  it('a child that exits is no longer adoptable', () => {
    const { ws, child, id } = startPinned();
    ws.drop();
    child.emit('close', 0);
    expect(findLiveChat(id)).toBeNull();
  });

  it('pings the bound socket every 25 s and terminates one that stopped answering', () => {
    const { ws } = startPinned();
    ws.ping.mockImplementation(() => { /* a peer that answers only by hand */ });
    vi.advanceTimersByTime(WS_PING_MS);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    ws.emit('pong');
    vi.advanceTimersByTime(WS_PING_MS);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WS_PING_MS);   // no pong for the 2nd ping
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  describe('activity contract (the cloud idle clock reads liveChatsSnapshot)', () => {
    it('only turn edges move busy / turnStartedAt / lastTurnEndedAt', () => {
      const { ws, child, id } = startPinned();
      expect(snapshotOf(id)).toEqual({ conversationId: id, projectRoot: '/tmp/agent-chat-reattach-test', busy: false, turnStartedAt: null, lastTurnEndedAt: null });

      const t0 = Date.now();
      ws.emit('message', JSON.stringify({ type: 'setEffort', effort: 'high' }));   // a user frame → a turn
      expect(snapshotOf(id)).toEqual({ conversationId: id, projectRoot: '/tmp/agent-chat-reattach-test', busy: true, turnStartedAt: t0, lastTurnEndedAt: null });

      vi.advanceTimersByTime(90_000);
      child.print({ type: 'result', subtype: 'success', result: 'ok' });
      const ended = snapshotOf(id);
      expect(ended).toEqual({ conversationId: id, projectRoot: '/tmp/agent-chat-reattach-test', busy: false, turnStartedAt: null, lastTurnEndedAt: t0 + 90_000 });
    });

    it('a drop, a reattach, pings and a chat-history replay fetch never look like activity', async () => {
      const { ws, child, id } = startPinned({ prompt: 'job' });
      child.print({ type: 'result', subtype: 'success', result: 'ok' });
      const before = snapshotOf(id);

      vi.advanceTimersByTime(5 * 60_000);
      ws.drop();
      vi.advanceTimersByTime(60_000);
      const ws2 = new FakeWs();
      findLiveChat(id)!.adopt(asWs(ws2));
      vi.advanceTimersByTime(WS_PING_MS * 3);
      ws2.emit('pong');

      const res = { statusCode: 0, setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
      await handleAgentChatHistory(
        { url: `/api/agent/chat-history?claudeId=${id}`, headers: { host: 'localhost' } } as unknown as import('node:http').IncomingMessage,
        res as unknown as import('node:http').ServerResponse,
        {},
        null,
      );
      expect(snapshotOf(id)).toEqual(before);
    });

    it('the snapshot is a read-only copy, not the registry itself', () => {
      const { id } = startPinned();
      const snap = liveChatsSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.find((e) => e.conversationId === id))).toBe(true);
    });
  });
});

// ── Client half (chatSession.ts): the replay after a reconnect shows every entry ONCE ──
const { mergeReplay, readReattachedFrame, RECONNECT_BACKOFF_MS } = await import(
  '../../dashboard/src/components/sleepy/chatSession'
);
type Item = Parameters<typeof mergeReplay>[0][number];
const user = (text: string): Item => ({ kind: 'user', id: `u-${text}`, text, ts: 0 });
const said = (text: string, done = true): Item => ({ kind: 'text', id: `t-${text}`, index: 0, text, done, ts: 0 });
const tool = (toolUseId: string): Item => ({ kind: 'tool', id: `x-${toolUseId}`, toolUseId, name: 'Bash', input: {}, status: 'running', startedAt: 0 });

describe('chat replay merge (client)', () => {
  it('backs off 1, 2, 5, 10, 30 s', () => {
    expect([...RECONNECT_BACKOFF_MS]).toEqual([1000, 2000, 5000, 10000, 30000]);
  });

  it('missed output lands once: live items already in the transcript go, the rest of the transcript is history', () => {
    const live = [user('go'), said('working'), tool('t1')];
    const transcript = [user('earlier'), said('old'), user('go'), said('working'), tool('t1'), said('MISSED'), said('done')];
    const { history, kept } = mergeReplay(transcript, live);
    expect(history).toBe(transcript);
    expect(kept).toEqual([]);
  });

  it('a block still streaming at the drop matches its finished transcript version', () => {
    const { kept } = mergeReplay([user('go'), said('half and the rest')], [user('go'), said('half', false)]);
    expect(kept).toEqual([]);
  });

  it('live items the transcript does not record yet stay live, after the history', () => {
    const live = [user('go'), said('a'), said('streamed after the reconnect', false)];
    const { kept } = mergeReplay([user('go'), said('a')], live);
    expect(kept).toEqual([2]);
  });

  it('a repeated message anchors on the occurrence that matches the live tail', () => {
    const live = [user('devam'), said('second answer')];
    const transcript = [user('devam'), said('first answer'), user('devam'), said('second answer')];
    expect(mergeReplay(transcript, live).kept).toEqual([]);
  });

  it('is idempotent: replaying twice adds nothing', () => {
    const transcript = [user('go'), said('x')];
    const first = mergeReplay(transcript, [user('go')]);
    expect(mergeReplay(transcript, first.kept.map(() => user('go'))).kept).toEqual([]);
  });

  it('reads only the server\'s reattached frame', () => {
    expect(readReattachedFrame('{"type":"_meta","subtype":"reattached","adopted":true,"busy":true}')).toEqual({ adopted: true, busy: true });
    expect(readReattachedFrame('{"type":"assistant","text":"reattached"}')).toBeNull();
    expect(readReattachedFrame('not json "reattached"')).toBeNull();
  });
});
