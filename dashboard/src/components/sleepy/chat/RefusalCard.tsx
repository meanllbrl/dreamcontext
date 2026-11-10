import { useId, useState } from 'react';
import type { GrantSize, SuperQueueItem } from '../../../lib/superTypes';
import { useI18n } from '../../../context/I18nContext';
import { ToolBadge } from './atoms';
import { CardHeader } from './molecules';
import {
  allowAnswer, allowedWaiting, callOf, declineAnswer, grantChoices, refusalItemsOf, useOwnerAnswer, useSessionGrantItems, visibleText,
  type GrantChoices, type ShownCall, noAllowReasonKey } from '../super/ownerAnswer';

/**
 * A command the safety check refused, as a card in a chat (uye-bildirim K4, drawing B1): the
 * whole command, what happened ("Nothing ran"), and the sizes the server offers for it, picked
 * once, then Allow. Before this a refusal was a turn that ended "success" with nobody told.
 *
 * `GrantDecision` is the body every in-chat grant card shares: this card, the Super chat's member
 * card (SuperQuestionCard.tsx) and the member's own permission card (PermissionCard.tsx), so the
 * three sizes read the same wherever he meets them. It never builds a rule: it names a size, and
 * the server writes the grant from the item it stored.
 */

export interface DecisionWords {
  /** Who and what, one sentence (`{name} wanted to run this. Nothing ran.`). */
  lead: string;
  /** The member's title for "Always for <member>" (absent: main's crew, no member size). */
  memberName?: string;
}

/** The text of one size: the card's choice ("Always for this job") or, `menu`, the bar's
 *  Always menu entry ("For this job"), as the approved drawing words them (A2, B1). */
export function sizeWords(size: GrantSize, t: (k: string) => string, memberName: string | undefined, menu = false): { title: string; desc: string } {
  const name = memberName ?? '';
  if (size === 'once') return { title: t('owner.answer.allowOnce'), desc: t('owner.answer.onceDesc') };
  if (size === 'job') return { title: t(menu ? 'owner.answer.forJob' : 'owner.answer.alwaysJob'), desc: t('owner.answer.jobDesc') };
  return {
    title: t(menu ? 'owner.answer.forMember' : 'owner.answer.alwaysMember').replace('{name}', name),
    desc: t('owner.answer.memberDesc').replace('{name}', name),
  };
}

export function GrantDecision({ kind, call, choices, words, busy, onAllow, onDecline, onOpen }: {
  kind: 'permission' | 'refusal';
  call: ShownCall;
  choices: GrantChoices;
  words: DecisionWords;
  busy: boolean;
  onAllow: (size: GrantSize) => void;
  onDecline: () => void;
  /** Where he decides a call this card cannot allow: drawn as Open when no Allow is. */
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const [size, setSize] = useState<GrantSize>(choices.sizes[0] ?? 'once');
  // One radio group per card: two refusals of the same tool in one chat never share a choice.
  const group = useId();
  const pick = choices.sizes.includes(size) ? size : choices.sizes[0];
  const several = choices.sizes.length > 1;
  return (
    <div className="chat-permcard-body" data-testid="grant-decision" data-kind={kind}>
      <div className="chat-permcard-lead">
        <p className="chat-permcard-desc">{words.lead}</p>
        <pre className="chat-permcard-raw" data-testid="grant-command">{visibleText(call.input, true)}</pre>
        {choices.onceOnlyReason && <p className="chat-permcard-why" data-testid="grant-once-only">{choices.onceOnlyReason}</p>}
        {choices.sizes.length === 0 && (
          <p className="chat-permcard-why" data-testid="grant-none">{t(noAllowReasonKey(call, !!onOpen))}</p>
        )}
      </div>
      {several && (
        <div className="chat-permcard-details" role="radiogroup" aria-label={t('owner.answer.sizes')}>
          {choices.sizes.map((s) => {
            const w = sizeWords(s, t, words.memberName);
            return (
              <label key={s} className="chat-permcard-always" data-testid={`grant-size-${s}`} style={{ alignItems: 'flex-start' }}>
                <input type="radio" name={group} checked={pick === s} onChange={() => setSize(s)} disabled={busy} />
                <span>
                  <strong>{w.title}</strong>
                  <span className="chat-permcard-explainer" style={{ display: 'block' }}>{w.desc}</span>
                  {s !== 'once' && choices.notChecked && <span className="chat-permcard-explainer" style={{ display: 'block' }} data-testid="grant-not-checked">{choices.notChecked}</span>}
                  {s === 'member' && choices.rule && <code className="chat-permcard-raw" style={{ display: 'block' }} data-testid="grant-rule">{visibleText(choices.rule)}</code>}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <div className="chat-permcard-decide">
        <div className="chat-permcard-actions">
          <button type="button" className="chat-btn pill" data-testid="grant-decline" disabled={busy} onClick={onDecline}>
            {t(kind === 'refusal' ? 'owner.answer.notNeeded' : 'owner.answer.deny')}
          </button>
          {pick ? (
            <button type="button" className="chat-btn pill primary" data-testid="grant-allow" disabled={busy} onClick={() => onAllow(pick)}>
              {t(several ? 'owner.answer.allow' : 'owner.answer.allowOnce')}
            </button>
          ) : onOpen && !call.whole ? (
            // Nothing to allow here: the way to decide it, never only a button that refuses.
            <button type="button" className="chat-btn pill primary" data-testid="grant-open" onClick={onOpen}>{t('owner.answer.open')}</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One refused call of a session, answered in place (`via` names the surface for the server). */
export function RefusalCard({ record, item, who, memberName, via = 'member-chat', onOpen }: {
  record: string;
  item: SuperQueueItem;
  /** The session's name as the owner knows it ("Turing · Funnel QA"). */
  who: string;
  memberName?: string;
  via?: 'chat' | 'member-chat';
  /** Where the owner goes when this window cannot answer (no owner key, window closed). */
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const answer = useOwnerAnswer(record, item, via);
  const call = callOf(item);
  const choices = grantChoices(item, call, record);
  return (
    <div className="chat-permcard" data-testid="refusal-card" data-item={item.id}>
      <CardHeader glyph="⛔" title={t('owner.answer.refusedTitle')} aside={call ? <ToolBadge name={call.tool} /> : undefined} />
      {allowedWaiting(item) ? (
        // Already allowed, waiting for its chat to open: the line and Open, never a second Allow.
        <div className="chat-permcard-body">
          {call && <pre className="chat-permcard-raw" data-testid="grant-command">{visibleText(call.input, true)}</pre>}
          <p className="chat-permcard-why" data-testid="grant-allowed">{t('owner.answer.allowedWaiting')}</p>
          {onOpen && (
            <div className="chat-permcard-actions">
              <button type="button" className="chat-btn pill primary" data-testid="grant-open" onClick={onOpen}>{t('owner.answer.open')}</button>
            </div>
          )}
        </div>
      ) : call && !answer.fallback ? (
        <GrantDecision
          kind="refusal"
          call={call}
          choices={choices}
          words={{ lead: t('owner.answer.refusedLead').replace('{name}', who), ...(memberName ? { memberName } : {}) }}
          busy={answer.busy}
          onAllow={(size) => answer.submit(allowAnswer('refusal', size))}
          onDecline={() => answer.submit(declineAnswer('refusal'))}
          {...(onOpen ? { onOpen } : {})}
        />
      ) : (
        <div className="chat-permcard-body">
          <p className="chat-permcard-desc">{item.ownerText ?? t('owner.answer.refusedTitle')}</p>
          {onOpen && (
            <div className="chat-permcard-actions">
              <button type="button" className="chat-btn pill primary" data-testid="grant-open" onClick={onOpen}>{t('owner.answer.open')}</button>
            </div>
          )}
        </div>
      )}
      {answer.note && <p className="chat-permcard-explainer" data-testid="grant-note" style={{ padding: '0 var(--space-4) var(--space-4)' }}>{t(answer.note)}</p>}
    </div>
  );
}

/** Every open refusal of a session, for its own chat (the items the record's surface published). */
export function SessionRefusalCards({ sessionId, who }: { sessionId: string | null; who: string }) {
  const view = useSessionGrantItems(sessionId);
  const items = refusalItemsOf(view);
  if (!view || !items.length) return null;
  return (
    <>
      {items.map((q) => <RefusalCard key={q.id} record={view.record} item={q} who={who} {...(view.memberTitle ? { memberName: view.memberTitle } : {})} />)}
    </>
  );
}
