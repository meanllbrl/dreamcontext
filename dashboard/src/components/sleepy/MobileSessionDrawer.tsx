import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import './MobileChat.css';
import type { SessionKind } from './agentSession';
import type { SessionStatusInfo } from './agentStatus';
import type { PastSession } from './ChatHistoryPicker';
import { useApi } from '../../context/VaultContext';
import { useChrome } from '../layout/WindowChrome';
import { useLauncherStatus } from '../../hooks/useLauncher';
import { VaultDot } from '../layout/VaultDot';
import { useI18n } from '../../context/I18nContext';
import { isMacPhoneSurface } from '../../lib/phoneSurface';
import { setPendingMacAdopt } from '../handsfree/macAdopt';
import type { LiveChatWire, LiveChatsWire } from '../handsfree/macContract';
import { activeStateKey, drawerRows, liveStateKey, pastTap } from './drawerRows';
import { PushOptIn } from '../handsfree/phone/PushOptIn';

/**
 * The phone's navigator — a LEFT DRAWER holding the three things the desktop spends its
 * whole top chrome on: which PROJECT you are in, which session is live, and which
 * conversation you had yesterday.
 *
 * A Chrome-style tab row assumes a pointer and a wide viewport: at 390px four tabs are four
 * illegible slivers, and the per-tab ✕/minimize buttons are far under the 44px touch floor.
 * The same lists read as full-width rows fit the screen they are on.
 *
 * It owns its own reads (projects, past chats) rather than taking them as props, and both
 * are gated on being OPEN — a closed drawer costs nothing, and `/agent/chat-sessions` scans
 * transcripts on its first call per project.
 */

export interface MobileSessionVM {
  id: string;
  title: string;
  info: SessionStatusInfo;
  sessionKind: SessionKind;
  bypass: boolean;
  attention: boolean;
}

/** How many past conversations the drawer lists. The picker (desktop) has search for the
 *  long tail; here the answer to "where was I yesterday" is the top of a short list. */
const PAST_LIMIT = 20;

/** The mono glyph that names a session's kind — the same vocabulary the desktop tabs use. */
function kindGlyph(kind: SessionKind): string {
  if (kind === 'shell') return '>_';
  if (kind === 'chat') return '◆';
  if (kind === 'automation') return '◷';
  return '◇';
}

/** "2h", "3d" — a past chat's age, in the one unit that reads at a glance. */
function ago(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

interface ChatSessionsResponse {
  sessions: PastSession[];
  total: number;
}

export function MobileSessionDrawer({
  open, sessions, activeId, openClaudeIds,
  onClose, onSelect, onCloseSession, onNewChat, onResumePast, onAdoptLive, onExitToDashboard,
}: {
  open: boolean;
  sessions: MobileSessionVM[];
  activeId: string;
  /** Conversation UUIDs that already hold a tab — those never repeat in the Past list. */
  openClaudeIds: string[];
  onClose: () => void;
  onSelect: (sid: string) => void;
  onCloseSession: (sid: string) => void;
  onNewChat: () => void;
  onResumePast: (past: PastSession) => void;
  /** Mac mode: open a chat the Mac runs right now, taking it from the desktop window. */
  onAdoptLive?: (chat: LiveChatWire) => void;
  /** The escape hatch — leave chat-only mode and show the full dashboard. Without it the
   *  phone can never reach Settings, which is where a missing prerequisite is fixed. */
  onExitToDashboard: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const api = useApi();
  const chrome = useChrome();
  const [projectsOpen, setProjectsOpen] = useState(false);

  // Only while the project list is expanded — this is the launcher's whole-registry poll and
  // the drawer is mounted for the life of the surface.
  const { t } = useI18n();
  // Mac mode's phone: the launcher poll is the desktop's (refused on the phone listener), so
  // the project list comes from /api/vaults, which a phone socket answers with names only.
  const mac = isMacPhoneSurface();
  const { data: launcher } = useLauncherStatus(open && projectsOpen && !mac);
  const { data: macVaults } = useQuery({
    queryKey: ['mac-phone-vaults'],
    queryFn: () => api.get<{ vaults: Array<{ name: string; exists: boolean }> }>('/vaults'),
    enabled: open && mac,
    staleTime: 30_000,
    retry: false,
  });
  const vaults: Array<{ name: string; exists: boolean; needsUpdate?: boolean }> = mac
    ? (macVaults?.vaults ?? []).filter((v) => v.exists)
    : (launcher?.vaults ?? []).filter((v) => v.exists);
  // AC16: the phone lists projects only when the owner chose several at start.
  const macMulti = mac && vaults.length > 1;
  // "Mac'te açık": every chat the Mac runs right now in the chosen projects (names, never paths).
  const { data: live } = useQuery({
    queryKey: ['mac-live-chats'],
    queryFn: () => api.get<LiveChatsWire>('/agent/live-chats'),
    enabled: open && mac,
    staleTime: 5_000,
    retry: false,
  });
  const adopt = (chat: LiveChatWire) => {
    if (chat.vault && chat.vault !== chrome.activeVault) {
      setPendingMacAdopt(chat);
      void chrome.addTab(chat.vault);
    } else {
      onAdoptLive?.(chat);
    }
    onClose();
  };

  const { data: past, isLoading: pastLoading } = useQuery({
    queryKey: ['mobile-past-chats'],
    queryFn: () => api.get<ChatSessionsResponse>(`/agent/chat-sessions?limit=${PAST_LIMIT}`),
    enabled: open,
    // A conversation the user just closed should be in this list the next time they look,
    // so it re-reads on each open rather than serving a session-long cache.
    staleTime: 10_000,
    retry: false,
  });
  // AC18: a conversation is listed once — never under Past while it runs (or drains) on the Mac.
  const { liveRows, pastRows } = drawerRows({
    live: live?.chats ?? [], draining: live?.draining ?? [], past: past?.sessions ?? [], openClaudeIds,
  });
  const tapPast = async (s: PastSession) => {
    if (mac) {
      // The lists may have raced: ask the Mac again, and adopt a running chat instead of resuming it.
      try {
        const fresh = await api.get<LiveChatsWire>('/agent/live-chats');
        const d = pastTap(s.id, fresh.chats);
        if ('adopt' in d) { adopt(d.adopt); return; }
      } catch { /* unreachable: resume as before */ }
    }
    onResumePast(s);
    onClose();
  };

  // Collapse the project list whenever the drawer closes, so reopening always starts on the
  // sessions — the thing it is for — rather than on whatever was expanded last time.
  useEffect(() => { if (!open) setProjectsOpen(false); }, [open]);

  // Esc closes, and — the half a phone actually uses — the hardware/gesture BACK closes
  // instead of navigating the whole app away. A history entry is pushed while the drawer is
  // open and popped when it closes by any other route, so the back stack never accumulates
  // one entry per open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onPop = () => onClose();
    window.history.pushState({ drawer: true }, '');
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('popstate', onPop);
      // Only unwind the entry we pushed. When the close CAME from popstate the entry is
      // already gone, and `history.state` is how we tell the two apart.
      if (window.history.state?.drawer) window.history.back();
    };
  }, [open, onClose]);

  // Scroll-lock the transcript underneath: on iOS a swipe that starts on the scrim otherwise
  // scrolls the page behind the drawer, which reads as the drawer itself being broken.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Move focus into the panel so a screen reader lands inside the drawer rather than
  // continuing to read the transcript it just covered.
  useEffect(() => { if (open) panelRef.current?.focus(); }, [open]);

  const pickProject = (vault: string) => {
    // `addTab` is the ONE place that knows the live-instance ceiling and the "already open →
    // just focus it" rule, so the phone asks it exactly like ⌘P does rather than reaching for
    // `activate` and getting a blank body for a project this window never opened.
    void chrome.addTab(vault);
    onClose();
  };

  return (
    <div className="mchat-drawer" data-open={open ? 'true' : undefined} aria-hidden={!open}>
      <div className="mchat-scrim" onClick={onClose} />
      <div
        className="mchat-panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
      >
        {/* The project row REPLACES a "Sessions" title: the drawer's own heading said nothing
            the list below it did not, and which project you are in is the one fact the phone
            has nowhere else to show (the desktop's chip strip is hidden here). */}
        <div className="mchat-panel-head">
          {mac && !macMulti ? (
            // One chosen project (AC16): its name, no project list.
            <span className="mchat-project" title={chrome.activeVault} data-testid="mchat-project-fixed">
              <span className="mchat-project-name">{chrome.activeVault || 'Project'}</span>
            </span>
          ) : (
          <button
            className="mchat-project"
            onClick={() => setProjectsOpen((v) => !v)}
            aria-expanded={projectsOpen}
            title={chrome.activeVault}
          >
            <span className="mchat-project-name">{chrome.activeVault || 'Project'}</span>
            <span className="mchat-project-caret" data-open={projectsOpen ? 'true' : undefined} aria-hidden>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6.5 8 10.5 12 6.5" />
              </svg>
            </span>
          </button>
          )}
          <button className="mchat-icon-btn" onClick={onClose} aria-label="Close sessions">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <path d="M4 4 12 12M12 4 4 12" />
            </svg>
          </button>
        </div>

        {projectsOpen && (!mac || macMulti) && (
          <div className="mchat-projects" role="listbox" aria-label="Projects">
            {vaults.length === 0 && <p className="mchat-empty">Loading projects…</p>}
            {vaults.map((v) => {
              const isOpen = chrome.open.some((p) => p.vault === v.name);
              return (
                <button
                  key={v.name}
                  className={'mchat-project-row' + (v.name === chrome.activeVault ? ' active' : '')}
                  role="option"
                  aria-selected={v.name === chrome.activeVault}
                  onClick={() => pickProject(v.name)}
                >
                  <VaultDot exists={v.exists} needsUpdate={v.needsUpdate ?? false} />
                  <span className="mchat-project-row-name">{v.name}</span>
                  {isOpen && v.name !== chrome.activeVault && <span className="mchat-tagword">open</span>}
                </button>
              );
            })}
          </div>
        )}

        <div className="mchat-list">
          <p className="mchat-section">Active</p>
          {sessions.length === 0 && (
            <p className="mchat-empty">No active session yet. Start one below.</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={'mchat-row' + (s.id === activeId ? ' active' : '')}
              data-kind={s.info.kind}
            >
              <button
                className="mchat-row-main"
                role="option"
                aria-selected={s.id === activeId}
                onClick={() => { onSelect(s.id); onClose(); }}
                title={`${s.title} — ${s.info.label}`}
              >
                <span className="mchat-dot" data-kind={s.info.kind} aria-hidden />
                <span className="mchat-row-text">
                  <span className="mchat-row-title">{s.title}</span>
                  <span className="mchat-row-sub">
                    <span className="mchat-kind" aria-hidden>{kindGlyph(s.sessionKind)}</span>
                    {activeStateKey(s.info) ? t(activeStateKey(s.info)!) : s.info.label}
                    {s.bypass && <span className="mchat-bypass" title="Bypass permissions is ON"> ⚡</span>}
                  </span>
                </span>
                {s.attention && <span className="mchat-badge" aria-label="Waiting for you" />}
              </button>
              <button
                className="mchat-icon-btn mchat-row-close"
                onClick={() => onCloseSession(s.id)}
                aria-label={`Close ${s.title}`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
                  <path d="M4 4 12 12M12 4 4 12" />
                </svg>
              </button>
            </div>
          ))}

          {mac && liveRows.length > 0 && (
            <>
              <p className="mchat-section">{t('handsfree.mac.liveSection')}</p>
              {liveRows.map((c) => (
                <div key={c.conversationId} className="mchat-row" data-testid="mac-live-row" data-id={c.conversationId}>
                  <button className="mchat-row-main" onClick={() => adopt(c)} title={c.title || ''}>
                    <span className="mchat-dot" data-kind={c.state === 'asking' ? 'asking' : c.state === 'working' ? 'working' : 'idle'} aria-hidden />
                    <span className="mchat-row-text">
                      <span className="mchat-row-title">{c.title || t('handsfree.mac.untitled')}</span>
                      <span className="mchat-row-sub" data-testid="mac-live-state">{macMulti ? `${c.vault} · ` : ''}{t(liveStateKey(c.state))}</span>
                    </span>
                  </button>
                </div>
              ))}
            </>
          )}

          {/* Past chats — the same resume path the desktop picker uses, minus its search.
              A row that already holds a tab is filtered out rather than shown as "open": it
              is directly above in Active, and one conversation twice in one list is a bug
              the user has to reason about. */}
          <p className="mchat-section">Past chats</p>
          {pastLoading && pastRows.length === 0 && <p className="mchat-empty">Reading past chats…</p>}
          {!pastLoading && pastRows.length === 0 && (
            <p className="mchat-empty">No past conversations in this project yet.</p>
          )}
          {pastRows.map((s) => (
            <div key={s.id} className="mchat-row" data-testid="past-row" data-id={s.id}>
              <button
                className="mchat-row-main"
                onClick={() => { void tapPast(s); }}
                title={s.preview || s.title}
              >
                <span className="mchat-past-glyph" aria-hidden>◷</span>
                <span className="mchat-row-text">
                  <span className="mchat-row-title">{s.title}</span>
                  <span className="mchat-row-sub">{ago(s.updatedAt)} ago</span>
                </span>
              </button>
            </div>
          ))}
        </div>

        <PushOptIn />

        <div className="mchat-panel-foot">
          <button className="mchat-new" onClick={() => { onNewChat(); onClose(); }}>
            <span aria-hidden>＋</span> New chat
          </button>
          <button className="mchat-exit" onClick={() => { onExitToDashboard(); onClose(); }}>
            Show full dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
