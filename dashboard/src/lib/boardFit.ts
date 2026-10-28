/**
 * When a read-only board may fit itself to its box, and to WHICH box (owner 2026-10-28: a
 * whiteboard on the Super stage drew as a tiny cluster in the card's top-left corner, and again
 * after he came back from another page).
 *
 * Excalidraw measures its box with `getBoundingClientRect` — the box as DRAWN, transforms
 * included — and only again when its layout size changes. The Super stage moves cards with
 * transform animations (a card flies in scaled, a page coming back replays the stage's entry),
 * so a board measured mid-flight keeps that scaled size for good: measured 307x95 inside a
 * 1097x340 card (0.28, the flight's start scale), it sized its canvas to that and fitted the
 * board into it. Hidden (another page), it measures 0x0 and a fit computes the smallest zoom.
 *
 * So a fit waits until the box has stopped moving (two frames alike), never runs while the box
 * is hidden, and first tells Excalidraw the settled box when its own record differs.
 *
 * No React, no Excalidraw import: root vitest runs it as it is.
 */

import { extractExcalidrawScene } from './excalidraw';

/** A box on screen, as `getBoundingClientRect` reads it. */
export interface FitBox {
  width: number;
  height: number;
  left: number;
  top: number;
}

/** Excalidraw's own record of its box (`appState`). */
export interface FitRecord {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

export type FitStep =
  /** Not drawn (another page, a collapsed card): leave the viewport alone, a resize brings it back. */
  | { kind: 'hidden' }
  /** Still moving under a transform: look again next frame. */
  | { kind: 'settling' }
  /** Settled: fit, after handing Excalidraw `resize` when its record is stale. */
  | { kind: 'fit'; resize: FitRecord | null };

/** Frames a fit waits for the box to stop moving before it fits anyway (~2 s at 60 fps). */
export const FIT_MAX_SETTLE_FRAMES = 120;

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

export function sameBox(a: FitBox, b: FitBox): boolean {
  return near(a.width, b.width) && near(a.height, b.height) && near(a.left, b.left) && near(a.top, b.top);
}

/**
 * One frame of a fit. `prev` is the box the previous frame saw (null on the first frame, so
 * every fit compares two frames before it trusts the box); `frames` how many it has waited.
 */
export function planFit(prev: FitBox | null, now: FitBox, record: FitRecord, frames: number): FitStep {
  if (!(now.width >= 1 && now.height >= 1)) return { kind: 'hidden' };
  if ((!prev || !sameBox(prev, now)) && frames < FIT_MAX_SETTLE_FRAMES) return { kind: 'settling' };
  const stale = !near(record.width, now.width) || !near(record.height, now.height)
    || !near(record.offsetLeft, now.left) || !near(record.offsetTop, now.top);
  return {
    kind: 'fit',
    resize: stale ? { width: now.width, height: now.height, offsetLeft: now.left, offsetTop: now.top } : null,
  };
}

// ── A whiteboard drawn read-only (a stage card, the chat, full screen) ─────────────────────

const WHITEBOARD_PATH = /^_dream_context\/whiteboards\/([a-z0-9][a-z0-9-]{0,80})\/\1\.excalidraw\.md$/;

/**
 * The whiteboard slug a board path names (`_dream_context/whiteboards/<slug>/<slug>.excalidraw.md`),
 * or null for any other board. A whiteboard is not an Obsidian board: its pictures live beside
 * it in `files/` (served by `/whiteboards/<slug>/files/<id>`, never listed under `## Embedded
 * Files`), and its widgets are embeddables only the whiteboard's widget renderer can draw. A
 * card that reads it as a plain board shows every picture and widget blank.
 */
export function whiteboardSlugOf(path: string): string | null {
  const m = WHITEBOARD_PATH.exec(path.replace(/^\.\//, ''));
  return m ? m[1]! : null;
}

interface PictureLike {
  type?: unknown;
  isDeleted?: unknown;
  fileId?: unknown;
}

/** A picture as the board's own route returns it. */
export interface BoardPictureFile { id: string; mimeType: string; dataURL: string }

/**
 * A whiteboard's pictures for a read-only draw: every picture the scene names but does not
 * carry, fetched by id (the Whiteboards page's own route, `/whiteboards/<slug>/files/<id>`).
 * One that fails is left out; the board still draws.
 */
export async function loadWhiteboardPictures(
  content: string,
  download: (id: string) => Promise<BoardPictureFile>,
): Promise<Record<string, { mimeType: string; dataURL: string }>> {
  const scene = extractExcalidrawScene(content);
  const ids = scene ? missingPictureIds(scene.elements, scene.files ?? undefined) : [];
  const got = await Promise.allSettled(ids.map((id) => download(id)));
  const files: Record<string, { mimeType: string; dataURL: string }> = {};
  for (const r of got) if (r.status === 'fulfilled') files[r.value.id] = { mimeType: r.value.mimeType, dataURL: r.value.dataURL };
  return files;
}

/** The file ids of the live pictures a scene draws whose bytes it does not carry, each once. */
export function missingPictureIds(elements: readonly unknown[], files: Record<string, unknown> | undefined): string[] {
  const ids = new Set<string>();
  for (const raw of elements) {
    const el = raw as PictureLike | null;
    if (!el || el.type !== 'image' || el.isDeleted === true) continue;
    if (typeof el.fileId !== 'string' || !el.fileId || files?.[el.fileId]) continue;
    ids.add(el.fileId);
  }
  return [...ids];
}
