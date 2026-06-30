/**
 * Unit tests for the agent-sessions route's PUT validation (`sanitizeRoster`):
 *   - rejects a non-object body / non-array `sessions` (→ null, the handler's 400)
 *   - caps the roster length to MAX_SESSIONS (drops extras)
 *   - clamps title length (200) and size ([0.1, 10]), defaults a blank title
 *   - coerces the booleans (only `true` is true)
 *   - strips every field outside the known four
 */

import { describe, it, expect } from 'vitest';
import { sanitizeRoster, MAX_SESSIONS, type SavedMeta } from '../../src/server/routes/agent-sessions.js';

const valid = (over: Partial<SavedMeta> = {}): SavedMeta => ({
  title: 'Agent', bypass: false, minimized: false, size: 1, ...over,
});

describe('MAX_SESSIONS', () => {
  it('is 20', () => {
    expect(MAX_SESSIONS).toBe(20);
  });
});

describe('sanitizeRoster — body shape rejection', () => {
  it('returns null for a non-array `sessions`', () => {
    expect(sanitizeRoster({ sessions: 'nope' })).toBeNull();
    expect(sanitizeRoster({ sessions: 42 })).toBeNull();
    expect(sanitizeRoster({ sessions: { 0: 'x' } })).toBeNull();
    expect(sanitizeRoster({ sessions: null })).toBeNull();
  });

  it('returns null when `sessions` is absent', () => {
    expect(sanitizeRoster({})).toBeNull();
  });

  it('returns null for a non-object body', () => {
    expect(sanitizeRoster(null)).toBeNull();
    expect(sanitizeRoster(undefined)).toBeNull();
    expect(sanitizeRoster('string')).toBeNull();
    expect(sanitizeRoster(123)).toBeNull();
    expect(sanitizeRoster([])).toBeNull(); // a top-level array is not the `{ sessions }` envelope
  });

  it('returns an empty array for an empty `sessions` array', () => {
    expect(sanitizeRoster({ sessions: [] })).toEqual([]);
  });
});

describe('sanitizeRoster — length cap', () => {
  it('caps the roster to MAX_SESSIONS, dropping extras', () => {
    const sessions = Array.from({ length: 50 }, (_, i) => valid({ title: `Agent ${i}` }));
    const out = sanitizeRoster({ sessions });
    expect(out).toHaveLength(MAX_SESSIONS);
    // Keeps the FIRST 20 (slice from the head), not the tail.
    expect(out?.[0].title).toBe('Agent 0');
    expect(out?.[MAX_SESSIONS - 1].title).toBe(`Agent ${MAX_SESSIONS - 1}`);
  });

  it('passes through a roster at the cap unchanged in length', () => {
    const sessions = Array.from({ length: MAX_SESSIONS }, () => valid());
    expect(sanitizeRoster({ sessions })).toHaveLength(MAX_SESSIONS);
  });
});

describe('sanitizeRoster — title coercion + clamp', () => {
  it('trims and caps the title at 200 chars', () => {
    const longTitle = 'x'.repeat(500);
    const out = sanitizeRoster({ sessions: [valid({ title: longTitle })] });
    expect(out?.[0].title).toHaveLength(200);
  });

  it('trims surrounding whitespace', () => {
    const out = sanitizeRoster({ sessions: [valid({ title: '  Refactor  ' })] });
    expect(out?.[0].title).toBe('Refactor');
  });

  it('defaults a blank / whitespace-only title to "Agent"', () => {
    expect(sanitizeRoster({ sessions: [valid({ title: '' })] })?.[0].title).toBe('Agent');
    expect(sanitizeRoster({ sessions: [valid({ title: '   ' })] })?.[0].title).toBe('Agent');
  });

  it('defaults a non-string title to "Agent"', () => {
    const out = sanitizeRoster({ sessions: [{ title: 123, bypass: true, minimized: false, size: 1 }] });
    expect(out?.[0].title).toBe('Agent');
  });
});

describe('sanitizeRoster — size clamp', () => {
  it('clamps size below the floor up to 0.1', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: -5 })] })?.[0].size).toBe(0.1);
    expect(sanitizeRoster({ sessions: [valid({ size: 0 })] })?.[0].size).toBe(0.1);
  });

  it('clamps size above the ceiling down to 10', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: 9999 })] })?.[0].size).toBe(10);
  });

  it('defaults a non-finite / non-number size to 1', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: NaN })] })?.[0].size).toBe(1);
    expect(sanitizeRoster({ sessions: [{ title: 'A', size: 'big' }] })?.[0].size).toBe(1);
    expect(sanitizeRoster({ sessions: [{ title: 'A' }] })?.[0].size).toBe(1);
  });

  it('keeps an in-range size verbatim', () => {
    expect(sanitizeRoster({ sessions: [valid({ size: 2.5 })] })?.[0].size).toBe(2.5);
  });
});

describe('sanitizeRoster — boolean coercion', () => {
  it('treats only literal `true` as true for bypass/minimized', () => {
    const out = sanitizeRoster({ sessions: [
      { title: 'A', bypass: true, minimized: true, size: 1 },
      { title: 'B', bypass: 1, minimized: 'yes', size: 1 },
      { title: 'C', bypass: 'true', minimized: 0, size: 1 },
    ] });
    expect(out?.[0]).toMatchObject({ bypass: true, minimized: true });
    expect(out?.[1]).toMatchObject({ bypass: false, minimized: false });
    expect(out?.[2]).toMatchObject({ bypass: false, minimized: false });
  });

  it('defaults missing booleans to false', () => {
    const out = sanitizeRoster({ sessions: [{ title: 'A', size: 1 }] });
    expect(out?.[0]).toMatchObject({ bypass: false, minimized: false });
  });
});

describe('sanitizeRoster — field stripping', () => {
  it('keeps ONLY the four known fields, dropping everything else', () => {
    const out = sanitizeRoster({ sessions: [{
      title: 'Refactor',
      bypass: true,
      minimized: false,
      size: 2,
      id: 'agent-7',
      dormant: true,
      __proto__: { polluted: true },
      evil: 'rm -rf',
    }] });
    expect(out?.[0]).toEqual({ title: 'Refactor', bypass: true, minimized: false, size: 2 });
    expect(Object.keys(out![0]).sort()).toEqual(['bypass', 'minimized', 'size', 'title']);
  });

  it('coerces a non-object roster entry into a full default meta', () => {
    const out = sanitizeRoster({ sessions: [null, 'string', 42, []] });
    expect(out).toHaveLength(4);
    for (const meta of out!) {
      expect(meta).toEqual({ title: 'Agent', bypass: false, minimized: false, size: 1 });
    }
  });
});

describe('sanitizeRoster — sessionId (Claude --resume id) coercion', () => {
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('keeps a canonical UUID sessionId', () => {
    expect(sanitizeRoster({ sessions: [valid({ sessionId: UUID })] })?.[0].sessionId).toBe(UUID);
  });

  it('drops a non-UUID sessionId so a malformed id never reaches `claude --resume <id>`', () => {
    const bad: unknown[] = ['', 'not-a-uuid', '../../etc/passwd', '3f2504e0', `${UUID}; rm -rf /`, `${UUID}x`, 123, null, { uuid: UUID }];
    for (const sessionId of bad) {
      const out = sanitizeRoster({ sessions: [{ title: 'A', bypass: false, minimized: false, size: 1, sessionId }] });
      expect(out?.[0].sessionId).toBeUndefined();
      expect('sessionId' in out![0]).toBe(false);
    }
  });

  it('omits sessionId entirely when absent (legacy rosters)', () => {
    expect('sessionId' in sanitizeRoster({ sessions: [valid()] })![0]).toBe(false);
  });
});
