// Hands-free is the phone layout on ANY device (owner, 2026-10-19): a tablet or a second computer
// reaching the Mac through the phone listener got the desktop chrome, whose project strip and
// launcher the phone listener refuses, so it showed no chats and no projects. Off the phone
// listener the answer is still the viewport's: narrow AND a finger.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readIsMobile } from '../../dashboard/src/hooks/useIsMobile.js';
import { setPhoneSurfaceForTests } from '../../dashboard/src/lib/phoneSurface.js';

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

describe('readIsMobile', () => {
  it('is the phone layout on the hands-free surface whatever the device', () => {
    setPhoneSurfaceForTests('mac');
    for (const [narrow, coarse] of [[false, true], [false, false], [true, false], [true, true]] as const) {
      stubViewport(narrow, coarse);
      expect(readIsMobile(), `narrow=${narrow} coarse=${coarse}`).toBe(true);
    }
  });

  it('is the phone layout on the hands-free surface before any window exists', () => {
    setPhoneSurfaceForTests('mac');
    expect(readIsMobile()).toBe(true);
  });

  it('off the phone listener: only a narrow viewport with a coarse pointer', () => {
    stubViewport(true, true);
    expect(readIsMobile()).toBe(true);
    stubViewport(false, true); // a tablet on the laptop's own listener
    expect(readIsMobile()).toBe(false);
    stubViewport(true, false); // a narrowed desktop window
    expect(readIsMobile()).toBe(false);
    stubViewport(false, false);
    expect(readIsMobile()).toBe(false);
  });

  it('off the phone listener with no matchMedia: the desktop', () => {
    expect(readIsMobile()).toBe(false);
  });
});
