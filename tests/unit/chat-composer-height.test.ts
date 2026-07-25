/**
 * Unit tests for the Chat composer's height rule
 * (`dashboard/src/components/sleepy/chat/composerHeight.ts`).
 *
 * The regression these lock down: the composer used to be a FIXED pixel box
 * (`MIN_COMPOSER_H = 88` / `DEFAULT_COMPOSER_H = 118`) that the textarea scrolled inside —
 * it never grew with the draft, it never shrank after a send, and both constants drifted
 * out of true whenever `--font-size-md` or the field's line-height moved. Every bound is
 * now derived from measured line metrics, and the drag handle composes with auto-grow as a
 * FLOOR rather than as a rival owner of the same number.
 */
import { describe, it, expect } from 'vitest';
import {
  composerBodyHeight, composerHeightBounds,
  COMPOSER_MIN_LINES, COMPOSER_MAX_LINES, COMPOSER_PANE_FRACTION,
  type ComposerHeightInput,
} from '../../dashboard/src/components/sleepy/chat/composerHeight.js';

// Realistic metrics for the shipped tokens: 14px text at line-height 1.45 → 20.3px a line,
// 4px+4px field padding, and 8px of body padding under the field.
const LINE = 20.3;
const FIELD_CHROME = 8;
const BODY_CHROME = 8;
const PANE = 800;

/** The field's `scrollHeight` for `n` rendered lines (it includes the field's padding). */
const contentFor = (lines: number) => LINE * lines + FIELD_CHROME;

const base = (over: Partial<ComposerHeightInput> = {}): ComposerHeightInput => ({
  contentHeight: contentFor(1),
  lineHeight: LINE,
  fieldChrome: FIELD_CHROME,
  chromeHeight: BODY_CHROME,
  paneHeight: PANE,
  draggedHeight: null,
  ...over,
});

/** What the rule should return for exactly `n` lines of text, unclamped. */
const heightFor = (lines: number, chrome = BODY_CHROME) =>
  Math.round(LINE * lines + FIELD_CHROME + chrome);

describe('composerHeightBounds', () => {
  it('derives the minimum from line metrics, not a pixel constant', () => {
    const { min } = composerHeightBounds(base());
    expect(min).toBe(heightFor(COMPOSER_MIN_LINES));
    // The old constant was 88px — nearly four lines at this token, which is the drift the
    // measured minimum exists to stop.
    expect(min).toBeLessThan(88);
  });

  it('follows the font-size token instead of drifting when it changes', () => {
    const big = composerHeightBounds(base({ lineHeight: LINE * 2 })).min;
    expect(big).toBe(Math.round(LINE * 2 * COMPOSER_MIN_LINES + FIELD_CHROME + BODY_CHROME));
    expect(big).toBeGreaterThan(composerHeightBounds(base()).min);
  });

  it('ceilings at half the pane — the same limit the drag handle has always enforced', () => {
    expect(composerHeightBounds(base()).ceiling).toBe(PANE * COMPOSER_PANE_FRACTION);
  });

  it('still owes the composer its minimum when half a pane is less than that', () => {
    const { min, ceiling } = composerHeightBounds(base({ paneHeight: 40 }));
    expect(ceiling).toBe(min);
  });
});

describe('composerBodyHeight — auto-grow', () => {
  it('sits at the two-line minimum for an empty draft', () => {
    expect(composerBodyHeight(base({ contentHeight: contentFor(0) }))).toBe(heightFor(2));
  });

  it('stays at the minimum for one line — two lines is the RESTING size, not a floor to grow into', () => {
    expect(composerBodyHeight(base({ contentHeight: contentFor(1) }))).toBe(heightFor(2));
    expect(composerBodyHeight(base({ contentHeight: contentFor(2) }))).toBe(heightFor(2));
  });

  it('grows a line at a time past the minimum', () => {
    const three = composerBodyHeight(base({ contentHeight: contentFor(3) }));
    const four = composerBodyHeight(base({ contentHeight: contentFor(4) }));
    expect(three).toBe(heightFor(3));
    expect(four).toBe(heightFor(4));
    expect(four - three).toBe(Math.round(heightFor(4) - heightFor(3)));
    expect(four).toBeGreaterThan(three);
  });

  it('caps at the auto-grow line ceiling — past that the field scrolls instead', () => {
    const capped = composerBodyHeight(base({ contentHeight: contentFor(40) }));
    expect(capped).toBe(heightFor(COMPOSER_MAX_LINES));
    expect(composerBodyHeight(base({ contentHeight: contentFor(200) }))).toBe(capped);
  });

  it('never exceeds half the pane, even with room left in the line budget', () => {
    // A 120px pane gives a 60px ceiling — under three lines' worth.
    const h = composerBodyHeight(base({ contentHeight: contentFor(40), paneHeight: 120 }));
    expect(h).toBe(60);
    expect(h).toBeLessThan(heightFor(COMPOSER_MAX_LINES));
  });

  it('never lets auto-grow reach a size a manual drag is forbidden to reach', () => {
    for (const paneHeight of [120, 240, 400, 800, 2000]) {
      const { ceiling } = composerHeightBounds(base({ paneHeight }));
      expect(composerBodyHeight(base({ contentHeight: contentFor(500), paneHeight }))).toBeLessThanOrEqual(ceiling);
    }
  });
});

describe('composerBodyHeight — chip rows', () => {
  it('adds the quote / skill / attachment rows to BOTH the minimum and the grown height', () => {
    const chips = 96; // a quote strip + an attachments row
    expect(composerBodyHeight(base({ contentHeight: contentFor(0), chromeHeight: chips })))
      .toBe(heightFor(2, chips));
    expect(composerBodyHeight(base({ contentHeight: contentFor(5), chromeHeight: chips })))
      .toBe(heightFor(5, chips));
  });

  it('keeps the full line budget when chips appear — a picked skill must not eat a line', () => {
    const chips = 40;
    const withChips = composerBodyHeight(base({ contentHeight: contentFor(6), chromeHeight: chips }));
    const without = composerBodyHeight(base({ contentHeight: contentFor(6) }));
    expect(withChips - without).toBe(chips - BODY_CHROME);
  });

  it('still respects the pane ceiling once the chips have taken most of it', () => {
    // 120px of chips + 6 lines wants 250px; half of a 400px pane is 200px.
    expect(composerBodyHeight(base({ contentHeight: contentFor(6), chromeHeight: 120, paneHeight: 400 }))).toBe(200);
  });

  it('gives chips taller than half the pane the two-line minimum anyway', () => {
    // The chips are content the user asked for, not decoration — clipping them to honour a
    // ceiling would hide the quote they are about to reply to.
    const h = composerBodyHeight(base({ contentHeight: contentFor(6), chromeHeight: 300, paneHeight: 400 }));
    expect(h).toBe(heightFor(2, 300));
    expect(h).toBeGreaterThan(400 * COMPOSER_PANE_FRACTION);
  });
});

describe('composerBodyHeight — the manual drag is a FLOOR', () => {
  it('honours a dragged height the content does not need', () => {
    expect(composerBodyHeight(base({ contentHeight: contentFor(1), draggedHeight: 260 }))).toBe(260);
  });

  it('lets auto-grow push PAST the dragged floor, up to the ceiling', () => {
    const h = composerBodyHeight(base({ contentHeight: contentFor(9), draggedHeight: 120 }));
    expect(h).toBe(heightFor(9));
    expect(h).toBeGreaterThan(120);
  });

  it('never shrinks below what the user chose, however short the draft gets', () => {
    const dragged = 300;
    for (const lines of [0, 1, 2, 5, 9]) {
      expect(composerBodyHeight(base({ contentHeight: contentFor(lines), draggedHeight: dragged })))
        .toBeGreaterThanOrEqual(dragged);
    }
  });

  it('clamps a stale floor into the current bounds rather than honouring it blindly', () => {
    // Dragged tall in a big pane, then the pane was split in half: the floor may not survive
    // as a size the drag itself could no longer produce.
    expect(composerBodyHeight(base({ draggedHeight: 900, paneHeight: 400 }))).toBe(200);
    // …and a floor below the two-line minimum is not a smaller composer, it is a broken one.
    expect(composerBodyHeight(base({ draggedHeight: 4 }))).toBe(heightFor(2));
  });

  it('refuses to hide text already typed — a drag DOWN stops at the content height', () => {
    // The visible consequence of "floor, not fixed height", written down so it stays a
    // decision rather than becoming a bug report.
    expect(composerBodyHeight(base({ contentHeight: contentFor(6), draggedHeight: heightFor(3) })))
      .toBe(heightFor(6));
  });
});

describe('composerBodyHeight — after a send', () => {
  it('returns to the two-line minimum the moment the draft clears', () => {
    const typed = composerBodyHeight(base({ contentHeight: contentFor(8) }));
    const sent = composerBodyHeight(base({ contentHeight: contentFor(0), chromeHeight: BODY_CHROME }));
    expect(typed).toBe(heightFor(8));
    expect(sent).toBe(heightFor(2));
  });

  it('drops the chip rows with the draft — sending consumes the quote and attachments too', () => {
    const typed = composerBodyHeight(base({ contentHeight: contentFor(5), chromeHeight: 120 }));
    const sent = composerBodyHeight(base({ contentHeight: contentFor(0) }));
    expect(sent).toBe(heightFor(2));
    expect(sent).toBeLessThan(typed);
  });

  it('returns to the DRAGGED size for someone who set one — an explicit choice is not leftovers', () => {
    expect(composerBodyHeight(base({ contentHeight: contentFor(0), draggedHeight: 240 }))).toBe(240);
  });
});
