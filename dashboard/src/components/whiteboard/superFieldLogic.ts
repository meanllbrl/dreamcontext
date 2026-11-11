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
