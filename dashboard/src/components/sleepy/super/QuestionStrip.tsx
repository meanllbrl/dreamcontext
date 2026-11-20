import { useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { REVEAL_QUESTION_EVENT } from './superQuestions';

const OPEN_CARD = '[data-testid="super-question-card"][data-state="open"]';
const FLASH_MS = 1600;

/** Bring an open question card into view and mark it for a moment (super-v3 D7). */
export function scrollToQuestion(scroller: HTMLElement | null, itemId?: string): boolean {
  if (!scroller) return false;
  const esc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&'));
  const card = itemId
    ? scroller.querySelector<HTMLElement>(`${OPEN_CARD}[data-item="${esc(itemId)}"]`) ?? scroller.querySelector<HTMLElement>(`[data-item="${esc(itemId)}"]`)
    : scroller.querySelector<HTMLElement>(OPEN_CARD);
  if (!card) return false;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.setAttribute('data-revealed', 'true');
  window.setTimeout(() => card.removeAttribute('data-revealed'), FLASH_MS);
  return true;
}

/**
 * The Super chat's one copy of a question (super-v3 D7): a stage card's "Show" (`revealQuestion`)
 * scrolls the chat to that question, and while an open question is scrolled out of view one line
 * over the bottom of the transcript says so: "Claude is waiting on your answer · Go to question".
 * It reads the drawn cards themselves (nothing new in the record), and takes no layout room.
 */
export function QuestionStrip({ scrollRef, enabled }: { scrollRef: { readonly current: HTMLElement | null }; enabled: boolean }) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ itemId?: string }>).detail?.itemId;
      scrollToQuestion(scrollRef.current, typeof id === 'string' ? id : undefined);
    };
    window.addEventListener(REVEAL_QUESTION_EVENT, on);
    return () => window.removeEventListener(REVEAL_QUESTION_EVENT, on);
  }, [enabled, scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!enabled || !scroller) { setHidden(false); return undefined; }
    let frame = 0;
    const check = () => {
      frame = 0;
      const cards = [...scroller.querySelectorAll<HTMLElement>(OPEN_CARD)];
      if (!cards.length) { setHidden(false); return; }
      const box = scroller.getBoundingClientRect();
      const seen = cards.some((c) => { const r = c.getBoundingClientRect(); return r.bottom > box.top + 8 && r.top < box.bottom - 8; });
      setHidden(!seen);
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(check); };
    scroller.addEventListener('scroll', soon, { passive: true });
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(soon) : null;
    mo?.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    check();
    return () => { scroller.removeEventListener('scroll', soon); mo?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [enabled, scrollRef]);

  if (!enabled || !hidden) return null;
  return (
    <div className="super-question-strip" role="status" data-testid="super-question-strip">
      <span className="super-question-strip-dot" aria-hidden />
      <span className="super-question-strip-text">{t('super.question.waiting')}</span>
      <button type="button" className="super-question-strip-go" onClick={() => scrollToQuestion(scrollRef.current)}>{t('super.question.goTo')}</button>
    </div>
  );
}
