import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { applySettingsSearch, paintSettingsSearch } from '../settingsSearch';
import { SW_GROUPS, groupOf, pageTitleKey, swTarget, type SwModelsTab, type SwPageId } from './sections';
import { SwIcon } from './icons';
import {
  ChatPage, ConnectedPage, GeneralPage, HandsfreePage, ReposPage, SleepPage, SuperPage, SystemPage, TasksPage,
  type PageProps,
} from './pages/SimplePages';
import { McpPage, MemoryPage, MirrorPage, TeamSyncPage, VoicePage } from './pages/TopicPages';
import { AssistantPage } from './pages/AssistantPage';
import { ModelsPage } from './pages/ModelsPage';
import { JobChip } from './JobChip';
import './SettingsWindow.css';

export interface SettingsWindowFocus {
  focusId: string | null;
  nonce: number;
}

/** Everything a page component may receive from the window. */
export interface WindowPageProps extends PageProps {
  tab: SwModelsTab;
  setTab: (tab: SwModelsTab) => void;
}

const PAGES: Record<SwPageId, (p: WindowPageProps) => ReactNode> = {
  general: GeneralPage,
  chat: ChatPage,
  voice: VoicePage,
  models: ModelsPage,
  mcp: McpPage,
  super: SuperPage,
  assistant: AssistantPage,
  memory: MemoryPage,
  sleep: SleepPage,
  tasks: TasksPage,
  repos: ReposPage,
  teamsync: TeamSyncPage,
  mirror: MirrorPage,
  connected: ConnectedPage,
  handsfree: HandsfreePage,
  system: SystemPage,
};

const HIDDEN = 'data-search-hidden';

/** What still shows inside one page's body after the search filter ran: each row, and each
 *  block below the head that has no rows of its own (Tasks, Code repos, Connected projects). */
function visibleRows(root: Element): number {
  let n = 0;
  for (const row of root.querySelectorAll('.setting-row')) if (!row.closest(`[${HIDDEN}]`)) n++;
  for (const block of root.querySelectorAll(`:scope > :not(.sw-head)`)) {
    if (!block.hasAttribute(HIDDEN) && !block.querySelector('.setting-row')) n++;
  }
  return n;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Settings in the new layout: a large window over the app (T3 style). The page behind stays
 * mounted and unchanged; Esc or ✕ closes the window and it is exactly where it was. Pages are
 * by topic (`sections.ts`); search draws every page and filters by name, hint and keywords.
 */
export function SettingsWindow({ open, focus, onClose }: {
  open: boolean;
  focus: SettingsWindowFocus;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState<SwPageId>(() => swTarget(focus.focusId).page);
  const [tab, setTab] = useState<SwModelsTab>(() => swTarget(focus.focusId).tab ?? 'defaults');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Partial<Record<SwPageId, number>>>({});
  const searchRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const winRef = useRef<HTMLDivElement | null>(null);
  const searching = query.trim() !== '';

  // A deep link (every navigate to 'settings') lands on its page and tab.
  useEffect(() => {
    const target = swTarget(focus.focusId);
    setPage(target.page);
    if (target.tab) setTab(target.tab);
    setQuery('');
  }, [focus.focusId, focus.nonce]);

  // While open: the chat surface's own shortcuts step aside (they read this flag), and the
  // search takes the cursor.
  // Closing gives the cursor back to where it was. On a phone the window itself takes focus (a
  // keyboard popping up for the search would cover the page).
  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.dataset.settingsWindow = 'open';
    const id = requestAnimationFrame(() => {
      if (window.innerWidth > 600) searchRef.current?.focus();
      else winRef.current?.focus();
    });
    return () => {
      delete document.body.dataset.settingsWindow;
      cancelAnimationFrame(id);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);

  /** Tab stays inside the window (a model picker's popover keeps its own order). */
  const trapTab = (e: KeyboardEvent) => {
    const win = winRef.current;
    const at = document.activeElement;
    if (!win || at?.closest('.sw-popover')) return;
    const items = Array.from(win.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const inside = !!at && win.contains(at) && at !== win;
    if (e.shiftKey && (!inside || at === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || at === last)) { e.preventDefault(); first.focus(); }
  };

  // Esc: a picker or menu inside closes itself first; then a typed query clears; then the
  // window closes. `/` puts the cursor in the search unless one is typing already.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (e.key === 'Escape') {
        // Whatever inside the window owns Esc goes first: a picker, an open list (ClickUp's
        // list picker), or a field that reverts or cancels a capture (`data-sw-esc`). Each of
        // those stops the key itself, so the page behind never sees it either.
        if (document.querySelector('.sw-popover, [data-sw-modal], .sw .ss-pop') || el?.closest('.sw [data-sw-esc]')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (query) { setQuery(''); return; }
        onClose();
        return;
      }
      if (e.key === 'Tab') { trapTab(e); return; }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !el?.closest('input, textarea, select, [contenteditable="true"]')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, query, onClose]);

  // Search: every page is drawn; each one's body is filtered by its own text and counted.
  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    if (!searching) {
      for (const sec of root.querySelectorAll<HTMLElement>('[data-sw-page]')) applySettingsSearch(sec, '');
      return;
    }
    const next: Partial<Record<SwPageId, number>> = {};
    for (const sec of root.querySelectorAll<HTMLElement>('[data-sw-page]')) {
      applySettingsSearch(sec, query, { paint: false });
      next[sec.dataset.swPage as SwPageId] = visibleRows(sec);
    }
    paintSettingsSearch(root, query);
    setHits((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });
  // Pages load their own data after the keystroke: filter again when their rows arrive.
  useEffect(() => {
    const root = bodyRef.current;
    if (!searching || !root || typeof MutationObserver === 'undefined') return undefined;
    let raf = 0;
    const obs = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next: Partial<Record<SwPageId, number>> = {};
        for (const sec of root.querySelectorAll<HTMLElement>('[data-sw-page]')) {
          applySettingsSearch(sec, query, { paint: false });
          next[sec.dataset.swPage as SwPageId] = visibleRows(sec);
        }
        paintSettingsSearch(root, query);
        setHits(next);
      });
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { obs.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [searching, query]);

  const go = (id: SwPageId) => { setPage(id); setQuery(''); bodyRef.current?.scrollTo({ top: 0 }); };

  /** A click on a search hit opens its page (and tab) and brings the row into view. */
  const onBodyClick = (e: React.MouseEvent) => {
    if (!searching) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el || el.closest('button, input, select, textarea, a, label, summary')) return;
    const row = el.closest<HTMLElement>('[data-row]');
    const sec = el.closest<HTMLElement>('[data-sw-page]');
    if (!row || !sec) return;
    const groupTab = row.closest<HTMLElement>('[data-tab]')?.dataset.tab as SwModelsTab | undefined;
    const rowId = row.dataset.row;
    setPage(sec.dataset.swPage as SwPageId);
    if (groupTab) setTab(groupTab);
    setQuery('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = bodyRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowId ?? '')}"]`);
      target?.scrollIntoView({ block: 'center' });
      target?.classList.add('sw-pulse');
      window.setTimeout(() => target?.classList.remove('sw-pulse'), 1400);
    }));
  };

  if (!open) return null;

  const total = Object.values(hits).reduce((a, n) => a + (n ?? 0), 0);
  const group = groupOf(page);
  // Every job's model row is the same chip as in Models → Defaults; its "Sign in" opens the tool's tab.
  const chip: PageProps['chip'] = (job) => (
    <JobChip job={job} onOpenTab={(target) => { setPage('models'); setQuery(''); setTab(target === 'accounts-codex' ? 'codex' : target === 'accounts' ? 'claude' : 'defaults'); }} />
  );
  const props: WindowPageProps = { searching, chip, go, tab, setTab };
  const Page = PAGES[page];

  return createPortal(
    <div className="sw" data-testid="settings-window">
      <div className="sw-scrim" onClick={onClose} aria-hidden="true" />
      <div className="sw-win" ref={winRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('nav.settings')}>
        <aside className="sw-side">
          <label className="sw-q">
            <SwIcon name="search" />
            <input
              ref={searchRef}
              type="search"
              placeholder={t('shell.settings.search')}
              aria-label={t('shell.settings.search')}
              value={query}
              data-testid="settings-search"
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>/</kbd>
          </label>
          <nav className="sw-nav" aria-label={t('nav.settings')}>
            {SW_GROUPS.map((g) => (
              <div key={g.id} className="sw-ng-wrap">
                {g.labelKey ? <div className="sw-ng">{t(g.labelKey)}</div> : <div className="sw-ng sw-ng--none" />}
                {g.pages.map((id) => {
                  const on = !searching && page === id;
                  const n = hits[id] ?? 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`sw-ni${on ? ' on' : ''}${searching && !n ? ' dim' : ''}`}
                      aria-current={on ? 'page' : undefined}
                      data-sw-nav={id}
                      onClick={() => go(id)}
                    >
                      <SwIcon name={id} />
                      <span>{t(pageTitleKey(id))}</span>
                      {searching && n > 0 && <b>{n}</b>}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>
        <div className="sw-pane">
          <header className="sw-top">
            <span className="sw-crumb">
              {searching
                ? <b>{t(total === 1 ? 'shell.sw.hits.one' : 'shell.sw.hits').replace('{n}', String(total))}</b>
                : <>{t('nav.settings')}{group.labelKey && <><i>›</i>{t(group.labelKey)}</>}<i>›</i><b>{t(pageTitleKey(page))}</b></>}
            </span>
            <button type="button" className="sw-x" onClick={onClose} aria-label={t('shell.sw.close')} title={t('shell.sw.close')} data-testid="settings-close">
              <SwIcon name="x" />
            </button>
          </header>
          <div className="sw-body" ref={bodyRef} onClick={onBodyClick}>
            {searching ? (
              <>
                {SW_GROUPS.flatMap((g) => g.pages).map((id) => {
                  const P = PAGES[id];
                  return (
                    <section key={id} className="sw-sec sw-sec--hit" data-sw-page={id} hidden={!(hits[id] ?? 1)}>
                      <P {...props} />
                    </section>
                  );
                })}
                {total === 0 && (
                  <div className="sw-empty" data-testid="settings-search-empty">
                    <b>{t('shell.sw.noMatch').replace('{q}', query.trim())}</b>
                    <span>{t('shell.sw.noMatch.h')}</span>
                  </div>
                )}
              </>
            ) : (
              <section className="sw-sec" data-sw-page={page} key={page}>
                <Page {...props} />
              </section>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
