/**
 * The status mark at the head of a checklist row.
 *
 * Two channels, never one (style guide): SHAPE and MOTION carry the mode, COLOUR carries the
 * mood. A hollow ring is something still to do; a rotating arc is work in progress; a drawn
 * check is done; a ring with a breathing dot is waiting on the person; a "!" is a failure; a
 * dashed ring waits on another row. Colours come from the stylesheet (`currentColor`), so the
 * mark never names a colour itself and a reader who cannot tell the hues apart still reads the
 * shape.
 */

export type GlyphMode = 'todo' | 'working' | 'done' | 'needs-you' | 'failed' | 'blocked';

export function StatusGlyph({ mode, animate = false }: { mode: GlyphMode; animate?: boolean }) {
  return (
    <svg
      className={`ob-glyph ob-glyph--${mode}${animate ? ' ob-glyph--animate' : ''}`}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      {mode === 'working' ? (
        <>
          <circle className="ob-glyph-track" cx="10" cy="10" r="8" />
          <path className="ob-glyph-arc" d="M10 2 a8 8 0 0 1 8 8" />
        </>
      ) : (
        <circle className="ob-glyph-ring" cx="10" cy="10" r="8" />
      )}
      {mode === 'done' && <path className="ob-glyph-check" d="M6 10.4 L8.8 13 L14 7.4" pathLength={24} />}
      {mode === 'needs-you' && <circle className="ob-glyph-dot" cx="10" cy="10" r="3" />}
      {mode === 'failed' && (
        <>
          <path className="ob-glyph-bang" d="M10 5.6 V11" />
          <circle className="ob-glyph-bang-dot" cx="10" cy="14" r="1.1" />
        </>
      )}
    </svg>
  );
}
