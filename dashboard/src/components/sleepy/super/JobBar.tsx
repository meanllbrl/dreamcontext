import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAgent } from '../../../hooks/useAgents';
import { raiseAskAttention } from '../../../lib/attention';
import { requestOpenAgents } from '../../../lib/openAgents';
import type { SuperQueueItem, SuperStateView } from '../../../lib/superTypes';
import type { ChatSession, PendingPermission } from '../chatSession';
import {
  headAlarmOnce, optionsFit, permissionSummary, type JobLook, type OptionsFit,
} from './superHandover';
import {
  claimOwnerAnswer, noteOwnerPending, openOwnerQuestions, ownerAnswerKey, ownerAnswerLocked, ownerOptionsOf, ownerPendingPresent,
  recordOwnerAnswer, releaseOwnerAnswer, sendOwnerAnswer, useOwnerAnswerVersion,
} from './superQuestions';
import type { Rect } from './superLayout';
import './JobBar.css';

/**
 * The question band (plan r4 D1): the top band above the centre holds ONLY the head of the one
 * question queue below. The counts and the job list it carried moved into the agenda, the
 * always-visible column left of the stage (SuperAgenda.tsx, task super-agent-ajandasi-…), so
 * there is one list. Nothing here polls: the record is pushed. Empty: nothing is drawn.
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
 * The ONE alarm (D16): the first time an item the owner must answer is the head, the strip raises
 * `raiseAskAttention` once (`headAlarmOnce`: a remount does not ring it again); a question's
 * banner is the server's (lib/super/owner-question.ts), so it reaches him off this stage too. Children raise nothing themselves while handed over.
 *
 * ONE answer per head item: the first click on Allow, Deny or an option latches that item, so a
 * double-click (two clicks before React re-renders) sends one answer. A new head, or the same
 * request re-sent by the server (the answer never landed), reopens it. The latch is the one the
 * super chat's question card shares (superQuestions.ts): a pick in either place locks both.
 */
export function JobBar({ state, head, waiting, vault, rect, look, superSession, sessionFor, titleFor, onReplyToSuper }: {
  state: SuperStateView;
  head: SuperQueueItem | null;
  /** The top band above the centre (planStage's `queue`). */
  rect: Rect;
  look: JobLook;
  superSession: ChatSession | undefined;
  /** How many items wait on the owner in all (the head included). */
  waiting: number;
  vault: string;
  sessionFor: (claudeId: string) => ChatSession | undefined;
  titleFor: (claudeId: string) => string;
  onReplyToSuper: () => void;
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
  const optionLabels = head && head.kind === 'question' ? ownerOptionsOf(head, child) : [];
  const fitKey = answerKey === null ? null
    : [answerKey, titleFor(head?.sessionId ?? ''), waiting > 1 ? waiting - 1 : 0, t('super.queue.reply'), ...optionLabels, ...(head?.kind === 'ask' ? head.options ?? [] : [])].join('\u0001');
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

  const superId = superSession?.claudeId ?? null;
  const serverBanner = !!head && (state.bannered ?? []).includes(head.id);
  useEffect(() => {
    if (!head || !headAlarmOnce(vault, head)) return;
    // The banner opens the super stage (`linkOpensSuperStage`). One the server posted (it
    // names it: lib/super/owner-question.ts) is not posted twice.
    raiseAskAttention({
      banner: !serverBanner,
      source: vault,
      detail: head.kind === 'permission' ? t('super.queue.permissionAlarm')
        : head.kind === 'approval' ? t('super.queue.approval').replace('{name}', head.member ?? '')
          : (head.ownerText ?? t('super.queue.escalatedAlarm')),
      sessionId: superId,
    });
  }, [head, vault, superId, t, serverBanner]);

  // Empty: nothing is drawn (the agenda, left of the stage, holds every count and row).
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
          <span className="super-queue-who">{head.kind === 'ask' ? look.superTitle : head.kind === 'approval' ? t('super.queue.team') : titleFor(head.sessionId)}</span>
          {head.kind === 'permission'
            ? <PermissionHead item={head} child={child} locked={locked} answerOnce={answerOnce} />
            : head.kind === 'ask'
              ? <AskHead item={head} superSession={superSession} locked={locked} answerOnce={answerOnce} onReplyToSuper={onReplyToSuper} showOptions={showOptions} />
              : head.kind === 'approval'
                ? <ApprovalHead item={head} onReplyToSuper={onReplyToSuper} />
              : <EscalatedHead item={head} child={child} locked={locked} answerOnce={answerOnce} onReplyToSuper={onReplyToSuper} showOptions={showOptions} />}
          {waiting > 1 && <span className="super-queue-more">{t('super.queue.more').replace('{n}', String(waiting - 1))}</span>}
      </div>
    </div>
  );
}

/** The answer an `ask` option sends: one definition, shared with the chat card. */
export { askAnswerText } from './superQuestions';

/**
 * The super agent's OWN question (`super ask`, D7): its text, its validated options as buttons
 * and Reply. Each option button measures its own overflow (r2-S): a label that does not fit
 * whole hides every option (Reply only), never a cut label; no `max-width` ellipsis here. A
 * click sends exactly the drawn label, framed, into the super chat (a running turn steers).
 */
function AskHead({ item, superSession, locked, answerOnce, onReplyToSuper, showOptions }: {
  item: SuperQueueItem;
  superSession: ChatSession | undefined;
  locked: boolean;
  answerOnce: (send: () => boolean | void) => void;
  onReplyToSuper: () => void;
  showOptions: boolean;
}) {
  const { t } = useI18n();
  const options = item.options ?? [];
  const btns = useRef<Array<HTMLButtonElement | null>>([]);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    setCut(btns.current.some((b) => !!b && b.scrollWidth > b.clientWidth + 1));
  }, [options.join('\u0001'), showOptions]);
  // The framed label into the super chat, never a child (sendOwnerAnswer: a running turn steers).
  const send = (label: string) => {
    const sent = sendOwnerAnswer(item, label, { superSession, child: undefined });
    if (sent) recordOwnerAnswer(item.id, label);
    return sent;
  };
  return (
    <>
      <QueueText full={item.ownerText ?? ''}>{item.ownerText ?? ''}</QueueText>
      <span className="super-queue-actions">
        {showOptions && !cut && superSession && options.map((label, i) => (
          <button
            key={label}
            ref={(el) => { btns.current[i] = el; }}
            type="button"
            className="super-queue-btn super-job-option"
            data-testid="super-ask-option"
            disabled={locked}
            onClick={() => answerOnce(() => send(label))}
          >{label}</button>
        ))}
        <button type="button" className="super-queue-btn super-queue-btn--reply" onClick={onReplyToSuper}>
          {t('super.queue.reply')}
        </button>
      </span>
    </>
  );
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

function PermissionHead({ item, child, locked, answerOnce }: {
  item: SuperQueueItem;
  child: ChatSession | undefined;
  locked: boolean;
  answerOnce: (send: () => boolean | void) => void;
}) {
  const { t } = useI18n();
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

function EscalatedHead({ item, child, locked, answerOnce, onReplyToSuper, showOptions }: {
  item: SuperQueueItem;
  child: ChatSession | undefined;
  locked: boolean;
  answerOnce: (send: () => boolean | void) => void;
  onReplyToSuper: () => void;
  /** False when the options do not all fit at full width: Reply only (`optionsFit`). */
  showOptions: boolean;
}) {
  const { t } = useI18n();
  // A single-choice single question gets its options as buttons: one click answers the child
  // exactly as its own card would (sendOwnerAnswer). Anything richer is answered by talking to
  // the Super Agent.
  const options = ownerOptionsOf(item, child);
  return (
    <>
      <QueueText full={item.ownerText ?? t('super.queue.escalatedAlarm')}>{item.ownerText ?? t('super.queue.escalatedAlarm')}</QueueText>
      <span className="super-queue-actions">
        {showOptions && child && options.map((label) => (
          <button
            key={label}
            type="button"
            className="super-queue-btn super-queue-btn--option"
            title={label}
            disabled={locked}
            onClick={() => answerOnce(() => {
              const sent = sendOwnerAnswer(item, label, { superSession: undefined, child });
              if (sent) recordOwnerAnswer(item.id, label);
              return sent;
            })}
          >{label}</button>
        ))}
        <button type="button" className="super-queue-btn super-queue-btn--reply" onClick={onReplyToSuper}>
          {t('super.queue.reply')}
        </button>
      </span>
    </>
  );
}
