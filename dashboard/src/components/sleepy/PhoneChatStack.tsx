import { useEffect, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import './MobileChat.css';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { pollMs } from '../../lib/windowActivity';
import type { LiveChatWire, LiveChatsWire } from '../handsfree/macContract';
import type { ChatSession } from './chatSession';
import { chatLastLine, stackRows, stackTap, type StackRow, type StackTab } from './phoneStack';
import { recentlyClosed } from './phoneClosed';

/**
 * The phone's chat STACK (AC19): every other open chat as a one-line row ABOVE the focused one —
 * the phone's answer to the desktop's side-by-side panes. A row is the desktop tab's own pieces
 * (its status dot and title), the state in words, and the chat's last line; a chat waiting for
 * you sorts first and is marked. With no other open chat it renders nothing, so a single chat
 * looks exactly as it did.
 *
 * The Mac's live chats are polled only while the phone chat is on screen (`polling`); this
 * phone's own tabs re-render from their sessions, throttled, so a streaming turn moves the last
 * line without re-rendering the surface on every token.
 */

const LINE_THROTTLE_MS = 400;

export function PhoneChatStack({
  tabs, activeId, vault, polling, sessionFor, onSelect, onAdopt, onSwap,
}: {
  tabs: StackTab[];
  activeId: string;
  vault: string;
  /** Mac mode's phone with the chat on screen: poll the Mac's running chats. */
  polling: boolean;
  sessionFor: (id: string) => ChatSession | undefined;
  onSelect: (paneId: string, id: string) => void;
  onAdopt: (chat: LiveChatWire) => void;
  /** Called on every tap, before the switch, so the surface can play the swap. */
  onSwap: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const { data: live } = useQuery({
    queryKey: ['mac-live-chats'],
    queryFn: () => api.get<LiveChatsWire>('/agent/live-chats'),
    enabled: polling,
    refetchInterval: polling ? () => pollMs(3_000) : false,
    staleTime: 2_000,
    retry: false,
  });
  // A chat closed here a moment ago is still exiting on the Mac: not a row.
  const rows = stackRows({ tabs, activeId, live: polling ? live?.chats ?? [] : [], draining: [...(live?.draining ?? []), ...recentlyClosed()], vault });

  // The rows' last lines follow their sessions. One throttled tick for the whole stack.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const tabIds = rows.filter((r) => r.kind === 'tab').map((r) => r.id).join('|');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => { if (!timer) timer = setTimeout(() => { timer = null; tick(); }, LINE_THROTTLE_MS); };
    const offs = tabIds ? tabIds.split('|').map((id) => sessionFor(id)?.subscribe(bump)) : [];
    return () => { for (const off of offs) off?.(); if (timer) clearTimeout(timer); };
  }, [tabIds, sessionFor]);

  if (rows.length === 0) return null;

  const tap = (row: StackRow) => {
    onSwap();
    const d = stackTap(row);
    if ('select' in d) onSelect(d.select.paneId, d.select.id);
    else onAdopt(d.adopt);
  };
  const lineOf = (row: StackRow): string => {
    if (row.kind === 'mac') return row.lastLine;
    const s = sessionFor(row.id);
    return s && s.kind === 'chat' ? chatLastLine(s.getModel()) : '';
  };

  return (
    <ul className="mchat-stack" aria-label={t('handsfree.mac.stack')} data-testid="phone-stack">
      {rows.map((row) => {
        const title = row.title || t('handsfree.mac.untitled');
        const state = row.stateKey ? t(row.stateKey) : row.kind === 'tab' ? row.label : '';
        const line = lineOf(row);
        return (
          <li key={row.key} className="mchat-stack-item">
          <button
            className="mchat-stack-row"
            data-testid="phone-stack-row"
            data-kind={row.kind}
            data-id={row.id}
            data-waiting={row.waiting ? 'true' : undefined}
            onClick={() => tap(row)}
            title={row.kind === 'mac' ? `${title} · ${t('handsfree.mac.onMac')}` : title}
          >
            <span className="mchat-stack-chip">
              <span className="agent-tab-dot" data-kind={row.dot} aria-hidden />
              <span className="mchat-stack-title">{title}</span>
            </span>
            <span className="mchat-stack-state" data-testid="phone-stack-state">{state}</span>
            {line && <span className="mchat-stack-line">{line}</span>}
          </button>
          </li>
        );
      })}
    </ul>
  );
}
