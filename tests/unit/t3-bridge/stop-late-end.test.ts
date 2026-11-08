/**
 * A Stop the agent never confirms is closed by the bridge after STOP_CONFIRM_MS. When the agent's
 * own end of that turn arrives later, after the owner already started the next run, it must reach
 * nothing: no second result, and the run that came after it stays open until its own end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeSession, STOP_CONFIRM_MS } from '../../../src/lib/t3-bridge/session.js';

type Frame = Record<string, unknown>;
type Inner = {
  providerThread: { id: string };
  activeRun: { runId: string; providerTurnId: string | null } | null;
  closeAfterStop(run: { runId: string; providerTurnId: string | null }): void;
  onEvent(event: unknown): void;
};

function session(frames: Frame[]): Inner {
  const Make = BridgeSession as unknown as new (opts: unknown) => Inner;
  const s = new Make({ tool: 'antigravity', cwd: '/tmp/x', model: '', mode: 'auto', paneId: 'pane-1', emit: (f: Frame) => { frames.push(f); } });
  s.providerThread = { id: 'pt-1' };
  return s;
}

const end = (turn: string, status = 'completed') => ({
  type: 'turn.terminal', driver: 'antigravity', providerThreadId: 'pt-1', providerTurnId: turn,
  runOrdinal: 1, status, failure: null, threadDisposition: 'reusable',
});

afterEach(() => { vi.useRealTimers(); });

describe('a Stop the agent never confirms', () => {
  it('ends the turn once, and the late end of it never closes the next run', () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const s = session(frames);
    const first = { runId: 'run-1', providerTurnId: 'turn-1' };
    s.activeRun = first;
    s.closeAfterStop(first);
    vi.advanceTimersByTime(STOP_CONFIRM_MS);
    const results = () => frames.filter((f) => f.type === 'result');
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ subtype: 'error_during_execution', dc_tool: 'antigravity' });
    expect(s.activeRun).toBeNull();

    // The owner sends again; then the stopped turn's own end arrives.
    const second = { runId: 'run-2', providerTurnId: 'turn-2' };
    s.activeRun = second;
    s.onEvent(end('turn-1', 'interrupted'));
    expect(results()).toHaveLength(1);
    expect(s.activeRun).toBe(second);

    // The new run's own end still draws its result and closes it.
    s.onEvent(end('turn-2'));
    expect(results()).toHaveLength(2);
    expect(s.activeRun).toBeNull();
  });

  it('does nothing when the agent confirmed the Stop in time', () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const s = session(frames);
    const run = { runId: 'run-1', providerTurnId: 'turn-1' };
    s.activeRun = run;
    s.closeAfterStop(run);
    s.onEvent(end('turn-1', 'interrupted'));
    vi.advanceTimersByTime(STOP_CONFIRM_MS);
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(1);
    expect(s.activeRun).toBeNull();
  });
});
