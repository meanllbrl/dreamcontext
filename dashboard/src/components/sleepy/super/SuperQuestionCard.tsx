import { useEffect, useReducer, useState } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession, PendingQuestion } from '../chatSession';
import { ALREADY_ANSWERED_MESSAGE } from '../chat/surveyAnswers';
import { SurveyCard, SurveyReceipt, type SurveyHost, type SurveyRead } from '../chat/SurveyCard';
import { useSuperQuestions, type SuperRemoteQuestions } from './superJobsStore';
import { OwnerCardSlot } from './OwnerCardSlot';
import { ownerCardItemsOf, placeOwnerCards } from './cardPlacement';
import { surveyDraftKey } from '../chat/surveyDrafts';
import { RemotePermission } from './SuperPermissionCard';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { requestOpenAgents } from '../../../lib/openAgents';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { CardHeader } from '../chat/molecules';
import { GrantDecision } from '../chat/RefusalCard';
import '../chat/AgentThreadCard.css';
import {
  MAIN_RECORD, allowAnswer, allowedWaiting, callOf, declineAnswer, grantChoices, oneChoiceQuestion, rewriteAnswer, ownerRowKind, questionAnswer, useOwnerAnswer, visibleText,
} from './ownerAnswer';
import {
  askPendingOf, askQuestionsOf, cardState, childQuestionOf, memberItemText, parseSuperAnswer, sendToSuper, superAnswerText, superUnclearText, superAlreadyText,
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
      reads={item.kind === 'ask' ? view.readsOf?.(item) : undefined}
    />
  );
}

function OpenQuestion({ item, superSession, child, remote, reads }: {
  item: SuperQueueItem;
  superSession: ChatSession;
  child: ChatSession | undefined;
  remote?: SuperRemoteQuestions;
  /** Its report cards on the stage ("To read: <card> →"). */
  reads?: SurveyRead[];
}) {
  // A child's permission that waits for him, on a surface without the child's socket (the
  // hands-free phone): Allow / Deny through the Mac window. On the laptop the child's own tab and
  // the bar answer it: nothing is drawn here.
  if (item.kind === 'permission') {
    const perm = remote?.permissionOf?.(item.id) ?? null;
    return perm && remote?.answerPermission ? <RemotePermission item={item} perm={perm} answer={remote.answerPermission} /> : null;
  }
  return <OpenAsk item={item} superSession={superSession} child={child} remote={remote} reads={reads} />;
}

function OpenAsk({ item, superSession, child, remote, reads }: {
  item: SuperQueueItem;
  superSession: ChatSession;
  child: ChatSession | undefined;
  remote?: SuperRemoteQuestions;
  reads?: SurveyRead[];
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
    answer: (_requestId, opts) => { send(opts.message === ALREADY_ANSWERED_MESSAGE ? superAlreadyText(item) : superUnclearText(item, opts.message ?? '')); return true; },
  };
  return wrap(<SurveyCard key={`${item.id}:${attempt}`} item={pending} session={host} reads={reads} />);
}

const NONE_PLACED: ReadonlySet<string> = new Set();

/**
 * Every OPEN question, owner card or member wait with NO place on screen: neither its asking call
 * nor any drawn item from before it was asked is in the transcript (behind "Show earlier
 * messages", or before any message at all). At the chat's end, so a wait is never lost. One that
 * has a place is drawn there by time (cardPlacement.ts), never here: the tail sits under his
 * later messages, and a question asked before them must stay above them (owner 2026-11-15).
 */
export function SuperQuestionTail({ session, anchored, placedCards = NONE_PLACED }: {
  session: ChatSession;
  /** The question ids that already have a live card in the rendered transcript (at their call or
   *  by time). */
  anchored: ReadonlySet<string>;
  /** The owner-card and member-wait items drawn in their place in the transcript
   *  (cardPlacement.ts); none = every waiting one has no place on screen. */
  placedCards?: ReadonlySet<string>;
}) {
  const view = useSuperQuestions(session.claudeId);
  if (!view) return null;
  const rest = view.open.filter((q) => !anchored.has(q.id));
  // An owner card (a child's, or a member's mirror carrying one) is drawn in its place in the
  // transcript (cardPlacement.ts). Here only one that still waits on the owner and has no place on
  // screen (posted behind "Show earlier messages"), so the wait is never lost.
  const waiting = new Set(placeOwnerCards(ownerCardItemsOf(view)).tail.filter((q) => !placedCards.has(q.id)).map((q) => q.id));
  const members = (view.members ?? []).filter((q) => (q.card ? waiting.has(q.id) : !placedCards.has(q.id)));
  const cards = (view.cards ?? []).filter((q) => waiting.has(q.id));
  if (!rest.length && !members.length && !cards.length) return null;
  return (
    <>
      {rest.map((q) => (
        <SuperQuestionCard
          key={`tail-${q.id}`}
          ask={{ item: q.id, kind: q.kind === 'ask' ? 'ask' : 'question', toolItemId: '', live: true }}
          session={session}
        />
      ))}
      {cards.map((q) => (
        <OwnerCardSlot
          key={`card-${q.id}`}
          item={q}
          title={view.titleFor?.(q.sessionId) || q.ownerText || ''}
          paused={!!view.pausedFor?.(q.sessionId)}
        />
      ))}
      {members.map((q) => <MemberWaitCard key={`member-${q.id}`} item={q} paused={!!view.pausedFor?.(q.sessionId)} />)}
    </>
  );
}

/**
 * An AI Team member waiting on the owner (owner 2026-11-10: "üyenin izni kimseye düşmüyor"), as
 * main's record mirrors it, answered IN PLACE (uye-bildirim K11, drawing B1/B2): a question's
 * options (and, for its own question to him, his words), a permission's or a refused command's
 * sizes with the whole command, a stalled job's Not needed. Whatever this window cannot decide
 * (no owner key, the member's window closed, a command it cannot show whole, a card only the
 * member's page draws) is one Open button that brings the member's page, as before.
 * Leaves the chat when the member's item closes, wherever it was answered (Telegram, its page).
 */
export function MemberWaitCard({ item, paused = false }: { item: SuperQueueItem; paused?: boolean }) {
  const slug = item.member ?? '';
  const agent = useAgent(slug || null).data?.agent;
  const name = agent?.title || slug;
  // A member's child left a card (K7): the slot draws it from the record the mirror carries.
  if (item.card) return <OwnerCardSlot item={item} title={name} paused={paused} />;
  return <MemberWaitBody item={item} name={name} slug={slug} hasPhoto={agent?.hasPhoto ?? false} />;
}

/**
 * One member's question drawn as `SurveyCard`, the very card every other question uses. Its answer
 * goes through the owner-answer route: options and notes as AskUserQuestion's answers, his own
 * words (a free-text ask) or "Unclear" as his words to the member's Super.
 */
function MemberAskCard({ item, name, slug, hasPhoto, answer, open }: {
  item: SuperQueueItem; name: string; slug: string; hasPhoto: boolean;
  answer: ReturnType<typeof useOwnerAnswer>;
  open: () => void;
}) {
  const { t } = useI18n();
  const pending: PendingQuestion = item.ask || item.options?.length
    ? askPendingOf(item)
    : { kind: 'question', requestId: item.id, toolName: 'AskUserQuestion', questions: [{ question: item.ownerText ?? '', options: [], kind: 'text' }] };
  const host: SurveyHost = {
    answerQuestion: (_requestId, questions, picked, notes) => {
      const text = questions.length === 1 && questions[0].kind === 'text' ? picked[questions[0].question]?.trim() : '';
      if (text) { answer.submit({ kind: 'ask', text }); return true; }
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const pick = picked[q.question]?.trim() || '';
        const note = notes?.[q.question]?.trim();
        answers[q.question] = [pick, note].filter(Boolean).join(' - ') || '(no answer)';
      }
      answer.submit({ kind: 'question', answers });
      return true;
    },
    answer: (_requestId, opts) => { answer.submit({ kind: 'ask', text: opts.message || '' }); return true; },
  };
  return (
    <div className="chat-memberask" data-testid="super-member-card" data-item={item.id} data-member={slug} data-of={item.of} data-row="question">
      <div className="chat-memberask-head">
        <AgentAvatar slug={slug} title={name} hasPhoto={hasPhoto} size={18} />
        <span className="chat-memberask-name">{name}</span>
        <span className="chat-memberask-says">{t('super.queue.memberAsks')}</span>
        <button type="button" className="chat-memberask-open" data-testid="super-member-open" disabled={!slug} onClick={open}>{t('owner.answer.open')}</button>
      </div>
      <SurveyCard key={item.id} item={pending} session={host} draftKey={surveyDraftKey(MAIN_RECORD, item.id)} />
      {answer.note && <p className="chat-agentthread-note" data-testid="super-member-note">{t(answer.note)}</p>}
    </div>
  );
}

function MemberWaitBody({ item, name, slug, hasPhoto }: { item: SuperQueueItem; name: string; slug: string; hasPhoto: boolean }) {
  const { t } = useI18n();
  const row = ownerRowKind(item);
  // Member mirrors are drawn in MAIN's chat only (SuperQuestionView.members): main's record.
  const answer = useOwnerAnswer(MAIN_RECORD, item, 'chat');
  const [reply, setReply] = useState('');
  const questions = item.ask ? askQuestionsOf(item.ask) : [];
  const call = callOf(item);
  const choices = grantChoices(item, call, MAIN_RECORD);
  const open = () => requestOpenAgents({ slug });
  const live = !answer.fallback;
  // Already allowed, waiting for its chat to open: the line and Open, never a second Allow.
  const allowed = allowedWaiting(item) && (row === 'permission' || row === 'refusal');
  const grant = live && !allowed && (row === 'permission' || row === 'refusal') && !!call;
  const one = live && row === 'question' ? oneChoiceQuestion(item) : null;
  // A member's question to him is the chat's own AskUserQuestion card (owner 2026-11-18: the
  // hand-drawn one was ugly): who asks and Open on one small line, the card below answers.
  if (live && !allowed && row === 'question' && (item.of === 'ask' || (one && item.ask))) {
    return <MemberAskCard item={item} name={name} slug={slug} hasPhoto={hasPhoto} answer={answer} open={open} />;
  }
  const title = row === 'refusal' ? 'owner.answer.refusedTitle' : item.of === 'permission' ? 'super.queue.memberCardPermission' : 'super.queue.memberCard';
  return (
    <div className="chat-viewcard chat-agentthread" data-testid="super-member-card" data-item={item.id} data-member={slug} data-of={item.of} data-row={row}>
      <CardHeader
        glyph={<AgentAvatar slug={slug} title={name} hasPhoto={hasPhoto} size={22} />}
        title={t(title).replace('{name}', name)}
      />
      {allowed ? (
        <>
          {call && <pre className="chat-agentthread-note" data-testid="super-member-command">{visibleText(call.input, true)}</pre>}
          <p className="chat-agentthread-note" data-testid="super-member-allowed">{t('owner.answer.allowedWaiting')}</p>
        </>
      ) : grant && call ? (
        <GrantDecision
          kind={row === 'refusal' ? 'refusal' : 'permission'}
          call={call}
          choices={choices}
          words={{ lead: t(row === 'refusal' ? 'owner.answer.refusedLead' : 'owner.answer.permissionLead').replace('{name}', name), memberName: name }}
          busy={answer.busy}
          onAllow={(size) => answer.submit(allowAnswer(row === 'refusal' ? 'refusal' : 'permission', size))}
          onDecline={() => answer.submit(declineAnswer(row))}
          onRewrite={() => answer.submit(rewriteAnswer())}
          onOpen={open}
        />
      ) : questions.length
        ? questions.map((q, i) => (
          <div key={i} className="chat-agentthread-note">
            <strong>{q.question}</strong>
            {/* A single-choice question is answered by its option; anything richer is read here. */}
            {!one && q.options && q.options.length > 0 && <ul>{q.options.map((o, j) => <li key={j}>{o.label}</li>)}</ul>}
          </div>
        ))
        // Its own words when it has some; a permission's are the child's request, drawn on its page.
        : item.ownerText
          ? <p className="chat-agentthread-note">{row === 'stalled' ? t('owner.answer.stalled').replace('{text}', visibleText(item.ownerText)) : memberItemText(item, t)}</p>
          : null}
      {live && item.of === 'ask' && (
        // The member's own question to him: his words go into the member's Super as his (K5).
        <textarea
          className="chat-agentthread-note"
          data-testid="super-member-reply"
          rows={2}
          value={reply}
          placeholder={t('owner.answer.replyPlaceholder')}
          aria-label={t('owner.answer.reply')}
          onChange={(e) => setReply(e.target.value)}
          disabled={answer.busy}
        />
      )}
      {!grant && (
        <div className="chat-agentthread-actions">
          {one && one.options.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`chat-agentthread-btn${i === 0 ? ' is-primary' : ''}`}
              data-testid="super-member-option"
              disabled={answer.busy}
              onClick={() => answer.submit(questionAnswer(one.question, label))}
            >{label}</button>
          ))}
          {live && item.of === 'ask' && (
            <button
              type="button"
              className="chat-agentthread-btn"
              data-testid="super-member-send"
              disabled={answer.busy || !reply.trim()}
              onClick={() => answer.submit({ kind: 'ask', text: reply.trim() })}
            >{t('owner.answer.send')}</button>
          )}
          <button type="button" className={`chat-agentthread-btn${one ? '' : ' is-primary'}`} data-testid="super-member-open" disabled={!slug} onClick={open}>
            {t('owner.answer.open')}
          </button>
          {live && row === 'stalled' && (
            <button type="button" className="chat-agentthread-btn" data-testid="super-member-dismiss" disabled={answer.busy} onClick={() => answer.submit(declineAnswer('stalled'))}>
              {t('owner.answer.notNeeded')}
            </button>
          )}
        </div>
      )}
      {answer.note
        ? <p className="chat-agentthread-note" data-testid="super-member-note">{t(answer.note)}</p>
        : !grant && !allowed && !one && item.of !== 'ask' && row !== 'stalled' && <p className="chat-agentthread-note">{t('super.queue.memberCardNote')}</p>}
    </div>
  );
}

/** The owner's answer to a question card, where it sits in the super chat: the card's own
 *  receipt ("You chose: …"), never a bubble he seems to have typed. Null for any other text. */
export function SuperAnswerReceipt({ text, itemId }: { text: string; itemId?: string }) {
  const answer = parseSuperAnswer(text);
  if (!answer) return null;
  return (
    <div data-testid="super-answer-receipt" data-item={answer.item} data-item-id={itemId}>
      <SurveyReceipt unclear={answer.unclear} already={answer.already} values={answer.values} />
    </div>
  );
}
