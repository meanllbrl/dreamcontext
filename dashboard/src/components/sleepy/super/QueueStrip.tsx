import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { raiseAskAttention } from '../../../lib/attention';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession, PendingPermission, PendingQuestion } from '../chatSession';
import {
  OPEN_LATCH, headAlarm, latchClick, latchSeen, optionsFit, permissionSummary, superAnswerPicks, type AnswerLatch, type OptionsFit,
} from './superHandover';
import type { Rect } from './superLayout';

/**
 * The ONE question queue (plan-r7 D7, D16, owner decision 2), as a pill centred in the top band
 * directly above the centre window (plan-r8 F7): the owner looks at the centre, so what he must
 * answer sits on its edge. It grows as an overlay anchored to the band (text, options, Reply)
 * and never moves the centre. Empty: nothing is drawn.
 *
 * Only what the OWNER must answer reaches it: a child's permission request (head of the line,
 * at once — the Super Agent never sees it) or a question the Super Agent escalated with its
 * own words. Everything it answers itself never shows here.
 *
 * A PERMISSION is drawn only from the CHILD's own pending request (tool name and input) and
 * Allow/Deny call that child's own `ChatSession.answer`, exactly what the child's tab card does
 * — no new privileged route, and the Super Agent's words never caption it. The server resolves
 * the item when the child leaves `asking`.
 *
 * The ONE alarm (D16): when the head CHANGES to an item the owner must answer, the strip raises
 * `raiseAskAttention` once. Children raise nothing themselves while handed over.
 *
 * ONE answer per head item: the first click on Allow, Deny or an option latches that item, so a
 * double-click (two clicks before React re-renders) sends one answer. A new head, or the same
 * request re-sent by the server (the answer never landed), reopens it.
 */
export function QueueStrip({ head, waiting, vault, rect, sessionFor, titleFor, onReplyToSuper }: {
  head: SuperQueueItem | null;
  /** The top band above the centre (planStage's `queue`). */
  rect: Rect;
  /** How many items wait on the owner in all (the head included). */
  waiting: number;
  vault: string;
  sessionFor: (claudeId: string) => ChatSession | undefined;
  titleFor: (claudeId: string) => string;
  onReplyToSuper: () => void;
}) {
  const { t } = useI18n();
  const child = head ? sessionFor(head.sessionId) : undefined;
  const [, force] = useReducer((n: number) => n + 1, 0);
  // Follow the head's child only: its pending request is what the strip draws.
  useEffect(() => (child ? child.subscribe(() => force()) : undefined), [child]);

  // One answer per head item (`latchSeen` / `latchClick`). A ref, not state: the second click of
  // a double-click must see the first one's latch before any re-render.
  const latch = useRef<AnswerLatch>(OPEN_LATCH);
  const answerKey = head ? `${head.id}:${head.requestId ?? ''}` : null;
  const requestId = head?.requestId;
  const pendingPresent = !!child && !!requestId && child.getModel().pending.some((p) => p.requestId === requestId);
  latch.current = latchSeen(latch.current, answerKey, pendingPresent);
  const locked = answerKey !== null && latch.current.key === answerKey;
  const answerOnce = (send: () => void) => {
    if (!answerKey) return;
    const next = latchClick(latch.current, answerKey, child?.status === 'open');
    latch.current = next.latch;
    if (!next.send) return;
    send();
    force();
  };

  // Option buttons at full width or not at all (`optionsFit`), never decided on hover. The fit is
  // keyed on everything the row holds (the head, the who, the "n more", the option labels, the
  // locale), so a content change inside a full-width pill, which resizes no box, starts shown
  // and is measured again; measured in a layout effect on every show/hide too, before paint.
  const pendingQuestion = head && head.kind !== 'permission'
    ? child?.getModel().pending.find((p): p is PendingQuestion => p.kind === 'question' && p.requestId === head.requestId)
    : undefined;
  const optionLabels = pendingQuestion && pendingQuestion.questions.length === 1 && !pendingQuestion.questions[0].multiSelect
    ? pendingQuestion.questions[0].options.slice(0, 4).map((o) => o.label)
    : [];
  const fitKey = answerKey === null ? null
    : [answerKey, titleFor(head?.sessionId ?? ''), waiting > 1 ? waiting - 1 : 0, t('super.queue.reply'), ...optionLabels].join('\u0001');
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

  const alarmKey = useRef<string | null>(null);
  useEffect(() => {
    const next = headAlarm(alarmKey.current, head);
    alarmKey.current = next.key;
    if (!next.raise || !head) return;
    // No `sessionId`: the banner brings the PROJECT forward (a link to the Super Agent's own
    // conversation would open it as a tab, which it never is).
    raiseAskAttention({
      source: vault,
      detail: head.kind === 'permission' ? t('super.queue.permissionAlarm') : (head.ownerText ?? t('super.queue.escalatedAlarm')),
    });
  }, [head, vault, t]);

  return (
    <div
      className="super-queue-strip"
      data-testid="super-queue-strip"
      data-empty={head ? undefined : 'true'}
      role="region"
      aria-label={t('super.queue.label')}
      style={{ left: rect.x, top: rect.y, width: rect.width, minHeight: rect.height }}
    >
      {!head ? null : (
        <div ref={headRef} className="super-queue-head" data-testid="super-queue-head" data-kind={head.kind} data-state={head.state} data-options={showOptions ? undefined : 'reply-only'}>
          <span className="super-queue-who">{titleFor(head.sessionId)}</span>
          {head.kind === 'permission'
            ? <PermissionHead item={head} child={child} locked={locked} answerOnce={answerOnce} />
            : <EscalatedHead item={head} child={child} locked={locked} answerOnce={answerOnce} onReplyToSuper={onReplyToSuper} showOptions={showOptions} />}
          {waiting > 1 && <span className="super-queue-more">{t('super.queue.more').replace('{n}', String(waiting - 1))}</span>}
        </div>
      )}
    </div>
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
  answerOnce: (send: () => void) => void;
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

function EscalatedHead({ item, child, locked, answerOnce, onReplyToSuper, showOptions }: {
  item: SuperQueueItem;
  child: ChatSession | undefined;
  locked: boolean;
  answerOnce: (send: () => void) => void;
  onReplyToSuper: () => void;
  /** False when the options do not all fit at full width: Reply only (`optionsFit`). */
  showOptions: boolean;
}) {
  const { t } = useI18n();
  const question = child?.getModel().pending.find(
    (p): p is PendingQuestion => p.kind === 'question' && p.requestId === item.requestId,
  );
  // A single-choice single question gets its options as buttons: one click answers the child
  // exactly as its own card would. Anything richer is answered by talking to the Super Agent.
  const q = question && question.questions.length === 1 && !question.questions[0].multiSelect ? question.questions[0] : null;
  return (
    <>
      <QueueText full={item.ownerText ?? t('super.queue.escalatedAlarm')}>{item.ownerText ?? t('super.queue.escalatedAlarm')}</QueueText>
      <span className="super-queue-actions">
        {showOptions && child && question && q && q.options.slice(0, 4).map((o) => (
          <button
            key={o.label}
            type="button"
            className="super-queue-btn super-queue-btn--option"
            title={o.label}
            disabled={locked}
            onClick={() => {
              const picks = superAnswerPicks(question.questions, [o.label]);
              if (picks.ok) answerOnce(() => child.answerQuestion(question.requestId, question.questions, picks.picked, picks.notes));
            }}
          >{o.label}</button>
        ))}
        <button type="button" className="super-queue-btn super-queue-btn--reply" onClick={onReplyToSuper}>
          {t('super.queue.reply')}
        </button>
      </span>
    </>
  );
}
