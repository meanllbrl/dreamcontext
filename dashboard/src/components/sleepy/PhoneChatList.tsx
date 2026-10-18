import { useEffect, useReducer, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import './MobileChat.css';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useChrome } from '../layout/WindowChrome';
import { pollMs } from '../../lib/windowActivity';
import type { LiveChatWire, LiveChatsWire } from '../handsfree/macContract';
import { PhoneChip } from '../handsfree/phone/PhoneChip';
import { PushOptIn } from '../handsfree/phone/PushOptIn';
import type { PastSession } from './ChatHistoryPicker';
import type { ChatSession } from './chatSession';
import { pastTap } from './drawerRows';
import { markClosed, recentlyClosed } from './phoneClosed';
import { chatLastLine, heldIds, type StackTab } from './phoneStack';
import {
  ageLabel, chatLastTs, chatSearchText, closedRows, highlight, listTap, listView, openMatches, openRows, queryTokens,
  type ClosedRow, type ListFilter, type OpenRow,
} from './phoneList';
import { fill } from '../../lib/fill';

/**
 * The phone's home on Mac mode: the Sohbetler list (AC21-AC22). Every chat of the project, open
 * ones first by what they need from you, closed ones newest first; a search over titles and your
 * messages; Tümü / Açık / Kapalı chips. A tap opens the chat; the chat's ‹ comes back here.
 *
 * It takes over the drawer's other duties too: switching between the chosen projects, the
 * notifications row, and the way out to the rest of the dashboard.
 *
 * Closed chats are searched on the Mac (`/agent/chat-sessions?q=`: titles and your messages,
 * never Claude's answers — the index the desktop picker already keeps); open ones here, over
 * their title, last line and, for this phone's own tabs, the loaded conversation.
 */

const PAST_LIMIT = 50;
const QUERY_DEBOUNCE_MS = 200;
const LINE_THROTTLE_MS = 400;
/** A closed row's re-check gives up after this and resumes: a stalled tunnel must not hold the tap. */
const RECHECK_TIMEOUT_MS = 5_000;

interface ChatSessionsResponse { sessions: PastSession[]; total: number }

function Marked({ text, tokens }: { text: string; tokens: readonly string[] }) {
  return <>{highlight(text, tokens).map((p, k) => (p.hit ? <mark key={k} className="mlist-hit">{p.text}</mark> : <span key={k}>{p.text}</span>))}</>;
}

export function PhoneChatList({
  tabs, vault, active, sessionFor, onSelect, onCloseSession, onAdopt, onResume, onNewChat, onExitToDashboard,
}: {
  tabs: StackTab[];
  vault: string;
  /** The list is on screen: poll the Mac and read past chats only then. */
  active: boolean;
  sessionFor: (id: string) => ChatSession | undefined;
  onSelect: (paneId: string, id: string) => void;
  /** Close one of this phone's tabs (its conversation then lists under Kapalı). */
  onCloseSession: (id: string) => void;
  onAdopt: (chat: LiveChatWire) => void;
  onResume: (past: PastSession) => void;
  onNewChat: () => void;
  onExitToDashboard: () => void;
}) {
  const api = useApi();
  const chrome = useChrome();
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [filter, setFilter] = useState<ListFilter>('all');
  // The list covers the chat, which stays mounted beneath it: take the chat out of the tab order
  // and the accessibility tree while the list is up, and put focus on the list's heading.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    const covered = el?.parentElement ? [...el.parentElement.children].filter((c) => c !== el && !c.hasAttribute('inert')) : [];
    for (const c of covered) c.setAttribute('inert', '');
    el?.querySelector<HTMLElement>('.mlist-h')?.focus({ preventScroll: true });
    return () => { for (const c of covered) c.removeAttribute('inert'); };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDq(q.trim()), q ? QUERY_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [q]);

  const { data: vaultsResp } = useQuery({
    queryKey: ['mac-phone-vaults'],
    queryFn: () => api.get<{ vaults: Array<{ name: string; exists: boolean }> }>('/vaults'),
    enabled: active,
    staleTime: 30_000,
    retry: false,
  });
  const projects = (vaultsResp?.vaults ?? []).filter((v) => v.exists);
  const { data: live } = useQuery({
    queryKey: ['mac-live-chats'],
    queryFn: () => api.get<LiveChatsWire>('/agent/live-chats'),
    enabled: active,
    refetchInterval: active ? () => pollMs(3_000) : false,
    staleTime: 2_000,
    retry: false,
  });
  const { data: past, isLoading: pastLoading } = useQuery({
    queryKey: ['phone-list-past', dq],
    queryFn: () => api.get<ChatSessionsResponse>(`/agent/chat-sessions?limit=${PAST_LIMIT}&q=${encodeURIComponent(dq)}`),
    enabled: active,
    // A chat closed here lands under Kapalı once its process has exited: re-read while on screen
    // (the Mac's index is memoized, so this is a pass over memory).
    refetchInterval: active ? () => pollMs(10_000) : false,
    staleTime: 5_000,
    placeholderData: (prev) => prev,
    retry: false,
  });

  // The open rows' last lines follow their sessions: one throttled tick for the whole list.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const tabIds = tabs.map((x) => x.id).join('|');
  useEffect(() => {
    if (!active) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => { if (!timer) timer = setTimeout(() => { timer = null; tick(); }, LINE_THROTTLE_MS); };
    const offs = tabIds ? tabIds.split('|').map((id) => sessionFor(id)?.subscribe(bump)) : [];
    return () => { for (const off of offs) off?.(); if (timer) clearTimeout(timer); };
  }, [active, tabIds, sessionFor]);

  const tokens = queryTokens(dq);
  const chats = live?.chats ?? [];
  const lineOf = (row: OpenRow): string => {
    if (row.kind === 'mac') return row.lastLine;
    const s = sessionFor(row.id);
    return s && s.kind === 'chat' ? chatLastLine(s.getModel()) : '';
  };
  // A chat closed here a moment ago is still exiting on the Mac: neither open nor closed yet.
  const draining = [...(live?.draining ?? []), ...recentlyClosed()];
  const open = openRows({ tabs, live: chats, draining, vault }).filter((row) => {
    if (!tokens.length) return true;
    const s = row.kind === 'tab' ? sessionFor(row.id) : undefined;
    return openMatches(tokens, row.title ?? '', lineOf(row), s && s.kind === 'chat' ? chatSearchText(s.getModel()) : '');
  });
  const pastSessions = past?.sessions ?? [];
  const closed = closedRows({
    past: pastSessions, live: chats, draining: live?.draining,
    openClaudeIds: heldIds(tabs),
  });
  const view = listView({ open, closed, closedTotal: past?.total ?? 0, closedDropped: pastSessions.length - closed.length, filter });

  // One tap, one chat: a closed row asks the Mac first (a round trip over the tunnel), and a
  // second tap meanwhile would resume the same conversation twice: two processes, one transcript.
  const tapping = useRef(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Every tap, and leaving the list, supersedes a closed row's re-check still in flight: a late
  // answer must not pull the owner out of the chat they went to meanwhile.
  const tapSeq = useRef(0);
  useEffect(() => () => { tapSeq.current++; }, []);
  const tap = async (row: OpenRow | ClosedRow) => {
    const seq = ++tapSeq.current;
    const d = listTap(row);
    // Open rows need no network: they never wait on a closed row's re-check.
    if ('select' in d) { onSelect(d.select.paneId, d.select.id); return; }
    if ('adopt' in d) { onAdopt(d.adopt); return; }
    if (tapping.current) return;
    tapping.current = true;
    setPendingId(row.id);
    try {
      // The lists may have raced: ask the Mac again, and adopt a chat that turned live (AC18).
      try {
        const fresh = await Promise.race([
          api.get<LiveChatsWire>('/agent/live-chats'),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), RECHECK_TIMEOUT_MS)),
        ]);
        if (seq !== tapSeq.current) return;
        const r = pastTap(d.resume.id, fresh.chats);
        if ('adopt' in r) { onAdopt(r.adopt); return; }
      } catch { /* unreachable or too slow: resume as before */ }
      if (seq !== tapSeq.current) return;
      onResume(d.resume);
    } finally {
      tapping.current = false;
      setPendingId(null);
    }
  };
  const age = (ms: number | null): string => {
    if (!ms) return '';
    const a = ageLabel(ms);
    return a === 'now' ? t('handsfree.list.now') : a;
  };

  // A tab's age is its loaded conversation's newest item, else the Mac's clock for that chat.
  const openAge = (row: OpenRow): number | null => {
    if (row.kind === 'mac') return row.chat.updatedAt;
    const s = sessionFor(row.id);
    const loaded = s && s.kind === 'chat' ? chatLastTs(s.getModel()) : null;
    if (loaded) return loaded;
    const held = tabs.find((x) => x.id === row.id);
    const ids = [held?.claudeId, held?.altClaudeId].filter(Boolean);
    return chats.find((c) => ids.includes(c.conversationId))?.updatedAt ?? null;
  };

  const empty = view.open.length === 0 && view.closed.length === 0;
  // Nothing under this chip, but the other one holds chats: say that, not "no chats yet".
  const hiddenByChip = empty && view.counts.all > 0;
  const chip = (f: ListFilter, label: string) => (
    <button
      type="button"
      className="mlist-chip"
      data-on={filter === f ? 'true' : undefined}
      aria-pressed={filter === f}
      data-testid={`list-filter-${f}`}
      onClick={() => setFilter(f)}
    >
      {label} <b>{view.counts[f]}</b>
    </button>
  );

  return (
    <div className="mlist-screen" data-testid="phone-list" ref={rootRef}>
      <div className="mlist-head">
        <h1 className="mlist-h" tabIndex={-1}>{t('handsfree.list.title')}</h1>
        <PhoneChip />
        <button className="mchat-head-btn" onClick={onNewChat} aria-label={t('handsfree.list.new')}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
      </div>
      {projects.length > 1 && (
        // Several chosen projects (AC16): switch between exactly those, no tabs.
        <div className="mlist-projects" data-testid="list-projects">
          {projects.map((p) => (
            <button
              key={p.name}
              type="button"
              className="mlist-chip mlist-project"
              data-on={p.name === vault ? 'true' : undefined}
              aria-pressed={p.name === vault}
              onClick={() => { if (p.name !== vault) void chrome.addTab(p.name); }}
            >{p.name}</button>
          ))}
        </div>
      )}
      <div className="mlist-search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
          <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
        </svg>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('handsfree.list.search')}
          aria-label={t('handsfree.list.search')}
          data-testid="list-search"
          enterKeyHint="search"
        />
        {q && (
          <button type="button" className="mlist-clear" onClick={() => setQ('')} aria-label={t('handsfree.list.clear')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden><path d="M4 4 12 12M12 4 4 12" /></svg>
          </button>
        )}
      </div>
      <div className="mlist-chips">
        {chip('all', t('handsfree.list.all'))}
        {chip('open', t('handsfree.list.open'))}
        {chip('closed', t('handsfree.list.closed'))}
      </div>

      <div className="mlist-body">
        {view.open.length > 0 && (
          <>
            <p className="mlist-sec">{t('handsfree.list.open')} · {view.open.length}</p>
            <ul className="mlist-rows">
              {view.open.map((row) => {
                const line = lineOf(row);
                const state = row.stateKey ? t(row.stateKey) : row.kind === 'tab' ? row.label : '';
                return (
                  <li key={row.key} className="mlist-item">
                    <button
                      className="mlist-row"
                      data-testid={row.kind === 'mac' ? 'mac-live-row' : 'list-tab-row'}
                      data-kind={row.kind}
                      data-id={row.id}
                      data-waiting={row.waiting ? 'true' : undefined}
                      onClick={() => { void tap(row); }}
                    >
                      <span className="agent-tab-dot" data-kind={row.dot} aria-hidden />
                      <span className="mlist-text">
                        <span className="mlist-title">
                          <span className="mlist-title-text"><Marked text={row.title || t('handsfree.mac.untitled')} tokens={tokens} /></span>
                          {row.kind === 'mac' && <span className="mlist-mac">Mac</span>}
                        </span>
                        <span className="mlist-sub">
                          {state && <span className="mlist-state" data-testid={row.kind === 'mac' ? 'mac-live-state' : 'list-state'}>{state}</span>}
                          {state && line ? ' · ' : ''}
                          {line && <Marked text={line} tokens={tokens} />}
                        </span>
                      </span>
                      <span className="mlist-age">{age(openAge(row))}</span>
                    </button>
                    {row.kind === 'tab' && (
                      <button className="mchat-icon-btn mlist-close" onClick={() => {
                          const held = tabs.find((x) => x.id === row.id);
                          markClosed([held?.claudeId, held?.altClaudeId]);
                          onCloseSession(row.id);
                        }} aria-label={fill(t('handsfree.list.closeChat'), { title: () => row.title || t('handsfree.mac.untitled') })} data-testid="list-close">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden><path d="M4 4 12 12M12 4 4 12" /></svg>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {view.closed.length > 0 && (
          <>
            <p className="mlist-sec">{t('handsfree.list.closed')} · {view.counts.closed}</p>
            <ul className="mlist-rows">
              {view.closed.map((row) => (
                <li key={row.key} className="mlist-item">
                  <button
                    className="mlist-row mlist-row--closed"
                    data-testid="past-row"
                    data-kind="past"
                    data-id={row.id}
                    aria-busy={pendingId === row.id || undefined}
                    disabled={pendingId !== null}
                    onClick={() => { void tap(row); }}
                  >
                    <span className="mlist-glyph" aria-hidden>◷</span>
                    <span className="mlist-text">
                      <span className="mlist-title"><span className="mlist-title-text"><Marked text={row.title} tokens={tokens} /></span></span>
                      {row.line && <span className="mlist-sub" data-testid="past-line"><Marked text={row.line} tokens={tokens} /></span>}
                    </span>
                    <span className="mlist-age">{age(row.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {empty && !hiddenByChip && pastLoading && <p className="mchat-empty">{t('handsfree.list.loading')}</p>}
        {empty && (hiddenByChip || !pastLoading) && (
          <p className="mchat-empty" data-testid="list-empty">
            {hiddenByChip
              ? t(filter === 'open' ? 'handsfree.list.noneOpen' : 'handsfree.list.noneClosed')
              : dq ? fill(t('handsfree.list.noMatch'), { q: () => dq }) : t('handsfree.list.empty')}
          </p>
        )}
      </div>

      <PushOptIn />
      <div className="mlist-foot">
        <button type="button" className="mlist-foot-btn" onClick={onExitToDashboard} data-testid="list-dashboard">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            <path d="M3 5.5h14M3 10h14M3 14.5h14" />
          </svg>
          {t('handsfree.list.dashboard')}
        </button>
        <button type="button" className="mlist-foot-btn mlist-foot-btn--primary" onClick={onNewChat} data-testid="list-new">
          <span aria-hidden>＋</span> {t('handsfree.list.new')}
        </button>
      </div>
    </div>
  );
}
