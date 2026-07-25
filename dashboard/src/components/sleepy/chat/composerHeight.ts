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

// ── DOM measurement (the impure half — everything above is pure and unit-tested) ──────

/** Line metrics read off the live field, so the bounds follow the design tokens rather than
 *  a constant that has to be remembered when a token moves. */
export function readFieldMetrics(ta: HTMLTextAreaElement): { lineHeight: number; fieldChrome: number } {
  const cs = getComputedStyle(ta);
  const px = (v: string) => parseFloat(v) || 0;
  // `line-height: normal` computes to the keyword in some engines — fall back to the ratio
  // the stylesheet actually sets rather than to a hardcoded pixel count.
  const lineHeight = px(cs.lineHeight) || px(cs.fontSize) * 1.45 || 20;
  const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  return { lineHeight, fieldChrome: px(cs.paddingTop) + px(cs.paddingBottom) + border };
}

/**
 * How tall the draft WANTS to be. The field is `height: 100%` of its row, so its
 * `scrollHeight` is normally just the row's height — it has to be collapsed first for the
 * measurement to be about the content. Both writes happen inside one synchronous block, so
 * the browser never lays the collapsed field out for paint.
 */
export function measureFieldContent(ta: HTMLTextAreaElement): number {
  const cs = getComputedStyle(ta);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const prev = ta.style.height;
  ta.style.height = '0px';
  const content = ta.scrollHeight; // includes the field's padding, excludes its border
  ta.style.height = prev;
  return content + border;
}

/**
 * The body box minus the field: its own vertical padding, the chip rows currently rendered,
 * and the gaps between them. Measured from the chips THEMSELVES (`offsetHeight`) rather than
 * derived from the body's current height — the chips never shrink (`flex: 0 0 auto`), so
 * when they briefly overflow a too-short box the derived figure would under-report and the
 * height would need a second frame to converge.
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
