import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import { useI18n } from '../../../context/I18nContext';
import { useSuperQuestions } from './superJobsStore';
import { cardInView, lineTextOf } from './questionLineModel';
import { showQuestionCard } from './JobBar';
import './SuperQuestionLine.css';

/**
 * The open question's line above the Super chat's composer (owner 2026-11-17, option C): while a
 * question card waits in the transcript but is not on screen, one thin line names it and
 * "Soruya git" takes the chat to the card, through the same door the agenda's Waiting row uses
 * (`showQuestionCard`). It has no options of its own: the question is asked only on its card
 * (owner 2026-10-22). It never moves the chat by itself (owner 2026-11-13, 2026-11-15): only his
 * press does. It leaves once the card is in view, or the question closes.
 */
export function SuperQuestionLine({ sessionId, scrollRef, hidden }: {
  sessionId: string | null;
  /** An agenda row's thread hides this question's card (ajanda-filtre C4): it counts as away, and
   *  the press ends the filter on its way to the card (`showQuestionCard`'s gate). */
  hidden?: (item: string) => boolean;
  /** The transcript's scroller: the card is "on screen" when it shows inside it. */
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const view = useSuperQuestions(sessionId);
  const open = view?.open ?? NONE;
  const away = useCardsAway(scrollRef, open, hidden);
  const item = open.find((q) => away.includes(q.id));
  const go = useCallback(() => {
    if (item) showQuestionCard(item.id, scrollRef.current);
  }, [item, scrollRef]);
  if (!item) return null;
  const text = lineTextOf(item);
  const more = away.length - 1;
  return (
    <div className="super-qline" data-testid="super-question-line" data-item={item.id}>
      <span className="super-qline-mark" aria-hidden>?</span>
      <span className="super-qline-text" title={text}>{text}</span>
      {more > 0 && <span className="super-qline-more" data-testid="super-question-line-more">+{more}</span>}
      <button type="button" className="super-qline-go" data-testid="super-question-line-go" onClick={go}>
        <span aria-hidden>↑ </span>{t('super.questionLine.go')}
      </button>
    </div>
  );
}

const NONE: readonly SuperQueueItem[] = [];

/**
 * The ids of the open questions whose card is drawn in the transcript but not on screen. A
 * question with no card drawn is not counted: there is nothing to go to. Re-read on scroll, on a
 * size change, and when the transcript's rows change (a card mounting or leaving).
 */
function useCardsAway(scrollRef: RefObject<HTMLElement | null>, open: readonly SuperQueueItem[], hidden?: (item: string) => boolean): string[] {
  const [away, setAway] = useState<string[]>([]);
  const ids = open.map((q) => q.id).join('\n');
  useEffect(() => {
    const scroller = scrollRef.current;
    const wanted = ids ? ids.split('\n') : [];
    if (!scroller || !wanted.length) { setAway((prev) => (prev.length ? [] : prev)); return undefined; }
    let frame = 0;
    const read = () => {
      frame = 0;
      const box = scroller.getBoundingClientRect();
      const next: string[] = [];
      if (box.height > 0) {
        const cards = scroller.querySelectorAll<HTMLElement>('[data-testid="super-question-card"]');
        for (const id of wanted) {
          const card = [...cards].find((el) => el.dataset.item === id);
          if (card ? !cardInView(card.getBoundingClientRect(), box) : !!hidden?.(id)) next.push(id);
        }
      }
      setAway((prev) => (prev.join('\n') === next.join('\n') ? prev : next));
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    scroller.addEventListener('scroll', soon, { passive: true });
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
    sizes?.observe(scroller);
    const rows = typeof MutationObserver === 'function' ? new MutationObserver(soon) : null;
    rows?.observe(scroller, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', soon);
      sizes?.disconnect();
      rows?.disconnect();
    };
  }, [scrollRef, ids, hidden]);
  return away;
}
