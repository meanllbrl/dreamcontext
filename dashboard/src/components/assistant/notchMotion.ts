/**
 * HOW THE NOTCH OPENS AND FOLDS, as a plan (Notch.tsx runs it).
 *
 * The owner, 2026-10-04: the notch "just appears". The window is TRANSPARENT; all the owner
 * sees is the black island the webview draws, and growing the window (set_frames over 200 ms)
 * never showed as a growing island: WKWebView did not repaint the heavy chat pane on every
 * tick, so the island landed at full size. So the window no longer animates in the notch seat.
 * It lands on its frame in ONE step, and the island itself grows in CSS (a clip-path on the
 * root: the layout stays at its final size, so the chat pane is not re-laid out every frame).
 *
 * - open: the window lands on the panel frame at once, THEN the island grows out of the pill
 *   (or the peek it opens from) to the panel;
 * - fold: the island shrinks back to the pill FIRST, then the window lands on the pill frame;
 * - the last request wins: a fold during an open (or an open during a fold) starts from
 *   wherever the island is now, and the superseded run lands nothing late;
 * - reduced motion: no CSS step at all, the state changes at once.
 *
 * Pure: no DOM, no Tauri. The popped-out window seat never comes here (it keeps its native,
 * animated path).
 */

export type MotionPhase = 'closed' | 'opening' | 'open' | 'folding';
export type MotionRequest = 'open' | 'fold';

/** Where the island or the window ends up: the open panel, or the collapsed pill. */
export type MotionTarget = 'panel' | 'pill';

export type MotionStep =
  /** Land the notch window on the target's frame in one step (always 0 ms). */
  | { kind: 'frame'; to: MotionTarget; ms: 0 }
  /** Grow or shrink the island in CSS. `from: 'rect'` starts at the pill / peek rect,
   *  `from: 'current'` at whatever the island paints now (a superseded run's midpoint). */
  | { kind: 'css'; to: MotionTarget; from: 'rect' | 'current'; ms: number }
  /** The run is over: the phase it settles on. */
  | { kind: 'settle'; phase: 'open' | 'closed' };

export interface MotionPlan {
  /** The phase the notch is in from the moment the request is taken. */
  phase: 'opening' | 'folding';
  steps: MotionStep[];
}

/** The island's grow / shrink (owner-visible, so short: a breath, not a show). */
export const NOTCH_GROW_MS = 220;
/** tokens.css `--ease-out`: fast out of the pill, settling into the panel. */
export const NOTCH_GROW_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * The plan for `request` from `current`, or null when there is nothing to do (opening what is
 * already open or opening, folding what is already folded or folding).
 */
export function planMotion(current: MotionPhase, request: MotionRequest, opts: { reduced: boolean }): MotionPlan | null {
  const ms = opts.reduced ? 0 : NOTCH_GROW_MS;
  if (request === 'open') {
    if (current === 'open' || current === 'opening') return null;
    const css: MotionStep[] = ms > 0 ? [{ kind: 'css', to: 'panel', from: current === 'folding' ? 'current' : 'rect', ms }] : [];
    return { phase: 'opening', steps: [{ kind: 'frame', to: 'panel', ms: 0 }, ...css, { kind: 'settle', phase: 'open' }] };
  }
  if (current === 'closed' || current === 'folding') return null;
  const css: MotionStep[] = ms > 0 ? [{ kind: 'css', to: 'pill', from: 'current', ms }] : [];
  return { phase: 'folding', steps: [...css, { kind: 'frame', to: 'pill', ms: 0 }, { kind: 'settle', phase: 'closed' }] };
}

/** True while the island must still be drawn as the open one (open, or on its way in or out). */
export function drawsOpen(phase: MotionPhase): boolean {
  return phase !== 'closed';
}

export interface IslandRect { width: number; height: number }

/**
 * The island's clip: `rect` anchored top-centre in the root (flat top fused with the housing,
 * the bottom corners rounded by `radius`), or the whole root when `rect` is null. Written in
 * percentages of the root, so it shows the same rect whatever size the window is at the moment
 * (the window and the CSS never have to land in the same frame).
 */
export function islandClip(rect: IslandRect | null, radius: string): string {
  if (!rect) return `inset(0px 0px 0px 0px round 0px 0px ${radius} ${radius})`;
  const side = `calc(50% - ${round(rect.width / 2)}px)`;
  return `inset(0px ${side} calc(100% - ${round(rect.height)}px) ${side} round 0px 0px ${radius} ${radius})`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
