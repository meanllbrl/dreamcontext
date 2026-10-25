import { useI18n } from '../../../context/I18nContext';
import { agendaAboutStrip, type AgendaAbout } from '../super/superHandover';
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

/** "Page: Tasks · Current Version" under a message the dock sent from that page (owner
 *  2026-10-25): the `[On page …]` block it ends with, drawn, never shown raw. */
export function PageStrip({ label, text }: { label: string; text: string }) {
  return (
    <div className="chat-msg-about chat-msg-about--page" data-testid="chat-msg-page">
      <span className="chat-msg-about-glyph" aria-hidden>⌖</span>
      <span className="chat-msg-about-label">{label}:</span>
      <span className="chat-msg-about-text" title={text}>{text}</span>
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
