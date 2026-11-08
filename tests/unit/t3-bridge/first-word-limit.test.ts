/**
 * An Antigravity turn that never says anything is stopped at the first-word limit, and the owner is
 * told why in plain words. Real case (3 Nov 2026): a tool server hung on the agent's handshake, the
 * agent sent nothing past "running" for five minutes, and the chat showed "Working… 207s".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeSession, STOP_CONFIRM_MS } from '../../../src/lib/t3-bridge/session.js';

type Frame = Record<string, unknown>;
type Run = { runId: string; providerTurnId: string | null };
type Inner = {
  providerThread: { id: string } | null;
  session: unknown;
  activeRun: Run | null;
  armFirstWord(): void;
  onEvent(event: unknown): void;
  run(effect: unknown): Promise<unknown>;
};

const LIMIT = 1_000;

function session(frames: Frame[], tool: 'antigravity' | 'codex' = 'antigravity'): Inner {
  const Make = BridgeSession as unknown as new (opts: unknown) => Inner;
  const s = new Make({ tool, cwd: '/tmp/x', model: '', mode: 'auto', paneId: 'pane-1', firstWordLimitMs: LIMIT, emit: (f: Frame) => { frames.push(f); } });
  s.providerThread = { id: 'pt-1' };
  return s;
}

const said = (frames: Frame[]): string => frames
  .filter((f) => f.type === 'assistant')
  .map((f) => ((f.message as { content: Array<{ text?: string }> }).content).map((b) => b.text ?? '').join(''))
  .join('\n');
const results = (frames: Frame[]): Frame[] => frames.filter((f) => f.type === 'result');

afterEach(() => { vi.useRealTimers(); });

describe('the first-word limit on an Antigravity turn', () => {
  it('a turn that only ever said "running" is stopped, the agent is told, and the owner reads why', async () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const s = session(frames);
    const interrupts: unknown[] = [];
    s.session = { interruptTurn: (x: unknown) => { interrupts.push(x); return 'effect'; } };
    s.run = async () => undefined;
    s.activeRun = { runId: 'run-1', providerTurnId: null };
    s.armFirstWord();
    s.onEvent({ type: 'provider_turn.updated', threadId: undefined, providerTurn: { id: 'turn-1', status: 'running' } });
    s.onEvent({ type: 'provider_thread.updated', providerThread: { id: 'pt-1' } });
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(said(frames)).toMatch(/Antigravity did not start answering within 1 seconds/);
    expect(said(frames)).toMatch(/Settings > Tool servers/);
    expect(interrupts).toHaveLength(1);
    // The agent never confirms: the bridge ends the turn, once, so the next message is not held.
    await vi.advanceTimersByTimeAsync(STOP_CONFIRM_MS);
    expect(results(frames)).toHaveLength(1);
    expect(results(frames)[0]).toMatchObject({ dc_tool: 'antigravity' });
    expect(s.activeRun).toBeNull();
  });

  // Review (3 Nov): a run whose start is still under way must never be closed by hand, or its late
  // events reach the pane and the next run. It is stopped once the agent names the turn.
  it('a turn still starting is not closed by hand: it is stopped once the agent names it', async () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const s = session(frames);
    const interrupts: unknown[] = [];
    s.session = { interruptTurn: (x: unknown) => { interrupts.push(x); return 'effect'; } };
    s.run = async () => undefined;
    s.activeRun = { runId: 'run-1', providerTurnId: null };
    (s as unknown as { turnKnown: unknown }).turnKnown = (() => { let r = (): void => undefined; const p = new Promise<void>((x) => { r = x; }); return { promise: p, resolve: () => r() }; })();
    s.armFirstWord();
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(said(frames)).toMatch(/did not start answering/);
    expect(results(frames)).toHaveLength(0);
    expect(s.activeRun).not.toBeNull();
    s.onEvent({ type: 'provider_turn.updated', providerTurn: { id: 'turn-1', status: 'running' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(interrupts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STOP_CONFIRM_MS);
    expect(results(frames)).toHaveLength(1);
    expect(s.activeRun).toBeNull();
  });

  it('a turn the agent never names at all is a dead tool: the session ends, once', async () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const fatals: string[] = [];
    const Make = BridgeSession as unknown as new (opts: unknown) => Inner;
    const s = new Make({ tool: 'antigravity', cwd: '/tmp/x', model: '', mode: 'auto', paneId: 'pane-1', firstWordLimitMs: LIMIT, emit: (f: Frame) => { frames.push(f); }, onFatal: (m: string) => { fatals.push(m); } });
    s.providerThread = { id: 'pt-1' };
    s.activeRun = { runId: 'run-1', providerTurnId: null };
    (s as unknown as { turnKnown: unknown }).turnKnown = { promise: new Promise<void>(() => undefined), resolve: () => undefined };
    s.armFirstWord();
    await vi.advanceTimersByTimeAsync(LIMIT + 15_000);
    expect(said(frames)).toMatch(/did not start answering/);
    expect(fatals).toEqual(['Antigravity stopped responding.']);
    expect(results(frames)).toHaveLength(1);
    expect(s.activeRun).toBeNull();
  });

  it('any word from the agent lifts the limit, however long the turn then runs', () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const s = session(frames);
    s.activeRun = { runId: 'run-1', providerTurnId: 'turn-1' };
    s.armFirstWord();
    s.onEvent({ type: 'turn_item.updated', turnItem: { type: 'reasoning', status: 'inProgress' } });
    vi.advanceTimersByTime(LIMIT * 100);
    expect(said(frames)).not.toMatch(/did not start answering/);
    expect(s.activeRun).not.toBeNull();
  });

  it('a turn that ended in time is never stopped later, and the next run is not touched', () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const s = session(frames);
    s.activeRun = { runId: 'run-1', providerTurnId: 'turn-1' };
    s.armFirstWord();
    s.activeRun = { runId: 'run-2', providerTurnId: 'turn-2' };
    vi.advanceTimersByTime(LIMIT);
    expect(said(frames)).toBe('');
    expect(s.activeRun).toMatchObject({ runId: 'run-2' });
  });

  it('Codex keeps its own pace: no limit is set', () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const s = session(frames, 'codex');
    s.activeRun = { runId: 'run-1', providerTurnId: 'turn-1' };
    s.armFirstWord();
    vi.advanceTimersByTime(LIMIT * 10);
    expect(frames).toEqual([]);
  });
});
