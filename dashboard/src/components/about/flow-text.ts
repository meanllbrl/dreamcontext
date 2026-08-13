/**
 * Text fitting for {@link FlowDiagram} node titles — pure string math, no React
 * and no DOM, so it is unit-testable from this repo's node-only vitest suite
 * (`tests/unit/automations-flow-title-fit.test.ts`) where the component that
 * uses it is not.
 *
 * SVG `<text>` neither wraps nor clips: a title wider than its node draws
 * straight out of the box and through whatever sits beside it. Hand-authored
 * specs never hit that — each title was written for the box it is shown in.
 * A GENERATED spec does, constantly: the automations flow canvas's node titles
 * are user data (a schedule phrase, an automation name, an output path) of
 * unknown length. That asymmetry is why the fitting is opt-in per diagram
 * (`FlowDiagramProps.fitTitles`) rather than always-on.
 */

/** Maximum lines a re-fitted title may occupy before it is ellipsized. Two —
 *  a third line would collide with the caption below it in a glyph node. */
export const TITLE_MAX_LINES = 2;

/** Font-size multiplier for a title that had to wrap. `.fd-node-title--fit` in
 *  `FlowDiagram.css` is what actually applies it; this constant is what the
 *  wrap math is computed at. The two are asserted equal by the unit test —
 *  drift between them would wrap at one size and render at another. */
export const TITLE_SCALE = 0.8;

/** Wrapped-title line-height, in viewBox units. */
export const TITLE_LH = 18;

/** Average advance of the title font, as a fraction of its size. Measured, not
 *  guessed: bold Inter at 17px runs 7.8–8.8px per character across the strings
 *  these diagrams actually carry, so 0.53 sits just above the widest of them —
 *  close enough not to shrink a title that would have fitted, conservative
 *  enough not to let one spill. */
const TITLE_CHAR_EM = 0.53;

/** Total horizontal inset inside a node, in viewBox units. */
const TITLE_INSET = 8;

/**
 * Splits a title where a reader expects it to break: on whitespace (consumed)
 * and AFTER a `/` or `·` (kept on the leading token, so a path breaks as
 * `automations/output/` + `calbuddy-funnel-watch/` rather than mid-word).
 */
function titleTokens(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === ' ') {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
      if (ch === '/' || ch === '·') {
        out.push(cur);
        cur = '';
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Greedy line-filling over {@link titleTokens}. Tokens are joined with a
 *  space unless the running line already ends in `/`, which is its own break. */
function packTitle(tokens: readonly string[], maxChars: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const tok of tokens) {
    const candidate = !cur ? tok : cur.endsWith('/') ? cur + tok : `${cur} ${tok}`;
    if (cur && candidate.length > maxChars) {
      lines.push(cur);
      cur = tok;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface FittedTitle {
  lines: string[];
  /** The title had to drop to {@link TITLE_SCALE} of its size to fit. */
  scaled: boolean;
  /** Even re-fitted it did not fit, so it was ellipsized — the caller must
   *  expose the full string some other way (a hover `<title>`), so nothing
   *  this does can make a label unreadable. */
  truncated: boolean;
}

/**
 * Fits a node title inside its box. A title that already fits is returned
 * untouched at full size, so a diagram that opts in changes nothing about the
 * titles that were never a problem. Only an overflowing one is re-fitted:
 * dropped to {@link TITLE_SCALE}, wrapped to at most {@link TITLE_MAX_LINES},
 * and ellipsized only if it still overflows after both.
 */
export function fitTitle(text: string, boxW: number, fontSize: number): FittedTitle {
  const charsAt = (fs: number): number =>
    Math.max(6, Math.floor((boxW - TITLE_INSET) / (fs * TITLE_CHAR_EM)));
  if (text.length <= charsAt(fontSize)) return { lines: [text], scaled: false, truncated: false };

  const maxChars = charsAt(fontSize * TITLE_SCALE);
  const packed = packTitle(titleTokens(text), maxChars);
  const lines = packed.slice(0, TITLE_MAX_LINES);
  const last = lines.length - 1;
  const overflows = packed.length > lines.length || lines[last].length > maxChars;
  if (overflows) lines[last] = `${lines[last].slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  return { lines, scaled: true, truncated: overflows };
}
