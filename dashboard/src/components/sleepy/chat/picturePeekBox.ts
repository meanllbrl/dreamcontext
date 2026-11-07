/**
 * Where a picture chip's hover card goes (owner 2026-11-07: "hover yapınca görsem fotoyu güzel
 * olur"). Pure: no React, no DOM, so root vitest pins it.
 *
 * The card holds the whole picture at its own aspect, no larger than `max`, never upscaled, and
 * stays inside the window: above the chip when it fits there, else below it, else on whichever
 * side has more room (shrunk to fit). It floats (fixed, portaled), so nothing in the text moves.
 */
import { agentFileKind } from '../../../lib/agentFileKind';

export interface PeekRect { left: number; top: number; right: number; bottom: number }
export interface PeekBox { left: number; top: number; width: number; height: number; side: 'above' | 'below' }

/** The card's picture box: at most 320 x 240, the window's 8 px margin and the 8 px gap to the chip. */
export const PEEK_MAX = { w: 320, h: 240 } as const;
const MARGIN = 8;
const GAP = 8;

/** The picture's own size scaled to fit `w` x `h`, never upscaled; at least 1 px each way. */
function fit(natural: { w: number; h: number }, w: number, h: number): { width: number; height: number } {
  const nw = Math.max(1, natural.w);
  const nh = Math.max(1, natural.h);
  const s = Math.min(1, w / nw, h / nh);
  return { width: Math.max(1, Math.round(nw * s)), height: Math.max(1, Math.round(nh * s)) };
}

export function peekBox(
  anchor: PeekRect,
  natural: { w: number; h: number },
  view: { w: number; h: number },
  max: { w: number; h: number } = PEEK_MAX,
): PeekBox {
  const roomW = Math.max(1, Math.min(max.w, view.w - 2 * MARGIN));
  const above = anchor.top - GAP - MARGIN;
  const below = view.h - anchor.bottom - GAP - MARGIN;
  const full = fit(natural, roomW, max.h);
  const side: PeekBox['side'] = above >= full.height ? 'above' : below >= full.height ? 'below' : above >= below ? 'above' : 'below';
  const { width, height } = fit(natural, roomW, Math.max(1, Math.min(max.h, side === 'above' ? above : below)));
  const left = Math.round(Math.max(MARGIN, Math.min(anchor.left, view.w - MARGIN - width)));
  const top = Math.round(side === 'above' ? anchor.top - GAP - height : anchor.bottom + GAP);
  return { left, top, width, height, side };
}

/** What a chip's thumbnail room holds for a path: the picture itself, or its kind's icon (a clip
 *  shows its name only: no still frame is cut, and an `<img>` of a video would draw broken). */
export function chipThumbFor(path: string): { picture: true } | { picture: false; icon: string } {
  const lower = path.toLowerCase();
  if (agentFileKind(lower) === 'image' || lower.endsWith('.svg')) return { picture: true };
  return { picture: false, icon: agentFileKind(lower) === 'video' ? '🎞' : '📄' };
}
