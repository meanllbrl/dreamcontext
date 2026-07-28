/**
 * Unit tests for `contextLimitFor` (dashboard/src/lib/agentComposer.ts) — the context-window
 * size the composer's gauge divides by.
 *
 * The regression this locks down: the gauge used to assume 200K and only reach for 1M when
 * the model id carried Claude Code's `[1m]` marker. But a chat session reports the BARE id
 * (`claude-opus-5`) even when the 1M variant is running — the marker never arrives — so
 * every session read as five times fuller than it was (a 520K-token conversation showed
 * "52%" of a window it had long since passed). 1M is now the default and 200K the exception.
 *
 * These cases MIRROR tests/unit/agent-session-stats.test.ts, which covers the server's twin
 * of this function. The two must agree, or the terminal strip and the chat composer disagree
 * about the same session.
 */
import { describe, it, expect } from 'vitest';
import { contextLimitFor } from '../../dashboard/src/lib/agentComposer.js';

describe('contextLimitFor — window per model', () => {
  it('gives every current model its real 1M window', () => {
    for (const id of [
      'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-mythos-5',
    ]) {
      expect(contextLimitFor(1000, id)).toBe(1_000_000);
    }
  });

  it('resolves the picker aliases the chat pane reports before the first init frame', () => {
    expect(contextLimitFor(1000, 'opus')).toBe(1_000_000);
    expect(contextLimitFor(1000, 'sonnet')).toBe(1_000_000);
    expect(contextLimitFor(1000, 'fable')).toBe(1_000_000);
    expect(contextLimitFor(1000, 'haiku')).toBe(200_000);
  });

  it('keeps 200K for Haiku and the pre-4.6 Opus/Sonnet generations', () => {
    for (const id of [
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-3-opus-20240229',
      'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022',
    ]) {
      expect(contextLimitFor(1000, id)).toBe(200_000);
    }
  });

  it('treats an unknown or not-yet-reported id as a NEW model (1M), not a retired one', () => {
    expect(contextLimitFor(1000, undefined)).toBe(1_000_000);
    expect(contextLimitFor(1000, '')).toBe(1_000_000);
    expect(contextLimitFor(1000, 'some-future-model')).toBe(1_000_000);
  });

  it('honours the [1m] marker even on a model that is otherwise 200K', () => {
    expect(contextLimitFor(1000, 'claude-opus-4-5[1m]')).toBe(1_000_000);
    expect(contextLimitFor(1000, 'claude-fable-5[1m]')).toBe(1_000_000);
  });

  it('promotes on the observed footprint — a session cannot exceed its own window', () => {
    expect(contextLimitFor(250_000, 'claude-haiku-4-5-20251001')).toBe(1_000_000);
    // …and never demotes below what the model actually has.
    expect(contextLimitFor(0, 'claude-opus-5')).toBe(1_000_000);
  });
});
