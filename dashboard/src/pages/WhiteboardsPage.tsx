import { Suspense, useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { useFocusTarget, type FocusTarget } from '../hooks/useFocusTarget';
import { useDefaultWhiteboard, useWhiteboardEditor } from '../hooks/useWhiteboards';
import type { SaveState } from '../hooks/whiteboardSaveLoop';
import type { ExportNote } from '../lib/exportDownload';
import { LazyWhiteboardCanvas } from '../components/whiteboard/LazyWhiteboardCanvas';
import { BoardSwitcher } from './whiteboards/BoardSwitcher';
import './WhiteboardsPage.css';

interface WhiteboardsPageProps {
  /** Shell navigation focus: the `id` is a board slug, opened full-bleed. */
  focus?: FocusTarget;
}

/**
 * Control Panel (A15): one board open full-bleed, with the board switcher on top (A16). A
 * board is an Excalidraw scene the user and the agent draw on together; the CLI writes the
 * same file, and the editor's save + poll loop keeps the two in step (D5, D11).
 *
 * The page id stays `whiteboards` (persisted nav state, the chat's appNav deep links). With
 * no slug it opens the default board, which the server ensures exists; there is no list page.
 */
export function WhiteboardsPage({ focus }: WhiteboardsPageProps = {}) {
  const { t } = useI18n();
  const [openSlug, setOpenSlug] = useState<string | null>(focus?.id ?? null);
  useFocusTarget(focus, setOpenSlug);
  const fallback = useDefaultWhiteboard(openSlug === null);

  useEffect(() => {
    if (openSlug === null && fallback.data) setOpenSlug(fallback.data);
  }, [openSlug, fallback.data]);

  if (openSlug) {
    // Keyed on the slug: switching boards unmounts this editor first, so its save loop's
    // dispose flushes the unsaved scene while the canvas handle is still there.
    return <WhiteboardEditor key={openSlug} slug={openSlug} onOpen={setOpenSlug} />;
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

function WhiteboardEditor({ slug, onOpen }: { slug: string; onOpen: (slug: string) => void }) {
  const { t } = useI18n();
  const { load, saveState, onApi, onSceneChange, exportFile } = useWhiteboardEditor(slug);
  const [exportNote, setExportNote] = useState<ExportNote | null>(null);

  const doExport = async () => setExportNote(await exportFile());

  const switcher = (
    <BoardSwitcher slug={slug} name={load.kind === 'ready' ? load.name : undefined} onOpen={onOpen} />
  );

  if (load.kind === 'loading') {
    return <div className="wbp-editor"><div className="wbp-bar">{switcher}</div><div className="wbp-loading">{t('common.loading')}</div></div>;
  }

  if (load.kind === 'corrupt' || load.kind === 'missing' || load.kind === 'error') {
    return (
      <div className="wbp-editor">
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
      <h1 className="wbp-sr-only">{load.name}</h1>
      <div className="wbp-bar">
        {switcher}
        <span className="wbp-head-spacer" />
        <SaveStatus state={saveState} />
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
      <div className="wbp-canvas">
        <Suspense fallback={<div className="wbp-loading">{t('common.loading')}</div>}>
          <LazyWhiteboardCanvas initialScene={load.scene} onApi={onApi} onSceneChange={onSceneChange} />
        </Suspense>
      </div>
    </div>
  );
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
