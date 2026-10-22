import { useEffect, useReducer } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatItem, ChatSession } from '../chatSession';
import { useSuperQuestions } from './superJobsStore';
import {
  answerLabelOf, cardState, claimOwnerAnswer, clickedOwnerAnswer, noteOwnerPending, ownerAnswerKey, ownerAnswerLocked,
  ownerOptionsOf, ownerPendingPresent, recordOwnerAnswer, releaseOwnerAnswer, sendOwnerAnswer, useOwnerAnswerVersion,
  type AskRef,
} from './superQuestions';

/**
 * The Super Agent's question as a card in its own chat (superQuestions.ts): under the turn that
 * asked it, its options as buttons, answered where the job bar answers it and through the same
 * latch, so a pick here locks the bar and back. Nothing waits on it: the super's turn is over.
 * Drawn like the chat's own question card (`chat-surveycard`), so it reads as a question to him.
 */
export function SuperQuestionCard({ ask, session, transcript }: {
  ask: AskRef & { live: boolean };
  /** The super chat this card is drawn in (Reply focuses its composer). */
  session: ChatSession;
  /** The whole transcript, read only for an answered card's label. */
  transcript: () => readonly ChatItem[];
}) {
  const { t } = useI18n();
  const view = useSuperQuestions(session.claudeId);
  useOwnerAnswerVersion();
  const state = cardState(ask.item, ask.live, view);
  const item = state === 'open' ? view?.open.find((q) => q.id === ask.item) : undefined;
  const child = item && item.kind === 'question' ? view?.sessionFor(item.sessionId) : undefined;
  // The child's pending question is what its options are drawn from: follow it (as the bar does).
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (child ? child.subscribe(() => force()) : undefined), [child]);
  const text = item?.ownerText || ask.text;

  if (!item || !view) {
    const answer = state === 'answered' ? answerLabelOf(ask, transcript(), clickedOwnerAnswer(ask.item)) : null;
    return (
      <div className="chat-surveycard super-question-card" data-testid="super-question-card" data-state={state} data-item={ask.item} data-kind={ask.kind}>
        <div className="chat-surveycard-head">
          <span className="chat-surveycard-pill"><span aria-hidden>❓</span> {t('super.question.pill')}</span>
        </div>
        {text && <p className="chat-surveycard-title">{text}</p>}
        {answer && (
          <div className="chat-surveycard-receipt" data-testid="super-question-receipt">
            {answer === 'closed'
              ? <span>{t('super.question.closed')}</span>
              : <>
                <span className="chat-surveycard-receipt-check" aria-hidden>✓</span>
                <span>{typeof answer === 'object' ? t('super.question.answered').replace('{label}', () => answer.label) : t('super.question.answeredPlain')}</span>
              </>}
          </div>
        )}
      </div>
    );
  }
  return <OpenQuestion item={item} child={child} open={view.open} superSession={view.superSession ?? session} session={session} text={text} />;
}

function OpenQuestion({ item, child, open, superSession, session, text }: {
  item: SuperQueueItem;
  child: ChatSession | undefined;
  open: readonly SuperQueueItem[];
  superSession: ChatSession;
  session: ChatSession;
  text: string;
}) {
  const { t } = useI18n();
  // Noted first, then read (the latch is silent during a render).
  const key = ownerAnswerKey(item);
  noteOwnerPending(key, ownerPendingPresent(item, child, open));
  const locked = ownerAnswerLocked(key);
  const options = ownerOptionsOf(item, child);
  // The socket the answer rides: the super's own for an `ask`, the child's for its question.
  // Not open (a reconnect after a reload) = nothing to click yet, and the card says to write.
  const carrier = item.kind === 'ask' ? superSession : child;
  const canSend = carrier?.status === 'open';
  const picked = locked ? clickedOwnerAnswer(item.id) : undefined;
  const pick = (label: string) => {
    if (!claimOwnerAnswer(key, item.id, session.claudeId, canSend)) return;
    if (sendOwnerAnswer(item, label, { superSession, child })) recordOwnerAnswer(item.id, label);
    else releaseOwnerAnswer(key);
  };
  return (
    <div className="chat-surveycard super-question-card" data-testid="super-question-card" data-state="open" data-item={item.id} data-kind={item.kind}>
      <div className="chat-surveycard-head">
        <span className="chat-surveycard-pill"><span aria-hidden>❓</span> {t('super.question.pill')}</span>
      </div>
      {text && <p className="chat-surveycard-title">{text}</p>}
      {options.length > 0 && (
        <div className="chat-surveycard-options" role="group" aria-label={text}>
          {options.map((label) => (
            <button
              key={label}
              type="button"
              className={`chat-surveycard-opt${picked === label ? ' on' : ''}`}
              data-testid="super-question-option"
              aria-pressed={picked === label}
              disabled={locked || !canSend}
              onClick={() => pick(label)}
            >
              <span className="chat-surveycard-opt-mark radio" aria-hidden>{picked === label ? '●' : ''}</span>
              <span className="chat-surveycard-opt-body"><span className="chat-surveycard-opt-title">{label}</span></span>
            </button>
          ))}
        </div>
      )}
      <div className="chat-surveycard-actions">
        {(options.length === 0 || locked || !canSend) && <span className="chat-surveycard-count">{t('super.question.writeBelow')}</span>}
        <button type="button" className="chat-surveycard-unclear" data-testid="super-question-reply" onClick={() => session.focus()}>
          {t('super.queue.reply')}
        </button>
      </div>
    </div>
  );
}

/**
 * Every OPEN question whose asking call is not drawn above (folded into an event line, behind
 * "Show earlier messages", compacted away, or asked in a way the transcript cannot read): at the
 * chat's end, so the question is always in the chat.
 */
export function SuperQuestionTail({ session, anchored, transcript }: {
  session: ChatSession;
  /** The item ids that already have a live card in the rendered transcript. */
  anchored: ReadonlySet<string>;
  transcript: () => readonly ChatItem[];
}) {
  const view = useSuperQuestions(session.claudeId);
  if (!view) return null;
  const rest = view.open.filter((q) => !anchored.has(q.id));
  if (!rest.length) return null;
  return (
    <>
      {rest.map((q) => (
        <SuperQuestionCard
          key={`tail-${q.id}`}
          ask={{ item: q.id, kind: q.kind === 'ask' ? 'ask' : 'question', text: q.ownerText ?? '', options: q.options ?? [], toolItemId: '', live: true }}
          session={session}
          transcript={transcript}
        />
      ))}
    </>
  );
}
