import { useEffect, useReducer, useState, type ReactNode } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession, PendingPermission } from '../chatSession';
import { noteOwnerWrote } from '../../../lib/ownerAtMac';
import { permissionSummary } from './superHandover';
import { MAIN_RECORD, allowAnswer, grantChoices, useOwnerAnswer, visibleText } from './ownerAnswer';
import {
  claimOwnerAnswer, noteOwnerPending, ownerAnswerKey, ownerAnswerLocked, ownerPendingPresent, releaseOwnerAnswer, useOwnerAnswerVersion,
} from './superQuestions';
import type { SuperRemoteQuestions } from './superJobsStore';
import type { PhonePermission } from './usePhoneSuperQuestions';
import { useI18n } from '../../../context/I18nContext';
import { CardHeader } from '../chat/molecules';
import { ToolBadge, CodeSentence } from '../chat/atoms';
import { PermissionDetails } from '../chat/PermissionDetails';
import { permissionReasonLine } from '../chat/permissionReason';

/** The phone's Allow / Deny for a child's permission: the chat's PermissionCard, read the same
 *  way (owner 2026-11-05). What happens in words, one line on why it asks, the command folded
 *  behind "Show command" (plain text, never HTML). A refusal that may land again re-enables the
 *  buttons and says why; a stale one waits for the next read to take the card away. */
export function RemotePermission({ item, perm, answer }: {
  item: SuperQueueItem;
  perm: PhonePermission;
  answer: NonNullable<SuperRemoteQuestions['answerPermission']>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (choice: 'allow' | 'deny') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void answer(item, choice).then((r) => {
      if (r.ok) return;
      setBusy(!r.retry);
      if (r.retry) setError(r.error ?? 'network');
    });
  };
  // The phone does not know the child's mode: without the CLI's reason, no line at all.
  const reasonLine = permissionReasonLine({ reason: perm.reason, reasonType: perm.reasonType });
  const reason = !reasonLine ? '' : 'key' in reasonLine ? t(reasonLine.key) : reasonLine.text;
  const lead = perm.description || t('super.queue.permissionRemote');
  return (
    <div data-testid="super-question-card" data-state="open" data-item={item.id} data-kind="permission">
      <div className="chat-permcard">
        <CardHeader glyph="🔓" title={t('perm.title')} aside={<ToolBadge name={perm.tool} />} />
        <div className="chat-permcard-body">
          <div className="chat-permcard-lead">
            <p className="chat-permcard-desc"><CodeSentence text={lead} /></p>
            {reason && <p className="chat-permcard-why" data-testid="permission-why">{reason}</p>}
          </div>
          {perm.text && (
            <div data-testid="super-permission-text">
              {perm.tool === 'Bash' ? <PermissionDetails command={perm.text} /> : <PermissionDetails command={null} input={perm.text} />}
            </div>
          )}
          <div className="chat-permcard-decide">
            <div className="chat-permcard-actions">
              <button type="button" className="chat-btn pill" disabled={busy} onClick={() => decide('deny')} data-testid="super-permission-deny">{t('perm.deny')}</button>
              <button type="button" className="chat-btn pill primary" disabled={busy} onClick={() => decide('allow')} data-testid="super-permission-allow">{t('perm.allow')}</button>
            </div>
          </div>
          {error && <p className="chat-permcard-explainer" role="alert">{t('super.queue.permissionFailed')} ({error})</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * A child's permission on the MAC (super-v3 D8): a card in the Super chat, never the stage's top
 * band. The same card as the chat's PermissionCard (what happens, why it asks, the command in a
 * mono box) with the Mac's three answers: Don't allow, Always for this job (only when the stored
 * item offers that size), Allow once (primary). Drawn only from the CHILD's own pending request;
 * Allow once and Don't allow are the child's own `ChatSession.answer`, exactly as its tab's card
 * and the band answered it; Always goes through the owner-answer route with what was shown. ONE
 * answer per request: the same latch the band used (`claimOwnerAnswer`), so a double-click sends
 * one, and a request the server re-sends reopens it.
 */
export function MacPermission({ item, child, title, scope, record = MAIN_RECORD }: {
  item: SuperQueueItem;
  /** The record the item lives in (main's, or a member's on its own stage). */
  record?: string;
  child: ChatSession | undefined;
  /** The asking job's name. */
  title: string;
  /** The Super session this record belongs to (the latch's scope). */
  scope: string;
}) {
  const { t } = useI18n();
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (child ? child.subscribe(() => force()) : undefined), [child]);
  const wide = useOwnerAnswer(record, item, 'chat');
  useOwnerAnswerVersion();
  const key = ownerAnswerKey(item);
  noteOwnerPending(key, ownerPendingPresent(item, child, []));
  const locked = ownerAnswerLocked(key);
  const pending = child?.getModel().pending.find(
    (p): p is PendingPermission => p.kind === 'permission' && p.requestId === item.requestId,
  );
  const wrap = (body: ReactNode) => (
    <div data-testid="super-question-card" data-state="open" data-item={item.id} data-kind="permission">
      <div className="chat-permcard" data-testid="super-permission-mac">
        <CardHeader glyph="🔓" title={t('super.perm.title').replace('{name}', title)} aside={pending ? <ToolBadge name={pending.displayName || pending.toolName} /> : undefined} />
        <div className="chat-permcard-body">{body}</div>
      </div>
    </div>
  );
  // The child's request is not (yet) in this window: nothing to answer from here.
  if (!child || !pending) return wrap(<p className="chat-permcard-desc">{t('super.queue.permissionWaiting')}</p>);
  const answerOnce = (send: () => boolean) => {
    if (!claimOwnerAnswer(key, item.id, scope, child.status === 'open')) return;
    if (send()) noteOwnerWrote();
    else releaseOwnerAnswer(key);
  };
  const command = typeof (pending.input as { command?: unknown } | null)?.command === 'string' ? (pending.input as { command: string }).command : null;
  const choices = grantChoices(item, { tool: pending.toolName, input: command ?? JSON.stringify(pending.input ?? null), whole: true }, record);
  const reasonLine = permissionReasonLine({ reason: pending.decisionReason, reasonType: pending.decisionReasonType });
  const reason = !reasonLine ? '' : 'key' in reasonLine ? t(reasonLine.key) : reasonLine.text;
  const lead = pending.description || visibleText(permissionSummary(pending.input));
  const job = choices.sizes.includes('job') && !pending.suppressAlwaysAllow;
  return wrap(
    <>
      <div className="chat-permcard-lead">
        <p className="chat-permcard-desc"><CodeSentence text={lead} /></p>
        {reason && <p className="chat-permcard-why" data-testid="permission-why">{reason}</p>}
        {choices.onceOnlyReason && <p className="chat-permcard-why" data-testid="super-permission-once-only">{choices.onceOnlyReason}</p>}
      </div>
      <div data-testid="super-permission-text">
        {command !== null ? <PermissionDetails command={command} startOpen /> : <PermissionDetails command={null} input={pending.input} />}
      </div>
      <div className="chat-permcard-decide">
        <div className="chat-permcard-actions">
          <button type="button" className="chat-btn pill" disabled={locked} data-testid="super-permission-deny"
            onClick={() => answerOnce(() => child.answer(pending.requestId, { behavior: 'deny', message: 'Denied by user.' }))}
          >{t('super.perm.dontAllow')}</button>
          {job && (
            <button type="button" className="chat-btn pill" disabled={locked || wide.busy} data-testid="super-permission-job"
              onClick={() => { if (!locked) wide.submit(allowAnswer('permission', 'job')); }}
            >{t('owner.answer.alwaysJob')}</button>
          )}
          <button type="button" className="chat-btn pill primary" disabled={locked} data-testid="super-permission-allow"
            onClick={() => answerOnce(() => child.answer(pending.requestId, { behavior: 'allow', updatedInput: pending.input }))}
          >{t('owner.answer.allowOnce')}</button>
        </div>
      </div>
      {wide.note && <p className="chat-permcard-explainer" role="alert">{t(wide.note)}</p>}
    </>,
  );
}

/** The words of a job's folded allow line: "inside this job's own folder" only when EVERY logged
 *  command stayed there (the server's `allowsLine`, mirrored). Null with nothing logged. */
export function allowsLineKey(entries: readonly { inFolder?: boolean }[]): { key: string; n: number } | null {
  const n = entries.length;
  if (!n) return null;
  const folder = entries.every((e) => e.inFolder === true);
  return { key: `super.allows.${n === 1 ? 'one' : 'many'}${folder ? 'Folder' : ''}`, n };
}

/**
 * What the Super allowed a job on its own (super-v3 D8, K5): ONE folded line under its messages,
 * "Claude allowed N commands inside this job's own folder · Show", the commands (their redacted
 * one-line summaries, newest last) behind Show. Nothing to answer: a record, never a question.
 */
export function SuperAllowsLine({ entries, title }: { entries: readonly { at: number; summary: string; inFolder?: boolean }[]; title: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const line = allowsLineKey(entries);
  if (!line) return null;
  return (
    <div className="super-allows" data-testid="super-allows-line">
      <p className="super-allows-head">
        {title && <span className="super-allows-who">{title}</span>}
        <span>{t(line.key).replace('{n}', String(line.n))}</span>
        <button type="button" className="super-allows-toggle" aria-expanded={open} data-testid="super-allows-toggle" onClick={() => setOpen((o) => !o)}>
          {t(open ? 'super.allows.hide' : 'super.allows.show')}
        </button>
      </p>
      {open && (
        <ul className="super-allows-list" data-testid="super-allows-list">
          {entries.map((e, i) => <li key={`${e.at}-${i}`}><code>{e.summary}</code></li>)}
        </ul>
      )}
    </div>
  );
}
