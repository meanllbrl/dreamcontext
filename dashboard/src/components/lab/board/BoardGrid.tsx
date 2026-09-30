import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { useI18n } from '../../../context/I18nContext';
import {
  GRID_COLUMNS, GRID_MAX_H, GRID_ROW_PX, clampRect, compact, gridBottom, narrowOrder, rectsOverlap, readingOrder,
  type GridRect,
} from '../../../generated/grid';
import type { Card } from './boardTypes';
import './board.css';

/**
 * THE BOARD'S 12-COLUMN GRID.
 *
 * Cards sit absolutely on the geometry the mirrored `grid.ts` owns: a column is
 * 1/12 of the container, a row is 56px, and the gap between cards is carved out
 * of each cell (so a card's rect never depends on its neighbours). In edit mode
 * a card moves by pointer drag and grows from its bottom-right corner; both snap
 * to the grid under a dashed preview and write ONCE, on release.
 *
 * NARROW (< 720px) is a different surface, not a squeezed one: cards stack full
 * width in reading order (y, then x), keep their height, and nothing can be
 * dragged, so a phone-width window can never rewrite a desktop layout. A drag
 * that is running when the container crosses 720px is cancelled, not dropped.
 */

/** Below this container width the grid is a single read-only column. */
export const NARROW_PX = 720;
/** The gap between cards, in px (the `--space-3` step), carved out of each cell. */
export const GRID_GAP_PX = 12;

export function isNarrow(width: number): boolean {
  return width < NARROW_PX;
}

/** One column's pitch (cell + its share of gap), in px. */
export function columnPitch(containerWidth: number): number {
  return (containerWidth + GRID_GAP_PX) / GRID_COLUMNS;
}

/** A grid rect -> pixel box inside a container `containerWidth` wide. */
export function rectToBox(at: GridRect, containerWidth: number): { left: number; top: number; width: number; height: number } {
  const col = columnPitch(containerWidth);
  return {
    left: at.x * col,
    top: at.y * GRID_ROW_PX,
    width: Math.max(0, at.w * col - GRID_GAP_PX),
    height: Math.max(0, at.h * GRID_ROW_PX - GRID_GAP_PX),
  };
}

/** A card dragged by (dx, dy) px from `start`, snapped to the nearest cell and kept on the board. */
export function snapMove(start: GridRect, dx: number, dy: number, pitch: number): GridRect {
  return clampRect({
    x: start.x + Math.round(dx / pitch),
    y: start.y + Math.round(dy / GRID_ROW_PX),
    w: start.w,
    h: start.h,
  });
}

/** A card resized from its bottom-right corner by (dx, dy) px: the origin stays, the size snaps. */
export function snapResize(start: GridRect, dx: number, dy: number, pitch: number): GridRect {
  const w = Math.min(GRID_COLUMNS - start.x, Math.max(1, start.w + Math.round(dx / pitch)));
  const h = Math.min(GRID_MAX_H, Math.max(1, start.h + Math.round(dy / GRID_ROW_PX)));
  return { x: start.x, y: start.y, w, h };
}

/**
 * The board after `id` lands on `at`: the moved card keeps its spot, every card
 * it now covers is pushed down (reading order) until it fits, then the board is
 * compacted upward so no holes are left behind.
 */
export function placeCard<T extends { id: string; at: GridRect }>(cards: readonly T[], id: string, at: GridRect): T[] {
  const target = clampRect(at);
  const placed: GridRect[] = [target];
  const moved = new Map<string, GridRect>([[id, target]]);
  for (const card of readingOrder(cards.filter((c) => c.id !== id))) {
    const next = { ...card.at };
    while (placed.some((p) => rectsOverlap(p, next))) next.y += 1;
    placed.push(next);
    moved.set(card.id, next);
  }
  return compact(cards.map((c) => ({ ...c, at: moved.get(c.id) ?? c.at })));
}

/** Did a layout change at all (so a click that moved nothing writes nothing)? */
export function sameLayout(a: readonly { id: string; at: GridRect }[], b: readonly { id: string; at: GridRect }[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((c) => [c.id, c.at]));
  return a.every((c) => {
    const o = byId.get(c.id);
    return !!o && o.x === c.at.x && o.y === c.at.y && o.w === c.at.w && o.h === c.at.h;
  });
}

/** The verify hooks on a laid-out cell: its card id and the grid rect it occupies. */
export function cellHooks(card: { id: string; at: GridRect }): Record<string, string | number> {
  return {
    'data-lab-card': card.id,
    'data-lab-card-x': card.at.x,
    'data-lab-card-y': card.at.y,
    'data-lab-card-w': card.at.w,
    'data-lab-card-h': card.at.h,
  };
}

/** A running drag must stop the moment the grid turns into the narrow column. */
export function shouldCancelDrag(dragging: boolean, containerWidth: number): boolean {
  return dragging && isNarrow(containerWidth);
}

type DragMode = 'move' | 'resize';

interface Drag {
  id: string;
  mode: DragMode;
  pointerId: number;
  startX: number;
  startY: number;
  start: GridRect;
  /** The snapped target, drawn as the preview. */
  at: GridRect;
  /** The raw pointer offset, for the card following the pointer. */
  dx: number;
  dy: number;
}

export interface BoardGridProps {
  cards: Card[];
  /** Edit mode: drag + resize. Ignored in the narrow column. */
  editing: boolean;
  renderCard: (card: Card) => ReactNode;
  /** A committed drag or resize: the whole new card list (only called when something moved). */
  onLayout?: (cards: Card[]) => void;
  /** Edit mode: a card pressed and released without moving (opens the inspector). */
  onSelectCard?: (id: string) => void;
}

export function BoardGrid({ cards, editing, renderCard, onLayout, onSelectCard }: BoardGridProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = width > 0 && isNarrow(width);
  const canEdit = editing && !narrow && width > 0 && !!onLayout;

  // Crossing 720px mid-drag cancels it: the narrow column never writes.
  useEffect(() => {
    if (shouldCancelDrag(dragRef.current !== null, width)) setDrag(null);
  }, [width]);

  // Esc drops a drag where it started.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  const begin = useCallback((e: ReactPointerEvent<HTMLElement>, card: Card, mode: DragMode) => {
    if (!canEdit || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: card.id, mode, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, start: card.at, at: card.at, dx: 0, dy: 0 });
  }, [canEdit]);

  const move = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const pitch = columnPitch(width);
    const at = d.mode === 'move' ? snapMove(d.start, dx, dy, pitch) : snapResize(d.start, dx, dy, pitch);
    setDrag({ ...d, at, dx, dy });
  }, [width]);

  const end = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    setDrag(null);
    if (!onLayout || isNarrow(width)) return;
    // Released where it started: a click, never a write (even on a board with holes).
    if (sameLayout([{ id: d.id, at: d.at }], [{ id: d.id, at: d.start }])) {
      if (d.mode === 'move') onSelectCard?.(d.id);
      return;
    }
    const next = placeCard(cards, d.id, d.at);
    if (!sameLayout(cards, next)) onLayout(next);
  }, [cards, onLayout, onSelectCard, width]);

  const cancel = useCallback(() => setDrag(null), []);

  if (narrow) {
    return (
      <div ref={ref} className="board-grid board-grid--narrow">
        {narrowOrder(cards).map((card) => (
          <div
            key={card.id}
            className="board-cell board-cell--narrow"
            data-card-id={card.id}
            {...cellHooks(card)}
            style={{ height: card.at.h * GRID_ROW_PX - GRID_GAP_PX }}
          >
            {renderCard(card)}
          </div>
        ))}
      </div>
    );
  }

  const rows = Math.max(gridBottom(cards), drag ? drag.at.y + drag.at.h : 0);
  return (
    <div
      ref={ref}
      className={`board-grid${canEdit ? ' board-grid--editing' : ''}${drag ? ' board-grid--dragging' : ''}`}
      style={{ height: Math.max(0, rows * GRID_ROW_PX - GRID_GAP_PX) }}
    >
      {drag && width > 0 && (
        <div className="board-preview" aria-hidden="true" style={rectToBox(drag.at, width)} />
      )}
      {/* While a drag runs, nothing under the pointer (an html block's iframe, a chart) may take
          its events: pointer capture alone is not trusted across an iframe boundary. */}
      {drag && <div className="board-drag-shield" aria-hidden="true" />}
      {width > 0 && cards.map((card) => {
        const active = drag?.id === card.id ? drag : null;
        const box = rectToBox(active?.mode === 'resize' ? active.at : card.at, width);
        const style = active?.mode === 'move'
          ? { ...box, transform: `translate(${active.dx}px, ${active.dy}px)` }
          : box;
        return (
          <div
            key={card.id}
            className={`board-cell${active ? ' board-cell--active' : ''}`}
            data-card-id={card.id}
            {...cellHooks(card)}
            style={style}
          >
            {renderCard(card)}
            {canEdit && (
              <>
                {/* Over the card's content in edit mode: an iframe or a chart must not eat the drag. */}
                <div
                  className="board-cell-handle"
                  data-lab-drag-handle
                  role="button"
                  tabIndex={-1}
                  aria-label={t('lab.board.grid.move')}
                  onPointerDown={(e) => begin(e, card, 'move')}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={cancel}
                />
                <div
                  className="board-cell-resize"
                  data-lab-resize-handle
                  role="button"
                  tabIndex={-1}
                  aria-label={t('lab.board.grid.resize')}
                  onPointerDown={(e) => begin(e, card, 'resize')}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={cancel}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
