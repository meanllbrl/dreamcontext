/**
 * The board writing field's decisions, kept pure so root vitest pins them (plan K3, criteria
 * 7-10, 12): what the message says, which key does what, how long the field waits for the save,
 * and when the "working" marks stand. `BoardSuperField.tsx` only wires them to the screen.
 */
import { pageContextBlock, pageSelectionTail, type PageSelection } from '../../lib/superTypes';
import { stripSentinelChars } from '../../lib/chatProtocol';
import { neutraliseHeaders } from '../sleepy/chat/composerScratch';
import type { SelectionRef } from './agentDrop';

/** The selection as the page block carries it (`label`/`one` stay on screen). */
export function pageSelectionOf(sel: SelectionRef | null | undefined): PageSelection | undefined {
  return sel ? { n: sel.n, box: sel.box, ids: sel.ids } : undefined;
}

/** One predicate for the chip and the wire: a selection whose ids would all be dropped shows no
 *  chip, so what the owner sees is what is sent. */
export function selectionSendable(sel: SelectionRef | null | undefined): boolean {
  return pageSelectionTail(pageSelectionOf(sel)) !== '';
}

/**
 * The message: the owner's words (no Telegram sentinel, no line that would read as a header), a
 * blank line, the page block naming the board and, when there is one, the selection. Null when
 * there are no words: an empty field never sends.
 */
export function composeFieldMessage(words: string, board: string, sel: SelectionRef | null | undefined): string | null {
  const said = neutraliseHeaders(stripSentinelChars(words ?? '').trim());
  if (!said.trim()) return null;
  const block = pageContextBlock({ page: 'whiteboards', board, ...(selectionSendable(sel) ? { sel: pageSelectionOf(sel) } : {}) });
  return block ? `${said}\n\n${block}` : said;
}

export type FieldKeyAction = 'send' | 'blur' | null;

/** Enter sends; Shift+Enter is a newline; IME composition never sends; Escape leaves the field. */
export function fieldKeyAction(e: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): FieldKeyAction {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'blur';
  if (e.key === 'Enter' && !e.shiftKey) return 'send';
  return null;
}

export type SaveKind = 'saved' | 'saving' | 'retrying' | 'failed' | 'deleted';
export type SaveSettle = 'saved' | 'unsaved' | 'deleted';

/** How long a send waits for the board to reach the disk. */
export const SAVE_WAIT_MS = 3000;

/**
 * Flush the board's save and wait (up to `timeoutMs`) for a `saved` reached after the flush:
 * a deleted board refuses; a failed save or the timeout sends anyway (the Super then sees the
 * last saved board, and the field says so).
 */
export async function settleSave(
  readKind: () => SaveKind,
  flush: () => void,
  opts: { timeoutMs?: number; stepMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<SaveSettle> {
  const timeoutMs = opts.timeoutMs ?? SAVE_WAIT_MS;
  const stepMs = opts.stepMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  if (readKind() === 'deleted') return 'deleted';
  flush();
  const end = now() + timeoutMs;
  for (;;) {
    const kind = readKind();
    if (kind === 'deleted') return 'deleted';
    if (kind === 'saved') return 'saved';
    if (kind === 'failed') return 'unsaved';
    if (now() >= end) return 'unsaved';
    await sleep(stepMs);
  }
}

/** A kind in the reader's words: a shape's own key, else the widget's palette label, else the raw kind. */
function kindName(kind: string, t: (key: string) => string): string {
  const shape = `whiteboard.field.kind.${kind}`;
  if (t(shape) !== shape) return t(shape);
  const widget = `whiteboard.palette.${kind}`;
  if (t(widget) !== widget) return t(widget).replace(/…$/, '');
  return kind;
}

/** The selection chip's words: one unit by its title (else its kind), several by count. */
export function selectionChipText(
  sel: SelectionRef,
  t: (key: string) => string,
): string {
  if (sel.n === 1 && sel.one) {
    const name = sel.one.title || kindName(sel.one.kind, t);
    return t('whiteboard.field.selOne').replace('{name}', () => name);
  }
  return t('whiteboard.field.selMany').replace('{n}', String(sel.n));
}

// ── where the field sits (review r1/r2: never under the open dock window, never on Excalidraw's
//    controls). This function is the ONLY place the field's geometry is decided: the component
//    applies its box inline and the CSS carries no width, floor or offset of its own, so what is
//    painted is exactly what was reasoned about here.

/** The Super dock window's width and its inset from the viewport edge (SuperDock.css
 *  `--super-dock-width`, `--space-5`; a drift test pins the width). */
export const DOCK_WINDOW_PX = 420;
export const DOCK_INSET_PX = 20;
/** Excalidraw's bottom-left zoom + undo group (≈ 252 px from the canvas edge) and a gap. */
export const FIELD_LEFT_RESERVE_PX = 272;
/** The field's inset from the canvas edges (`--space-5`). */
export const FIELD_INSET_PX = 20;
/** The zoom/undo row's height (36 px) and a gap: how far the narrow field rises above it. */
export const ZOOM_ROW_RISE_PX = 48;
/** The field's widest. */
export const FIELD_MAX_PX = 640;
/** Below this the field is too cramped to type in: it steps aside for the open window. */
export const FIELD_MIN_PX = 280;
/** Below this canvas width the field cannot sit between the zoom/undo group and its mirror
 *  (2 x 272 px + a 400 px field): it rises above that row instead. */
export const NARROW_CANVAS_PX = 944;

/** The canvas's measured box: its width, its right edge and the viewport width (px). */
export interface CanvasBox {
  width: number;
  right: number;
  viewport: number;
}

/** The field's box in canvas px (left and bottom offsets, width), or covered. */
export interface FieldLayout {
  left: number;
  bottom: number;
  width: number;
  /** Risen above the zoom/undo row. */
  narrow: boolean;
  /** No room beside the open window: the field steps aside (the window has the Super's own
   *  composer), keeping its draft and work marks. Also before the canvas is measured. */
  covered: boolean;
}

/** How much of the canvas's right side the open dock window takes, with its gap (px). The
 *  window is fixed to the viewport's right edge; whatever stands between it and the canvas (the
 *  board agents panel) already keeps part of it off the canvas. */
export function dockReserveOf(box: CanvasBox, dockOpen: boolean): number {
  if (!dockOpen) return 0;
  return Math.max(0, DOCK_WINDOW_PX + 2 * DOCK_INSET_PX - Math.max(0, box.viewport - box.right));
}

const COVERED: FieldLayout = { left: 0, bottom: FIELD_INSET_PX, width: 0, narrow: false, covered: true };

/** One rule for every width: the field never sits under the open dock window, never on the
 *  zoom/undo group, never wider than {@link FIELD_MAX_PX}. */
export function fieldLayout(box: CanvasBox | null, dockOpen: boolean): FieldLayout {
  if (!box || box.width <= 0) return COVERED;
  const reserve = dockReserveOf(box, dockOpen);
  const narrowCanvas = box.width < NARROW_CANVAS_PX;
  if (reserve === 0) {
    // Centred: beside the zoom/undo group on a wide canvas, above it on a narrow one.
    const room = narrowCanvas ? box.width - 2 * FIELD_INSET_PX : box.width - 2 * FIELD_LEFT_RESERVE_PX;
    const width = Math.max(0, Math.floor(Math.min(FIELD_MAX_PX, room)));
    if (width < FIELD_MIN_PX) return COVERED;
    return {
      left: Math.floor((box.width - width) / 2),
      bottom: narrowCanvas ? FIELD_INSET_PX + ZOOM_ROW_RISE_PX : FIELD_INSET_PX,
      width,
      narrow: narrowCanvas,
      covered: false,
    };
  }
  // The window open: left-aligned, ending before the window; beside the zoom/undo group when
  // that leaves room, else risen above it from the canvas's left inset, else stepped aside.
  const wideRoom = box.width - FIELD_LEFT_RESERVE_PX - reserve;
  if (!narrowCanvas && wideRoom >= FIELD_MIN_PX) {
    return { left: FIELD_LEFT_RESERVE_PX, bottom: FIELD_INSET_PX, width: Math.floor(Math.min(FIELD_MAX_PX, wideRoom)), narrow: false, covered: false };
  }
  const narrowRoom = box.width - FIELD_INSET_PX - reserve;
  if (narrowRoom >= FIELD_MIN_PX) {
    return { left: FIELD_INSET_PX, bottom: FIELD_INSET_PX + ZOOM_ROW_RISE_PX, width: Math.floor(Math.min(FIELD_MAX_PX, narrowRoom)), narrow: true, covered: false };
  }
  return COVERED;
}
