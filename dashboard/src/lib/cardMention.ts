/**
 * A stage card named in an owner message (owner 2026-10-31: a card dropped on the Super chat is a
 * chip, in the composer and in the sent bubble, never the raw `@card:<id> “<title>”`).
 *
 * The WIRE is unchanged: the Super Agent still reads `@card:<id> “<title>”` (briefing O11). Only
 * the window draws it. React-free and DOM-free, so root vitest loads it directly.
 */
import type { ContainerKind } from './superTypes';

/** The longest card title an `@card` reference carries (§0 C-minors). */
export const CARD_REF_TITLE_MAX = 60;

/** A card kind's glyph: the stage's tiles and headers, and a card chip's room. */
export const KIND_GLYPH: Record<ContainerKind, string> = {
  chat: '◆', insight: '◔', task: '☐', knowledge: '¶', whiteboard: '▦', board: '▦', web: '◎', image: '▣', pdf: '▥', video: '▶', browser: '◉', team: '◈', agenda: '☰',
};
/** A group of cards (a group's tile on the stage). */
export const GROUP_GLYPH = '▤';
/** A card whose kind is not known here (gone from the stage, or no stage in this window). */
export const UNKNOWN_CARD_GLYPH = '▢';

/** The glyph a card chip wears: its kind's, a group's, or the neutral one. */
export function cardGlyph(kind: string | undefined): string {
  if (kind === 'group') return GROUP_GLYPH;
  return (kind && (KIND_GLYPH as Record<string, string>)[kind]) || UNKNOWN_CARD_GLYPH;
}

/** A card title as the wire carries it: one line, no control characters or quotes, clipped. */
export function cleanCardTitle(title: string): string {
  const clean = (title ?? '').replace(/[\u0000-\u001f\u007f“”"]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > CARD_REF_TITLE_MAX ? `${clean.slice(0, CARD_REF_TITLE_MAX - 1).trimEnd()}…` : clean;
}

/** The exact words a card stands for in a message: `@card:<id> “<title>”` (no edge spaces). */
export function cardMentionText(id: string, title: string): string {
  return `@card:${id} “${cleanCardTitle(title)}”`;
}

/** One card named in a text: where, which card, and the title it was sent with (may be ''). */
export interface CardMention { start: number; end: number; id: string; title: string }

const MENTION_RE = /@card:([A-Za-z0-9_-]{1,64})(?: “([^“”\n]*)”)?/g;
/** Where a `@card:` is part of a block header, not a mention he wrote (`[About card @card:…]`,
 *  a picked element's `[Selected element on card @card:…]`): drawn by their own strips. */
const HEADER_BEFORE_RE = /\[(?:About card|Selected element on card) $/;

/** Every card mention in `text`, in order (headers excluded). */
export function cardMentions(text: string): CardMention[] {
  const out: CardMention[] = [];
  if (typeof text !== 'string' || !text.includes('@card:')) return out;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    // A word character before it: part of something else (an e-mail-like `x@card:`).
    if (start > 0 && /[\w@]/.test(text[start - 1])) continue;
    if (HEADER_BEFORE_RE.test(text.slice(Math.max(0, start - 32), start))) continue;
    out.push({ start, end: start + m[0].length, id: m[1], title: (m[2] ?? '').trim() });
  }
  return out;
}
