/**
 * Unit tests for the agent-terminal output pump (PTY→WS coalescing + client-acked
 * flow control). The pump is the transport-perf layer behind the embedded terminal:
 *  - coalesces the TUI's tiny high-frequency PTY chunks into one WS frame per window
 *  - flushes immediately when a burst fills the buffer (never sits on big output)
 *  - pauses the PTY above a high-water mark of un-acked output — but ONLY once the
 *    client has declared ack support (n=0 hello), so a legacy client that never acks
 *    keeps fire-and-forget behavior instead of stalling the PTY forever
 *  - resumes once acks bring the un-acked window back under the low-water mark
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutputPump } from '../../src/server/routes/agent-terminal.js';

function harness(opts: Parameters<typeof createOutputPump>[1] = {}) {
  const sent: string[] = [];
  let paused = 0;
  let resumed = 0;
  const pump = createOutputPump(
    { send: (c) => sent.push(c), pause: () => { paused++; }, resume: () => { resumed++; } },
    { flushMs: 5, maxBuffer: 100, highWater: 200, lowWater: 50, ...opts },
  );
  return { pump, sent, isPaused: () => paused > resumed, pauseCalls: () => paused, resumeCalls: () => resumed };
}

describe('createOutputPump', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces chunks arriving within the flush window into one frame', () => {
    const h = harness();
    h.pump.data('a');
    h.pump.data('b');
    h.pump.data('c');
    expect(h.sent).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(h.sent).toEqual(['abc']);
  });

  it('flushes immediately when the buffer reaches maxBuffer', () => {
    const h = harness();
    h.pump.data('x'.repeat(100));
    expect(h.sent).toEqual(['x'.repeat(100)]);
    // No stray timer flush afterwards.
    vi.advanceTimersByTime(20);
    expect(h.sent).toHaveLength(1);
  });

  it('never pauses the PTY before the client has acked (legacy client)', () => {
    const h = harness();
    h.pump.data('x'.repeat(100)); // 100 un-acked
    h.pump.data('y'.repeat(100)); // 200
    h.pump.data('z'.repeat(100)); // 300 > highWater — but no ack ever seen
    expect(h.pauseCalls()).toBe(0);
  });

  it('pauses above high water once ack support is declared, resumes below low water', () => {
    const h = harness();
    h.pump.ack(0); // capability hello
    h.pump.data('x'.repeat(100));
    h.pump.data('y'.repeat(100));
    h.pump.data('z'.repeat(100)); // 300 un-acked > 200 highWater
    expect(h.pauseCalls()).toBe(1);
    expect(h.isPaused()).toBe(true);
    h.pump.ack(100); // 200 left — still above lowWater(50)
    expect(h.isPaused()).toBe(true);
    h.pump.ack(200); // 0 left (clamped) — under lowWater
    expect(h.resumeCalls()).toBe(1);
    expect(h.isPaused()).toBe(false);
  });

  it('does not double-pause while already paused', () => {
    const h = harness();
    h.pump.ack(0);
    h.pump.data('x'.repeat(300)); // crosses highWater in one flush
    h.pump.data('y'.repeat(300)); // still paused — no second pause()
    expect(h.pauseCalls()).toBe(1);
  });

  it('flush() drains the buffer immediately (exit-message ordering)', () => {
    const h = harness();
    h.pump.data('tail');
    h.pump.flush();
    expect(h.sent).toEqual(['tail']);
    vi.advanceTimersByTime(20);
    expect(h.sent).toHaveLength(1); // timer was cleared — nothing sent twice
  });

  it('dispose() cancels a pending flush', () => {
    const h = harness();
    h.pump.data('never');
    h.pump.dispose();
    vi.advanceTimersByTime(20);
    expect(h.sent).toEqual([]);
  });

  it('ignores negative or non-finite ack values', () => {
    const h = harness();
    h.pump.ack(0);
    h.pump.data('x'.repeat(300));
    expect(h.isPaused()).toBe(true);
    h.pump.ack(-500);
    h.pump.ack(Number.NaN);
    expect(h.isPaused()).toBe(true); // un-acked untouched by garbage
    h.pump.ack(300);
    expect(h.isPaused()).toBe(false);
  });
});
