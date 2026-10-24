import { useI18n } from '../../../context/I18nContext';
import { agendaAboutStrip, type AgendaAbout } from '../super/superHandover';
import type { ReplyHead } from './replyLinks';
import { useSuperEventContext, useSuperQuestions } from '../super/superJobsStore';

/** "About: <the agenda line>" above a message written about it. A question names whose it is
 *  only while the live record still has it open. */
export function AgendaAboutStrip({ about, superSid }: { about: AgendaAbout; superSid: string | null }) {
  const { t } = useI18n();
  const view = useSuperQuestions(about.kind === 'item' ? superSid : null);
  const ctx = useSuperEventContext(about.kind === 'item' ? superSid : null);
  const strip = agendaAboutStrip(about, view?.open ?? [], (sid) => ctx?.titleFor(sid) ?? '', {
    about: t('super.agenda.about'), question: t('super.agenda.aboutQuestion'),
    superQuestion: t('super.agenda.aboutSuperQuestion'), aQuestion: t('super.agenda.aboutAQuestion'),
  });
  return (
    <div className="chat-msg-about" data-testid="chat-msg-about" data-kind={about.kind}>
      <span className="chat-msg-about-dot" aria-hidden />
      <span className="chat-msg-about-label">{strip.label}</span>
      <span className="chat-msg-about-text" title={strip.text}>{strip.text}</span>
    </div>
  );
}

/**
 * The reply variant (owner 2026-10-23): "↩ To Super: <quote>" above his reply, or "↩ Your
 * message: <quote>" above a Super answer group. The same strip, a ↩ where the dot is; a click
 * scrolls to the message it names. One line, the quote clipped.
 */
export function ReplyStrip({ label, quotes, onJump }: { label: string; quotes: readonly string[]; onJump?: () => void }) {
  const text = quotes.join(' · ');
  const body = (
    <>
      <span className="chat-msg-about-glyph" aria-hidden>↩</span>
      <span className="chat-msg-about-label">{label}</span>
      <span className="chat-msg-about-text" title={text}>{text}</span>
    </>
  );
  return onJump
    ? <button type="button" className="chat-msg-about chat-msg-about--reply" data-testid="chat-msg-reply" onClick={onJump}>{body}</button>
    : <div className="chat-msg-about chat-msg-about--reply" data-testid="chat-msg-reply">{body}</div>;
}

/**
 * The head a section of one Super reply opens with (owner 2026-10-24, pick A): the chip of the
 * message that part answers, inside the answer's own body. About variant: the dot, "About" and
 * the agenda line (the same hooks as {@link AgendaAboutStrip}), then his words; reply variant:
 * ↩ "To your message" + his words. One line, clipped; a click lands on that message.
 * `data-reply-head` keeps it out of the spoken highlight.
 */
export function ReplySectionHead({ head, superSid, onReplyTarget }: {
  head: ReplyHead;
  superSid: string | null;
  onReplyTarget?: (targetId: string) => void;
}) {
  const { t } = useI18n();
  const about = head.kind === 'about' ? head.about ?? null : null;
  const view = useSuperQuestions(about?.kind === 'item' ? superSid : null);
  const ctx = useSuperEventContext(about?.kind === 'item' ? superSid : null);
  const quotes = head.quotes.filter(Boolean).join(' · ');
  const strip = about
    ? agendaAboutStrip(about, view?.open ?? [], (sid) => ctx?.titleFor(sid) ?? '', {
      about: t('super.agenda.about'), question: t('super.agenda.aboutQuestion'),
      superQuestion: t('super.agenda.aboutSuperQuestion'), aQuestion: t('super.agenda.aboutAQuestion'),
    })
    : null;
  const label = strip?.label ?? (head.count > 1 ? t('super.reply.nMessages').replace('{n}', String(head.count)) : t('super.reply.yourMessage'));
  const title = strip ? `${strip.text}${quotes ? ` · “${quotes}”` : ''}` : quotes;
  return (
    <button
      type="button"
      className="chat-msg-about chat-reply-head"
      data-reply-head=""
      data-testid="chat-reply-head"
      data-kind={head.kind}
      onClick={() => onReplyTarget?.(head.targetId)}
    >
      {strip
        ? <span className="chat-msg-about-dot" aria-hidden />
        : <span className="chat-msg-about-glyph" aria-hidden>↩</span>}
      <span className="chat-msg-about-label">{label}</span>
      <span className="chat-msg-about-text" title={title}>
        {strip ? strip.text : quotes}
        {strip && quotes && <span className="chat-reply-head-quote"> · “{quotes}”</span>}
      </span>
    </button>
  );
}

