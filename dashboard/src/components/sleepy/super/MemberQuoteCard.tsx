import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { AgentAvatar } from '../../agents/AgentAvatar';
import type { ChatSession } from '../chatSession';
import { jobNameOf, type MemberAnswer } from './memberQuote';
import './MemberQuoteCard.css';

/**
 * An AI Team member's answer in the Super chat (plan super-v3 Ü3, frame T3-sonra): its face,
 * "<name> answered · for <job> · <time>", the answer quoted in two lines, "Read full answer"
 * (opens the quote in place) and "Ask <name>" (a line for him to finish in the composer). Drawn
 * from the server's own event lines (`memberAnswersOf`), never from the Super's prose.
 */
export function MemberQuoteCard({ answer, at, session }: { answer: MemberAnswer; at: number; session: ChatSession }) {
  const { t } = useI18n();
  const agent = useAgent(answer.member).data?.agent;
  const name = agent?.title || answer.member;
  const [open, setOpen] = useState(false);
  const job = jobNameOf(answer.brief);
  const when = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ask = () => {
    session.sendText(t('super.quote.askDraft').replace('{name}', name));
    session.focus();
  };
  return (
    <figure className="super-quote" data-testid="member-quote-card" data-member={answer.member} data-team={answer.team} data-open={open ? '' : undefined}>
      <figcaption className="super-quote-head">
        <AgentAvatar slug={answer.member} title={name} hasPhoto={agent?.hasPhoto ?? false} size={28} />
        <span className="super-quote-who">{t(answer.event === 'done' ? 'super.quote.answered' : 'super.quote.noted').replace('{name}', name)}</span>
        <span className="super-quote-meta">{job ? `· ${t('super.quote.for').replace('{job}', job)} ` : ''}· {when}</span>
      </figcaption>
      <blockquote className="super-quote-text" data-testid="member-quote-text">{answer.answer}</blockquote>
      {open && answer.cut && <p className="super-quote-cut">{t('super.quote.cut')}</p>}
      <div className="super-quote-actions">
        <button type="button" className="super-quote-btn" data-testid="member-quote-read" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t(open ? 'super.quote.less' : 'super.quote.read').replace('{name}', name)}
        </button>
        <button type="button" className="super-quote-btn" data-testid="member-quote-ask" onClick={ask}>
          {t('super.quote.ask').replace('{name}', name)}
        </button>
      </div>
    </figure>
  );
}
