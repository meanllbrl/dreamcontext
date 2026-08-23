// The closed-tab process leak (agent-chat.ts): a chat's `claude -p --input-format
// stream-json` child waits on stdin forever, so a route that reacted to socket close by
// merely untracking the child stranded a live ~200-400MB process per closed tab — observed
// as dozens of days-old "2.1.220" processes in Activity Monitor (~10GB RSS). These tests
// pin the fixed lifecycle: socket gone → stdin EOF (graceful drain) → SIGTERM at
// CLOSE_LINGER_MS → SIGKILL at +CLOSE_KILL_GRACE_MS, with every timer disarmed the moment
// the child actually exits.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4242;
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

const { startChatSession, CLOSE_LINGER_MS, CLOSE_KILL_GRACE_MS } = await import(
  '../../src/server/routes/agent-chat.js'
);

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

function startSession(): { ws: FakeWs; child: FakeChild } {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, '/tmp/agent-chat-close-reap-test', {
    bypass: false, sessionId: '', resumeId: '', model: '', effort: '', initialPrompt: '', deferPrompt: false,
  });
  const child = spawned[spawned.length - 1];
  return { ws, child };
}

describe('agent-chat socket-gone reaping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawned.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains the child on ws close: stdin EOF immediately, no kill inside the linger window', () => {
    const { ws, child } = startSession();
    ws.emit('close');
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CLOSE_LINGER_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('escalates a child that outlives the linger window: SIGTERM, then SIGKILL after the grace', () => {
    const { ws, child } = startSession();
    ws.emit('close');
    vi.advanceTimersByTime(CLOSE_LINGER_MS);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenLastCalledWith();
    vi.advanceTimersByTime(CLOSE_KILL_GRACE_MS);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('disarms the escalation once the child exits during the drain', () => {
    const { ws, child } = startSession();
    ws.emit('close');
    child.emit('close', 0);
    vi.advanceTimersByTime(CLOSE_LINGER_MS + CLOSE_KILL_GRACE_MS);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('arms the drain exactly once when close and error both fire', () => {
    const { ws, child } = startSession();
    ws.emit('close');
    ws.emit('error', new Error('gone'));
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CLOSE_LINGER_MS + CLOSE_KILL_GRACE_MS);
    // One SIGTERM + one SIGKILL — a double-armed drain would double both.
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it('child exit still closes the ws and reports the exit frame (unchanged path)', () => {
    const { ws, child } = startSession();
    child.emit('close', 0);
    expect(ws.close).toHaveBeenCalled();
    const frames = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
    expect(frames.some((f) => f.type === '_meta' && f.subtype === 'exit')).toBe(true);
  });
});
