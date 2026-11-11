import { Suspense, lazy, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import { useI18n } from '../../../context/I18nContext';
import { useApi, useVaultId } from '../../../context/VaultContext';
import { cardNotNeeded, useCardState, type CardStateView } from '../../../lib/cardRecords';
import type { RunCard as RunCardT } from '../chat/RunCard';
import type { SecretCard as SecretCardT } from '../chat/SecretCard';
import type { ChecklistCard as ChecklistCardT } from '../chat/ChatViews';
import { CardHeader } from '../chat/molecules';
import '../chat/AgentThreadCard.css';
import { mountOwnerSlot, openJobRow, takeSlotRun, useSlotRunRequest } from './superJobsStore';
import { MAIN_RECORD, claimOwnerItem, releaseOwnerItem, visibleText } from './ownerAnswer';

/**
 * The owner-card SLOT in the Super chat (sahip-karti-yerinde K7), kept apart from the question
 * card (SuperQuestionCard.tsx), which only ever mounts the chat's own AskUserQuestion card.
 */

/** The live-children cap a held result names (K6/K7): 15 for main's crew, 2 for a member's. */
export function heldCapOf(childRecordId: string): number {
  return childRecordId === MAIN_RECORD ? 15 : 2;
}

/** The slot's one true result line (w2-shared), an i18n key and its filled words; null when the
 *  item has no result yet. */
export function deliveryLine(item: Pick<SuperQueueItem, 'delivery' | 'card'>, child: string, t: (k: string) => string): string | null {
  if (!item.delivery) return null;
  const n = String(heldCapOf(item.card?.childRecordId ?? MAIN_RECORD));
  return t(`ownerCard.delivery.${item.delivery}`).replace('{child}', child).replace('{n}', n);
}

/**
 * What the slot's header says, from the item (the screen tells the truth): "<child> needs you"
 * only while the card waits on the owner; once his action has a result (`delivery`) or the item
 * closed, "<child>: done"; a child the Super ended, "<child>: ended".
 */
export function slotTitleKey(item: Pick<SuperQueueItem, 'state' | 'delivery'>): string {
  if (item.delivery === 'ended') return 'ownerCard.endedTitle';
  if (item.delivery || item.state === 'done') return 'ownerCard.doneTitle';
  return 'ownerCard.needsYouTitle';
}

/** The time a kept entry was written, as the owner reads it. */
function keptTime(at: number, locale: string): string {
  if (!at) return '';
  try { return new Date(at).toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/** The cards the slot mounts: the very ones the child's chat draws. Loaded on first use, so this
 *  module (and every test that draws a question card) does not pull the terminal in. */
export interface SlotCards {
  RunCard: ComponentType<Parameters<typeof RunCardT>[0]>;
  SecretCard: ComponentType<Parameters<typeof SecretCardT>[0]>;
  ChecklistCard: ComponentType<Parameters<typeof ChecklistCardT>[0]>;
}
const LAZY_CARDS: SlotCards = {
  RunCard: lazy(() => import('../chat/RunCard').then((m) => ({ default: m.RunCard }))),
  SecretCard: lazy(() => import('../chat/SecretCard').then((m) => ({ default: m.SecretCard }))),
  ChecklistCard: lazy(() => import('../chat/ChatViews').then((m) => ({ default: m.ChecklistCard }))),
};

/**
 * THE SLOT (sahip-karti-yerinde K7): a card a child left for the owner, drawn in the Super chat
 * from the RECORD the owner item carries (`item.card`), never from chat text and never written by
 * the Super. It mounts the very cards the child's own chat draws (`RunCard`, `SecretCard`, the
 * checklist card) with a record host, so every press goes through the same gate (a ticket, the
 * owner key, the checklist window's nonce). After the action it says, in one line, where the
 * result went (`item.delivery`). A result kept from before a restart is drawn read-only, as plain
 * text, beside the card's own action; a card the transcript no longer holds offers only Not needed.
 */
export function OwnerCardSlot({ item, title, paused, cards = LAZY_CARDS, cardState }: {
  item: SuperQueueItem;
  title: string;
  paused: boolean;
  /** Tests only: the card components (the lazy real ones by default). */
  cards?: SlotCards;
  /** Tests only: the card's state instead of reading it from the server. */
  cardState?: CardStateView | null;
}) {
  const { RunCard, SecretCard, ChecklistCard } = cards;
  const { t, locale } = useI18n();
  const api = useApi();
  const { vault } = useVaultId();
  const handle = item.card;
  const open = item.state !== 'done';
  const fetched = useCardState(vault ?? null, cardState === undefined ? handle : undefined, `${item.state}\u0001${item.delivery ?? ''}`);
  const state = cardState === undefined ? fetched.state : cardState;
  const reload = fetched.reload;
  useEffect(() => mountOwnerSlot(item.id), [item.id]);
  const runRequest = useSlotRunRequest(item.id);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!handle) return null;
  const spec = handle.spec;
  const child = title || t('ownerCard.theJob');
  const views = (state?.views ?? []).filter((v) => v.cardRef === handle.cardRef);
  const kept = views.filter((v) => v.state === 'kept');
  const cutOff = views.some((v) => v.state === 'cut_off') || !!state?.cutOff;
  const line = deliveryLine(item, child, t);
  const host = { record: handle, open };

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
  const showJob = () => openJobRow(`c:${item.sessionId}`);

  let body: ReactNode;
  if (state?.gone) {
    body = <p className="chat-agentthread-note" data-testid="super-owner-gone">{t('ownerCard.gone')}</p>;
  } else if (spec.type === 'run') {
    body = <RunCard spec={spec} host={host} folder={state?.folder} startRequest={runRequest} onEnded={reload} onStartRequest={(n) => takeSlotRun(item.id, n)} />;
  } else if (spec.type === 'secret') {
    body = <SecretCard spec={spec} host={host} folder={state?.folder} reentry={open && kept.some((k) => k.kind === 'secret')} onSaved={reload} />;
  } else if (spec.type === 'checklist') {
    body = <ChecklistCard spec={spec} host={host} />;
  } else {
    // MCP (D6): connecting goes through the child's own live process; here it is the line, Open
    // and Not needed, and the wait no longer gets lost.
    const names = spec.servers.join(', ');
    body = <p className="chat-agentthread-note" data-testid="super-owner-mcp">{spec.why ? visibleText(spec.why) : t('ownerCard.mcpLine').replace('{names}', names)}</p>;
  }

  return (
    <div
      className="chat-viewcard chat-agentthread"
      data-testid="super-owner-card"
      data-item={item.id}
      data-kind={spec.type}
      data-delivery={item.delivery}
      data-state={open ? 'open' : 'closed'}
    >
      <CardHeader
        glyph={spec.type === 'run' ? '>_' : spec.type === 'secret' ? '🔑' : spec.type === 'checklist' ? '☑' : '⇄'}
        title={t(slotTitleKey(item)).replace('{name}', child)}
        aside={paused ? <span className="chat-runcard-exit is-unknown" data-testid="super-owner-paused">{t('ownerCard.paused')}</span> : undefined}
      />
      {cutOff && spec.type === 'run' && (
        <p className="chat-agentthread-note" data-testid="super-owner-cutoff">{t('ownerCard.cutOff')}</p>
      )}
      {!cutOff && kept.map((k) => (
        <div key={k.id} data-testid="super-owner-kept">
          <p className="chat-agentthread-note">{t('ownerCard.kept')}{keptTime(k.at, locale) ? ` · ${keptTime(k.at, locale)}` : ''}</p>
          {/* PLAIN TEXT, never markdown: a same-user process can write this file. */}
          <pre className="chat-agentthread-note" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{k.text}</pre>
        </div>
      ))}
      <Suspense fallback={null}>{body}</Suspense>
      {spec.type === 'run' && (cutOff || kept.length > 0) && (
        <p className="chat-agentthread-note" data-testid="super-owner-runagain">{t('ownerCard.runAgainNote')}</p>
      )}
      {line && <p className="chat-agentthread-note" data-testid="super-owner-result">{line}</p>}
      {open && (
        <div className="chat-agentthread-actions">
          {spec.type === 'mcp' && (
            <button type="button" className="chat-agentthread-btn is-primary" data-testid="super-owner-open" onClick={showJob}>{t('ownerCard.openJob')}</button>
          )}
          <button type="button" className="chat-agentthread-btn" data-testid="super-owner-not-needed" disabled={busy} onClick={notNeeded}>
            {t('owner.answer.notNeeded')}
          </button>
        </div>
      )}
      {note && <p className="chat-agentthread-note" data-testid="super-owner-note">{note}</p>}
    </div>
  );
}
