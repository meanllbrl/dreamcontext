/**
 * The quiet pill (owner, 2026-11-01: "notch'u büyütmek yerine minimal kullanıp elegant kalmak").
 * Folded with no peek, the notch draws ONE mark beside the camera housing, most urgent first,
 * and keeps the hardware's own size when there is nothing to say.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_ROLLUP, QUIET_EAR_W, beadCount, quietEarWidth, quietSignal, type Rollup,
} from '../../dashboard/src/components/assistant/notchModel.js';

const r = (o: Partial<Rollup>): Rollup => ({ ...EMPTY_ROLLUP, ...o });
const none = { running: 0, inbox: 0, busy: false };

describe('quietSignal', () => {
  it('says nothing when nothing happens, so the ears fold to zero', () => {
    expect(quietSignal(r({ idle: 4, stale: 5 }), none)).toBeNull();
    expect(quietEarWidth(null)).toBe(0);
  });

  it('puts what waits on the owner first, prompts and proposals counted together', () => {
    const s = quietSignal(r({ asking: 1, proposals: 2, working: 5 }), { running: 1, inbox: 3, busy: true });
    expect(s).toEqual({ kind: 'asking', count: 3 });
    expect(quietEarWidth(s)).toBe(QUIET_EAR_W);
  });

  it('draws the working dot for a chat turn, a starting chat, an automation or its own turn', () => {
    expect(quietSignal(r({ working: 2 }), none)).toEqual({ kind: 'working' });
    expect(quietSignal(r({ starting: 1 }), none)).toEqual({ kind: 'working' });
    expect(quietSignal(EMPTY_ROLLUP, { ...none, running: 1 })).toEqual({ kind: 'working' });
    expect(quietSignal(EMPTY_ROLLUP, { ...none, busy: true })).toEqual({ kind: 'working' });
  });

  it('falls back to a dim unread dot when only news waits', () => {
    expect(quietSignal(EMPTY_ROLLUP, { ...none, inbox: 2 })).toEqual({ kind: 'unread' });
  });
});

describe('beadCount', () => {
  it('caps the bead at 9+ so it never outgrows its ear', () => {
    expect(beadCount(2)).toBe('2');
    expect(beadCount(9)).toBe('9');
    expect(beadCount(12)).toBe('9+');
  });
});
