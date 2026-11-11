import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TOGGLE_PAGE_DRAWER_EVENT } from '../lib/uxMode';
import { useI18n } from '../context/I18nContext';
import { useApi, useInstanceEvent, useVault } from '../context/VaultContext';
import { useFocusTarget, type FocusTarget } from '../hooks/useFocusTarget';
import { useDefaultWhiteboard, useWhiteboardEditor, useWhiteboardList } from '../hooks/useWhiteboards';
import { useAgents } from '../hooks/useAgents';
import type { SaveState } from '../hooks/whiteboardSaveLoop';
import type { ExportNote } from '../lib/exportDownload';
import { LazyWhiteboardCanvas } from '../components/whiteboard/LazyWhiteboardCanvas';
import { PagePopupProvider } from '../components/whiteboard/PagePopup';
import { BoardAgentPanel } from '../components/whiteboard/BoardAgentPanel';
import { setAgentPanelOpen, useAgentPanelOpen, useBoardCards } from '../components/whiteboard/agentPanelState';
import { dropBoardAgentScratch, sweepHomeSessions } from '../components/whiteboard/boardAgentScratch';
import { readLastBoard, writeLastBoard } from '../components/whiteboard/boardPlace';
import { dropWhiteboardPref, hydrateWhiteboardPrefs, isWhiteboardPrefsHydrated } from '../components/whiteboard/whiteboardPrefs';
import { BoardExplorer } from './whiteboards/BoardExplorer';
import { SidebarGlyph } from './whiteboards/boardGlyphs';
import { useExplorerPrefs } from './whiteboards/useExplorerPrefs';
import { touchRecent } from './whiteboards/explorerLogic';
import { DEFAULT_BOARD_SLUG, goneBoardTarget } from './whiteboards/boardSwitcherLogic';
import { useIsMobile } from '../hooks/useIsMobile';
import { clearBoardHash, formatBoardHash, parseBoardHash } from './whiteboards/boardHash';
import { publishPageDetail } from '../lib/pageContext';
import { useSuperPresence } from '../lib/superPageBridge';
import { BoardSuperField, type FieldWork } from '../components/whiteboard/BoardSuperField';
import { useCanvasBox } from './whiteboards/useCanvasBox';
import { useTopRowFit } from './whiteboards/useTopRowFit';
import type { SelectionRef } from '../components/whiteboard/agentDrop';
import type { WhiteboardCanvasApi } from '../components/whiteboard/LazyWhiteboardCanvas';
import './WhiteboardsPage.css';

interface WhiteboardsPageProps {
  /** Shell navigation focus: the `id` is a board slug, opened full-bleed. */
  focus?: FocusTarget;
}

/**
 * Control Panel (A15): one board open full-bleed under the shell bar, the boards in the explorer
 * on the left (the tabs row is gone, 2026-11-11). A board is an Excalidraw scene the user and the agent draw on together; the CLI writes the
 * same file, and the editor's save + poll loop keeps the two in step (D5, D11).
 *
 * The page id stays `whiteboards` (persisted nav state, the chat's appNav deep links). With
 * no slug it opens the default board, which the server ensures exists; there is no list page.
 */
export function WhiteboardsPage({ focus }: WhiteboardsPageProps = {}) {
  const { t } = useI18n();
  const { vault } = useVault();
  const api = useApi();
  // The page's memory (explorer, last board, viewports, panel) is read back from the server
  // before anything reads it synchronously: after a desktop relaunch localStorage is empty.
  const prefsKey = vault ?? '';
  const [readFor, setReadFor] = useState<string | null>(() => (isWhiteboardPrefsHydrated(prefsKey) ? prefsKey : null));
  const prefsReady = readFor === prefsKey;
  useEffect(() => {
    if (prefsReady) return;
    let live = true;
    void hydrateWhiteboardPrefs(prefsKey, {
      load: () => api.get<{ settings: unknown }>('/whiteboard-prefs').then((r) => r.settings),
      save: (values) => api.put('/whiteboard-prefs', { settings: values }),
    }).then(() => { if (live) setReadFor(prefsKey); });
    return () => { live = false; };
  }, [api, prefsKey, prefsReady]);
  if (!prefsReady) return <div className="wbp-editor"><div className="wbp-loading">{t('common.loading')}</div></div>;
  return <WhiteboardsPageBody key={prefsKey} focus={focus} />;
}

function WhiteboardsPageBody({ focus }: WhiteboardsPageProps) {
  const { t } = useI18n();
  const { instanceId, vault, bus } = useVault();
  // The board open before a reload: the URL hash (see boardHash). There is one URL per window,
  // so only the window's first project reads it back, like Shell's `/lab/` deep link.
  const [openSlug, setOpenSlug] = useState<string | null>(
    () => focus?.id ?? (instanceId === 'inst-1' ? parseBoardHash(window.location.hash) : null),
  );
  useFocusTarget(focus, setOpenSlug);
  // Agent cards keep their composer buckets across remounts and board switches; they die with
  // the page, all but the boards' home conversations, which the agent panel keeps alive while
  // the owner is on another page (boardAgentScratch.ts).
  useEffect(() => (vault ? () => dropBoardAgentScratch({ vault, keepHome: true }) : undefined), [vault]);
  // The retired tab strip's memory (open tabs, coloured groups) leaves the prefs file once.
  useEffect(() => { if (vault) dropWhiteboardPref(vault, 'tabs', `dreamcontext:whiteboard-tabs:${vault}`); }, [vault]);
  // With no deep link, the board the owner was on when they last left the page (boardPlace.ts),
  // once the list says it still exists; else the default board.
  const [remembered] = useState(() => (vault ? readLastBoard(vault) : null));
  const boards = useWhiteboardList();
  // A board that was deleted while open (or opened after it was): the page moved on to the most
  // recent other board; this says so on the board it moved to, until the owner moves again.
  const [goneNote, setGoneNote] = useState<{ board: string; text: string } | null>(null);
  useEffect(() => { setGoneNote((prev) => (prev && prev.board === openSlug ? prev : null)); }, [openSlug]);
  const onGone = useCallback((next: string, text: string) => { setGoneNote({ board: next, text }); }, []);
  const fallback = useDefaultWhiteboard(openSlug === null);

  useEffect(() => {
    if (openSlug !== null) return;
    if (remembered) {
      if (!boards.data && !boards.isError) return;
      if (boards.data?.some((b) => b.slug === remembered)) { setOpenSlug(remembered); return; }
    }
    if (fallback.data) setOpenSlug(fallback.data);
  }, [openSlug, remembered, boards.data, boards.isError, fallback.data]);

  useEffect(() => {
    if (openSlug && vault) writeLastBoard(vault, openSlug);
  }, [openSlug, vault]);
  // The open board, for the Super dock's page chip (lib/pageContext.ts).
  useEffect(() => {
    if (!openSlug) return undefined;
    publishPageDetail(bus, 'whiteboards', { page: 'whiteboards', board: openSlug });
    return () => publishPageDetail(bus, 'whiteboards', null);
  }, [bus, openSlug]);

  // Only the open board's agents' conversations stay alive (one `claude` each): its home agents
  // and the agents with a card on it. The rest end once idle, so boards visited with the panel
  // open, deleted boards, removed cards and re-homed agents never pile up.
  // Read from the agent roster, the list the panel and the cards read, so the sweep and the
  // panel agree on who is on the board.
  const { data: roster } = useAgents();
  const openCards = useBoardCards(vault, openSlug ?? undefined);
  useEffect(() => {
    if (!vault || !openSlug || !roster) return;
    sweepHomeSessions(vault, (board, agent) => board === openSlug && roster.some((a) => a.slug === agent
      && (a.whiteboard === board || openCards.some((c) => c.agent === agent))));
  }, [vault, openSlug, roster, openCards]);

  // The board explorer (left sidebar) lives HERE, above the slug-keyed editor, so a board
  // switch keeps its search, its fields and its scroll, and it is there in every state.
  const phone = useIsMobile();
  const [prefs, changePrefs] = useExplorerPrefs();
  // The phone never reads or writes the saved `open`: its drawer starts closed, in memory only.
  const [drawer, setDrawer] = useState(false);
  const [wide] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1100);
  const explorerOpen = phone ? drawer : (prefs.open ?? wide);
  // Who asked for the last show/hide: focus follows the owner's own click (to the explorer's
  // search when shown, back to the show toggle when hidden), never a page load.
  const [shownByOwner, setShownByOwner] = useState(false);
  const setExplorerOpen = useCallback((next: boolean) => {
    if (phone) setDrawer(next);
    else changePrefs((p) => ({ ...p, open: next }));
    setShownByOwner(next);
    if (!next) requestAnimationFrame(() => document.querySelector<HTMLElement>('.wbp-explorer-toggle')?.focus());
  }, [phone, changePrefs]);
  useEffect(() => {
    if (openSlug) changePrefs((p) => touchRecent(p, openSlug));
  }, [openSlug, changePrefs]);
  // The new shell's drawer button and ⌘B on this page: its own explorer, not the chat drawer.
  useInstanceEvent(TOGGLE_PAGE_DRAWER_EVENT, () => setExplorerOpen(!explorerOpen));

  const toggle = explorerOpen ? null : (
    <button
      type="button"
      className="wbp-explorer-toggle"
      aria-label={t('whiteboard.explorer.show')}
      title={t('whiteboard.explorer.show')}
      onClick={() => setExplorerOpen(true)}
    >
      <SidebarGlyph />
    </button>
  );

  return (
    <div className="wbp-shell" data-phone={phone ? '' : undefined}>
      {explorerOpen && (
        <>
          {phone && <button type="button" className="wbp-shell-scrim" aria-label={t('whiteboard.explorer.hide')} onClick={() => setExplorerOpen(false)} />}
          <BoardExplorer
            openSlug={openSlug}
            onOpen={setOpenSlug}
            prefs={prefs}
            change={changePrefs}
            onHide={() => setExplorerOpen(false)}
            phone={phone}
            // Not on a phone: focusing a field there pops the keyboard over the drawer.
            focusOnMount={shownByOwner && !phone}
          />
        </>
      )}
      <div className="wbp-shell-main">
        {renderMain(toggle)}
      </div>
    </div>
  );

  function renderMain(explorerToggle: ReactNode) {
  if (openSlug) {
    // Keyed on the slug: switching boards unmounts this editor first, so its save loop's
    // dispose flushes the unsaved scene while the canvas handle is still there.
    return (
      <WhiteboardEditor key={openSlug}
        slug={openSlug}
        onOpen={setOpenSlug}
        goneNote={goneNote?.board === openSlug ? goneNote.text : null}
        onGone={onGone}
        recent={prefs.recent}
        explorerToggle={explorerToggle}
      />
    );
  }
  if (fallback.isError) {
    return (
      <div className="wbp-editor">
        {explorerToggle && <div className="wbp-state-top">{explorerToggle}</div>}
        <div className="wbp-card-state" role="alert">
          <h2 className="wbp-state-title">{t('whiteboard.page.defaultFailed')}</h2>
          <p className="wbp-state-reason">{fallback.error?.message}</p>
          <button type="button" className="wbp-btn" onClick={() => void fallback.refetch()}>
            {t('whiteboard.page.retry')}
          </button>
        </div>
      </div>
    );
  }
  return <div className="wbp-editor">{explorerToggle && <div className="wbp-state-top">{explorerToggle}</div>}<div className="wbp-loading">{t('common.loading')}</div></div>;
  }
}

// ── one board, full-bleed ────────────────────────────────────────────────────────────────────

function WhiteboardEditor({ slug, onOpen, goneNote, onGone, recent, explorerToggle }: {
  slug: string;
  onOpen: (slug: string) => void;
  goneNote: string | null;
  onGone: (next: string, text: string) => void;
  /** The explorer's recent boards, newest first: where a board deleted elsewhere moves the page. */
  recent: readonly string[];
  /** The "show the board list" button, when the explorer is hidden. */
  explorerToggle?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const { load, saveState, gone, onApi, onSceneChange, exportFile, pictures, flush } = useWhiteboardEditor(slug);
  const { vault, bus } = useVault();
  // The Super's writing field (2026-11-11): only while Super mode is on, on a ready board.
  const presence = useSuperPresence(bus);
  const [selection, setSelection] = useState<SelectionRef | null>(null);
  const [work, setWork] = useState<FieldWork | null>(null);
  // The canvas, measured once: the writing field's place and whether the page's controls fit
  // in Excalidraw's top row both read it.
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const canvasBox = useCanvasBox(canvasEl);
  // The save state and the Agents toggle ride Excalidraw's top-right row while it fits the
  // canvas, else their own corner group under it (useTopRowFit decides, and re-measures on every
  // width change of the row or its controls).
  const [toggleEl, setToggleEl] = useState<HTMLButtonElement | null>(null);
  const controlsAside = useTopRowFit(toggleEl, canvasBox, locale);
  const canvasRef = useRef<WhiteboardCanvasApi | null>(null);
  const onCanvasApi = useCallback((api: WhiteboardCanvasApi | null) => {
    canvasRef.current = api;
    onApi(api);
  }, [onApi]);
  const clearSelection = useCallback(() => {
    canvasRef.current?.excalidraw.updateScene({ appState: { selectedElementIds: {} } as never });
  }, []);
  const panelOpen = useAgentPanelOpen(vault);
  const [exportNote, setExportNote] = useState<ExportNote | null>(null);
  const boards = useWhiteboardList();
  useBoardHash(slug);

  const doExport = async () => setExportNote(await exportFile());
  // The list first: a rename patches it, never the loaded board.
  const listed = boards.data?.find((b) => b.slug === slug)?.name;
  const name = listed || (load.kind === 'ready' ? load.name : slug);

  // The open board went from disk (the CLI, an agent, another window; useWhiteboardEditor): the
  // page moves to the most recent other board that still exists, else the default, and says so
  // there. Never off the default board, which the server makes again on the next ask.
  const goneRef = useRef({ onGone, onOpen, recent, name, boards: boards.data });
  goneRef.current = { onGone, onOpen, recent, name, boards: boards.data };
  useEffect(() => {
    if (!gone || slug === DEFAULT_BOARD_SLUG) return;
    const cur = goneRef.current;
    const existing = cur.boards ? new Set(cur.boards.map((b) => b.slug)) : null;
    const next = goneBoardTarget(slug, cur.recent, existing);
    // A function replacement: a `$` in the name is text, never a pattern.
    cur.onGone(next, t('whiteboard.page.goneNote').replace('{board}', () => cur.name));
    cur.onOpen(next);
  }, [gone]); // eslint-disable-line react-hooks/exhaustive-deps

  const heading = <h1 className="wbp-sr-only">{name}</h1>;

  if (load.kind === 'loading') {
    return <div className="wbp-editor">{heading}{explorerToggle && <div className="wbp-state-top">{explorerToggle}</div>}<div className="wbp-loading">{t('common.loading')}</div></div>;
  }

  if (load.kind === 'corrupt' || load.kind === 'missing' || load.kind === 'error') {
    return (
      <div className="wbp-editor">
        {heading}
        {explorerToggle && <div className="wbp-state-top">{explorerToggle}</div>}
        {goneNote && <div className="wbp-banner wbp-banner--quiet" role="status">{goneNote}</div>}
        <div className="wbp-card-state" role="alert">
          {load.kind === 'corrupt' && (
            <>
              <h2 className="wbp-state-title">{t('whiteboard.page.corruptTitle')}</h2>
              <p className="wbp-state-body">{t('whiteboard.page.corruptBody')}</p>
              <code className="wbp-state-file">{load.file}</code>
              <p className="wbp-state-reason">{load.reason}</p>
            </>
          )}
          {load.kind === 'missing' && <h2 className="wbp-state-title">{t('whiteboard.page.missing')}</h2>}
          {load.kind === 'error' && (
            <>
              <h2 className="wbp-state-title">{t('whiteboard.page.loadFailed')}</h2>
              <p className="wbp-state-reason">{load.message}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const canExport = saveState.kind === 'failed' || saveState.kind === 'deleted';
  // The page's controls in the canvas's own top-right row, before "+ Add": the save state, quiet
  // until it fails, and the board agents panel's toggle.
  const controls = (
    <>
      <SaveStatus state={saveState} />
      <button
        ref={setToggleEl}
        type="button"
        className="wbp-agent-toggle"
        aria-pressed={panelOpen}
        title={t('whiteboard.agentPanel.toggle')}
        onClick={() => setAgentPanelOpen(vault, !panelOpen)}
      >
        <AgentsGlyph />
        {t('whiteboard.agentPanel.button')}
      </button>
    </>
  );

  return (
    <div className="wbp-editor">
      {heading}
      {canExport && (
        <div className="wbp-banner wbp-banner--action" role="alert">
          <span>{saveState.kind === 'deleted'
            ? t('whiteboard.page.deleted')
            : t('whiteboard.page.notSavedReason').replace('{reason}', () => saveState.reason)}</span>
          <button type="button" className="wbp-btn" onClick={() => void doExport()}>
            {saveState.kind === 'deleted' ? t('whiteboard.page.exportFile') : t('whiteboard.page.export')}
          </button>
        </div>
      )}
      {exportNote && <div className="wbp-banner wbp-banner--quiet" role="status">{exportNote.text}</div>}
      {goneNote && <div className="wbp-banner wbp-banner--quiet" role="status">{goneNote}</div>}
      <div className="wbp-body">
        {/* Pages open in a panel on the board's right; the board stays in view on its left. */}
        <PagePopupProvider>
          <div className="wbp-canvas" ref={setCanvasEl}>
            <Suspense fallback={<div className="wbp-loading">{t('common.loading')}</div>}>
              <LazyWhiteboardCanvas boardSlug={slug} initialScene={load.scene} onApi={onCanvasApi} pictures={pictures} onSceneChange={onSceneChange} topRight={controlsAside ? null : controls} onSelection={setSelection} workBox={work?.box ?? null} />
            </Suspense>
            {controlsAside && <div className="wbp-float-right" data-testid="wbp-controls-aside">{controls}</div>}
            {explorerToggle && (
              <div className="wbp-float-left">
                {explorerToggle}
                <span className="wbp-float-name" title={name}>{name}</span>
              </div>
            )}
            {presence?.on && (
              <BoardSuperField
                bus={bus}
                board={slug}
                boardName={name}
                selection={selection}
                onClearSelection={clearSelection}
                saveKind={saveState.kind}
                flush={flush}
                onWork={setWork}
                canvas={canvasBox}
              />
            )}
          </div>
        </PagePopupProvider>
        {panelOpen && <BoardAgentPanel board={slug} />}
      </div>
    </div>
  );
}

/**
 * Keep the board in the URL hash, so a reload lands back on it. Only the project in front
 * writes it (one URL per window); leaving the page takes it off.
 */
function useBoardHash(slug: string): void {
  const { isActive } = useVault();
  useEffect(() => {
    if (!isActive) return;
    writeHash(formatBoardHash(slug, window.location.hash));
  }, [isActive, slug]);
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  useLayoutEffect(() => () => {
    if (activeRef.current) writeHash(clearBoardHash(window.location.hash));
  }, []);
}

/** Replace the hash in place: a board switch is not a step the browser's Back should walk. */
function writeHash(hash: string): void {
  if (window.location.hash === hash || (!hash && !window.location.hash)) return;
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + hash);
}

function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useI18n();
  switch (state.kind) {
    case 'saved':
      return <span className="wbp-status" role="status">{t('whiteboard.page.saved')}</span>;
    case 'saving':
      return <span className="wbp-status" role="status">{t('whiteboard.page.saving')}</span>;
    case 'retrying':
      return <span className="wbp-status wbp-status--bad" role="status" title={state.reason}>{t('whiteboard.page.notSaved')}</span>;
    case 'failed':
      // Short here; the reason and Export are in the banner over the board.
      return <span className="wbp-status wbp-status--bad" role="alert" title={state.reason}>{t('whiteboard.page.notSaved')}</span>;
    case 'deleted':
      return <span className="wbp-status wbp-status--bad" role="alert">{t('whiteboard.page.notSaved')}</span>;
  }
}

function AgentsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5.5" r="2.25" /><path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4" /><path d="M10.5 3.5a2.25 2.25 0 0 1 0 4.25M11.5 9.2c1.5.5 2.5 1.9 2.5 3.8" />
    </svg>
  );
}
