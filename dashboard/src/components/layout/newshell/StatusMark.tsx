import type { RowMark } from './drawerModel';
import './StatusMark.css';

/**
 * A drawer row's ONE end mark (option A, owner 2026-11-09), in the order of what the owner must
 * do: something waits on the owner (a question, an approval) = a filled red count, and the row
 * itself takes the asking look (`askRow`); work running = a small grey spinner; a reply not read
 * yet = a grey count; idle = nothing. The words live on the row (its title and aria-label), so the
 * mark itself is hidden from a reader.
 */
export type MarkState = RowMark;

export const NO_MARK: MarkState = { asking: 0, working: false, unread: 0 };

export function StatusMark({ asking, working, unread }: MarkState) {
  if (asking > 0) return <span className="ns-mark ns-mark--ask" data-testid="mark-asking" aria-hidden="true">{asking}</span>;
  if (working) return <span className="ns-mark-spin" data-testid="mark-working" aria-hidden="true" />;
  if (unread > 0) return <span className="ns-mark ns-mark--unread" data-testid="mark-unread" aria-hidden="true">{unread}</span>;
  return null;
}

/** The attribute that gives a row the asking look (V2: soft red wash, red bar, semibold name). */
export const askRow = (asking: number | boolean): { 'data-ask-row'?: 'true' } => (asking ? { 'data-ask-row': 'true' } : {});

/** The mark in words, for a row's tooltip and its screen-reader label: the ONE place a row says
 *  what waits on the owner by kind (questions, approvals, the rest as plain waiting), so a row with
 *  only an approval never says "asks". */
export function markWords(t: (key: string) => string, m: MarkState): string {
  const questions = Math.max(0, Math.min(m.asking, m.questions ?? 0));
  const approvals = Math.max(0, Math.min(m.asking - questions, m.approvals ?? 0));
  const rest = m.asking - questions - approvals;
  const say = (key: string, n: number) => (n > 0 ? t(key).replace('{n}', String(n)) : '');
  return [
    say('drawer.mark.questions', questions),
    say('drawer.mark.approvals', approvals),
    say('drawer.mark.waiting', rest),
    m.working ? t('drawer.mark.working') : '',
    m.unread > 0 ? t('super.unread.count').replace('{n}', String(m.unread)) : '',
  ].filter(Boolean).join(', ');
}
