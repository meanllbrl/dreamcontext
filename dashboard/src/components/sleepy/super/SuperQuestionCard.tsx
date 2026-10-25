import { useEffect, useReducer, useState } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession, PendingQuestion } from '../chatSession';
import { SurveyCard, SurveyReceipt, type SurveyHost } from '../chat/SurveyCard';
import { useSuperQuestions, type SuperRemoteQuestions } from './superJobsStore';
import { surveyDraftKey } from '../chat/surveyDrafts';
import {
  askPendingOf, askQuestionsOf, cardState, childQuestionOf, parseSuperAnswer, sendToSuper, superAnswerText, superUnclearText,
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
      remote={view.remote}
    />
  );
}

function OpenQuestion({ item, superSession, child, remote }: {
  item: SuperQueueItem;
  superSession: ChatSession;
  child: ChatSession | undefined;
  remote?: SuperRemoteQuestions;
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

  // A surface that holds no child's socket (the hands-free phone): the child's OWN card as the
  // server read it, every question and option, answered through the Mac window into the child's
  // session (owner 2026-10-24: a 4-question card reached the phone with no options at all). Its
  // draft is keyed by the CHILD's request (no chat on the phone settles it; the hook drops it when
  // the question leaves), and no `connected`: the answer rides HTTP, not the mirror's socket.
  const remoteCard = item.kind === 'question' && remote && item.requestId ? remote.cardOf(item.id) : null;
  if (remoteCard && remote && item.requestId) {
    const pending: PendingQuestion = {
      kind: 'question', requestId: item.requestId, toolName: 'AskUserQuestion',
      questions: askQuestionsOf(remoteCard), ...(remoteCard.title ? { title: remoteCard.title } : {}),
    };
    // Written = handed to the route. A refusal brings the card back with its picks (the draft),
    // except a stale one (answered elsewhere meanwhile): the next read takes that card away.
    const post = (body: Parameters<typeof remote.answer>[1]): boolean => {
      void remote.answer(item, body).then((r) => { if (r.retry) setAttempt((a) => a + 1); });
      return true;
    };
    const host: SurveyHost = {
      answerQuestion: (_requestId, _questions, picked, notes) => post({ picked, ...(notes && Object.keys(notes).length ? { notes } : {}) }),
      answer: (_requestId, opts) => post({ unclear: opts.message ?? '' }),
    };
    return wrap(
      <SurveyCard
        key={`${item.id}:${item.requestId}:${attempt}`}
        item={pending}
        session={host}
        draftKey={surveyDraftKey(item.sessionId, item.requestId)}
      />,
    );
  }

  const pending: PendingQuestion = item.kind === 'ask'
    ? askPendingOf(item)
    : { kind: 'question', requestId: item.id, toolName: 'AskUserQuestion', questions: [{ question: item.ownerText ?? '', options: [], kind: 'text' }] };
  const send = (text: string) => {
    if (!sendToSuper(superSession, text)) setAttempt((a) => a + 1);
  };
  // Handed off either way: a refused send re-mounts the card (`attempt`), its own failure path.
  const host: SurveyHost = {
    answerQuestion: (_requestId, questions, picked, notes) => { send(superAnswerText(item, questions, picked, notes)); return true; },
    answer: (_requestId, opts) => { send(superUnclearText(item, opts.message ?? '')); return true; },
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
