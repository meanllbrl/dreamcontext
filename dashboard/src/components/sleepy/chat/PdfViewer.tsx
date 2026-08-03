import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, agentFileUrl } from '../../../api/client';
import { FileActions } from './FileActions';

/**
 * A PDF named in the transcript, opened AT FULL WINDOW — the same gesture an image gets, and
 * for the same reason (owner request: "when I say open the file, open the PDF in the app the
 * way an image opens").
 *
 * Before this, a `.pdf` chip fell through to the slide-over's text preview, which asked the
 * JSON branch of `/agent/file` for a binary and got back "File exceeds the preview size cap"
 * — the exact dead end a video hit before it was range-streamed. The route now serves a PDF
 * raw (`?raw=1`, `application/pdf`, ranges intact), which is what makes the embed below page
 * a large document in instead of stalling on it.
 *
 * The document is rendered by the ENGINE's own viewer rather than a bundled one. WebKit (the
 * desktop app's WKWebView) and Chromium both ship a real PDF viewer — scroll, search, select,
 * print, page thumbnails — and shipping pdf.js to re-implement a worse one would add a
 * megabyte to the bundle to lose features. Where the engine has no viewer (WebKitGTK builds
 * without PDF support), `navigator.pdfViewerEnabled` says so up front and the surface degrades
 * to the honest thing: "this window can't display it" plus the button that hands it to the
 * app that can. That button is never absent, in any state, on purpose.
 */

/** Does this engine have a built-in PDF viewer? `undefined` on engines predating the property
 *  (Safari < 17), where the embed is still the right bet — an engine that never told us is not
 *  the same as one that said no. */
function engineRendersPdf(): boolean {
  const flag = (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  return flag !== false;
}

type Probe =
  | { state: 'checking' }
  | { state: 'ok' }
  /** Outside the project root — `path` is the file the SERVER resolved the reference to, which
   *  is what a grant has to record (the notation the answer used never round-trips). */
  | { state: 'blocked'; path: string }
  | { state: 'missing'; message: string };

export function PdfViewer({
  path, label, src: srcOverride, onClose,
}: {
  /** The file as the surface names it — shown in the header, and the path handed to the OS. */
  path: string;
  label?: string;
  /** Where the BYTES come from, when they don't come from the chat surface's file route.
   *  The Knowledge page reads a PDF its note links to through `/api/graph/content?raw=1`
   *  instead: that route is vault-scoped and, unlike `/agent/file`, not gated on the desktop
   *  app — a browser dashboard must not be told "desktop only" about a file in its own vault. */
  src?: string;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [probe, setProbe] = useState<Probe>({ state: 'checking' });
  const [granting, setGranting] = useState(false);
  const src = srcOverride ?? agentFileUrl(path, { raw: true });

  // Ask the endpoint BEFORE embedding. An `<iframe>`/`<object>` reports nothing useful when it
  // fails — no status, no reason — so a file that merely needs consent would render as a blank
  // rectangle. One ranged byte (the router serves GET only, so a HEAD would 404 and make every
  // blocked file look unreachable) is enough to tell "allow this" from "it's gone".
  useEffect(() => {
    let cancelled = false;
    setProbe({ state: 'checking' });
    void fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then(async (r): Promise<Probe> => {
        if (r.ok || r.status === 206) return { state: 'ok' };
        if (r.status === 403) {
          const body = await r.json().catch(() => null) as { path?: unknown; error?: unknown } | null;
          if (body?.error === 'needs_grant') {
            return { state: 'blocked', path: typeof body.path === 'string' ? body.path : path };
          }
          return { state: 'missing', message: 'this file can’t be read from here' };
        }
        if (r.status === 404) return { state: 'missing', message: 'this file isn’t there any more' };
        return { state: 'missing', message: 'this file couldn’t be loaded' };
      })
      .catch((): Probe => ({ state: 'missing', message: 'this file couldn’t be loaded' }))
      .then((next) => { if (!cancelled) setProbe(next); });
    return () => { cancelled = true; };
  }, [src, path]);

  // Lock the page behind the viewer, exactly as ImageViewer does — it covers the window, and a
  // transcript scrolling underneath it is both distracting and a way to lose your place.
  useEffect(() => {
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => { body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Esc closes THIS and nothing else: the viewer opens over the agent overlay, which closes on
  // Esc too, and without swallowing the key one press would take the whole surface down with
  // the document. Capture phase, same as ImageViewer, for the same reason.
  //
  // This only fires while focus is outside the embedded document — a key pressed inside the
  // engine's PDF frame belongs to that frame, and no listener of ours can see it. Chrome's
  // built-in viewer takes focus as it initialises and will not give it back (see the frame's
  // own note), so on that engine Esc closes the viewer only once the user has clicked back
  // into our chrome. The ✕ is therefore not a convenience — it is the guaranteed way out, and
  // it is present in every state this component can be in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const allow = (grantPath: string) => {
    setGranting(true);
    void api.post('/agent/grant', { path: grantPath }).then(
      () => setProbe({ state: 'ok' }),
      () => setProbe({ state: 'missing', message: 'that file couldn’t be allowed' }),
    ).finally(() => setGranting(false));
  };

  const canEmbed = probe.state === 'ok' && engineRendersPdf();

  return createPortal(
    <div ref={rootRef} className="pdf-viewer" role="dialog" aria-modal="true" aria-label={label || path} tabIndex={-1}>
      <div className="pdf-viewer-head">
        <div className="pdf-viewer-head-text">
          <span className="pdf-viewer-name">{label || path.split('/').pop()}</span>
          <span className="pdf-viewer-path" title={path}>{path}</span>
        </div>
        <button type="button" className="pdf-viewer-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
      </div>

      <FileActions path={path} className="pdf-viewer-actions" />

      <div className="pdf-viewer-stage">
        {probe.state === 'checking' && <p className="pdf-viewer-status">Loading…</p>}

        {probe.state === 'missing' && (
          <p className="pdf-viewer-status error">Couldn’t open this PDF — {probe.message}.</p>
        )}

        {probe.state === 'blocked' && (
          <div className="pdf-viewer-blocked">
            <p className="pdf-viewer-status">
              This PDF lives outside the project. Allow access to read it here, or open it on your
              computer with the buttons above.
            </p>
            <button type="button" className="chat-btn" onClick={() => allow(probe.path)} disabled={granting}>
              {granting ? 'Allowing…' : 'Allow access'}
            </button>
          </div>
        )}

        {probe.state === 'ok' && !canEmbed && (
          <p className="pdf-viewer-status">
            This window can’t display PDFs. Use “Open on computer” above to read it in your PDF app.
          </p>
        )}

        {canEmbed && (
          // `<iframe>`, not `<object>`/`<embed>`: it is the form WebKit's built-in viewer is
          // most reliable in, and the one that keeps the document's own scroll, search and
          // print chrome. Same-origin (the local dashboard server serves both), so nothing
          // here is a cross-site frame.
          <iframe
            className="pdf-viewer-frame"
            src={src}
            title={label || path}
            // No attempt is made to hold focus against the plugin. Chrome's built-in viewer
            // takes it as it initialises and takes it BACK after a refocus — measured here:
            // a synchronous reclaim on `load`, a `requestAnimationFrame` one, and a 150ms
            // backstop all lost, leaving `document.activeElement` as this frame every time.
            // Winning that race would also be the wrong prize: focus is what makes the
            // document's own scroll, search and print keys work. So the ✕ (and a click on the
            // viewer's own chrome, which hands focus back and re-arms Esc) is the way out,
            // and it is always present — see the Esc effect above.
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
