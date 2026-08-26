import { useCallback, useEffect, useRef, useState } from 'react';
import { SANDBOX_GRANT } from '../../lib/sandboxHtml';
import { resolveKitTokens } from './labHtmlKit';
import { appPageIds, findAppPage, findDataset, type AppSpec, type DatasetBundle } from './appModel';
import {
  buildAppSrcdoc,
  isLabAppEnvelope,
  mintAppNonce,
  LAB_APP_PROTOCOL,
  type LabAppEnvelope,
  type LabAppInbound,
  type LabAppOutbound,
} from './labAppRuntime';

/**
 * The host half of the `app/v1` bridge: draws ONE page of a script-authored
 * multi-page insight in a network-less sandboxed iframe, and is the ONLY
 * thing that talks to it.
 *
 * CONTRACT FOR CALLERS: key this component by `${slug}:${pageId}` (or
 * equivalent) so a page or insight change REMOUNTS it rather than handing it
 * a changed `pageId`/`spec` prop in place. `page`, the per-instance nonce,
 * and the srcdoc are all resolved ONCE at mount and never rebuilt — that is
 * what makes the load-count teardown below sound: a mounted instance is
 * contractually pinned to one document, so any load event after the first
 * can only be that document navigating itself, never a legitimate host-
 * driven page switch (those go through a fresh mount, and therefore a fresh
 * key, fresh nonce, fresh load count). `params` MAY change without a
 * remount — same page, in-page navigation — and is pushed over the bridge
 * as a `route` message instead.
 *
 * SECURITY (see labAppRuntime.ts's module doc for the full argument):
 *   - `sandbox={SANDBOX_GRANT}` — imported UNCHANGED from `lib/sandboxHtml.ts`.
 *   - Every inbound message is gated, in order: `event.source` identity
 *     (never `event.origin` — opaque for a sandboxed frame), the
 *     `__dreamLabApp` envelope shape, then the per-instance nonce.
 *   - M1 (primary): a SECOND `load` event on this iframe means the document
 *     inside navigated itself (subresource fetches are blocked by the CSP,
 *     but nothing stops self-navigation). On it: stop posting, stop
 *     accepting, and remount the iframe to `about:blank` by bumping its key
 *     — the old, possibly still-live document is discarded, not just hidden.
 *   - M2: the per-instance nonce closes the race between a self-navigation
 *     and the `load` event that reveals it — a navigated-away document
 *     never learned the nonce, so it cannot newly request anything even in
 *     that window. It cannot stop a push already in flight, which is why M1
 *     (stop posting entirely) is primary and this is the belt to its braces.
 *   - `lab.data()` resolves ONLY from the `datasets` prop (via the pure
 *     `findDataset` lookup) — no other reachable input. Never another
 *     insight's cache, never credentials, never the manifest.
 */

const CARD_MIN_HEIGHT = 120;
const CARD_MAX_HEIGHT = 320;
const PAGE_MIN_HEIGHT = 200;
const PAGE_MAX_HEIGHT = 20000;

export type LabAppFrameMode = 'card' | 'page' | 'full';

export interface LabAppFrameProps {
  /** Used only for diagnostics (console messages) — never trusted as an
   *  access boundary; the bridge's real scoping is the `datasets` prop. */
  slug: string;
  spec: AppSpec;
  /** Null resolves to `spec.entry`. See the class doc: pinned at mount. */
  pageId: string | null;
  /** In-page navigation state — MAY change without remounting; pushed over
   *  the bridge as a `route` message. */
  params: Record<string, string>;
  /** The insight's current dataset bundle. The ONLY input `lab.data()` can
   *  ever resolve from — kept fresh via a ref so the message handler never
   *  needs to be re-attached, but never sourced from anywhere else. */
  datasets: DatasetBundle | null;
  mode: LabAppFrameMode;
  title: string;
  /** Fired when the iframe asks to navigate to a DECLARED page (an unknown
   *  page id is dropped with a console warning, never forwarded). Card mode
   *  passes none — the card is a single click target, not a router. */
  onNavigate?: (pageId: string, params: Record<string, string>) => void;
  onToast?: (message: string) => void;
}

/** The live value of `<html data-theme>` — the Lab/Chat surfaces' shared
 *  lesson: the attribute is what actually restyles tokens, and it can
 *  change from outside the theme context (verify harnesses do this). */
function useDataTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function clampHeightForMode(px: number, mode: 'card' | 'page'): number {
  const rounded = Math.max(0, Math.ceil(px));
  return mode === 'card'
    ? Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, rounded))
    : Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, rounded));
}

export function LabAppFrame({
  slug, spec, pageId, params, datasets, mode, title, onNavigate, onToast,
}: LabAppFrameProps) {
  const theme = useDataTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loadCountRef = useRef(0);
  const tornRef = useRef(false);
  const [torn, setTorn] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);
  const [height, setHeight] = useState<number | null>(null);
  const datasetsRef = useRef(datasets);
  datasetsRef.current = datasets;
  const didMountThemeRef = useRef(false);
  const didMountParamsRef = useRef(false);

  // Resolved ONCE at mount — page, nonce and srcdoc are pinned for this
  // instance's lifetime (see the module doc: callers key by slug+pageId so
  // a real page change remounts instead of landing here as a prop change).
  const [instance] = useState(() => {
    const page = findAppPage(spec, pageId);
    const nonce = mintAppNonce();
    const pages = spec.pages.map((p) => ({ id: p.id, title: p.title }));
    const scheme: 'light' | 'dark' = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const srcDoc = page
      ? buildAppSrcdoc({ page, shell: spec.shell, pages, tokens: resolveKitTokens(), scheme, params, nonce })
      : null;
    return { page, nonce, srcDoc };
  });

  const stop = useCallback((reason: string) => {
    if (tornRef.current) return;
    tornRef.current = true;
    setTorn(true);
    setInstanceKey((k) => k + 1);
    console.error(`[lab-app] ${slug}${instance.page ? `/${instance.page.id}` : ''}: ${reason}`);
    onToast?.('This app body navigated away and was stopped.');
  }, [slug, instance.page, onToast]);

  const postToFrame = useCallback((msg: LabAppInbound) => {
    if (tornRef.current) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const envelope: LabAppEnvelope<LabAppInbound> = {
      ...msg, __dreamLabApp: 1, v: LAB_APP_PROTOCOL, nonce: instance.nonce,
    };
    win.postMessage(envelope, '*');
  }, [instance.nonce]);

  // ── inbound half — the host receiving from THIS frame, and only this one ──
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (tornRef.current) return;
      // GATE 1 — identity, never `event.origin` (opaque "null" for a
      // sandboxed frame without allow-same-origin).
      if (event.source !== frameRef.current?.contentWindow) return;
      // GATE 2 — shape: is this even one of ours?
      if (!isLabAppEnvelope(event.data)) return;
      // GATE 3 — per-instance nonce (M2).
      if (event.data.nonce !== instance.nonce) return;
      const msg = event.data as LabAppEnvelope<LabAppOutbound>;
      if (msg.type === 'height') {
        if (mode === 'full') return;
        if (typeof msg.px !== 'number' || !Number.isFinite(msg.px)) return;
        setHeight(clampHeightForMode(msg.px, mode));
        return;
      }
      if (msg.type === 'navigate') {
        if (typeof msg.page !== 'string') return;
        if (!appPageIds(spec).includes(msg.page)) {
          console.warn(`[lab-app] ${slug}: navigate to unknown page "${msg.page}" ignored.`);
          return;
        }
        onNavigate?.(msg.page, msg.params && typeof msg.params === 'object' ? msg.params : {});
        return;
      }
      if (msg.type === 'data') {
        if (typeof msg.requestId !== 'string') return;
        // The ONLY input this resolves from — see the class doc.
        const dataset = findDataset(datasetsRef.current, msg.dataset ?? null);
        postToFrame(dataset
          ? { type: 'dataResult', requestId: msg.requestId, ok: true, dataset }
          : { type: 'dataResult', requestId: msg.requestId, ok: false, error: `Unknown dataset "${msg.dataset ?? ''}".` });
        return;
      }
      // 'ready' — no host-side action needed.
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [instance.nonce, mode, onNavigate, postToFrame, slug, spec]);

  // A SECOND load on this element can only be the document inside
  // navigating itself — this instance is pinned to one page for its
  // lifetime (M1, the primary mechanism; see the module doc).
  const handleLoad = useCallback(() => {
    if (tornRef.current) return;
    loadCountRef.current += 1;
    if (loadCountRef.current >= 2) {
      stop('app body navigated away from its srcdoc and was stopped.');
    }
  }, [stop]);

  // Params changing WITHOUT a remount is an in-page navigation — pushed
  // over the bridge, never a srcdoc rebuild (a rebuild would reset whatever
  // state the page's own script holds mid-interaction).
  useEffect(() => {
    if (!didMountParamsRef.current) { didMountParamsRef.current = true; return; }
    if (!instance.page) return;
    postToFrame({ type: 'route', page: instance.page.id, params });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Theme flips over the bridge too, for the same reason: a srcdoc rebuild
  // (the html/v1 card's approach) would reset app state mid-interaction.
  useEffect(() => {
    if (!didMountThemeRef.current) { didMountThemeRef.current = true; return; }
    postToFrame({ type: 'theme', scheme: theme, tokens: resolveKitTokens() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  if (!instance.page || !instance.srcDoc) {
    return <div className="lab-app-frame-message">No app pages declared.</div>;
  }

  if (torn) {
    return (
      <div className="lab-app-frame-message lab-app-frame-message--stopped" role="alert">
        This app body navigated away and was stopped.
        {/* A remount to about:blank (fresh key) discards the still-live
            navigated document rather than merely hiding it. Kept off-screen:
            the message above is the user-facing surface. */}
        <iframe
          key={instanceKey}
          srcDoc="about:blank"
          title={`${title} — stopped`}
          style={{ display: 'none' }}
        />
      </div>
    );
  }

  const baseStyle: React.CSSProperties = {
    width: '100%',
    border: 'none',
    display: 'block',
    colorScheme: theme,
  };
  const style: React.CSSProperties = mode === 'full'
    ? { ...baseStyle, height: '100%' }
    : {
        ...baseStyle,
        height: height ?? (mode === 'card' ? CARD_MIN_HEIGHT : PAGE_MIN_HEIGHT),
        // Card mode is a preview and a single click target (the card's own
        // click handler opens the app) — the iframe never intercepts the click.
        pointerEvents: mode === 'card' ? 'none' : 'auto',
      };

  return (
    <iframe
      key={instanceKey}
      ref={frameRef}
      className="lab-app-frame"
      title={`${title} — script-rendered app body`}
      sandbox={SANDBOX_GRANT}
      srcDoc={instance.srcDoc}
      onLoad={handleLoad}
      style={style}
    />
  );
}
