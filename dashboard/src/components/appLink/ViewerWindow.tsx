import { useCallback, useEffect, useState } from 'react';
import { agentFileUrl } from '../../api/client';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { closeCurrentWindow, startTitleBarDrag } from '../../lib/desktop';
import { isValidAppLinkPath } from '../../lib/appLink';
import { FileActions } from '../sleepy/chat/FileActions';
import { Lightbox } from '../sleepy/chat/Lightbox';
import { DocumentReader, readerLinkAction, readerTakesWholeWindow } from './DocumentReader';
import { fileNameOf } from './viewerPaths';
import '../sleepy/chat/cards.css';
import '../sleepy/chat/overlays.css';
import './ViewerWindow.css';

/**
 * The small dreamcontext window a clicked banner opens a document in (`?viewer=<path>&vault=`,
 * built by `openViewerWindow`): the run's report rendered as formatted markdown WITH its
 * pictures, where it used to open as raw text in whatever editor owned `.md`.
 *
 * The reading itself is {@link DocumentReader}, shared with the whiteboard's page popup and wiki
 * pane; this window adds its title bar, its back stack and the lightbox. Every piece is the one
 * the app already uses to show a file, so a document looks the same here as in Chat or on the
 * Agents page: `MarkdownPreview` for the prose, `useInlineMedia` for the
 * pictures and clips it references (with its Allow-access / Open fallbacks), and the Agents
 * page's routing by type — a board draws full, a PDF gets the engine's viewer, a picture is
 * shown. The one thing added is resolving a reference against the DOCUMENT's own folder, which
 * is how a report writes `![chart](chart.png)` beside itself.
 *
 * NARROW BY DESIGN. This window renders agent-authored markdown, so its capability grants drag,
 * close and focus only: nothing here emits events, builds windows or calls shell commands. A
 * link to another file in the project opens IN this window (with a way back); a picture opens
 * in the lightbox over it.
 */
export function ViewerWindow({ path: initialPath }: { path: string }) {
  const { vault } = useVault();
  const { t } = useI18n();
  const [stack, setStack] = useState<string[]>([initialPath]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const path = stack[stack.length - 1];
  const name = fileNameOf(path);

  useEffect(() => {
    document.title = name;
  }, [name]);

  const open = useCallback((next: string) => {
    const action = readerLinkAction(next);
    // A `dreamcontext://` link inside a document is not a file, and this window may not route.
    if (action === 'url') return;
    if (action === 'image') { setZoomed(next); return; }
    setStack((prev) => [...prev, next]);
  }, []);
  const back = useCallback(() => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)), []);
  /** The full-window viewers' close: back to the document that linked here, else the window. */
  const closeOrBack = useCallback(() => {
    if (stack.length > 1) back();
    else void closeCurrentWindow();
  }, [stack.length, back]);

  if (!vault || !isValidAppLinkPath(path)) {
    return (
      <div className="viewer-window">
        <ViewerBar name={name} path={path} canGoBack={false} onBack={back} />
        <p className="viewer-status viewer-status--error">{t('viewer.invalid')}</p>
      </div>
    );
  }

  if (readerTakesWholeWindow(path)) return <DocumentReader path={path} onOpen={open} onClose={closeOrBack} />;

  return (
    <div className="viewer-window">
      <ViewerBar name={name} path={path} canGoBack={stack.length > 1} onBack={back} />
      <div className="viewer-body">
        <DocumentReader path={path} onOpen={open} onClose={closeOrBack} />
      </div>
      {zoomed && (
        <Lightbox
          src={agentFileUrl(vault, zoomed, { raw: true })}
          caption={fileNameOf(zoomed)}
          path={zoomed}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>
  );
}

/** The window's own title bar: traffic-light room, a way back, the file name, the OS doors. */
function ViewerBar({
  name, path, canGoBack, onBack,
}: { name: string; path: string; canGoBack: boolean; onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div className="viewer-bar" onMouseDown={startTitleBarDrag}>
      <div className="viewer-bar-inset" aria-hidden="true" />
      {canGoBack && (
        <button type="button" className="viewer-back" onClick={onBack} title={t('viewer.back')}>
          <span aria-hidden="true">←</span> {t('viewer.back')}
        </button>
      )}
      <span className="viewer-bar-title" title={path}>{name}</span>
      {isValidAppLinkPath(path) && <FileActions path={path} compact className="viewer-bar-actions" />}
    </div>
  );
}
