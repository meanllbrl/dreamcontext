// One rule for every chat composer: ⏎ sends on a computer, adds a line on a phone; ⇧⏎ and an
// IME commit never send. "A phone" is a coarse pointer on a screen whose short side is < 600.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { enterSends, isTouchPhone, PHONE_SHORT_SIDE } from '../../dashboard/src/lib/enterKey.js';
import { REMOTE_PHONE_SHORT_SIDE } from '../../dashboard/src/hooks/useIsMobile.js';

function screen(coarse: boolean, w: number, h: number): void {
  vi.stubGlobal('window', {
    innerWidth: w,
    innerHeight: h,
    matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false }),
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('enterSends', () => {
  const enter = { key: 'Enter', shiftKey: false };

  it('sends on a computer, adds a line on a phone', () => {
    expect(enterSends(enter, false)).toBe(true);
    expect(enterSends(enter, true)).toBe(false);
  });

  it('never sends on Shift+Enter or another key', () => {
    expect(enterSends({ key: 'Enter', shiftKey: true }, false)).toBe(false);
    expect(enterSends({ key: 'a', shiftKey: false }, false)).toBe(false);
  });

  it('never sends while an IME composition is committing', () => {
    expect(enterSends({ ...enter, isComposing: true }, false)).toBe(false);
    expect(enterSends({ ...enter, keyCode: 229 }, false)).toBe(false);
    expect(enterSends({ ...enter, keyCode: 13 }, false)).toBe(true);
  });
});

describe('isTouchPhone', () => {
  it('a finger on a phone screen, upright or sideways', () => {
    screen(true, 390, 844);
    expect(isTouchPhone()).toBe(true);
    expect(enterSends({ key: 'Enter', shiftKey: false })).toBe(false);
    screen(true, 844, 390);
    expect(isTouchPhone()).toBe(true);
  });

  it('a narrowed desktop window still sends (mouse, not finger)', () => {
    screen(false, 390, 844);
    expect(isTouchPhone()).toBe(false);
    expect(enterSends({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  it('a tablet keeps Enter = send', () => {
    screen(true, 820, 1180);
    expect(isTouchPhone()).toBe(false);
  });

  it('no window or matchMedia reads as a computer', () => {
    vi.stubGlobal('window', undefined);
    expect(isTouchPhone()).toBe(false);
  });

  it('uses the same short side as the tunnel phone layout', () => {
    expect(PHONE_SHORT_SIDE).toBe(REMOTE_PHONE_SHORT_SIDE);
  });
});
