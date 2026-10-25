import { useEffect, useReducer, useRef, useState } from 'react';
import './MobileChat.css';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useChrome } from '../layout/WindowChrome';
import { SuperAgentIcon } from '../layout/NavIcons';
import type { LiveChatWire, LiveChatsWire, SuperChatWire } from '../handsfree/macContract';
import { setPendingMacAdopt, setPendingPhoneOpen } from '../handsfree/macAdopt';
import { homeSections, narrowTo, type HomeRow } from './phoneHome';
import { usePhoneHome } from './usePhoneHome';
import { PhoneChip } from '../handsfree/phone/PhoneChip';
import { HandsfreeBackdrop, HandsfreeMark } from '../brand/HandsfreeMark';
import { PushOptIn } from '../handsfree/phone/PushOptIn';
import { PhoneLogSend } from '../handsfree/phone/PhoneLogSend';
import type { PastSession } from './ChatHistoryPicker';
import type { ChatSession } from './chatSession';
import { liveStateKey, pastTap } from './drawerRows';
import { markClosed, recentlyClosed } from './phoneClosed';
import { chatLastLine, type StackTab } from './phoneStack';
import {
  ageLabel, chatLastTs, chatSearchText, highlight, listTap, listView, openMatches, queryTokens,
  superRowFor, superTap, type ClosedRow, type ListFilter, type OpenRow,
} from './phoneList';

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
 *
 * A project whose Super Agent is handed over (`live.supers`) shows ONE row and nothing else: the
 * Super Agent runs that project's chats, so the phone talks to it alone — no search, no chips, no
 * closed chats, no new chat. Without a hand-over the list is exactly as before.
 */

const QUERY_DEBOUNCE_MS = 200;
const LINE_THROTTLE_MS = 400;
/** A closed row's re-check gives up after this and resumes: a stalled tunnel must not hold the tap. */
const RECHECK_TIMEOUT_MS = 5_000;

function Marked({ text, tokens }: { text: string; tokens: readonly string[] }) {
  return <>{highlight(text, tokens).map((p, k) => (p.hit ? <mark key={k} className="mlist-hit">{p.text}</mark> : <span key={k}>{p.text}</span>))}</>;
}

export function PhoneChatList({
  tabs, vault, active, sessionFor, onSelect, onCloseSession, onAdopt, onResume, onNewChat, onExitToDashboard, onOpenSuper,
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
  /** Open the handed-over Super Agent's chat (the phone mirrors it; it never takes it). */
  onOpenSuper: (row: SuperChatWire) => void;
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

  // The phone's ONE list over every chosen project (hands-free sekmeler W3, owner D1).
  const home = usePhoneHome({ vault, tabs, active, q: dq });
  const projects = home.projects;
  const live = home.live;
  const pastLoading = home.pastLoading;
  // "Proje ▾": narrow the one list to a project (null: all of them).
  const [project, setProject] = useState<string | null>(null);

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
  const justClosed = new Set(recentlyClosed());
  // Every row of every chosen project; the search runs over all of them (closed ones on the Mac).
  const allRows = narrowTo(home.rows, project).filter((r) => {
    if (r.kind === 'closed') return !justClosed.has(r.row.id);
    if (r.kind === 'super') return true;
    if (r.row.kind === 'mac' && justClosed.has(r.row.id)) return false;
    if (!tokens.length) return true;
    const s = r.row.kind === 'tab' ? sessionFor(r.row.id) : undefined;
    return openMatches(tokens, r.row.title ?? '', lineOf(r.row), r.vault, s && s.kind === 'chat' ? chatSearchText(s.getModel()) : '');
  });
  const openList = allRows.filter((r) => r.kind !== 'closed');
  const closedList = allRows.filter((r) => r.kind === 'closed');
  // Closed: the past chats listed (each project's newest, searched on the Mac), never one that runs.
  const view = listView({ open: openList, closed: closedList, closedTotal: closedList.length, closedDropped: 0, filter });
  const shown = [...view.open, ...view.closed];
  const sections = homeSections(shown);

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
  /** A row of the one list: this project's as before; another project's opens there (its surface
   *  takes the parked request when it is on screen, macAdopt.ts). */
  const tapHome = (r: HomeRow) => {
    if (r.vault === vault) {
      if (r.kind === 'super') {
        const st = superTap(r.row, tabs);
        if (!st) return;
        if ('select' in st) onSelect(st.select.paneId, st.select.id); else onOpenSuper(st.open);
        return;
      }
      void tap(r.row);
      return;
    }
    tapSeq.current++;
    openElsewhere(r, chrome);
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
  // A project's tag on a row: every row says where it runs (D1).
  const tag = (p: string) => (projects.length > 1 ? <span className="mlist-tag" data-testid="list-project-tag">{p}</span> : null);

  const openRow = (r: HomeRow & { kind: 'open' }) => {
    const row = r.row;
    const line = lineOf(row);
    const state = row.stateKey ? t(row.stateKey) : row.kind === 'tab' ? row.label : '';
    return (
      <li key={r.key} className="mlist-item">
        <button
          className="mlist-row"
          data-testid={row.kind === 'mac' ? 'mac-live-row' : 'list-tab-row'}
          data-kind={row.kind}
          data-id={row.id}
          data-vault={r.vault}
          data-waiting={row.waiting ? 'true' : undefined}
          onClick={() => tapHome(r)}
        >
          <span className="agent-tab-dot" data-kind={row.dot} aria-hidden />
          <span className="mlist-text">
            <span className="mlist-title">
              <span className="mlist-title-text"><Marked text={row.title || t('handsfree.mac.untitled')} tokens={tokens} /></span>
              {tag(r.vault)}
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
            }} aria-label={t('handsfree.list.closeChat').replace('{title}', () => row.title || t('handsfree.mac.untitled'))} data-testid="list-close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden><path d="M4 4 12 12M12 4 4 12" /></svg>
          </button>
        )}
      </li>
    );
  };
  const superItem = (r: HomeRow & { kind: 'super' }) => {
    const superRow = r.row;
    const tapSuper = r.vault === vault ? superTap(superRow, tabs) : (superRow.live ? { open: superRow } : null);
    const state = superRow.live ? t(liveStateKey(superRow.state)) : t('handsfree.super.offline');
    return (
      <li key={r.key} className="mlist-item">
        <button
          className="mlist-row"
          data-testid="super-row"
          data-kind="super"
          data-id={superRow.conversationId}
          data-vault={r.vault}
          data-waiting={superRow.state === 'asking' ? 'true' : undefined}
          disabled={!tapSuper}
          onClick={() => tapHome(r)}
        >
          <span className="agent-tab-dot" data-kind={superRow.live ? (superRow.state === 'asking' ? 'asking' : superRow.state === 'working' ? 'working' : 'idle') : 'idle'} aria-hidden />
          <span className="mlist-text">
            <span className="mlist-title"><span className="mlist-super-icon" aria-hidden><SuperAgentIcon size={16} /></span><span className="mlist-title-text">{t('handsfree.super.title')}</span>{tag(r.vault)}</span>
            <span className="mlist-sub">
              <span className="mlist-state" data-testid="super-state">{state}</span>
              {superRow.lastLine ? ` · ${superRow.lastLine}` : ''}
            </span>
          </span>
          <span className="mlist-age">{age(superRow.updatedAt)}</span>
        </button>
      </li>
    );
  };
  const closedItem = (r: HomeRow & { kind: 'closed' }) => {
    const row = r.row;
    return (
      <li key={r.key} className="mlist-item">
        <button
          className="mlist-row mlist-row--closed"
          data-testid="past-row"
          data-kind="past"
          data-id={row.id}
          data-vault={r.vault}
          aria-busy={pendingId === row.id || undefined}
          disabled={pendingId !== null}
          onClick={() => tapHome(r)}
        >
          <span className="mlist-glyph" aria-hidden>◷</span>
          <span className="mlist-text">
            <span className="mlist-title"><span className="mlist-title-text"><Marked text={row.title} tokens={tokens} /></span>{tag(r.vault)}</span>
            {row.line && <span className="mlist-sub" data-testid="past-line"><Marked text={row.line} tokens={tokens} /></span>}
          </span>
          <span className="mlist-age">{age(row.updatedAt)}</span>
        </button>
      </li>
    );
  };
  // This project is handed over: its Super row is all it lists (its chats are the Super's).
  const superHere = superRowFor(live, vault);

  return (
    <div className="mlist-screen" data-testid="phone-list" data-super={superHere ? 'true' : undefined} ref={rootRef}>
      <HandsfreeBackdrop />
      <div className="mlist-head">
        <HandsfreeMark height={22} className="mlist-mark" />
        <h1 className="mlist-h" tabIndex={-1}>{t('handsfree.list.title')}</h1>
        <PhoneChip />
        {!superHere && (
          <button className="mchat-head-btn" onClick={onNewChat} aria-label={t('handsfree.list.new')}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <path d="M10 4v12M4 10h12" />
            </svg>
          </button>
        )}
      </div>
      <div className="mlist-search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
          <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
        </svg>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t(projects.length > 1 ? 'handsfree.list.searchAll' : 'handsfree.list.search')}
          aria-label={t(projects.length > 1 ? 'handsfree.list.searchAll' : 'handsfree.list.search')}
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
        {projects.length > 1 && (
          // "Proje ▾" narrows the one list to a project (AC16 of the earlier task: only the chosen ones).
          <label className="mlist-chip mlist-project-pick" data-on={project ? 'true' : undefined}>
            <select
              data-testid="list-projects"
              value={project ?? ''}
              onChange={(e) => setProject(e.target.value || null)}
              aria-label={t('handsfree.list.project')}
            >
              <option value="">{t('handsfree.list.project')} ▾</option>
              {projects.map((p) => <option key={p} value={p} className="mlist-project">{p}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="mlist-body">
        {sections.map((sec) => (
          <section key={sec.section} data-testid={`list-section-${sec.section}`}>
            <p className="mlist-sec" data-section={sec.section}>{t(`handsfree.list.section.${sec.section}`)} · {sec.section === 'closed' ? view.counts.closed : sec.rows.length}</p>
            <ul className="mlist-rows">
              {sec.rows.map((r) => (r.kind === 'super' ? superItem(r) : r.kind === 'closed' ? closedItem(r) : openRow(r)))}
            </ul>
          </section>
        ))}
        {superHere && <p className="mchat-empty" data-testid="super-hint">{t('handsfree.super.hint')}</p>}
        {empty && !hiddenByChip && pastLoading && <p className="mchat-empty">{t('handsfree.list.loading')}</p>}
        {empty && (hiddenByChip || !pastLoading) && (
          <p className="mchat-empty" data-testid="list-empty">
            {hiddenByChip
              ? t(filter === 'open' ? 'handsfree.list.noneOpen' : 'handsfree.list.noneClosed')
              : dq ? t('handsfree.list.noMatch').replace('{q}', () => dq) : t('handsfree.list.empty')}
          </p>
        )}
      </div>

      <PushOptIn />
      <PhoneLogSend />
      <div className="mlist-foot">
        <button type="button" className="mlist-foot-btn" onClick={onExitToDashboard} data-testid="list-dashboard">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            <path d="M3 5.5h14M3 10h14M3 14.5h14" />
          </svg>
          {t('handsfree.list.dashboard')}
        </button>
        {!superHere && (
          <button type="button" className="mlist-foot-btn mlist-foot-btn--primary" onClick={onNewChat} data-testid="list-new">
            <span aria-hidden>＋</span> {t('handsfree.list.new')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Open a row of ANOTHER project: park what to open there, then show that project (its surface
 *  takes the request once it is on screen). A swipe on the chat screen goes the same way. */
export function openElsewhere(r: HomeRow, chrome: { addTab(vault: string): Promise<unknown> }): void {
  if (r.kind === 'super') setPendingPhoneOpen({ vault: r.vault, kind: 'super', id: r.row.conversationId });
  else if (r.kind === 'closed') setPendingPhoneOpen({ vault: r.vault, kind: 'resume', id: r.row.id, title: r.row.title });
  else if (r.row.kind === 'mac') setPendingMacAdopt(r.row.chat);
  void chrome.addTab(r.vault);
}
