import { useLayoutEffect, useRef, type DragEvent, type ReactNode, type RefObject } from 'react';
import { fmtScore, type Band, type Placed } from './priorityModel';

/**
 * One card on the priority board (objective or task). Dashed with ✦ when its
 * score or link is the agent's suggestion. Pure presentation: the view decides
 * selection and drag.
 */
export interface PriorityCardProps {
  title: string;
  place: Placed;
  band: Band | null;
  variant: 'objective' | 'task';
  selected?: boolean;
  /** A link-suggestion ghost (dashed even when the score is the owner's). */
  ghost?: boolean;
  /** Active or in-review status kind: the blue dot. */
  activeDot?: boolean;
  flipKey: string;
  onOpen: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  style?: React.CSSProperties;
  children?: ReactNode;
}

export function PriorityCard({
  title, place, band, variant, selected, ghost, activeDot, flipKey, onOpen, draggable, onDragStart, onDragEnd, style, children,
}: PriorityCardProps) {
  const suggested = place.suggested || !!ghost;
  const cls = [
    'pc',
    variant === 'objective' ? 'pc--obj' : 'pc--task',
    band ? `pc--${band}` : '',
    suggested ? 'is-suggested' : '',
    selected ? 'is-selected' : '',
  ].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      data-flip-key={flipKey}
      role="button"
      tabIndex={0}
      aria-pressed={!!selected}
      aria-label={`${title}${place.score != null ? `, score ${fmtScore(place.score)}` : ', not scored'}${suggested ? ', suggested' : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={style}
    >
      <div className="pc-head">
        {activeDot && <span className="pc-dot" aria-label="in progress" />}
        <span className="pc-title" title={title}>{title}</span>
        {place.score != null && (
          <span className="pc-score">{suggested && place.suggested ? '✦ ' : ''}{fmtScore(place.score)}</span>
        )}
        {place.score == null && ghost && <span className="pc-score">✦</span>}
      </div>
      {children}
    </div>
  );
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export const GLIDE_MS = 220;

/**
 * FLIP glide: after every render, each `[data-flip-key]` element that moved since
 * the last render starts at its old position and glides to the new one (220 ms).
 * Nothing moves under prefers-reduced-motion.
 */
export function useFlip(container: RefObject<HTMLElement | null>, deps: unknown[]): void {
  const last = useRef(new Map<string, { left: number; top: number }>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const next = new Map<string, { left: number; top: number }>();
    const els = root.querySelectorAll<HTMLElement>('[data-flip-key]');
    const animate = !reducedMotion();
    // Positions in the container's content box, so a scroll between renders is not a move.
    const base = root.getBoundingClientRect();
    // A root that IS the scroller moves its children on scroll: add the scroll back. A root inside
    // the scroller moves with them, so its own rect already cancels the scroll.
    const scroller = root.classList.contains('pv-scroll') ? root : { scrollLeft: 0, scrollTop: 0 };
    els.forEach((el) => {
      const key = el.dataset.flipKey!;
      const r = el.getBoundingClientRect();
      const rect = { left: r.left - base.left + scroller.scrollLeft, top: r.top - base.top + scroller.scrollTop };
      next.set(key, rect);
      const prev = last.current.get(key);
      if (!animate || !prev) return;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: GLIDE_MS, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    });
    last.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
