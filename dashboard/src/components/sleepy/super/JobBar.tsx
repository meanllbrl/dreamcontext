import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { useAutomation } from '../../../hooks/useAutomations';
import { requestOpenAgents } from '../../../lib/openAgents';
import type { GrantSize, SuperQueueItem, SuperStateView } from '../../../lib/superTypes';
import type { ChatSession, PendingPermission } from '../chatSession';
import {
  directChildQuestion, optionsFit, ownerWaitOf, permissionSummary, type JobLook, type OptionsFit,
} from './superHandover';
import {
  MAIN_RECORD, allowAnswer, allowedWaiting, callOf, claimOwnerItem, releaseOwnerItem, recordOf, declineAnswer, grantChoices, oneChoiceQuestion, ownerRowKind, questionAnswer, useOwnerAnswer, visibleText, type GrantChoices, noAllowReasonKey } from './ownerAnswer';
import { sizeWords } from '../chat/RefusalCard';
import {
  claimOwnerAnswer, memberItemText, noteOwnerPending, openOwnerQuestions, ownerAnswerKey, ownerAnswerLocked, ownerPendingPresent,
  releaseOwnerAnswer, useOwnerAnswerVersion,
} from './superQuestions';
import type { Rect } from './superLayout';
import { SuperAgentIcon } from '../../layout/NavIcons';
import { cssEsc } from './StageMotion';
import { showApprovalRow, showMemberApproval } from './superApprovals';
import './JobBar.css';
import { noteOwnerWrote } from '../../../lib/ownerAtMac';
import { useApi, useVaultId } from '../../../context/VaultContext';
import { cardFolderText, cardNotNeeded, useCardState } from '../../../lib/cardRecords';
import { barCanRun } from '../../../lib/unsafeChars';
import { publishQueueHeight, requestSlotRun, showOwnerSlot, useSuperQuestions } from './superJobsStore';

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
  /** The top band above the centre (planStage's `queue`). Absent (the Super dock): the band is a
   *  row in normal flow, full width, between the dock's head and the chat. */
  rect?: Rect;
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
  // The record this bar draws (main's, or a member's on its own stage): it decides whose crew an
  // item is and where its answer goes, never the item's kind.
  const record = recordOf(state);
  // On a member's own stage, "Always for <member>" names that member.
  const recordName = record === MAIN_RECORD ? undefined : (look.memberTitleFor?.(record) || record);
  // The Super this record belongs to: a member's own items and questions carry the member's name.
  const ownTitle = recordName ?? look.superTitle;
  // An `ask` is the super agent's own question: there is no child behind it.
  const child = head && head.kind !== 'ask' ? sessionFor(head.sessionId) : undefined;
  const [, force] = useReducer((n: number) => n + 1, 0);
  // A parked child (its tab dormant here) shows Paused on its card row (K7).
  const pausedFor = useSuperQuestions(state.session ?? null)?.pausedFor;
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

  // The bar's REAL height, measured (sahip-karti-yerinde K7): a card row wraps to draw its whole
  // command, so the stage (planStage `queueHeight`) starts the centre, a sheet and the agenda below
  // this bottom, at every width and for every row, never below a one-line constant. Includes the
  // strip's own top padding; 0 when no row is drawn.
  const barSession = state.session ?? '';
  useLayoutEffect(() => {
    const el = headRef.current;
    if (!barSession) return undefined;
    if (!el) { publishQueueHeight(barSession, 0); return undefined; }
    const strip = el.parentElement;
    const measure = () => {
      const pad = strip ? el.getBoundingClientRect().top - strip.getBoundingClientRect().top : 0;
      publishQueueHeight(barSession, el.getBoundingClientRect().height + Math.max(0, pad));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return () => publishQueueHeight(barSession, 0);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); publishQueueHeight(barSession, 0); };
  }, [barSession, answerKey, head?.id]);

  // Empty: nothing is drawn (the agenda card holds what waits on the owner).
  if (!head) return null;

  return (
    <div
      className="super-queue-strip super-job-bar"
      data-testid="super-job-bar"
      role="region"
      aria-label={t('super.queue.label')}
      data-flow={rect ? undefined : 'row'}
      style={rect ? { left: rect.x, top: rect.y, width: rect.width, minHeight: rect.height } : undefined}
    >
      <div ref={headRef} className="super-queue-head" data-testid="super-queue-head" data-kind={head.kind} data-state={head.state} data-options={showOptions ? undefined : 'reply-only'}
        // A child's card row WRAPS (JobBar.css): what its verb acts on is drawn whole, never cut.
        data-card={(head.kind === 'owner' || head.kind === 'member') && head.card ? head.card.spec.type : undefined}>
          {head.kind === 'ask' && <span className="super-queue-super" aria-hidden><SuperAgentIcon size={16} /></span>}
          {head.kind === 'member' || head.kind === 'routine' ? null : head.own
            // The Super's own refused command (K1): its own name, no child to open.
            ? <span className="super-queue-who">{ownTitle}</span>
            : !rect && head.kind !== 'ask' && head.kind !== 'approval'
            // In the dock the stage is not on screen: the child's name opens it there (its card
            // beside the agenda), the way the stage's own band reaches an owner card.
            ? <button type="button" className="super-queue-who super-queue-who--link" data-testid="super-queue-open-child" onClick={() => onShowChild(head.sessionId)}>{titleFor(head.sessionId)}</button>
            : <span className="super-queue-who">{head.kind === 'ask' ? ownTitle : head.kind === 'approval' ? t('super.queue.team') : titleFor(head.sessionId)}</span>}
          {allowedWaiting(head) && (head.kind === 'permission' || (head.kind === 'owner' && ownerWaitOf(head) === 'refusal'))
            ? <AllowedHead item={head} onOpen={() => (head.own ? onReplyToSuper() : onShowChild(head.sessionId))} />
            : head.kind === 'permission'
            ? <PermissionHead item={head} record={record} memberName={recordName} child={remote ? undefined : child} locked={locked} answerOnce={answerOnce} remote={remote} showOptions={showOptions} />
            : head.kind === 'ask'
              ? <QuestionHead item={head} text={head.ownerText ?? ''} root={superSession?.container} onReplyToSuper={onReplyToSuper} />
              : head.kind === 'approval'
                ? <ApprovalHead item={head} onReplyToSuper={onReplyToSuper} />
              : (head.kind === 'owner' || head.kind === 'member') && head.card
                ? <CardHead item={head} paused={!!pausedFor?.(head.sessionId)} onOpen={() => (head.kind === 'member' ? requestOpenAgents({ slug: head.member ?? '' }) : onShowChild(head.sessionId))} />
              : head.kind === 'member'
                ? <MemberHead item={head} record={record} showOptions={showOptions} />
              : head.kind === 'routine'
                ? <RoutineHead item={head} record={record} />
              : head.kind === 'owner' && ownerWaitOf(head) === 'refusal'
                ? <GrantHead item={head} record={record} memberName={recordName} showOptions={showOptions} onOpen={() => (head.own ? onReplyToSuper() : onShowChild(head.sessionId))} />
              : head.kind === 'owner' && ownerWaitOf(head) === 'stalled'
                ? <StalledHead item={head} record={record} onOpen={() => onShowChild(head.sessionId)} />
              : head.kind === 'owner'
                ? <OwnerHead text={head.ownerText ?? ''} onOpen={() => onShowChild(head.sessionId)} />
              : directChildQuestion(head)
                ? <ChildQuestionHead text={head.ownerText ?? t('super.queue.escalatedAlarm')} onOpen={() => onShowChild(head.sessionId)} />
              : <QuestionHead item={head} text={head.ownerText ?? t('super.queue.escalatedAlarm')} root={superSession?.container} onReplyToSuper={onReplyToSuper} />}
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
function QuestionHead({ item, text, root, onReplyToSuper }: { item: SuperQueueItem; text: string; root?: HTMLElement; onReplyToSuper: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        <button
          type="button"
          className="super-queue-btn super-queue-btn--option"
          data-testid="super-queue-answer"
          onClick={() => { if (!showQuestionCard(item.id, root)) onReplyToSuper(); }}
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

/**
 * A child's CARD on the row (sahip-karti-yerinde K7, drawing A1-A5): the card's own verb is the
 * primary button, drawn from the RECORD the item carries, never from chat text.
 *  - run: ▶ Run with the WHOLE command and the folder it runs in; the press starts it in the Super
 *    chat's slot with exactly the command drawn here (`shown`), where its terminal shows. A command
 *    the row cannot draw whole, or one holding characters that could hide what runs, gets Show,
 *    which brings the slot, never ▶ Run;
 *  - secret: Enter secret, checklist: Open checklist (both bring the slot, the checklist window
 *    opened from it); mcp: Open job (D6: connecting stays in the job's own chat).
 * Then Not needed and an Open link to the job. The row WRAPS (JobBar.css `[data-card]`): the
 * title, the whole command and its folder are drawn on as many lines as they need, never cut, and
 * at phone width it stacks (title line, command, buttons), as drawing A has it.
 */
function CardHead({ item, paused, onOpen }: { item: SuperQueueItem; paused: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const { vault } = useVaultId();
  const handle = item.card;
  const memberName = useAgent(item.kind === 'member' ? item.member || null : null).data?.agent.title || item.member || '';
  const { state } = useCardState(vault ?? null, handle?.spec.type === 'run' ? handle : undefined, item.delivery ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!handle) return null;
  const spec = handle.spec;
  const slot = () => showOwnerSlot(item.id);
  const toSlot = () => { if (!slot()) onOpen(); };
  const notNeeded = () => {
    if (busy || !claimOwnerItem(item.id)) return;
    setBusy(true);
    setNote(null);
    void cardNotNeeded(api, { session: handle.postingSession, card: handle.cardRef }).then((r) => {
      setBusy(false);
      if (r.ok) return;
      releaseOwnerItem(item.id);
      setNote(r.message || t('owner.answer.failed'));
    });
  };

  // THE ROW'S TEXT IS NEVER CUT (K4 "what is shown is what runs"): it wraps whole, at every width,
  // in `.super-queue-card-line` (JobBar.css), never the one-line ellipsis `QueueText` draws. ▶ Run
  // is offered only for a command drawn here whole AND the folder it runs in (`cardFolderText`, the
  // one text every surface draws, its cwd included); while that folder is loading or could not be
  // read, or the command cannot be drawn whole and safely, the row offers Show, which opens the slot.
  let line: ReactNode;
  let verb: ReactNode;
  if (spec.type === 'run') {
    const drawable = barCanRun(spec.command);
    const folder = cardFolderText(state?.folder, spec);
    const runnable = drawable && !!folder;
    line = drawable
      ? <>
          <code className="super-queue-input super-queue-card-command" data-testid="super-queue-card-command">{spec.command}</code>
          {folder && <span className="super-queue-card-folder" data-testid="super-queue-card-folder" title={state?.folder?.path}>{folder}</span>}
        </>
      : <span data-testid="super-queue-card-long">{t('ownerCard.bar.longCommand')}</span>;
    verb = runnable ? (
      <button
        type="button"
        className="super-queue-btn super-queue-btn--allow"
        data-testid="super-queue-card-run"
        data-shown={spec.command}
        disabled={busy}
        onClick={() => {
          // The slot's run card starts it, with a ticket minted for exactly this command.
          const sent = requestSlotRun(item.id, spec.command);
          slot();
          if (!sent) onOpen();
        }}
      ><span aria-hidden>▶</span> {t('ownerCard.bar.runVerb')}</button>
    ) : (
      <button type="button" className="super-queue-btn super-queue-btn--allow" data-testid="super-queue-card-show" onClick={toSlot}>{t('ownerCard.bar.show')}</button>
    );
  } else if (spec.type === 'secret') {
    line = <>{visibleText(spec.title)} <code className="super-queue-input super-queue-card-command">{visibleText(spec.file)}</code></>;
    verb = <button type="button" className="super-queue-btn super-queue-btn--allow" data-testid="super-queue-card-secret" onClick={toSlot}>{t('ownerCard.bar.enterSecret')}</button>;
  } else if (spec.type === 'checklist') {
    line = visibleText(spec.title);
    verb = (
      <button
        type="button"
        className="super-queue-btn super-queue-btn--allow"
        data-testid="super-queue-card-checklist"
        onClick={() => {
          if (!slot()) { onOpen(); return; }
          // The window is opened from the slot's own card, the window that receives its submit.
          document.querySelector<HTMLButtonElement>(`[data-testid="super-owner-card"][data-item="${cssEsc(item.id)}"] .chat-checklistcard-open:not([disabled])`)?.click();
        }}
      >{t('ownerCard.bar.openChecklist')}</button>
    );
  } else {
    line = t('ownerCard.mcpLine').replace('{names}', visibleText(spec.servers.join(', ')));
    verb = <button type="button" className="super-queue-btn super-queue-btn--allow" data-testid="super-queue-card-open-job" onClick={onOpen}>{t('ownerCard.openJob')}</button>;
  }

  return (
    <>
      {item.kind === 'member' && <span className="super-queue-who" data-testid="super-queue-member">{memberName}</span>}
      {paused && <span className="super-queue-paused" data-testid="super-queue-paused">{t('ownerCard.paused')}</span>}
      <span className="super-queue-card-line" data-testid="super-queue-card-line">{line}</span>
      <span className="super-queue-actions" data-testid="super-queue-card" data-kind={spec.type}>
        {verb}
        <button type="button" className="super-queue-btn" data-testid="super-queue-card-not-needed" disabled={busy} onClick={notNeeded}>
          {t('owner.answer.notNeeded')}
        </button>
        {spec.type !== 'mcp' && (
          <button type="button" className="super-queue-open-link" data-testid="super-queue-card-open" onClick={onOpen}>{t('ownerCard.openJob')}</button>
        )}
      </span>
      {note && <span className="super-queue-card-line" data-testid="super-queue-note">{note}</span>}
    </>
  );
}

/**
 * A child's own question, his from birth (`direct`, owner 2026-10-27): its words, and ONE button
 * that brings that child beside the centre, where the child's own AskUserQuestion card answers it
 * through the child's session. The Super hears it too; whoever answers first, the other's item
 * closes (the child leaves `asking`).
 */
function ChildQuestionHead({ text, onOpen }: { text: string; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        <button type="button" className="super-queue-btn super-queue-btn--option" data-testid="super-queue-open-chat" onClick={onOpen}>
          {t('super.queue.openChat')}
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
 *  agenda's Waiting row both open a question this one way. `root` is the Super session's own
 *  container (wherever it is homed: the stage centre or the dock); without it, the centre. */
export function showQuestionCard(itemId: string, root?: ParentNode | null): boolean {
  const scope: ParentNode = root ?? document;
  const sel = root ? '[data-testid="super-question-card"]' : '[data-super-slot="centre"] [data-testid="super-question-card"]';
  const card = [...scope.querySelectorAll<HTMLElement>(sel)].find((el) => el.dataset.item === itemId);
  if (!card || !card.isConnected) return false;
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

function PermissionHead({ item, record, memberName, child, locked, answerOnce, remote = false, showOptions = true }: {
  item: SuperQueueItem;
  record: string;
  memberName?: string;
  child: ChatSession | undefined;
  locked: boolean;
  answerOnce: (send: () => boolean | void) => void;
  remote?: boolean;
  /** False when the row does not fit (a phone): the Always sizes stay on the card, not the row. */
  showOptions?: boolean;
}) {
  const { t } = useI18n();
  // A wider size than once goes through the owner-answer route, which writes the rule from the
  // stored request; Allow once stays the child's own answer, as it always was.
  const wide = useOwnerAnswer(record, item, 'bar');
  // A remote screen never answers a child's permission (D6): the Mac does.
  if (remote) return <span className="super-queue-text" data-testid="super-queue-permission-remote">{t('super.queue.permissionRemote')}</span>;
  const pending = child?.getModel().pending.find(
    (p): p is PendingPermission => p.kind === 'permission' && p.requestId === item.requestId,
  );
  if (!child || !pending) {
    // The child's request is not (yet) in this window — nothing to answer from here.
    return <span className="super-queue-text">{t('super.queue.permissionWaiting')}</span>;
  }
  // What the bar shows is the child's own request: its whole text is the row's overlay.
  const command = typeof (pending.input as { command?: unknown } | null)?.command === 'string' ? (pending.input as { command: string }).command : null;
  const choices = grantChoices(item, { tool: pending.toolName, input: command ?? JSON.stringify(pending.input ?? null), whole: true }, record);
  const shown = visibleText(permissionSummary(pending.input));
  return (
    <>
      <QueueText full={`${pending.displayName || pending.toolName} ${visibleText(command ?? permissionSummary(pending.input))}${choices.onceOnlyReason ? ` · ${choices.onceOnlyReason}` : ''}`}>
        <strong className="super-queue-tool">{pending.displayName || pending.toolName}</strong>
        <code className="super-queue-input">{shown}</code>
        {choices.onceOnlyReason && <span data-testid="super-queue-once-only"> · {choices.onceOnlyReason}</span>}
      </QueueText>
      <span className="super-queue-actions">
        <button
          type="button"
          className="super-queue-btn super-queue-btn--allow"
          data-testid="super-queue-allow"
          disabled={locked}
          onClick={() => answerOnce(() => { const ok = child.answer(pending.requestId, { behavior: 'allow', updatedInput: pending.input }); if (ok) noteOwnerWrote(); return ok; })}
        >{t(choices.sizes.length > 1 ? 'owner.answer.allowOnce' : 'super.queue.allow')}</button>
        {/* Main's own crew has no member size (grantChoices); a member's own stage names it. */}
        {showOptions && <AlwaysMenu choices={choices} memberName={memberName} busy={locked || wide.busy} onPick={(size) => wide.submit(allowAnswer('permission', size))} />}
        <button
          type="button"
          className="super-queue-btn"
          data-testid="super-queue-deny"
          disabled={locked}
          onClick={() => answerOnce(() => { const ok = child.answer(pending.requestId, { behavior: 'deny', message: 'Denied by user.' }); if (ok) noteOwnerWrote(); return ok; })}
        >{t('super.queue.deny')}</button>
      </span>
    </>
  );
}


/**
 * An AI Team member waiting on the owner, mirrored into main's queue by the server (owner
 * 2026-11-10), answered IN PLACE (uye-bildirim K11, drawing A1-A6): a question's options, a
 * permission's or a refused command's Allow once / Always / Deny or Not needed, a stalled job's
 * Open and Not needed. Whatever this window cannot decide (no owner key, the member's window
 * closed, a command it cannot show whole, a card only the member's page draws) is one Open button
 * that brings the member's page, where its own card answers it, as before.
 */
function MemberHead({ item, record, showOptions }: { item: SuperQueueItem; record: string; showOptions: boolean }) {
  const { t } = useI18n();
  const member = item.member ?? '';
  const name = useAgent(member || null).data?.agent.title || member;
  const row = ownerRowKind(item);
  const answer = useOwnerAnswer(record, item, 'bar');
  const open = () => requestOpenAgents({ slug: member });
  if (allowedWaiting(item) && (row === 'permission' || row === 'refusal')) {
    return (
      <>
        <span className="super-queue-who" data-testid="super-queue-member">{name}</span>
        <AllowedHead item={item} onOpen={open} />
      </>
    );
  }
  if (!answer.fallback && (row === 'permission' || row === 'refusal')) {
    return (
      <>
        <span className="super-queue-who" data-testid="super-queue-member">{name}</span>
        <GrantHead item={item} record={record} memberName={name} showOptions={showOptions} onOpen={open} />
      </>
    );
  }
  if (!answer.fallback && row === 'stalled') {
    return (
      <>
        <span className="super-queue-who" data-testid="super-queue-member">{name}</span>
        <StalledHead item={item} record={record} onOpen={open} />
      </>
    );
  }
  const text = memberItemText(item, t);
  const q = row === 'question' && !answer.fallback ? oneChoiceQuestion(item) : null;
  return (
    <>
      <span className="super-queue-who" data-testid="super-queue-member">{name}</span>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        {q && showOptions && q.options.map((label, i) => (
          <button
            key={label}
            type="button"
            className={`super-queue-btn super-queue-btn--option${i === 0 ? ' super-queue-btn--allow' : ''}`}
            data-testid="super-queue-member-option"
            disabled={answer.busy}
            onClick={() => answer.submit(questionAnswer(q.question, label))}
          >{label}</button>
        ))}
        {row === 'question' && !answer.fallback ? (
          <button
            type="button"
            className="super-queue-btn super-queue-btn--reply"
            data-testid="super-queue-member-reply"
            disabled={!member}
            // Its card in the Super chat takes his words; no card on screen: the member's page.
            onClick={() => { if (!showMemberCard(item.id)) open(); }}
          >{t('owner.answer.reply')}</button>
        ) : (
          <button
            type="button"
            className="super-queue-btn super-queue-btn--option"
            data-testid="super-queue-open-member"
            disabled={!member}
            onClick={open}
          >{t('owner.answer.open')}</button>
        )}
      </span>
      {answer.note && <span className="super-queue-text" data-testid="super-queue-note">{t(answer.note)}</span>}
    </>
  );
}

/**
 * A permission or a refused command answered on the bar: the tool and the whole command (cut
 * only by the row's width, whole in its overlay), Allow once, the Always menu with exactly the
 * sizes the server offers, and Deny or Not needed. A command the row cannot show whole (stored
 * cut) or that nothing may allow offers Open, and says why.
 */
/** `showOptions` false (the row does not fit, a phone): Allow once alone; the Always sizes and the
 *  decline stay on the card. */
function GrantHead({ item, record, memberName, onOpen, showOptions = true }: { item: SuperQueueItem; record: string; memberName?: string; onOpen: () => void; showOptions?: boolean }) {
  const { t } = useI18n();
  const kind = ownerRowKind(item) === 'refusal' ? 'refusal' : 'permission';
  const answer = useOwnerAnswer(record, item, 'bar');
  const call = callOf(item);
  const choices = grantChoices(item, call, record);
  const input = call ? visibleText(call.input) : '';
  const lead = kind === 'refusal' ? t('owner.answer.refusedBar') : '';
  const why = !call ? '' : !choices.sizes.length ? t(noAllowReasonKey(call, true)) : choices.onceOnlyReason ?? '';
  const full = [lead, call?.tool, input].filter(Boolean).join(' ') + (why ? ` · ${why}` : '');
  const text = call ? null : memberItemText(item, t);
  return (
    <>
      {kind === 'refusal' && <span className="super-queue-needs" data-testid="super-queue-stopped">{t('owner.answer.stopped')}</span>}
      <QueueText full={text ?? full}>
        {text ?? (
          <>
            {lead && <>{lead} </>}
            {kind === 'permission' && <strong className="super-queue-tool">{call?.tool}</strong>}
            {kind === 'permission' && ' '}
            <code className="super-queue-input" data-testid="super-queue-command">{input}</code>
            {why && <span data-testid="super-queue-once-only"> · {why}</span>}
          </>
        )}
      </QueueText>
      <span className="super-queue-actions">
        {answer.fallback || !choices.sizes.length ? (
          <button type="button" className="super-queue-btn super-queue-btn--allow" data-testid="super-queue-open-member" onClick={onOpen}>{t('owner.answer.open')}</button>
        ) : (
          <>
            {choices.sizes.includes('once') && (
              <button
                type="button"
                className="super-queue-btn super-queue-btn--allow"
                data-testid="super-queue-allow-once"
                disabled={answer.busy}
                onClick={() => answer.submit(allowAnswer(kind, 'once'))}
              >{t('owner.answer.allowOnce')}</button>
            )}
            {showOptions && <AlwaysMenu choices={choices} memberName={memberName} busy={answer.busy} onPick={(size) => answer.submit(allowAnswer(kind, size))} />}
          </>
        )}
        {/* A row that does not fit keeps its one answer; the card beside it holds the rest. */}
        {(showOptions || answer.fallback || !choices.sizes.length) && (
          <button
            type="button"
            className="super-queue-btn"
            data-testid="super-queue-decline"
            disabled={answer.busy}
            onClick={() => answer.submit(declineAnswer(kind))}
          >{t(kind === 'refusal' ? 'owner.answer.notNeeded' : 'owner.answer.deny')}</button>
        )}
      </span>
      {answer.note && <span className="super-queue-text" data-testid="super-queue-note">{t(answer.note)}</span>}
    </>
  );
}

/**
 * A permission or a refused command the owner already allowed, waiting for its call to run (its
 * chat is closed: `allowed`, set by the server). Asking again would grant twice: the row says it
 * is allowed and offers Open only.
 */
function AllowedHead({ item, onOpen }: { item: SuperQueueItem; onOpen: () => void }) {
  const { t } = useI18n();
  const call = callOf(item);
  const input = call ? visibleText(call.input) : '';
  const line = t('owner.answer.allowedWaiting');
  return (
    <>
      <QueueText full={[call?.tool, input].filter(Boolean).join(' ') + ` · ${line}`}>
        {call && <><strong className="super-queue-tool">{call.tool}</strong> <code className="super-queue-input" data-testid="super-queue-command">{input}</code> · </>}
        <span data-testid="super-queue-allowed">{line}</span>
      </QueueText>
      <span className="super-queue-actions">
        <button type="button" className="super-queue-btn super-queue-btn--option" data-testid="super-queue-open-member" onClick={onOpen}>{t('owner.answer.open')}</button>
      </span>
    </>
  );
}

/** A member that stopped without closing its job or asking (K6, drawing A6): its last sentence,
 *  Open, and Not needed (he has seen it; nothing else changes). */
function StalledHead({ item, record, onOpen }: { item: SuperQueueItem; record: string; onOpen: () => void }) {
  const { t } = useI18n();
  const answer = useOwnerAnswer(record, item, 'bar');
  const text = t('owner.answer.stalled').replace('{text}', visibleText(item.ownerText ?? ''));
  return (
    <>
      <span className="super-queue-needs" data-testid="super-queue-stopped">{t('owner.answer.stopped')}</span>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        <button type="button" className="super-queue-btn super-queue-btn--allow" data-testid="super-queue-open-member" onClick={onOpen}>{t('owner.answer.open')}</button>
        {!answer.fallback && (
          <button type="button" className="super-queue-btn" data-testid="super-queue-decline" disabled={answer.busy} onClick={() => answer.submit(declineAnswer('stalled'))}>
            {t('owner.answer.notNeeded')}
          </button>
        )}
      </span>
      {answer.note && <span className="super-queue-text" data-testid="super-queue-note">{t(answer.note)}</span>}
    </>
  );
}

/**
 * A routine waiting on him (K7, drawing A7), drawn by its OWN title (its member's name before it
 * when it has one): what it waits for, and Review, which brings its row of the Super's approval
 * card into view, where the change is in view; AI Team when no row is drawn. Never approved here;
 * Not needed sets it aside (it stays closed while its fact lasts), so it never holds his list.
 */
function RoutineHead({ item, record }: { item: SuperQueueItem; record: string }) {
  const { t } = useI18n();
  const answer = useOwnerAnswer(record, item, 'bar');
  const slug = item.routine ?? '';
  const member = item.member ?? '';
  const memberName = useAgent(member || null).data?.agent.title || member;
  const routineTitle = (useAutomation(slug || null).data?.automation as { title?: string } | undefined)?.title || slug;
  const title = [memberName, routineTitle].filter(Boolean).join(' · ');
  const text = visibleText(item.ownerText ?? '');
  return (
    <>
      <span className="super-queue-who" data-testid="super-queue-routine">{title}</span>
      <QueueText full={text}>{text}</QueueText>
      <span className="super-queue-actions">
        <button
          type="button"
          className="super-queue-btn super-queue-btn--allow"
          data-testid="super-queue-review"
          disabled={!slug}
          onClick={() => { if (!showApprovalRow(`routine:${slug}`)) requestOpenAgents({ slug: member || slug }); }}
        >{t('owner.answer.review')}</button>
        {!answer.fallback && (
          <button type="button" className="super-queue-btn" data-testid="super-queue-decline" disabled={answer.busy} onClick={() => answer.submit(declineAnswer('routine'))}>
            {t('owner.answer.notNeeded')}
          </button>
        )}
      </span>
      {answer.note && <span className="super-queue-text" data-testid="super-queue-note">{t(answer.note)}</span>}
    </>
  );
}

/**
 * The Always menu (drawing A2): one entry per wider size the server offers, each saying how long
 * it lasts; the member's entry shows the rule in full and what is not checked. Absent when only
 * once is offered (an outward, deleting or classified command: the row says why instead).
 */
function AlwaysMenu({ choices, memberName, busy, onPick }: {
  choices: GrantChoices;
  memberName?: string;
  busy: boolean;
  onPick: (size: GrantSize) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const wide = choices.sizes.filter((s) => s !== 'once');
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!wide.length) return null;
  const entry = { height: 'auto', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--space-1)', whiteSpace: 'normal', padding: 'var(--space-2)' } as const;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="super-queue-btn"
        data-testid="super-queue-always"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >{t('owner.answer.always')} ▾</button>
      {open && (
        <div className="super-size-menu super-head-menu" role="menu" data-testid="super-queue-always-menu" style={{ minWidth: 280, maxWidth: 400 }}>
          {wide.map((size) => {
            const w = sizeWords(size, t, memberName, true);
            return (
              <button key={size} type="button" role="menuitem" className="super-head-menu-item" style={entry} data-testid={`super-queue-always-${size}`} onClick={() => { setOpen(false); onPick(size); }}>
                <strong>{w.title}</strong>
                <span className="super-size-menu-note" style={{ padding: 0 }}>{w.desc}</span>
                {size === 'member' && choices.rule && <code className="super-queue-input" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }} data-testid="super-queue-rule">{visibleText(choices.rule)}</code>}
                {choices.notChecked && <span className="super-size-menu-note" style={{ padding: 0 }} data-testid="super-queue-not-checked">{choices.notChecked}</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/** Bring a member's card in the Super chat into view and put the keyboard in its reply field.
 *  False when no such card is drawn (the chat not on screen): the caller opens the member. */
export function showMemberCard(itemId: string, root: ParentNode = document): boolean {
  const card = [...root.querySelectorAll<HTMLElement>('[data-testid="super-member-card"]')].find((el) => el.dataset.item === itemId);
  if (!card || !card.isConnected) return false;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  card.querySelector<HTMLElement>('textarea, button:not([disabled])')?.focus({ preventScroll: true });
  return true;
}

/**
 * An AI Team member the Super Agent chose is not approved on this machine. Approving is the
 * owner's, on the Super's own approval card above the chat (owner 2026-11-06), where Review shows
 * the text it grants: this row only brings that card's row into view (AI Team when none is drawn),
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
          // Its row on the Super's own approval card, above the chat; AI Team only when none is drawn.
          onClick={() => { if (!showMemberApproval(member)) requestOpenAgents({ slug: member }); }}
        >{t('super.approvals.reviewHere')}</button>
        <button type="button" className="super-queue-btn super-queue-btn--reply" onClick={onReplyToSuper}>
          {t('super.queue.reply')}
        </button>
      </span>
    </>
  );
}
