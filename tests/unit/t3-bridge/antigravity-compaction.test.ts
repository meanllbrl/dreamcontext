/** Antigravity compacts in silence: only its context falling says so. */
import { describe, expect, it } from 'vitest';
import { CONTEXT_FIRST_CHARS, wordsWithContext } from '../../../src/lib/t3-bridge/context.js';
import { ToWire } from '../../../src/lib/t3-bridge/to-wire.js';

const used = (w: ToWire, n: number): void => { w.translate({ type: 'provider_thread.updated', providerThread: { contextUsage: { usedTokens: n } } } as never); };
const wire = (tool: 'antigravity' | 'codex' = 'antigravity') => new ToWire({ tool, model: 'm', cwd: '/p', permissionMode: 'auto' });

describe('a fall in context', () => {
  it('counts once when a large context falls by more than 40%', () => {
    const w = wire();
    for (const n of [26_000, 300_000, 800_000]) used(w, n);
    expect(w.takeCompacted()).toBe(false);
    used(w, 120_000);
    expect(w.takeCompacted()).toBe(true);
    expect(w.takeCompacted()).toBe(false);
    used(w, 150_000);
    expect(w.takeCompacted()).toBe(false);
  });

  it('ignores the wobble real turns show, and a small context', () => {
    const w = wire();
    for (const n of [26_000, 56_000, 51_000, 69_000, 58_000, 20_000]) used(w, n);
    expect(w.takeCompacted()).toBe(false);
    for (const n of [145_000, 130_000]) used(w, n);
    expect(w.takeCompacted()).toBe(false);
  });

  it('a fresh thread measures from nothing', () => {
    const w = wire();
    used(w, 800_000);
    w.resetContext();
    used(w, 30_000);
    expect(w.takeCompacted()).toBe(false);
    expect(w.contextTokens).toBe(30_000);
  });

  it('is Antigravity only: Codex says when it compacts', () => {
    const w = wire('codex');
    used(w, 800_000);
    used(w, 30_000);
    expect(w.takeCompacted()).toBe(false);
  });
});

describe('where the context rides', () => {
  const ctx = [{ key: 'dreamcontext-brain', text: 'SNAPSHOT' }];

  it('after the words, normally', () => {
    expect(wordsWithContext('hello', ctx)).toBe('hello\n\n<dreamcontext-brain>\nSNAPSHOT\n</dreamcontext-brain>');
  });
  it('first in a message long enough for the agent to lose its end', () => {
    const long = 'x'.repeat(CONTEXT_FIRST_CHARS + 1);
    const out = wordsWithContext(long, ctx);
    expect(out.startsWith('<dreamcontext-brain>')).toBe(true);
    expect(out.endsWith(long)).toBe(true);
  });
  it('no context, the words alone', () => {
    expect(wordsWithContext('x'.repeat(60_000), [])).toBe('x'.repeat(60_000));
  });
});
