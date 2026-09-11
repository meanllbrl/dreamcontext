/**
 * The live input meter for J.A.R.V.I.S mode — the bars that REPLACE the placeholder while a
 * take is recording.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────
 * It is the mode's trust signal, and that is a stronger claim than "it looks alive". Today a
 * take that heard nothing and a take that was never recorded are pixel-identical on screen:
 * both are a composer with a red button. The owner finds out which by waiting for a
 * transcript that never comes. A meter that never moved answers it before the upload — and
 * it answers it in the slot the placeholder already occupies, so the card does not grow, the
 * toolbar does not move, and nothing below the composer re-flows.
 *
 * ── WHY A CANVAS AND NOT DIVS ───────────────────────────────────────────────────────────
 * The level arrives ~47 times a second. A bar per div would be ~120 elements re-styled at
 * that rate inside the composer's own subtree — every one of them a layout the browser has
 * to do in the same frame as the textarea it sits on. One canvas paints them in a single
 * rAF, and the React tree never re-renders while a take runs.
 *
 * ── THE HISTORY IS A RING, AND OLD SAMPLES ARE NEVER RESCALED ───────────────────────────
 * Bars scroll right-to-left: the newest sample is the rightmost bar. Normalisation is
 * therefore FIXED rather than per-frame auto-gain — an auto-gained meter shows a loud bar
 * for room tone the instant you stop speaking, which is precisely the lie this component
 * exists to prevent. {@link FULL_SCALE} is the RMS that reaches full height, set a little
 * above `RMS_FLOOR` so a take the silence gate will refuse is visibly SHORT rather than
 * merely quieter.
 */

import { useEffect, useRef } from 'react';

/** The RMS that draws a full-height bar. Normal speech at arm's length sits around 0.05–0.15;
 *  `RMS_FLOOR` (the gate that refuses a take) is 0.012, so a refused take draws stubs. */
export const FULL_SCALE = 0.14;

/** Bar geometry, in CSS pixels. */
const BAR_W = 2;
const BAR_GAP = 3;

/** The floor every bar is drawn at, so an idle meter is a dotted line rather than nothing —
 *  "recording, hearing silence" is a state, and a blank strip would read as "not running". */
const MIN_BAR = 2;

export interface VoiceMeterProps {
  /**
   * Subscribe to the level stream. Returns its unsubscribe.
   *
   * The component takes a SUBSCRIBE function rather than a level prop for the reason in the
   * header: a level prop would be React state, re-rendering the composer at audio rate.
   */
  subscribe: (fn: (level: number) => void) => () => void;
  /** `live` paints incoming levels; `frozen` keeps the last picture and dims it — the take is
   *  over and being transcribed, which is not the same as nothing happening. */
  phase: 'live' | 'frozen';
  /** Stroke colour. Passed explicitly so the meter matches the state rail rather than
   *  guessing at a token. */
  color: string;
  className?: string;
}

export function VoiceMeter({ subscribe, phase, color, className }: VoiceMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Newest-last level history, trimmed to whatever the current width can show. */
  const levelsRef = useRef<number[]>([]);
  /** `phase` read inside the rAF loop without restarting it. */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const colorRef = useRef(color);
  colorRef.current = color;

  useEffect(() => subscribe((level) => {
    const l = levelsRef.current;
    l.push(level);
    // A hard cap unrelated to width: the draw pass trims to what fits, and an unbounded array
    // would otherwise grow for the whole take.
    if (l.length > 600) l.splice(0, l.length - 600);
  }), [subscribe]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let stopped = false;

    const draw = () => {
      if (stopped) return;
      raf = requestAnimationFrame(draw);

      // The canvas is sized from its LAID-OUT box every frame rather than from a prop: the
      // composer is resizable and its pane can be dragged narrower mid-take.
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const slots = Math.max(1, Math.floor(w / (BAR_W + BAR_GAP)));
      const levels = levelsRef.current;
      const shown = levels.slice(-slots);
      const mid = h / 2;

      ctx.fillStyle = colorRef.current;
      ctx.globalAlpha = phaseRef.current === 'frozen' ? 0.45 : 1;

      for (let i = 0; i < shown.length; i++) {
        const v = Math.min(1, shown[i] / FULL_SCALE);
        const barH = Math.max(MIN_BAR, v * (h - 4));
        // Right-aligned: the newest sample is always hard against the right edge, so the
        // strip reads as "now" moving left rather than as a bar chart filling up.
        const x = w - (shown.length - i) * (BAR_W + BAR_GAP);
        ctx.beginPath();
        // A rounded cap on a 2px bar is the difference between a meter and a barcode.
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x, mid - barH / 2, BAR_W, barH, BAR_W / 2);
        } else {
          ctx.rect(x, mid - barH / 2, BAR_W, barH);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    raf = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }, []);

  // Cleared when a take ENDS, not when it starts: the frozen picture is what the transcribing
  // phase shows, so the history has to outlive the recording it came from.
  useEffect(() => {
    if (phase === 'live') levelsRef.current = [];
  }, [phase]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
