import type { WidgetPayload } from '../../../lib/whiteboardWidgets';
import type { SuperOpenBody } from './superApi';

/**
 * The stage's add menu, its pure half (`SuperAddMenu.tsx` draws it). Three small questions: what a
 * picker's pick asks the server to open, which sentence a refusal reads as, and where the menu fits.
 */

/** The menu's box, from `.wb-palette`: width and the tallest it grows. */
export const MENU_WIDTH = 280;
export const MENU_HEIGHT = 380;
/** Never closer to the stage's edge than this. */
export const MENU_EDGE = 8;

/** A picker's payload as the owner's open, or null for a kind the owner does not open here. */
export function payloadToOpen(p: WidgetPayload): SuperOpenBody | null {
  if (p.kind === 'web') return p.url ? { kind: 'web', ref: p.url } : null;
  if ((p.kind === 'knowledge' || p.kind === 'task' || p.kind === 'insight') && p.ref) return { kind: p.kind, ref: p.ref };
  return null;
}

/** A knowledge row as the owner's open. The page list answers a slug it cannot write as a page ref
 *  (`archive/2.memory-2026-08`) by its project path; a knowledge card names the slug the agent
 *  would, and a board kept in knowledge opens as the file it is. */
export function knowledgeOpen(ref: string): SuperOpenBody {
  const slug = /^_dream_context\/knowledge\/(.+)\.md$/.exec(ref)?.[1];
  if (!slug) return { kind: 'knowledge', ref };
  return slug.endsWith('.excalidraw') ? { path: ref } : { kind: 'knowledge', ref: slug };
}

const FILE_REFUSALS = new Set(['outside_project', 'unknown_file', 'not_a_file', 'unsupported_file', 'file_name_space']);

/** The sentence for a refusal's code. Every other code, a 500 and a lost connection read the same:
 *  the server's `message` is English prose for agents and is never shown. */
export function refusalKey(code: unknown): string {
  if (code === 'stage_full') return 'super.add.full.stage';
  if (code === 'record_full') return 'super.add.full.record';
  if (typeof code === 'string' && FILE_REFUSALS.has(code)) return `super.add.file.${code}`;
  return 'super.add.refused';
}

/** The menu's place in the stage for a press at `at`, and how tall it may be there: it opens beside
 *  the press and is kept inside the stage, however small the window. */
export function clampMenu(at: { x: number; y: number }, stage: { width: number; height: number }): { left: number; top: number; width: number; maxHeight: number } {
  const width = Math.max(0, Math.min(MENU_WIDTH, stage.width - 2 * MENU_EDGE));
  const maxHeight = Math.max(0, Math.min(MENU_HEIGHT, stage.height - 2 * MENU_EDGE));
  const inside = (v: number, size: number, room: number) => Math.max(MENU_EDGE, Math.min(v, room - size - MENU_EDGE));
  return { left: inside(at.x, width, stage.width), top: inside(at.y, maxHeight, stage.height), width, maxHeight };
}
