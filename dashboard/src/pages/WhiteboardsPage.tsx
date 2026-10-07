import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { useApi, useVault } from '../context/VaultContext';
import { useFocusTarget, type FocusTarget } from '../hooks/useFocusTarget';
import { useDefaultWhiteboard, useWhiteboardEditor, useWhiteboardList } from '../hooks/useWhiteboards';
import { useAutomations } from '../hooks/useAutomations';
import type { SaveState } from '../hooks/whiteboardSaveLoop';
import type { ExportNote } from '../lib/exportDownload';
import { LazyWhiteboardCanvas } from '../components/whiteboard/LazyWhiteboardCanvas';
import { PagePopupProvider } from '../components/whiteboard/PagePopup';
import { BoardAgentPanel } from '../components/whiteboard/BoardAgentPanel';
import { setAgentPanelOpen, useAgentPanelOpen, useBoardCards } from '../components/whiteboard/agentPanelState';
import { dropBoardAgentScratch, sweepHomeSessions } from '../components/whiteboard/boardAgentScratch';
import { readLastBoard, writeLastBoard } from '../components/whiteboard/boardPlace';
import { hydrateWhiteboardPrefs, isWhiteboardPrefsHydrated } from '../components/whiteboard/whiteboardPrefs';
import { BoardTabs } from './whiteboards/BoardTabs';
import { clearBoardHash, formatBoardHash, parseBoardHash } from './whiteboards/boardHash';
import './WhiteboardsPage.css';

interface WhiteboardsPageProps {
  /** Shell navigation focus: the `id` is a board slug, opened full-bleed. */
  focus?: FocusTarget;
}

/**
 * Control Panel (A15): one board open full-bleed, with the boards as tabs on top (A16). A
 * board is an Excalidraw scene the user and the agent draw on together; the CLI writes the
 * same file, and the editor's save + poll loop keeps the two in step (D5, D11).
 *
 * The page id stays `whiteboards` (persisted nav state, the chat's appNav deep links). With
 * no slug it opens the default board, which the server ensures exists; there is no list page.
 */
export function WhiteboardsPage({ focus }: WhiteboardsPageProps = {}) {
  const { t } = useI18n();
  const { vault } = useVault();
  const api = useApi();
  // The page's memory (tabs, groups, last board, viewports, panel) is read back from the server
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
  const { instanceId, vault } = useVault();
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
  // With no deep link, the board the owner was on when they last left the page (boardPlace.ts),
  // once the list says it still exists; else the default board.
  const [remembered] = useState(() => (vault ? readLastBoard(vault) : null));
  const boards = useWhiteboardList();
  // A refused rename's reason, here so it outlives the open board: a rename still in flight
  // when the owner switches boards reports to the next one.
  const [renameNote, setRenameNote] = useState<{ board: string; text: string } | null>(null);
  useEffect(() => { setRenameNote(null); }, [openSlug]);
  // A rename's answer clears only its own board's note: a late success on one board never
  // wipes another board's refusal.
  const onRenameNote = useCallback((board: string, text: string | null) => {
    setRenameNote((prev) => (text ? { board, text } : prev?.board === board ? null : prev));
  }, []);
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

  // Only the open board's agents' conversations stay alive (one `claude` each): its home agents
  // and the agents with a card on it. The rest end once idle, so boards visited with the panel
  // open, deleted boards, removed cards and re-homed agents never pile up.
  const { data: automations } = useAutomations();
  const openCards = useBoardCards(vault, openSlug ?? undefined);
  useEffect(() => {
    if (!vault || !openSlug || !automations) return;
    sweepHomeSessions(vault, (board, agent) => board === openSlug && automations.some((a) => a.slug === agent
      && (a.whiteboard === board || openCards.some((c) => c.agent === agent))));
  }, [vault, openSlug, automations, openCards]);

  if (openSlug) {
    // Keyed on the slug: switching boards unmounts this editor first, so its save loop's
    // dispose flushes the unsaved scene while the canvas handle is still there.
    return <WhiteboardEditor key={openSlug} slug={openSlug} onOpen={setOpenSlug} renameNote={renameNote?.text ?? null} onRenameNote={onRenameNote} />;
  }
  if (fallback.isError) {
    return (
      <div className="wbp-editor">
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
  return <div className="wbp-editor"><div className="wbp-loading">{t('common.loading')}</div></div>;
}

// ── one board, full-bleed ────────────────────────────────────────────────────────────────────

function WhiteboardEditor({ slug, onOpen, renameNote, onRenameNote }: {
  slug: string;
  onOpen: (slug: string) => void;
  renameNote: string | null;
  onRenameNote: (board: string, note: string | null) => void;
}) {
  const { t } = useI18n();
  const { load, saveState, onApi, onSceneChange, exportFile, pictures } = useWhiteboardEditor(slug);
  const { vault } = useVault();
  const panelOpen = useAgentPanelOpen(vault);
  const [exportNote, setExportNote] = useState<ExportNote | null>(null);
  const boards = useWhiteboardList();
  useBoardHash(slug);

  const doExport = async () => setExportNote(await exportFile());

  const switcher = (
    <BoardTabs slug={slug} name={load.kind === 'ready' ? load.name : undefined} onOpen={onOpen} onRenameNote={onRenameNote} />
  );
  // The same first child in every state, so the strip keeps its place (and its state) when
  // the board finishes loading.
  // The list first, as the tabs do: a rename patches it, never the loaded board.
  const listed = boards.data?.find((b) => b.slug === slug)?.name;
  const heading = <h1 className="wbp-sr-only">{listed || (load.kind === 'ready' ? load.name : slug)}</h1>;

  if (load.kind === 'loading') {
    return <div className="wbp-editor">{heading}<div className="wbp-bar">{switcher}</div><div className="wbp-loading">{t('common.loading')}</div></div>;
  }

  if (load.kind === 'corrupt' || load.kind === 'missing' || load.kind === 'error') {
    return (
      <div className="wbp-editor">
        {heading}
        <div className="wbp-bar">{switcher}</div>
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

  return (
    <div className="wbp-editor">
      {heading}
      <div className="wbp-bar">
        {switcher}
        <SaveStatus state={saveState} />
        <button
          type="button"
          className="wbp-agent-toggle"
          aria-pressed={panelOpen}
          title={t('whiteboard.agentPanel.toggle')}
          onClick={() => setAgentPanelOpen(vault, !panelOpen)}
        >
          {t('whiteboard.agentPanel.title')}
        </button>
        {canExport && (
          <button type="button" className="wbp-btn" onClick={() => void doExport()}>
            {saveState.kind === 'deleted' ? t('whiteboard.page.exportFile') : t('whiteboard.page.export')}
          </button>
        )}
      </div>
      {saveState.kind === 'deleted' && (
        <div className="wbp-banner" role="alert">{t('whiteboard.page.deleted')}</div>
      )}
      {exportNote && <div className="wbp-banner wbp-banner--quiet" role="status">{exportNote.text}</div>}
      {renameNote && <div className="wbp-banner" role="alert">{renameNote}</div>}
      <div className="wbp-body">
        {/* Pages open in a panel on the board's right; the board stays in view on its left. */}
        <PagePopupProvider>
          <div className="wbp-canvas">
            <Suspense fallback={<div className="wbp-loading">{t('common.loading')}</div>}>
              <LazyWhiteboardCanvas boardSlug={slug} initialScene={load.scene} onApi={onApi} pictures={pictures} onSceneChange={onSceneChange} />
            </Suspense>
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
      return (
        <span className="wbp-status wbp-status--bad" role="alert">
          {t('whiteboard.page.notSavedReason').replace('{reason}', state.reason)}
        </span>
      );
    case 'deleted':
      return <span className="wbp-status wbp-status--bad" role="alert">{t('whiteboard.page.notSaved')}</span>;
  }
}
