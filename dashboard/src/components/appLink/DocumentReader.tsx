import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { agentFileUrl, graphContentUrl } from '../../api/client';
import { useApi, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useTheme } from '../../context/ThemeContext';
import { revealPath } from '../../lib/reveal';
import { isValidAppLinkPath } from '../../lib/appLink';
import { agentFileKind } from '../../lib/agentFileKind';
import { resolveWikilinkTarget, type WikilinkCandidate } from '../../lib/wikilinks';
import { buildSandboxSrcdoc, SANDBOX_ALLOW } from '../../lib/sandboxHtml';
import { MarkdownPreview } from '../core/MarkdownPreview';
import {
  CHAT_HTML_KIT_CSS, CHAT_HTML_SANDBOX, HEIGHT_BRIDGE, HEIGHT_REQUEST_KEY, MAX_HTML_HEIGHT,
  readHeightMessage, resolveChatKitTokens,
} from '../sleepy/chat/chatHtmlKit';
import { inlineMediaKind, joinChildPath, useInlineMedia } from '../sleepy/chat/chatEntities';
import { FileActions } from '../sleepy/chat/FileActions';
import { FileUnavailable } from '../sleepy/chat/FileUnavailable';
import { MediaEmbed } from '../sleepy/chat/MediaEmbed';
import { PdfViewer } from '../sleepy/chat/PdfViewer';
import { BoardEmbed, BoardFullscreen } from '../sleepy/chat/BoardEmbed';
import { CloseIcon } from '../whiteboard/PanelIcons';
import { fileNameOf, resolveDocumentRef, stripFrontmatter } from './viewerPaths';
import '../sleepy/chat/cards.css';
import '../sleepy/chat/overlays.css';
import './ViewerWindow.css';
import './DocumentReader.css';

/**
 * ONE FILE, READ — the type routing the viewer window has always done, lifted out so a page
 * popup and a wiki pane read a file exactly the way the window does (component reuse, not a
 * second reader): markdown formatted with its pictures, a PDF in the engine's viewer, a board
 * drawn, a picture or clip shown, a folder listed, plain text as text, and a web page in the
 * chat's strict sandbox.
 *
 * The reader holds NO history. Every link it follows — a document-relative link, a folder
 * entry, a resolved `[[wikilink]]` — is handed to `onOpen`, and the host decides what that
 * means (the window pushes it on its back stack and zooms pictures; a popup keeps its own
 * back/forward). See {@link readerLinkAction} for the triage a host applies to it.
 *
 * TWO MODES. Full-window (`embedded` false, the viewer window): a board and a PDF take the
 * whole window and close through `onClose`, as they always have; the host checks
 * {@link readerTakesWholeWindow} to leave its own chrome off for them. Embedded: everything
 * renders inline in the container — a PDF through PdfViewer's embedded mode, a board as its
 * inline embed that can still go fullscreen.
 *
 * Standalone: it needs no host chrome, so the board's side panel and the wiki card's in-card
 * reader both mount it as is (`embedded vaultReads hostFileActions variant="page"`).
 */

export interface DocumentReaderProps {
  /** The file, project-relative (what `/agent/file` and the reveal routes take). */
  path: string;
  /** A link inside the document was followed: a project-relative path, a picture, or a URL. */
  onOpen: (path: string) => void;
  /** Full-window kinds (board, PDF) close through this when not embedded. */
  onClose?: () => void;
  /** Render inline in a popup or pane instead of taking the window for a board or PDF. */
  embedded?: boolean;
  /**
   * A `[[wikilink]]` was clicked. Given, the host handles it entirely; absent, the reader
   * resolves it against the knowledge list and opens it through `onOpen`, or says it is not
   * found.
   */
  onWikilink?: (target: string) => void;
  /**
   * Read files under `_dream_context/` through the vault-scoped `/graph/content` route instead
   * of `/agent/file`. That route is not gated on the desktop app, so a browser dashboard can
   * still read a knowledge page or a task; files outside the vault keep `/agent/file`.
   */
  vaultReads?: boolean;
  /** The host's own chrome already carries the file's open / reveal buttons: the reader
   *  leaves its own (under a web page) off. */
  hostFileActions?: boolean;
  /**
   * Also read an ABSOLUTE path (`/…`, never with a `..` step): the board's web block names a
   * file anywhere on this computer. `/agent/file` still decides: outside the project it serves
   * nothing until the owner has allowed that exact file (the host asks first).
   */
  allowAbsolute?: boolean;
  /**
   * `page`: read as a PAGE, not an editor card — no frame or card background around the text,
   * body text at reading size, the line capped near 70 characters and centred, generous
   * margins (DocumentReader.css, `.doc-reader--page`). The board's side panel and the wiki
   * card use it; the viewer window does not pass it and keeps its look.
   */
  variant?: 'default' | 'page';
}

const CONTEXT_PREFIX = '_dream_context/';

/** The vault-relative path `/graph/content` takes, when `vaultReads` applies to this file. */
function vaultPath(path: string, vaultReads: boolean): string | null {
  return vaultReads && path.startsWith(CONTEXT_PREFIX) && path.length > CONTEXT_PREFIX.length
    ? path.slice(CONTEXT_PREFIX.length)
    : null;
}

/** Board and PDF draw over the whole window in full-window mode, with their own chrome. */
export function readerTakesWholeWindow(path: string): boolean {
  const kind = agentFileKind(path);
  return kind === 'board' || kind === 'pdf';
}

/**
 * How a host should treat a path the reader handed to `onOpen`: a URL (`dreamcontext://`,
 * `https:`) is not a file and is the host's to route or ignore; a picture is zoomed over the
 * document; anything else is a document to read next.
 */
export function readerLinkAction(next: string): 'url' | 'image' | 'document' {
  if (/^[a-z][a-z0-9+.-]*:/i.test(next)) return 'url';
  if (inlineMediaKind(next) === 'image') return 'image';
  return 'document';
}

/** Copy this lane may not add to the shared dictionary yet: the key when it exists, else English. */
function useText(): (key: string, fallback: string) => string {
  const { t } = useI18n();
  return useCallback((key: string, fallback: string) => {
    const v = t(key);
    return v === key ? fallback : v;
  }, [t]);
}

export function DocumentReader({
  path, onOpen, onClose, embedded = false, onWikilink, vaultReads = false, hostFileActions = false,
  variant = 'default', allowAbsolute = false,
}: DocumentReaderProps) {
  const api = useApi();
  const { vault } = useVault();
  const queryClient = useQueryClient();
  const tx = useText();
  const [notice, setNotice] = useState<string | null>(null);
  const [boardFull, setBoardFull] = useState(false);
  const close = onClose ?? (() => {});

  // A notice is about the document it was raised on.
  useEffect(() => { setNotice(null); setBoardFull(false); }, [path]);

  const resolveWikilink = useCallback((target: string) => {
    setNotice(null);
    void queryClient.fetchQuery({
      // The Knowledge page's own query (hooks/useKnowledge.ts), so its cache answers.
      queryKey: ['knowledge'],
      queryFn: () => api.get<{ entries: WikilinkCandidate[] }>('/knowledge'),
    })
      .then((data) => data.entries, () => [] as WikilinkCandidate[])
      .then((entries) => {
        const resolved = resolveWikilinkTarget(target, entries);
        if (resolved) onOpen(resolved);
        else setNotice(`${tx('reader.wikilinkNotFound', 'Not found:')} ${target}`);
      });
  }, [api, queryClient, onOpen, tx]);

  const absoluteOk = allowAbsolute && path.startsWith('/') && !path.split('/').includes('..');
  if (!absoluteOk && !isValidAppLinkPath(path)) {
    return <p className="viewer-status viewer-status--error">{tx('viewer.invalid', 'This file can’t be opened here.')}</p>;
  }

  const name = fileNameOf(path);
  const kind = agentFileKind(path);
  const page = variant === 'page' ? ' doc-reader--page' : '';

  if (kind === 'board') {
    if (!embedded) return <BoardFullscreen path={path} onClose={close} />;
    return (
      <div className={`doc-reader doc-reader--board${page}`}>
        <BoardEmbed path={path} onOpenBoard={() => setBoardFull(true)} />
        {boardFull && <BoardFullscreen path={path} onClose={() => setBoardFull(false)} />}
      </div>
    );
  }
  if (kind === 'pdf') {
    const inVault = vaultPath(path, vaultReads);
    const src = inVault ? graphContentUrl(vault, inVault, { raw: true }) : undefined;
    if (!embedded) return <PdfViewer path={path} label={name} src={src} onClose={close} />;
    return (
      <div className={`doc-reader doc-reader--pdf${page}`}>
        <PdfViewer path={path} label={name} src={src} embedded />
      </div>
    );
  }

  const media = path.toLowerCase().endsWith('.svg') ? 'image' : inlineMediaKind(path);
  return (
    <div className={`${embedded ? 'doc-reader doc-reader--embedded' : 'doc-reader'}${page}`}>
      {notice && (
        <p className="doc-reader-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="doc-reader-notice-dismiss" onClick={() => setNotice(null)} aria-label={tx('reader.dismiss', 'Dismiss')} title={tx('reader.dismiss', 'Dismiss')}>
            {/* The window keeps its glyph; the page variant uses the panel's line icon. */}
            {page ? <CloseIcon size={14} /> : '✕'}
          </button>
        </p>
      )}
      {media ? <ViewerMedia key={path} path={path} kind={media} vaultReads={vaultReads} />
        : kind === 'html' ? (
          <HtmlPage key={path} path={path} embedded={embedded} vaultReads={vaultReads} fileActions={embedded && !hostFileActions} />
        ) : (
          <ViewerDocument key={path} path={path} onOpen={onOpen} onWikilink={onWikilink ?? resolveWikilink} vaultReads={vaultReads} />
        )}
    </div>
  );
}

/** A picture, clip or recording opened on its own. */
function ViewerMedia({ path, kind, vaultReads }: { path: string; kind: 'image' | 'video' | 'audio'; vaultReads: boolean }) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  // Consent changes what the server answers, so a granted file is requested again.
  const [reload, setReload] = useState(0);
  // The vault route serves raster pictures and clips, never an SVG (see graph.ts), so an SVG
  // keeps the file route.
  const inVault = path.toLowerCase().endsWith('.svg') ? null : vaultPath(path, vaultReads);
  const base = inVault ? graphContentUrl(vault, inVault, { raw: true }) : agentFileUrl(vault, path, { raw: true });
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

/** What `/graph/content` answers for a vault file: markdown and text as `/agent/file` does,
 *  JSON parsed (or raw when it does not parse). */
type VaultContent =
  | { path: string; type: 'text' | 'markdown'; content: string }
  | { path: string; type: 'json'; data?: unknown; raw?: string };

/** The file's text (or folder listing) from `/agent/file`, or from the vault route under
 *  `vaultReads`, refetched when the path changes. */
function useFileContent(path: string, vaultReads = false) {
  const api = useApi();
  const { t } = useI18n();
  const [state, setState] = useState<{ loading: boolean; data: FileContent | null; error: string | null }>(
    { loading: true, data: null, error: null },
  );
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    const inVault = vaultPath(path, vaultReads);
    const request: Promise<FileContent> = inVault
      ? api.get<VaultContent>(`/graph/content?path=${encodeURIComponent(inVault)}`).then((r): FileContent => (
        r.type === 'json'
          ? { path, type: 'text', content: typeof r.raw === 'string' ? r.raw : JSON.stringify(r.data, null, 2) }
          : { path, type: r.type, content: r.content }
      ))
      : api.get<FileContent>(`/agent/file?path=${encodeURIComponent(path)}`);
    request
      .then((data) => { if (!cancelled) setState({ loading: false, data, error: null }); })
      .catch((err: Error) => {
        if (!cancelled) setState({ loading: false, data: null, error: err.message || t('viewer.failed') });
      });
    return () => { cancelled = true; };
  }, [api, path, t, vaultReads]);
  return state;
}

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
function ViewerDocument({
  path, onOpen, onWikilink, vaultReads,
}: { path: string; onOpen: (path: string) => void; onWikilink: (target: string) => void; vaultReads: boolean }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useFileContent(path, vaultReads);
  const docRef = useRef<HTMLDivElement | null>(null);

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
        <MarkdownPreview content={stripFrontmatter(data.content)} onWikilink={onWikilink} />
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

/**
 * A web page (`.html`/`.htm`), drawn in the CHAT's strict sandbox: scripts yes; same-origin,
 * network, navigation, popups and forms no (CSP `default-src 'none'`). Built the way the board's
 * HTML block builds it (whiteboard/htmlWidgetFrame.ts): the shared srcdoc builder with the kit
 * CSS and the height bridge, and WITHOUT the chat's reach bridge — nothing in the page can post
 * a keystroke or a click into the host. A page's own `<link>` stylesheets and `<img src>` are
 * blocked by that CSP, which the line under the frame says.
 */
function HtmlPage({
  path, vaultReads, fileActions,
}: { path: string; embedded: boolean; vaultReads: boolean; fileActions: boolean }) {
  const tx = useText();
  const { t } = useI18n();
  const { resolved: theme } = useTheme();
  const state = useFileContent(path, vaultReads);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loads = useRef(0);
  const [height, setHeight] = useState<number | null>(null);
  const [torn, setTorn] = useState(false);
  const html = state.data && state.data.type !== 'dir' && typeof state.data.content === 'string'
    ? state.data.content : null;

  const srcDoc = useMemo(
    () => (html === null ? null : buildSandboxSrcdoc({
      html, css: CHAT_HTML_KIT_CSS, tokens: resolveChatKitTokens(), scheme: theme, headScript: HEIGHT_BRIDGE,
    })),
    [html, theme],
  );

  // The only message accepted: a height, from THIS frame's window (identity is the gate).
  useLayoutEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frameRef.current?.contentWindow || event.source !== frameRef.current.contentWindow) return;
      const h = readHeightMessage(event.data);
      if (h !== null) setHeight(Math.min(MAX_HTML_HEIGHT, h));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useLayoutEffect(() => { loads.current = 0; }, [srcDoc]);

  const onLoad = useCallback(() => {
    loads.current += 1;
    // A second load of the same srcdoc is the page navigating itself away.
    if (loads.current >= 2) { setTorn(true); return; }
    frameRef.current?.contentWindow?.postMessage({ [HEIGHT_REQUEST_KEY]: true }, '*');
  }, []);

  return (
    <div className="doc-reader-html">
      {state.loading && <p className="viewer-status">{t('viewer.loading')}</p>}
      {state.error && <p className="viewer-status viewer-status--error">{t('viewer.failed')} {state.error}</p>}
      {torn && (
        <p className="viewer-status viewer-status--error" role="alert">
          {tx('reader.htmlNavigated', 'This page tried to open another web page, so it was stopped.')}
        </p>
      )}
      {srcDoc !== null && !torn && (
        <iframe
          ref={frameRef}
          className="doc-reader-html-frame"
          title={fileNameOf(path)}
          sandbox={CHAT_HTML_SANDBOX}
          allow={SANDBOX_ALLOW}
          srcDoc={srcDoc}
          onLoad={onLoad}
          // The floor is for before the page has reported; after, the frame is exactly the
          // page's height, so the note below sits right under a short page's last line.
          style={{ height: height ?? undefined, minHeight: height === null ? undefined : 0, colorScheme: theme }}
        />
      )}
      {srcDoc !== null && (
        <div className="doc-reader-html-foot">
          <span className="doc-reader-html-note">
            {tx('reader.htmlSandboxNote', 'Shown in a sandbox: external stylesheets, images and scripts are not loaded.')}
          </span>
          {/* The window's bar already carries these; a popup or pane may not. */}
          {fileActions && <FileActions path={path} compact />}
        </div>
      )}
    </div>
  );
}
