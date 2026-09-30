import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { agentFileUrl } from '../../api/client';
import { useApi, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { closeCurrentWindow, startTitleBarDrag } from '../../lib/desktop';
import { revealPath } from '../../lib/reveal';
import { isValidAppLinkPath } from '../../lib/appLink';
import { MarkdownPreview } from '../core/MarkdownPreview';
import { agentFileKind } from '../agents/AgentMessage';
import { inlineMediaKind, joinChildPath, useInlineMedia } from '../sleepy/chat/chatEntities';
import { FileActions } from '../sleepy/chat/FileActions';
import { FileUnavailable } from '../sleepy/chat/FileUnavailable';
import { Lightbox } from '../sleepy/chat/Lightbox';
import { MediaEmbed } from '../sleepy/chat/MediaEmbed';
import { PdfViewer } from '../sleepy/chat/PdfViewer';
import { BoardFullscreen } from '../sleepy/chat/BoardEmbed';
import { fileNameOf, resolveDocumentRef, stripFrontmatter } from './viewerPaths';
import '../sleepy/chat/cards.css';
import '../sleepy/chat/overlays.css';
import './ViewerWindow.css';

/**
 * The small dreamcontext window a clicked banner opens a document in (`?viewer=<path>&vault=`,
 * built by `openViewerWindow`): the run's report rendered as formatted markdown WITH its
 * pictures, where it used to open as raw text in whatever editor owned `.md`.
 *
 * Every piece is the one the app already uses to show a file, so a document looks the same here
 * as in Chat or on the Agents page: `MarkdownPreview` for the prose, `useInlineMedia` for the
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
    // A `dreamcontext://` link inside a document is not a file, and this window may not route.
    if (/^[a-z][a-z0-9+.-]*:/i.test(next)) return;
    if (inlineMediaKind(next) === 'image') { setZoomed(next); return; }
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

  const kind = agentFileKind(path);
  if (kind === 'board') return <BoardFullscreen path={path} onClose={closeOrBack} />;
  if (kind === 'pdf') return <PdfViewer path={path} label={name} onClose={closeOrBack} />;

  const media = path.toLowerCase().endsWith('.svg') ? 'image' : inlineMediaKind(path);
  return (
    <div className="viewer-window">
      <ViewerBar name={name} path={path} canGoBack={stack.length > 1} onBack={back} />
      <div className="viewer-body">
        {media ? <ViewerMedia key={path} path={path} kind={media} /> : <ViewerDocument key={path} path={path} onOpen={open} />}
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

/** A picture, clip or recording opened on its own. */
function ViewerMedia({ path, kind }: { path: string; kind: 'image' | 'video' | 'audio' }) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  // Consent changes what the server answers, so a granted file is requested again.
  const [reload, setReload] = useState(0);
  const base = agentFileUrl(vault, path, { raw: true });
  const src = reload ? `${base}&reload=${reload}` : base;
  if (failed) {
    return <FileUnavailable src={src} kind={kind} onGranted={() => { setFailed(false); setReload((n) => n + 1); }} />;
  }
  if (kind === 'image') return <img className="viewer-media" src={src} alt={fileNameOf(path)} onError={() => setFailed(true)} />;
  return <MediaEmbed kind={kind} className="viewer-media" src={src} onError={() => setFailed(true)} />;
}

interface DirEntry { name: string; kind: 'dir' | 'file'; size: number | null }
type FileContent =
  | { path: string; type: 'text' | 'markdown'; content: string }
  | { path: string; type: 'dir'; entries: DirEntry[] };

/** Marks a reference this window has already resolved against the document's folder. */
const RESOLVED_ATTR = 'data-viewer-resolved';

/**
 * Rewrite every document-relative `img[src]` / `a[href]` to its project-relative path, so the
 * inline-media pass that runs right after (and the file route behind it) reads the file the
 * document meant. Marked once done: resolving a resolved path would apply the folder twice.
 */
function useDocumentRelativeRefs(ref: RefObject<HTMLElement | null>, docPath: string): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rewrite = (el: Element, attr: 'src' | 'href') => {
      el.setAttribute(RESOLVED_ATTR, '1');
      const resolved = resolveDocumentRef(docPath, el.getAttribute(attr) ?? '');
      if (resolved) el.setAttribute(attr, resolved);
    };
    root.querySelectorAll(`img[src]:not([${RESOLVED_ATTR}]):not([data-chat-media])`).forEach((el) => rewrite(el, 'src'));
    root.querySelectorAll(`a[href]:not([${RESOLVED_ATTR}]):not([data-chat-media])`).forEach((el) => rewrite(el, 'href'));
  }); // every render, like the inline-media pass it feeds
}

/** A text document: markdown formatted with its media, plain text as text, a folder listed. */
function ViewerDocument({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const api = useApi();
  const { t } = useI18n();
  const [state, setState] = useState<{ loading: boolean; data: FileContent | null; error: string | null }>(
    { loading: true, data: null, error: null },
  );
  const docRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    api.get<FileContent>(`/agent/file?path=${encodeURIComponent(path)}`)
      .then((data) => { if (!cancelled) setState({ loading: false, data, error: null }); })
      .catch((err: Error) => {
        if (!cancelled) setState({ loading: false, data: null, error: err.message || t('viewer.failed') });
      });
    return () => { cancelled = true; };
  }, [api, path, t]);

  // Order matters: both are layout effects of THIS component, run in declaration order after
  // MarkdownPreview has written its blocks, so references are resolved before media is built.
  useDocumentRelativeRefs(docRef, path);
  useInlineMedia(docRef, {
    onOpen,
    onReveal: (p) => revealPath(api, p),
    onGrant: (p) => api.post('/agent/grant', { path: p }).then(() => true, () => false),
  });

  const data = state.data;
  return (
    <div ref={docRef} className="viewer-doc">
      {state.loading && <p className="viewer-status">{t('viewer.loading')}</p>}
      {state.error && <p className="viewer-status viewer-status--error">{t('viewer.failed')} {state.error}</p>}
      {data?.type === 'markdown' && typeof data.content === 'string' && (
        <MarkdownPreview content={stripFrontmatter(data.content)} />
      )}
      {data?.type === 'text' && typeof data.content === 'string' && <pre className="viewer-text">{data.content}</pre>}
      {data?.type === 'dir' && (
        Array.isArray(data.entries) && data.entries.length > 0 ? (
          <div className="viewer-dir">
            {data.entries.map((e) => (
              <button
                type="button"
                key={e.name}
                className="viewer-dir-entry"
                onClick={() => onOpen(joinChildPath(path, e.name))}
                title={joinChildPath(path, e.name)}
              >
                <span className="viewer-dir-kind">{e.kind === 'dir' ? t('viewer.folder') : t('viewer.file')}</span>
                <span className="viewer-dir-name">{e.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="viewer-status">{t('viewer.emptyFolder')}</p>
      )}
    </div>
  );
}
