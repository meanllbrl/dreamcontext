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
import { readFileSync } from 'node:fs';
import {
  composerBodyHeight, composerHeightBounds, draftOnlyGrew, fieldContentHeight, keepFieldTextChildless, measureFieldContent,
  COMPOSER_MIN_LINES, COMPOSER_MAX_LINES, COMPOSER_PANE_FRACTION,
  type ComposerHeightInput, type MeasurableField,
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

// ── The keystroke path (task: the desktop app stays light on an 8GB MacBook Air) ──────
//
// A fake textarea: its content is `lines` rendered lines; its box is `box` px tall unless the
// measure collapses it (`style.height = '0px'`), when `scrollHeight` reports the content.
// Every collapse is counted — the collapse is the forced layout the keystroke path avoids.
function fakeField(lines: number, box: number) {
  const f = {
    lines,
    box,
    collapses: 0,
    style: {
      _h: '',
      get height() { return this._h; },
      set height(v: string) { if (v === '0px') f.collapses += 1; this._h = v; },
    },
    get content() { return Math.round(LINE * f.lines + FIELD_CHROME); },
    get clientHeight() { return f.box; },
    get scrollHeight() { return f.style.height === '0px' ? f.content : Math.max(f.box, f.content); },
  };
  return f as typeof f & MeasurableField;
}
const BORDER = 2;

describe('measureFieldContent — no style read', () => {
  it('collapses, reads, restores, and adds the cached border', () => {
    const f = fakeField(3, 120);
    f.style.height = '120px';
    expect(measureFieldContent(f, BORDER)).toBe(f.content + BORDER);
    expect(f.style.height).toBe('120px');
    expect(f.collapses).toBe(1);
  });
});

describe('fieldContentHeight — collapse only when the draft got shorter', () => {
  it('collapses on the first measure (nothing known yet)', () => {
    const f = fakeField(1, 60);
    expect(fieldContentHeight(f, BORDER, null, false)).toBe(f.content + BORDER);
    expect(f.collapses).toBe(1);
  });

  it('a draft that GREW and still fits keeps the last figure, with no collapse', () => {
    const f = fakeField(1, 60);
    const last = fieldContentHeight(f, BORDER, null, true);
    f.lines = 2; // still inside the 60px box
    expect(fieldContentHeight(f, BORDER, last, false)).toBe(last);
    expect(f.collapses).toBe(1);
  });

  it('a draft that GREW past the box reads scrollHeight, with no collapse', () => {
    const f = fakeField(2, 50);
    const last = fieldContentHeight(f, BORDER, null, true);
    f.lines = 4;
    expect(fieldContentHeight(f, BORDER, last, false)).toBe(f.content + BORDER);
    expect(f.collapses).toBe(1);
  });

  it('a draft that got SHORTER collapses and sees the smaller content', () => {
    const f = fakeField(6, 140);
    const last = fieldContentHeight(f, BORDER, null, true);
    f.lines = 2;
    const shrunk = fieldContentHeight(f, BORDER, last, true);
    expect(shrunk).toBe(f.content + BORDER);
    expect(shrunk).toBeLessThan(last);
    expect(f.collapses).toBe(2);
  });

  it('growth without the collapse lands on the same applied height as a full measure', () => {
    // The skipped measure must never change the answer: the box only ever needs MORE room.
    for (const [from, to] of [[1, 2], [2, 3], [3, 9], [9, 14]] as const) {
      const f = fakeField(from, 0);
      const firstContent = fieldContentHeight(f, BORDER, null, true);
      const applied = composerBodyHeight(base({ contentHeight: firstContent }));
      f.box = applied - BODY_CHROME - BORDER; // the field fills its row inside the body
      f.lines = to;
      const cheap = composerBodyHeight(base({ contentHeight: fieldContentHeight(f, BORDER, firstContent, false) }));
      const full = composerBodyHeight(base({ contentHeight: measureFieldContent(f, BORDER) }));
      expect(cheap).toBe(full);
    }
  });

  it('60 grown keystrokes after the first take no collapse at all', () => {
    const f = fakeField(1, 60);
    let last: number | null = null;
    last = fieldContentHeight(f, BORDER, last, true);
    for (let i = 0; i < 60; i++) last = fieldContentHeight(f, BORDER, last, false);
    expect(f.collapses).toBe(1);
  });
});

// The caller (Composer.tsx) skips the collapse only when this says the draft grew by insertion.
// Length alone is not enough: a select-all paste of one long line over a six-line draft is
// LONGER and spans fewer lines, and the box kept its six rows (end review, 2026-10-18).
describe('draftOnlyGrew — the collapse may be skipped only after a pure insertion', () => {
  it('typing at the end, in the middle and at the start is growth', () => {
    expect(draftOnlyGrew('hello', 'hello!')).toBe(true);
    expect(draftOnlyGrew('helo', 'hello')).toBe(true);
    expect(draftOnlyGrew('ello', 'hello')).toBe(true);
    expect(draftOnlyGrew('', 'a')).toBe(true);
    expect(draftOnlyGrew('a\nb', 'a\nxyz\nb')).toBe(true);
  });

  it('a longer replacement with fewer lines is NOT growth', () => {
    const six = 'one\ntwo\nthree\nfour\nfive\nsix';
    expect(draftOnlyGrew(six, 'x'.repeat(six.length + 20))).toBe(false);
    // a paste over a selection: the newlines it replaced are gone
    expect(draftOnlyGrew('a\nb\nc', 'a long single line instead')).toBe(false);
    expect(draftOnlyGrew('abc\ndef', 'abXXXXXXXXc def')).toBe(false);
  });

  it('equal or shorter is never growth', () => {
    expect(draftOnlyGrew('same', 'same')).toBe(false);
    expect(draftOnlyGrew('abcd', 'abc')).toBe(false);
    expect(draftOnlyGrew('abcd', 'wxyz')).toBe(false);
  });

  it('a repeated character inserted next to its twin is still one insertion', () => {
    expect(draftOnlyGrew('aaa', 'aaaa')).toBe(true);
    expect(draftOnlyGrew('abab', 'ababab')).toBe(true);
  });
});

describe('Composer.tsx skips the collapse only through draftOnlyGrew (source scan)', () => {
  it('a length check alone would bring the six-row box back', () => {
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/Composer.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(draft !== prev\.draft && !draftOnlyGrew\(prev\.draft, draft\)\) needFullRef\.current = true;/);
    expect(src).not.toMatch(/draft\.length <=? prev\.draft\.length/);
  });
});

// A stand-in for HTMLTextAreaElement: `defaultValue` is a prototype accessor over the child
// text, `value` is separate — the shape React's `updateTextarea` writes to.
class FakeField {
  text = '';
  value = '';
  childWrites = 0;
  get defaultValue() { return this.text; }
  set defaultValue(v: string) { this.text = v; this.childWrites += 1; }
}

describe('keepFieldTextChildless — a keystroke never rewrites the field\'s text child', () => {
  it('turns this field\'s defaultValue write into a no-op and keeps the getter', () => {
    const ta = new FakeField();
    ta.defaultValue = 'restored draft';
    keepFieldTextChildless(ta as unknown as HTMLTextAreaElement);
    // What React 19 does on every controlled update: value, then defaultValue = value.
    for (const v of ['h', 'he', 'hel']) { ta.value = v; if (ta.defaultValue !== v) ta.defaultValue = v; }
    expect(ta.childWrites).toBe(1);
    expect(ta.defaultValue).toBe('restored draft');
    expect(ta.value).toBe('hel');
  });
  it('is idempotent and leaves other fields alone', () => {
    const ta = new FakeField();
    const other = new FakeField();
    keepFieldTextChildless(ta as unknown as HTMLTextAreaElement);
    keepFieldTextChildless(ta as unknown as HTMLTextAreaElement);
    ta.defaultValue = 'x';
    other.defaultValue = 'y';
    expect(ta.childWrites).toBe(0);
    expect(other.childWrites).toBe(1);
  });
});

describe('Composer.tsx keystroke path (source scan)', () => {
  const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/Composer.tsx', import.meta.url), 'utf8');
  it('shims the field before the measure runs', () => {
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{ if \(taRef\.current\) keepFieldTextChildless\(taRef\.current\); \}\);/);
  });
  it('plain typing with both menus closed sets no menu state on keyup\'s onSelect', () => {
    expect(src).toMatch(/if \(q === null && mq === null && slashQuery === null && mentionQuery === null\) return;/);
  });
  it('a closed /mcp popover is not closed again on every key (one commit a key)', () => {
    expect(src).toMatch(/else if \(mcpOpenRef\.current && !isMcpCommand\(draft\)/);
  });
});
