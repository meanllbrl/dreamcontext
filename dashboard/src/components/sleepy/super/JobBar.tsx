import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { requestOpenAgents } from '../../../lib/openAgents';
import type { SuperQueueItem, SuperStateView } from '../../../lib/superTypes';
import type { ChatSession, PendingPermission } from '../chatSession';
import {
  optionsFit, permissionSummary, type JobLook, type OptionsFit,
} from './superHandover';
import {
  claimOwnerAnswer, noteOwnerPending, openOwnerQuestions, ownerAnswerKey, ownerAnswerLocked, ownerPendingPresent,
  releaseOwnerAnswer, useOwnerAnswerVersion,
} from './superQuestions';
import type { Rect } from './superLayout';
import { SuperAgentIcon } from '../../layout/NavIcons';
import { cssEsc } from './StageMotion';
import './JobBar.css';

/**
 * The question band (plan r4 D1): the top band above the centre holds ONLY the head of the one
 * question queue below. The counts and the job list it carried are gone: the agenda card on the
 * stage (SuperAgenda.tsx) is the super's own notepad and lists every question waiting on the
 * owner. Nothing here polls: the record is pushed. Empty: nothing is drawn.
 *
 * The ONE question queue (plan-r7 D7, D16, owner decision 2), as a pill centred in the top band
 * directly above the centre window (plan-r8 F7): the owner looks at the centre, so what he must
 * answer sits on its edge. It grows as an overlay anchored to the band (text, options, Reply)
 * and never moves the centre. Empty: nothing is drawn.
 *
 * Only what the OWNER must answer reaches it: a child's permission request (head of the line,
 * at once — the Super Agent never sees it), a question the Super Agent escalated with its
 * own words, or an AI Team member it chose that is not approved here (the server's question: the
 * owner approves it in AI Team, which the Super Agent never can). Everything it answers itself
 * never shows here.
 *
 * A PERMISSION is drawn only from the CHILD's own pending request (tool name and input) and
 * Allow/Deny call that child's own `ChatSession.answer`, exactly what the child's tab card does
 * — no new privileged route, and the Super Agent's words never caption it. The server resolves
 * the item when the child leaves `asking`.
 *
 * A QUESTION (the super's own `ask`, a child's question it escalated) is its words and one
 * Answer button that brings its card in the super chat into view: the chat's own AskUserQuestion
 * card answers it, never a second set of buttons here (owner 2026-10-22).
 *
 * The ONE alarm (D16) is not raised here: AgentSurface raises it (`superHeadAlarm`), where the
 * record lives whether or not this stage is up, so a question reaches the owner on any page the
 * way any agent's question does. A question's banner off this project is the server's
 * (lib/super/owner-question.ts). Children raise nothing themselves while handed over.
 *
 * ONE answer per permission: the first click on Allow or Deny latches that item, so a
 * double-click (two clicks before React re-renders) sends one answer. A new head, or the same
 * request re-sent by the server (the answer never landed), reopens it.
 */
export function JobBar({ state, head, waiting, rect, look, superSession, sessionFor, titleFor, onReplyToSuper, onShowChild, remote = false }: {
  state: SuperStateView;
  head: SuperQueueItem | null;
  /** The top band above the centre (planStage's `queue`). */
  rect: Rect;
  look: JobLook;
  superSession: ChatSession | undefined;
  /** How many items wait on the owner in all (the head included). */
  waiting: number;
  /** The project (no longer read here: the alarm moved to AgentSurface; kept for the caller). */
  vault: string;
  sessionFor: (claudeId: string) => ChatSession | undefined;
  titleFor: (claudeId: string) => string;
  onReplyToSuper: () => void;
  /** Bring a child beside the centre (and its open owner card into view). */
  onShowChild: (sid: string) => void;
  /** A remote screen (hands-free sekmeler W2, D6): a child's permission is answered on the Mac. */
  remote?: boolean;
}) {
  const { t } = useI18n();
  // An `ask` is the super agent's own question: there is no child behind it.
  const child = head && head.kind !== 'ask' ? sessionFor(head.sessionId) : undefined;
  const [, force] = useReducer((n: number) => n + 1, 0);
  // Follow the head's child only: its pending request is what the strip draws.
  useEffect(() => (child ? child.subscribe(() => force()) : undefined), [child]);

  // One answer per head item, shared with the super chat's question card (superQuestions.ts:
  // `latchSeen` / `latchClick` per key in a module store, read synchronously, so the second click
  // of a double-click sees the first one's latch before any re-render). Noted first, then read.
  useOwnerAnswerVersion();
  const answerKey = head ? ownerAnswerKey(head) : null;
  if (head && answerKey) noteOwnerPending(answerKey, ownerPendingPresent(head, child, openOwnerQuestions(state.queue)));
  const locked = answerKey !== null && ownerAnswerLocked(answerKey);
  const answerOnce = (send: () => boolean | void) => {
    if (!answerKey || !head) return;
    // The socket that carries the answer: the child's, or for the super agent's own `ask` its own.
    const carrier = head.kind === 'ask' ? superSession : child;
    if (!claimOwnerAnswer(answerKey, head.id, state.session ?? '', carrier?.status === 'open')) return;
    if (send() === false) releaseOwnerAnswer(answerKey);
  };

  // Option buttons at full width or not at all (`optionsFit`), never decided on hover. The fit is
  // keyed on everything the row holds (the head, the who, the "n more", the option labels, the
  // locale), so a content change inside a full-width pill, which resizes no box, starts shown
  // and is measured again; measured in a layout effect on every show/hide too, before paint.
  const fitKey = answerKey === null ? null
    : [answerKey, titleFor(head?.sessionId ?? ''), waiting > 1 ? waiting - 1 : 0, t('super.queue.reply'), t('super.queue.answer')].join('\u0001');
  const headRef = useRef<HTMLDivElement | null>(null);
  const [showOptions, setShowOptions] = useState(true);
  const showRef = useRef(showOptions);
  showRef.current = showOptions;
  const fitRef = useRef<OptionsFit | null>(null);
  useLayoutEffect(() => {
    const el = headRef.current;
    const band = el?.parentElement;
    if (!el || !band || !fitKey) return undefined;
    const measure = () => {
      const next = optionsFit(fitRef.current, fitKey, band.clientWidth, el.scrollWidth - el.clientWidth, showRef.current);
      fitRef.current = next.fit;
      if (next.show !== showRef.current) { showRef.current = next.show; setShowOptions(next.show); }
    };
    measure();
    let live = true;
    // A web font landing after the first measure changes widths without a resize.
    void document.fonts?.ready.then(() => { if (live) measure(); });
    if (typeof ResizeObserver === 'undefined') return () => { live = false; };
    const ro = new ResizeObserver(measure);
    ro.observe(band);
    ro.observe(el);
    return () => { live = false; ro.disconnect(); };
  }, [fitKey, showOptions]);

  // Empty: nothing is drawn (the agenda card holds what waits on the owner).
  if (!head) return null;

  return (
    <div
      className="super-queue-strip super-job-bar"
      data-testid="super-job-bar"
      role="region"
      aria-label={t('super.queue.label')}
      style={{ left: rect.x, top: rect.y, width: rect.width, minHeight: rect.height }}
    >
      <div ref={headRef} className="super-queue-head" data-testid="super-queue-head" data-kind={head.kind} data-state={head.state} data-options={showOptions ? undefined : 'reply-only'}>
          {head.kind === 'ask' && <span className="super-queue-super" aria-hidden><SuperAgentIcon size={16} /></span>}
          <span className="super-queue-who">{head.kind === 'ask' ? look.superTitle : head.kind === 'approval' ? t('super.queue.team') : titleFor(head.sessionId)}</span>
          {head.kind === 'permission'
            ? <PermissionHead item={head} child={remote ? undefined : child} locked={locked} answerOnce={answerOnce} remote={remote} />
            : head.kind === 'ask'
              ? <QuestionHead item={head} text={head.ownerText ?? ''} onReplyToSuper={onReplyToSuper} />
              : head.kind === 'approval'
                ? <ApprovalHead item={head} onReplyToSuper={onReplyToSuper} />
              : head.kind === 'owner'
                ? <OwnerHead text={head.ownerText ?? ''} onOpen={() => onShowChild(head.sessionId)} />
              : <QuestionHead item={head} text={head.ownerText ?? t('super.queue.escalatedAlarm')} onReplyToSuper={onReplyToSuper} />}
          {waiting > 1 && <span className="super-queue-more">{t('super.queue.more').replace('{n}', String(waiting - 1))}</span>}
      </div>
    </div>
  );
}

/**
 * A question the owner answers (the super's own `ask`, or a child's question it escalated): its
 * words, and ONE button that takes him to its card in the super chat, the chat's own
 * AskUserQuestion card (SuperQuestionCard.tsx). The bar draws no answers of its own: a question
 * is asked one way, in one place (owner 2026-10-22).
 */
function QuestionHead({ item, text, onReplyToSuper }: { item: SuperQueueItem; text: string; onReplyToSuper: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        <button
          type="button"
          className="super-queue-btn super-queue-btn--option"
          data-testid="super-queue-answer"
          onClick={() => { if (!showQuestionCard(item.id)) onReplyToSuper(); }}
        >{t('super.queue.answer')}</button>
      </span>
    </>
  );
}

/**
 * A child waiting on something only the owner can do (an `owner` item: a command to run himself,
 * a key to type, a checklist, a sign-in): what it needs, and ONE button that brings the child
 * beside the centre with that card in view. The card itself does it; the bar draws no copy.
 */
function OwnerHead({ text, onOpen }: { text: string; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <span className="super-queue-needs" data-testid="super-queue-needs">{t('super.card.needsYou')}</span>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        <button type="button" className="super-queue-btn super-queue-btn--option" data-testid="super-queue-open-owner" onClick={onOpen}>
          {t('super.queue.openCard')}
        </button>
      </span>
    </>
  );
}

/** The reveal in flight: a newer one (another click) supersedes it. */
let revealSeq = 0;

/**
 * Bring a child's owner card (`run`, `secret`, `checklist`) into view in the child shown beside
 * the centre, once it has mounted there (side by side renders on the next frames). The newest
 * card with that id wins. Gives up quietly after ~1.5 s: the child is in view either way. The
 * keyboard follows only if it has not moved since the click (he may already be typing elsewhere).
 */
export function showOwnerCard(wait: { kind: string; id: string } | undefined): void {
  if (!wait) return;
  const seq = ++revealSeq;
  const from = document.activeElement;
  let tries = 0;
  const find = () => {
    if (seq !== revealSeq) return;
    const sel = `[data-super-slot="shown"] .chat-viewcard[data-view-kind="${cssEsc(wait.kind)}"][data-view-id="${cssEsc(wait.id)}"]`;
    const cards = document.querySelectorAll<HTMLElement>(sel);
    const card = cards[cards.length - 1];
    if (!card) { if (++tries < 30) window.setTimeout(find, 50); return; }
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    if (document.activeElement === from || document.activeElement === document.body) {
      card.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
    }
  };
  window.requestAnimationFrame(find);
}

/** Bring the question's card in the super chat into view and put the keyboard on it. False when
 *  no card is drawn (the chat not on screen): the caller falls back. The band's Answer and the
 *  agenda's Waiting row both open a question this one way. */
export function showQuestionCard(itemId: string): boolean {
  const card = [...document.querySelectorAll<HTMLElement>('[data-super-slot="centre"] [data-testid="super-question-card"]')].find((el) => el.dataset.item === itemId);
  if (!card) return false;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  // The card's page is its focus target (SurveyCard focuses it on paging): its keys work at once.
  card.querySelector<HTMLElement>('.chat-surveycard-page:not([inert])')?.focus({ preventScroll: true });
  return true;
}

/**
 * The pill's text: one line, cut with an ellipsis when the row is short of room. Only a CUT text
 * gets the whole of it as an overlay below the row (shown on pointer or focus by CSS), so the
 * row itself never reflows under the owner's pointer.
 */
function QueueText({ full, children }: { full: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    measure();
    let live = true;
    void document.fonts?.ready.then(() => { if (live) measure(); });
    if (typeof ResizeObserver === 'undefined') return () => { live = false; };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { live = false; ro.disconnect(); };
  }, [full]);
  return (
    <>
      <span ref={ref} className="super-queue-text">{children}</span>
      {cut && <span className="super-queue-full" aria-hidden="true"><span className="super-queue-full-box">{full}</span></span>}
    </>
  );
}

function PermissionHead({ item, child, locked, answerOnce, remote = false }: {
  item: SuperQueueItem;
  child: ChatSession | undefined;
  locked: boolean;
  answerOnce: (send: () => boolean | void) => void;
  remote?: boolean;
}) {
  const { t } = useI18n();
  // A remote screen never answers a child's permission (D6): the Mac does.
  if (remote) return <span className="super-queue-text" data-testid="super-queue-permission-remote">{t('super.queue.permissionRemote')}</span>;
  const pending = child?.getModel().pending.find(
    (p): p is PendingPermission => p.kind === 'permission' && p.requestId === item.requestId,
  );
  if (!child || !pending) {
    // The child's request is not (yet) in this window — nothing to answer from here.
    return <span className="super-queue-text">{t('super.queue.permissionWaiting')}</span>;
  }
  return (
    <>
      <QueueText full={`${pending.displayName || pending.toolName} ${permissionSummary(pending.input)}`}>
        <strong className="super-queue-tool">{pending.displayName || pending.toolName}</strong>
        <code className="super-queue-input">{permissionSummary(pending.input)}</code>
      </QueueText>
      <span className="super-queue-actions">
        <button
          type="button"
          className="super-queue-btn super-queue-btn--allow"
          data-testid="super-queue-allow"
          disabled={locked}
          onClick={() => answerOnce(() => child.answer(pending.requestId, { behavior: 'allow', updatedInput: pending.input }))}
        >{t('super.queue.allow')}</button>
        <button
          type="button"
          className="super-queue-btn"
          data-testid="super-queue-deny"
          disabled={locked}
          onClick={() => answerOnce(() => child.answer(pending.requestId, { behavior: 'deny', message: 'Denied by user.' }))}
        >{t('super.queue.deny')}</button>
      </span>
    </>
  );
}

/**
 * An AI Team member the Super Agent chose is not approved on this machine. Approving is the
 * owner's, in AI Team, where the text it grants is read first: this row only takes him there,
 * and Reply tells the Super Agent to give the job again. Nothing here approves anything.
 */
function ApprovalHead({ item, onReplyToSuper }: { item: SuperQueueItem; onReplyToSuper: () => void }) {
  const { t } = useI18n();
  const member = item.member ?? '';
  const name = useAgent(member || null).data?.agent.title || member;
  const text = t('super.queue.approval').replace('{name}', name);
  return (
    <>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        <button
          type="button"
          className="super-queue-btn super-queue-btn--option"
          data-testid="super-queue-open-team"
          disabled={!member}
          onClick={() => requestOpenAgents({ slug: member })}
        >{t('super.queue.openTeam')}</button>
        <button type="button" className="super-queue-btn super-queue-btn--reply" onClick={onReplyToSuper}>
          {t('super.queue.reply')}
        </button>
      </span>
    </>
  );
}
