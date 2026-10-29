/**
 * How tall the Chat composer's body box is, this frame.
 *
 * The composer used to be a FIXED pixel box (`MIN_COMPOSER_H = 88`, `DEFAULT_COMPOSER_H =
 * 118`) that the textarea scrolled inside — so a one-line question and a twelve-line spec
 * were given exactly the same room, and both magic numbers silently drifted out of true the
 * moment `--font-size-md` or the field's line-height changed. Every bound here is derived
 * from the field's OWN measured line metrics instead, so "two lines" means two rendered
 * lines at whatever the tokens currently say a line is.
 *
 * ── Drag vs auto-grow: the drag sets a FLOOR, never a fixed height ──────────────────
 * Both mechanisms want to own one number, so one of them has to be subordinate. The rule:
 * `applied = min(ceiling, max(autoGrown, draggedFloor))`.
 *   • Auto-grow is what the CONTENT needs — it may always push the box up (to the ceiling).
 *   • The drag is what the USER asked for — it is a minimum the content may exceed but
 *     never undercut, so a box you deliberately made tall does not collapse under you the
 *     instant you send or delete a line.
 *   • Neither may pass the ceiling, which is the same `paneHeight / 2` the drag handle has
 *     always enforced — auto-grow must not be able to reach a size a drag is forbidden.
 * The visible consequence of "floor, not fixed height" is that dragging DOWN stops at the
 * height the current draft actually needs: the field will not hide text you have already
 * typed. With a short draft (the common case) the whole drag range is still available,
 * because the natural height IS the two-line minimum.
 *
 * After a submit the draft is empty, so `autoGrown` collapses back to the two-line minimum
 * and the box returns to `max(min, draggedFloor)` — i.e. to two lines for anyone who never
 * touched the handle, and to their chosen size for anyone who did. A drag is an explicit
 * standing choice, not the "leftover tall box" a send is supposed to clear.
 */

/** At rest the field shows two lines — enough that a second line of typing is expected
 *  rather than a surprise, which is the whole point of the change. */
export const COMPOSER_MIN_LINES = 2;
/** Auto-grow's own ceiling. Past ~10 lines you are writing a document, not a chat message,
 *  and every further line is stolen from the transcript you are answering. */
export const COMPOSER_MAX_LINES = 10;
/** Share of the pane the composer may occupy — the drag handle's long-standing limit, now
 *  also auto-grow's. */
export const COMPOSER_PANE_FRACTION = 0.5;

export interface ComposerHeightInput {
  /** The textarea's content height (its `scrollHeight` measured at `height: 0`, plus any
   *  border) — i.e. how tall the field would have to be to show the draft with no scroll. */
  contentHeight: number;
  /** One rendered line of the field, in px (its computed `line-height`). */
  lineHeight: number;
  /** The part of the field's height that is never text: vertical padding + border. */
  fieldChrome: number;
  /** Everything in the body box that is NOT the field — the body's own padding plus the
   *  quote / skill / attachment chip rows and the flex gaps between them. Chips appearing
   *  must move the min AND the max, or picking a skill would silently eat a line. */
  chromeHeight: number;
  /** The `.chat-pane` height that sets the ceiling. */
  paneHeight: number;
  /** The height the user last dragged (or arrow-keyed) the composer to; `null` if never. */
  draggedHeight: number | null;
}

/** The two bounds every caller needs alongside the applied height (the drag handle clamps
 *  its own live feedback to them). */
export function composerHeightBounds(
  i: Pick<ComposerHeightInput, 'lineHeight' | 'fieldChrome' | 'chromeHeight' | 'paneHeight'>,
): { min: number; ceiling: number } {
  const lh = i.lineHeight > 0 ? i.lineHeight : 0;
  const min = Math.round(lh * COMPOSER_MIN_LINES + i.fieldChrome + i.chromeHeight);
  // `max(min, …)`: a pane too short to give the composer half of itself still owes it its
  // minimum — a zero-height field is not a smaller composer, it is a broken one.
  const ceiling = Math.max(min, Math.round(i.paneHeight * COMPOSER_PANE_FRACTION));
  return { min, ceiling };
}

/** The height to apply to `.chat-cmp-body` — see this file's header for the rule. */
export function composerBodyHeight(i: ComposerHeightInput): number {
  const lh = i.lineHeight > 0 ? i.lineHeight : 0;
  const { min, ceiling } = composerHeightBounds(i);
  const autoMax = Math.min(Math.round(lh * COMPOSER_MAX_LINES + i.fieldChrome + i.chromeHeight), ceiling);
  const grown = Math.min(autoMax, Math.max(min, Math.round(i.contentHeight + i.chromeHeight)));
  const floor = i.draggedHeight == null ? min : Math.min(ceiling, Math.max(min, Math.round(i.draggedHeight)));
  return Math.min(ceiling, Math.max(grown, floor));
}

/** Did `next` come from `prev` by inserting text and deleting none? Only then can the field
 *  skip its collapse measure: an insertion never takes a line away, while a paste over a
 *  selection or a prefill can be LONGER and still span fewer lines. */
export function draftOnlyGrew(prev: string, next: string): boolean {
  if (next.length <= prev.length) return false;
  let p = 0;
  while (p < prev.length && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let q = 0;
  while (q < prev.length - p && prev.charCodeAt(prev.length - 1 - q) === next.charCodeAt(next.length - 1 - q)) q++;
  return p + q === prev.length;
}

// ── DOM measurement (the impure half — everything above is pure and unit-tested) ──────
//
// The keystroke path is the hot one (task: the desktop app stays light on an 8GB MacBook Air —
// a `getComputedStyle` per key forced a whole-document style resolve, ~25–50 ms a key with long
// panes mounted). So the field's metrics are read ONCE and cached by the caller (refreshed on
// mount, a field width change, theme, zoom and font load — never per key), and the content
// measure only collapses the field when the draft got shorter.

/** The field's line metrics; `border` is kept apart so the content measure needs no style read. */
export interface FieldMetrics { lineHeight: number; fieldChrome: number; border: number }

/** Line metrics read off the live field, so the bounds follow the design tokens rather than
 *  a constant that has to be remembered when a token moves. Cache the result: this is the one
 *  `getComputedStyle` of the composer. */
export function readFieldMetrics(ta: HTMLTextAreaElement): FieldMetrics {
  const cs = getComputedStyle(ta);
  const px = (v: string) => parseFloat(v) || 0;
  // `line-height: normal` computes to the keyword in some engines — fall back to the ratio
  // the stylesheet actually sets rather than to a hardcoded pixel count.
  const lineHeight = px(cs.lineHeight) || px(cs.fontSize) * 1.45 || 20;
  const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  return { lineHeight, fieldChrome: px(cs.paddingTop) + px(cs.paddingBottom) + border, border };
}

/** The part of a textarea the content measure touches (a plain object in tests). */
export type MeasurableField = Pick<HTMLTextAreaElement, 'scrollHeight' | 'clientHeight'> & { style: { height: string } };

/**
 * How tall the draft WANTS to be. The field is `height: 100%` of its row, so its
 * `scrollHeight` is normally just the row's height — it has to be collapsed first for the
 * measurement to be about the content. Both writes happen inside one synchronous block, so
 * the browser never lays the collapsed field out for paint. `border` comes from the cached
 * {@link FieldMetrics}.
 */
export function measureFieldContent(ta: MeasurableField, border: number): number {
  const prev = ta.style.height;
  ta.style.height = '0px';
  const content = ta.scrollHeight; // includes the field's padding, excludes its border
  ta.style.height = prev;
  return content + border;
}

/**
 * The content height for this pass, collapsing the field only when it has to.
 *
 * `full` (the draft got shorter or was replaced, the width changed, nothing measured yet)
 * takes the collapse-to-0 measure — the only way to see content SHRINK. A draft that only
 * GREW can only need more room: if the field now overflows, its `scrollHeight` already is
 * the content height; if it does not, the box it has is still enough and the last figure
 * stands (the applied height cannot change either way — see `composerBodyHeight`).
 */
export function fieldContentHeight(ta: MeasurableField, border: number, last: number | null, full: boolean): number {
  if (full || last == null) return measureFieldContent(ta, border);
  if (ta.scrollHeight > ta.clientHeight) return ta.scrollHeight + border;
  return last;
}

/**
 * The body box minus the field: its own vertical padding, the chip rows currently rendered,
 * and the gaps between them. Measured from the chips THEMSELVES (`offsetHeight`) rather than
 * derived from the body's current height — the chips never shrink (`flex: 0 0 auto`), so
 * when they briefly overflow a too-short box the derived figure would under-report and the
 * height would need a second frame to converge. Called only when a chip row changes or the
 * pane resizes; the keystroke path reuses the last figure.
 */
export function measureBodyChrome(body: HTMLElement, fieldRow: HTMLElement): number {
  const cs = getComputedStyle(body);
  const px = (v: string) => parseFloat(v) || 0;
  const gap = px(cs.rowGap) || px(cs.gap);
  const kids = Array.from(body.children) as HTMLElement[];
  let extra = px(cs.paddingTop) + px(cs.paddingBottom);
  kids.forEach((kid, idx) => {
    if (idx > 0) extra += gap;
    if (kid !== fieldRow) extra += kid.offsetHeight;
  });
  return extra;
}

/**
 * Stop React re-writing the field's text CHILD on every keystroke.
 *
 * For a controlled `<textarea value>` React 19 also sets `defaultValue` to the new value on
 * every update (`updateTextarea`), and a textarea's `defaultValue` IS its child text node: each
 * key replaced that node. The child-list mutation invalidates far more than the field — measured
 * in Chromium with five long panes, 286 elements re-styled per key — and the content measure's
 * `scrollHeight` read then resolved all of it synchronously inside the key's task (cpu-rca K2:
 * the WKWebView's `scrollHeight` → `resolveStyle` chain while the owner typed).
 *
 * The live text is `value`, which React still sets; `defaultValue` only matters to a form reset,
 * and the composer is in no form. So this one element's `defaultValue` setter becomes a no-op
 * (the getter still reads the real one) and the value path stays exactly React's. Idempotent.
 */
export function keepFieldTextChildless(ta: HTMLTextAreaElement): void {
  if (Object.prototype.hasOwnProperty.call(ta, 'defaultValue')) return;
  const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'defaultValue');
  if (!native?.get) return;
  const get = native.get;
  Object.defineProperty(ta, 'defaultValue', {
    configurable: true,
    get() { return get.call(this); },
    set() { /* see above: the field's text is `value`; its child text is never rewritten */ },
  });
}
