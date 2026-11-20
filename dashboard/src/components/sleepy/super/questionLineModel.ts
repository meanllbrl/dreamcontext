import type { SuperQueueItem } from '../../../lib/superTypes';
import { askSpecOf } from './superQuestions';

/** The pure half of SuperQuestionLine.tsx: what the line says and when a card counts as seen. */

/** One line of the question: its card title, else its first question, else the record's text. */
export function lineTextOf(item: Pick<SuperQueueItem, 'ask' | 'ownerText' | 'options'>): string {
  const spec = askSpecOf(item);
  const raw = spec.title || spec.questions[0]?.question || item.ownerText || '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** How much of a card must show before it counts as on screen: its whole when it is short. */
const SEEN_PX = 40;

/** Whether a card's box shows enough of itself inside the scroller's box. */
export function cardInView(card: { top: number; bottom: number }, view: { top: number; bottom: number }): boolean {
  const shown = Math.min(card.bottom, view.bottom) - Math.max(card.top, view.top);
  return shown >= Math.min(SEEN_PX, Math.max(1, card.bottom - card.top));
}
