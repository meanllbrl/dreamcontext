import { useEffect, useReducer, useState } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession, PendingQuestion } from '../chatSession';
import { SurveyCard, SurveyReceipt, type SurveyHost } from '../chat/SurveyCard';
import { useSuperQuestions } from './superJobsStore';
import {
  askPendingOf, cardState, childQuestionOf, parseSuperAnswer, sendToSuper, superAnswerText, superUnclearText,
  type AskRef,
} from './superQuestions';

/**
 * The Super Agent's question in its chat: the chat's OWN AskUserQuestion card (`SurveyCard`),
 * not a look-alike (owner 2026-10-22, superQuestions.ts). Same context strip, question, why line,
 * lettered options with descriptions, preview board, several picks, swipe deck, the note field,
 * "Unclear — ask again", paging, keys. What differs is only where the answer goes (`SurveyHost`):
 *
 *   • its own `super ask` → ONE message into the super chat (`superAnswerText`), a running turn
 *     steered; nothing waits on it, the super's turn ended when it asked;
 *   • a child's question it escalated → the child's own session, exactly as the child's card
 *     would; a child not in this window → the super, told to pass it on.
 *
 * A card shows while its item is open on the record; once answered it leaves, like any answered
 * question, and the answer stands in the transcript as the card's receipt (`SuperAnswerReceipt`).
 * A send that wrote nothing remounts the card, so it can be answered again.
 */
export function SuperQuestionCard({ ask, session }: {
  ask: AskRef & { live: boolean };
  /** The super chat this card is drawn in. */
  session: ChatSession;
}) {
  const view = useSuperQuestions(session.claudeId);
  if (cardState(ask.item, ask.live, view) !== 'open' || !view) return null;
  const item = view.open.find((q) => q.id === ask.item);
  if (!item) return null;
  return (
    <OpenQuestion
      item={item}
      superSession={view.superSession ?? session}
      child={item.kind === 'question' ? view.sessionFor(item.sessionId) : undefined}
    />
  );
}

function OpenQuestion({ item, superSession, child }: {
  item: SuperQueueItem;
  superSession: ChatSession;
  child: ChatSession | undefined;
}) {
  // A child's pending question is what its card is: follow it.
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (child ? child.subscribe(() => force()) : undefined), [child]);
  /** Bumped when a send to the super wrote nothing: a fresh card, answerable again. */
  const [attempt, setAttempt] = useState(0);

  const own = childQuestionOf(item, child);
  const wrap = (card: React.ReactNode) => (
    <div data-testid="super-question-card" data-state="open" data-item={item.id} data-kind={item.kind}>
      {card}
    </div>
  );

  if (own && child && child.status === 'open') {
    // The child's own AskUserQuestion, answered through the child's own session. The super's
    // words lead as the context strip when the child gave none.
    const pending: PendingQuestion = own.title || !item.ownerText ? own : { ...own, title: item.ownerText };
    return wrap(<SurveyCard key={own.requestId} item={pending} session={child} />);
  }
  // The child is here but no longer asks this (its answer just went out; the record follows):
  // nothing to draw, never a second way to answer it.
  if (item.kind === 'question' && child) return null;

  const pending: PendingQuestion = item.kind === 'ask'
    ? askPendingOf(item)
    : { kind: 'question', requestId: item.id, toolName: 'AskUserQuestion', questions: [{ question: item.ownerText ?? '', options: [], kind: 'text' }] };
  const send = (text: string) => {
    if (!sendToSuper(superSession, text)) setAttempt((a) => a + 1);
  };
  const host: SurveyHost = {
    answerQuestion: (_requestId, questions, picked, notes) => send(superAnswerText(item, questions, picked, notes)),
    answer: (_requestId, opts) => send(superUnclearText(item, opts.message ?? '')),
  };
  return wrap(<SurveyCard key={`${item.id}:${attempt}`} item={pending} session={host} />);
}

/**
 * Every OPEN question whose asking call is not drawn above (folded into an event line, behind
 * "Show earlier messages", compacted away, or asked in a way the transcript cannot read): at the
 * chat's end, so the question is always in the chat.
 */
export function SuperQuestionTail({ session, anchored }: {
  session: ChatSession;
  /** The item ids that already have a live card in the rendered transcript. */
  anchored: ReadonlySet<string>;
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
          ask={{ item: q.id, kind: q.kind === 'ask' ? 'ask' : 'question', toolItemId: '', live: true }}
          session={session}
        />
      ))}
    </>
  );
}

/** The owner's answer to a question card, where it sits in the super chat: the card's own
 *  receipt ("You chose: …"), never a bubble he seems to have typed. Null for any other text. */
export function SuperAnswerReceipt({ text, itemId }: { text: string; itemId?: string }) {
  const answer = parseSuperAnswer(text);
  if (!answer) return null;
  return (
    <div data-testid="super-answer-receipt" data-item={answer.item} data-item-id={itemId}>
      <SurveyReceipt unclear={answer.unclear} values={answer.values} />
    </div>
  );
}
