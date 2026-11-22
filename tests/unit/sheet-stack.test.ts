/**
 * Tek kenar end review r2: a sheet of a project out of sight stays mounted (hidden), so the
 * keyboard owner is the newest sheet whose project is on screen, not the newest sheet.
 */
import { describe, it, expect } from 'vitest';
import { keyboardOwner } from '../../dashboard/src/lib/sheetStack';

const sheet = (on: boolean) => ({ onScreen: () => on });

describe('sheet stack: the keyboard owner', () => {
  it('is the newest sheet when its project is on screen', () => {
    const a = sheet(true); const b = sheet(true);
    expect(keyboardOwner([a, b])).toBe(b);
  });
  it("skips a newer sheet of a project out of sight (B's sheet mounted while A is back)", () => {
    const a = sheet(true); const b = sheet(false);
    expect(keyboardOwner([a, b])).toBe(a);
  });
  it('is none when no sheet is on screen', () => {
    expect(keyboardOwner([sheet(false)])).toBeNull();
    expect(keyboardOwner([])).toBeNull();
  });
});
