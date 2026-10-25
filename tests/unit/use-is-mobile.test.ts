// The LAYOUT rule (hands-free sekmeler, owner 2026-10-25). On Mac mode's tunnel: the phone layout
// iff a finger on a small or upright screen — `(pointer: coarse)` and (short side < 600 or
// portrait); a mouse is always the desktop layout. So a computer and a landscape tablet get the
// desktop Chat (project chips, chat tabs, panes), a phone in either orientation and a portrait
// tablet the phone UI. Off the tunnel the answer is still the viewport's: narrow AND a finger.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readIsMobile, readRemoteDesktop } from '../../dashboard/src/hooks/useIsMobile.js';
import { setPhoneSurfaceForTests } from '../../dashboard/src/lib/phoneSurface.js';

/** A window of this size whose pointer is a finger (`coarse`) or a mouse. */
function stubScreen(w: number, h: number, coarse: boolean): void {
  vi.stubGlobal('window', {
    innerWidth: w,
    innerHeight: h,
    matchMedia: (q: string) => ({
      matches: q.includes('max-width') ? w <= 768 : q.includes('portrait') ? h > w : coarse,
    }),
  });
}

/** A window whose media queries answer `narrow` for the width and `coarse` for the pointer. */
function stubViewport(narrow: boolean, coarse: boolean): void {
  vi.stubGlobal('window', {
    matchMedia: (q: string) => ({ matches: q.includes('max-width') ? narrow : coarse }),
  });
}

afterEach(() => {
  setPhoneSurfaceForTests(null);
  vi.unstubAllGlobals();
});

describe('readIsMobile on the tunnel (AC1)', () => {
  it('a computer (any size with a mouse) and a landscape touch tablet: the desktop layout', () => {
    setPhoneSurfaceForTests('mac');
    for (const [w, h, coarse] of [[1440, 900, false], [1280, 560, false], [390, 844, false], [1024, 768, true], [1180, 820, true], [1366, 1024, true]] as const) {
      stubScreen(w, h, coarse);
      expect(readIsMobile(), `${w}x${h} coarse=${coarse}`).toBe(false);
      expect(readRemoteDesktop(), `${w}x${h} coarse=${coarse}`).toBe(true);
    }
  });

  it('a phone in either orientation and a portrait touch tablet: the phone layout', () => {
    setPhoneSurfaceForTests('mac');
    for (const [w, h] of [[390, 844], [844, 390], [375, 667], [768, 1024], [820, 1180]] as const) {
      stubScreen(w, h, true);
      expect(readIsMobile(), `${w}x${h}`).toBe(true);
      expect(readRemoteDesktop(), `${w}x${h}`).toBe(false);
    }
  });

  it('is the phone layout on the tunnel before any window exists', () => {
    setPhoneSurfaceForTests('mac');
    expect(readIsMobile()).toBe(true);
    expect(readRemoteDesktop()).toBe(false);
  });
});

describe('readIsMobile off the tunnel (unchanged)', () => {
  it('only a narrow viewport with a coarse pointer', () => {
    stubViewport(true, true);
    expect(readIsMobile()).toBe(true);
    stubViewport(false, true); // a tablet on the laptop's own listener
    expect(readIsMobile()).toBe(false);
    stubViewport(true, false); // a narrowed desktop window
    expect(readIsMobile()).toBe(false);
    stubViewport(false, false);
    expect(readIsMobile()).toBe(false);
    expect(readRemoteDesktop()).toBe(false);
  });

  it('with no matchMedia: the desktop', () => {
    expect(readIsMobile()).toBe(false);
  });
});
