import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentFileUrl } from '../../../api/client';
import { useApi, useVault } from '../../../context/VaultContext';
import { openWebSession, portOfHost, readLoopbackGrants, setLoopbackGrant, useLoopbackGrants, type WebSessionView } from '../../../lib/loopbackGrants';
import { proxiedHref } from '../../../lib/webPick';
import type { WebFrameControl, WebFrameInfo } from '../../../lib/webFrameControl';
import type { WebDevice } from '../../../lib/webDevice';
import { useDeviceBox } from '../../layout/DeviceSwitch';
import { openExternalUrl } from '../../../lib/desktop';
import { externalHref } from '../../../lib/externalLinks';
import { DocumentReader, readerLinkAction } from '../../appLink/DocumentReader';
import { revealPath } from '../../sleepy/chat/chatEntities';
import { usePagePopup } from '../PagePopup';
import { pathToPageRef } from '../pagePopupModel';
import { WEB_URL_REASON_TEXT, isTrustedHost, trustHost, validateWebUrl, type WebUrlCheck } from '../webUrl';
import { useWbText } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * A web page or a file on the board (D7; files and pages on this computer since 2026-10-06).
 *
 * The target is re-checked here even though the server checked it at write time
 * (`webUrl.ts`): an `https:` page, an `http:` page on this machine, or a file. Never userinfo,
 * never the dashboard's own origin.
 *
 * A PAGE from a host the user has not approved on this machine never loads on its own: the
 * widget shows the host (Unicode AND punycode, so a look-alike domain cannot pass for the real
 * one; host and port for a page on this computer) and waits for Load. The frame gets no popups
 * and no top navigation (nothing in the desktop shell handles a new window) and an empty
 * permissions policy. "Open in browser" goes through the app's external opener instead.
 *
 * A FILE is read by the board's own reader (`DocumentReader`, as the side panel and the wiki
 * card read one): a web page in the chat's strict sandbox, a PDF in the PDF viewer, a picture
 * as a picture. Its bytes come only through the project file route, which is desktop-only and
 * serves nothing outside the project until the owner allows that exact file, here, on the card.
 */
export const WEB_WIDGET_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

export function WebWidget({ elementId, payload, active, size, onFrameAllowed, zoomBridge, control, device }: WidgetProps & {
  /** A PAGE's frame is allowed and shown (its trust gate passed): the Super Agent's card offers
   *  it full screen only from then on. Never called for a file. */
  onFrameAllowed?: (href: string) => void;
  /** A project web page posts its wheel and pinch to the host (DocumentReader `zoomBridge`). */
  zoomBridge?: boolean;
  /** The Super Agent card's handle on the page: Reload, Clear cache, Inspect (webFrameControl.ts). */
  control?: WebFrameControl;
  /** A PAGE laid out at a phone, tablet or desktop width (lib/webDevice.ts); none fills the card. */
  device?: WebDevice | null;
}) {
  const tx = useWbText();
  const check = validateWebUrl(payload.url, window.location.origin);

  if (!check.ok) {
    return (
      <WidgetFrame kind="web" title={payload.title || tx('whiteboard.kind.web', 'Web')} active={active} size={size}>
        <WidgetNotice tone="error">{tx(`whiteboard.web.reason.${check.reason}`, WEB_URL_REASON_TEXT[check.reason])}</WidgetNotice>
      </WidgetFrame>
    );
  }
  if (check.kind === 'file') {
    return <WebFile elementId={elementId} file={check} title={payload.title || check.name} active={active} size={size} zoomBridge={zoomBridge} />;
  }
  return <WebPage page={check} title={payload.title || check.unicodeHost} active={active} size={size} onFrameAllowed={onFrameAllowed} control={control} device={device} />;
}

type PageCheck = Extract<WebUrlCheck, { kind: 'url' }>;
type FileCheck = Extract<WebUrlCheck, { kind: 'file' }>;
type FrameProps = Pick<WidgetProps, 'active' | 'size'> & { title: string; onFrameAllowed?: (href: string) => void; control?: WebFrameControl; device?: WebDevice | null };

/** Tells the card once a page's frame is up (the trust gate passed). */
function useFrameAllowed(shown: boolean, href: string, onFrameAllowed?: (href: string) => void) {
  useEffect(() => { if (shown) onFrameAllowed?.(href); }, [shown, href, onFrameAllowed]);
}

/** A card that appeared on its own (a Super Agent dev-server card) must not take a stray click:
 *  its allow buttons wake this long after it is drawn (T6). */
export const LOOPBACK_BUTTON_DELAY_MS = 600;

/** The ONE frame a web card ever draws: no popups, no top navigation, no permissions (T8).
 *  `control` (a Super Agent card) is handed the frame and what it loaded. `device`: laid out at
 *  that width and scaled into the card (the same box the full-screen viewer uses). */
export function PageFrame({ title, href, control, info, device = null }: {
  title: string; href: string; control?: WebFrameControl; info?: WebFrameInfo; device?: WebDevice | null;
}) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const box = useDeviceBox(device);
  useEffect(() => {
    const el = ref.current;
    if (!el || !control || !info) return undefined;
    control.attach(el, info);
    return () => control.detach(el);
  }, [control, info]);
  return (
    <div ref={box.ref} className="wb-web-device" data-device={box.fit ? device ?? undefined : undefined}>
      <iframe
        ref={ref}
        className="wb-web-frame"
        title={title}
        src={href}
        sandbox={WEB_WIDGET_SANDBOX}
        allow=""
        referrerPolicy="no-referrer"
        style={box.frameStyle}
      />
    </div>
  );
}

type SessionState = 'pending' | { direct: true } | { direct: false; view: WebSessionView };

/** The proxy for an allowed loopback page: `pending` while it is asked, `direct` when it could
 *  not be opened (or there is no project), null while the page is not allowed. */
function useWebSession(allowed: boolean, port: number, href: string, once: boolean): SessionState | null {
  const api = useApi();
  const { vault } = useVault();
  const [state, setState] = useState<SessionState | null>(null);
  const onceRef = useRef(once);
  onceRef.current = once;
  let host = 'localhost';
  try { host = new URL(href).hostname.toLowerCase(); } catch { /* the default */ }
  useEffect(() => {
    if (!allowed) { setState(null); return undefined; }
    if (!vault) { setState({ direct: true }); return undefined; }
    let cancelled = false;
    setState('pending');
    void openWebSession(api, vault, port, host, onceRef.current).then((view) => {
      if (!cancelled) setState(view ? { direct: false, view } : { direct: true });
    });
    return () => { cancelled = true; };
  }, [allowed, api, vault, port, host]);
  return state;
}

function WebPage(props: FrameProps & { page: PageCheck }) {
  return props.page.local ? <LoopbackPage {...props} /> : <RemotePage {...props} />;
}

/**
 * A page on this computer (a dev server). Trust is the SERVER's, per vault and per port
 * (`lib/loopbackGrants.ts`): "Open once" loads it now and remembers nothing; "Always allow
 * localhost:PORT" records the port. The app's own ports are refused whatever is recorded.
 */
function LoopbackPage({ page, title, active, size, onFrameAllowed, control, device }: FrameProps & { page: PageCheck }) {
  const tx = useWbText();
  const api = useApi();
  const { vault } = useVault();
  const grants = useLoopbackGrants(api, vault);
  const port = portOfHost(page.host);
  const [once, setOnce] = useState(false);
  const [denied, setDenied] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), LOOPBACK_BUTTON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  const owned = !!grants?.ownedPorts.includes(port);
  const granted = !!grants?.grants.includes(port) && !owned;
  const allowed = !owned && !denied && (granted || once);
  // The page's session (owner 2026-10-22): an allowed dev server loads through its proxy on
  // 127.0.0.1, the same site as this window, so its login cookie sticks (a `localhost` frame is
  // third-party in WKWebView: no cookie at all). A proxy that cannot open loads it directly.
  const session = useWebSession(allowed, port, page.href, once && !granted);
  const frameHref = session && session !== 'pending' ? (session.direct ? page.href : proxiedHref(page.href, session.view.origin)) : null;
  const info = useMemo<WebFrameInfo | undefined>(
    () => (session && session !== 'pending' ? { href: page.href, ...(session.direct ? {} : { proxyOrigin: session.view.origin, clearToken: session.view.clearToken }) } : undefined),
    [session, page.href],
  );
  useFrameAllowed(allowed && !!frameHref, frameHref ?? page.href, onFrameAllowed);
  // Fail closed: a refused or failed grant, or a port the server owns right now, never loads.
  const always = () => {
    if (!vault) { setDenied(true); return; }
    void setLoopbackGrant(api, vault, port, 'grant').catch(() => setDenied(true));
  };
  const openOnce = () => {
    if (!vault) { setDenied(true); return; }
    void readLoopbackGrants(api, vault, { fresh: true }).then((v) => {
      if (v.failed || v.ownedPorts.includes(port)) setDenied(true); else setOnce(true);
    });
  };
  return (
    <WidgetFrame kind="web" title={title} active={active} size={size}>
      {owned || denied ? (
        <WidgetNotice tone="error">{owned
          ? tx('web.loopback.owned', 'This is the app\'s own port; it is never shown in a card.')
          : tx('web.loopback.denied', 'This page could not be allowed here.')}</WidgetNotice>
      ) : (granted || once) ? (
        frameHref
          ? <PageFrame title={title} href={frameHref} control={control} info={info} device={device} />
          : <WidgetNotice tone="loading">{tx('whiteboard.widget.loading', 'Loading…')}</WidgetNotice>
      ) : (
        <div className="wb-web-prompt" data-testid="web-loopback-prompt">
          <span className="wb-web-host">{tx('web.loopback.ask', 'A page on this computer: {host}').replace('{host}', page.host)}</span>
          <div className="wb-web-buttons">
            <WidgetButton disabled={!armed || !grants || !!grants.failed} onClick={openOnce}>{tx('web.loopback.once', 'Open once')}</WidgetButton>
            <WidgetButton disabled={!armed || !grants || !!grants.failed} onClick={always}>
              {tx('web.loopback.always', 'Always allow {host}').replace('{host}', page.host)}
            </WidgetButton>
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}

function RemotePage({ page, title, active, size, onFrameAllowed, control, device }: FrameProps & { page: PageCheck }) {
  const tx = useWbText();
  const [loaded, setLoaded] = useState(() => isTrustedHost(page.host));
  const info = useMemo<WebFrameInfo>(() => ({ href: page.href }), [page.href]);
  useFrameAllowed(loaded, page.href, onFrameAllowed);

  const openInBrowser = (
    <WidgetButton onClick={() => void openExternalUrl(page.href)}>
      {tx('whiteboard.web.openInBrowser', 'Open in browser')}
    </WidgetButton>
  );

  return (
    <WidgetFrame kind="web" title={title} active={active} size={size} actions={openInBrowser}>
      {loaded ? (
        <PageFrame title={title} href={page.href} control={control} info={info} device={device} />
      ) : (
        <div className="wb-web-prompt">
          <span className="wb-web-host">{page.unicodeHost}</span>
          {page.unicodeHost !== page.host && <span className="wb-web-puny">{page.host}</span>}
          <div className="wb-web-buttons">
            <WidgetButton onClick={() => setLoaded(true)}>{tx('whiteboard.web.load', 'Load')}</WidgetButton>
            <WidgetButton onClick={() => { trustHost(page.host); setLoaded(true); }}>
              {tx('whiteboard.web.trust', 'Trust {host} on this machine').replace('{host}', page.unicodeHost)}
            </WidgetButton>
          </div>
          <p className="wb-web-trust-note">
            {tx('whiteboard.web.trustNote', 'Trust {host} on this machine: every board URL on this host will load automatically.')
              .replace('{host}', page.unicodeHost)}
          </p>
        </div>
      )}
    </WidgetFrame>
  );
}

/** Whether the file route will serve a file, asked the way `FileUnavailable` asks: one ranged
 *  byte, so a big PDF costs nothing. */
type FileAccess =
  | { state: 'checking' }
  | { state: 'ok' }
  /** Outside the project: `path` is the file the SERVER resolved, which a grant must record. */
  | { state: 'blocked'; path: string }
  | { state: 'desktop' }
  | { state: 'missing' }
  /** Over the server's cap for this file: its size and the cap, in bytes. */
  | { state: 'tooLarge'; size: number | null; limit: number | null }
  | { state: 'failed' };

function useFileAccess(src: string, attempt: number): FileAccess {
  const [access, setAccess] = useState<FileAccess>({ state: 'checking' });
  useEffect(() => {
    let cancelled = false;
    setAccess({ state: 'checking' });
    // `probe=1`: every gate and the cap, answered without the server reading the file (a ranged
    // GET was ignored by the text branch, which read a whole page just to say yes).
    void fetch(`${src}&probe=1`)
      .then(async (r): Promise<FileAccess> => {
        if (r.ok || r.status === 206) return { state: 'ok' };
        if (r.status === 404) return { state: 'missing' };
        if (r.status === 413) {
          const body = await r.json().catch(() => null) as { size?: unknown; limit?: unknown } | null;
          const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
          return { state: 'tooLarge', size: n(body?.size), limit: n(body?.limit) };
        }
        if (r.status === 403) {
          const body = await r.json().catch(() => null) as { path?: unknown; error?: unknown } | null;
          if (body?.error === 'needs_grant' && typeof body.path === 'string') return { state: 'blocked', path: body.path };
          if (body?.error === 'desktop_only') return { state: 'desktop' };
        }
        return { state: 'failed' };
      })
      .catch((): FileAccess => ({ state: 'failed' }))
      .then((next) => { if (!cancelled) setAccess(next); });
    return () => { cancelled = true; };
  }, [src, attempt]);
  return access;
}

function WebFile({ elementId, file, title, active, size, zoomBridge }: FrameProps & { elementId: string; file: FileCheck; zoomBridge?: boolean }) {
  const tx = useWbText();
  const api = useApi();
  const { vault } = useVault();
  const popup = usePagePopup();
  const [attempt, setAttempt] = useState(0);
  const [granting, setGranting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const access = useFileAccess(agentFileUrl(vault, file.path, { raw: true }), attempt);

  const allow = (path: string) => {
    setGranting(true);
    void api.post('/agent/grant', { path }).then(
      () => setAttempt((n) => n + 1),
      () => setNote(tx('whiteboard.web.grantFailed', 'Access could not be allowed.')),
    ).finally(() => setGranting(false));
  };

  // A link inside the file: a page in the project opens in the side panel, a web address in
  // the browser. The card keeps showing its own file.
  const follow = useCallback((next: string) => {
    if (readerLinkAction(next) === 'url') {
      const href = externalHref(next);
      if (href) void openExternalUrl(href);
      return;
    }
    const ref = pathToPageRef(next);
    if (ref) popup?.openPage({ kind: 'knowledge', ref }, elementId);
  }, [popup, elementId]);

  const openOnComputer = (
    <WidgetButton onClick={() => {
      setNote(null);
      void revealPath(api, file.path, 'auto').then((err) => { if (err) setNote(err); });
    }}
    >
      {tx('whiteboard.panel.openOnComputer', 'Open on computer')}
    </WidgetButton>
  );

  let body;
  if (access.state === 'checking') {
    body = <WidgetNotice tone="loading">{tx('whiteboard.widget.loading', 'Loading…')}</WidgetNotice>;
  } else if (access.state === 'blocked') {
    body = (
      <div className="wb-web-prompt wb-web-grant">
        <p className="wb-web-trust-note">{tx('whiteboard.web.outside', 'This file is outside the project. Allow access to show it here:')}</p>
        <span className="wb-web-path">{access.path}</span>
        <div className="wb-web-buttons">
          <WidgetButton onClick={() => allow(access.path)} disabled={granting}>
            {granting ? tx('whiteboard.web.allowing', 'Allowing…') : tx('whiteboard.web.allow', 'Allow access')}
          </WidgetButton>
        </div>
      </div>
    );
  } else if (access.state === 'desktop') {
    body = <WidgetNotice tone="missing">{tx('whiteboard.web.desktopOnly', 'Files open in the desktop app.')}</WidgetNotice>;
  } else if (access.state === 'missing') {
    body = <WidgetNotice tone="missing">{tx('whiteboard.web.fileMissing', 'File not found:')}&nbsp;<code>{file.path}</code></WidgetNotice>;
  } else if (access.state === 'tooLarge') {
    const mb = (b: number | null) => (b === null ? '?' : `${Math.max(0.1, Math.round(b / 104857.6) / 10)} MB`);
    body = (
      <WidgetNotice tone="error">
        {tx('whiteboard.web.fileTooLarge', 'This file is too large to show here ({size}; the limit is {limit}).')
          .replace('{size}', mb(access.size)).replace('{limit}', mb(access.limit))}
      </WidgetNotice>
    );
  } else if (access.state === 'failed') {
    body = <WidgetNotice tone="error">{tx('whiteboard.web.fileFailed', 'This file could not be read.')}</WidgetNotice>;
  } else {
    body = (
      <div className="wb-web-file">
        <DocumentReader
          key={`${file.path}#${attempt}`}
          path={file.path}
          onOpen={follow}
          embedded
          hostFileActions
          variant="page"
          allowAbsolute={file.absolute}
          zoomBridge={zoomBridge}
        />
      </div>
    );
  }

  return (
    <WidgetFrame kind="web" title={title} active={active} size={size} actions={access.state === 'ok' || access.state === 'tooLarge' ? openOnComputer : null}>
      {body}
      {note && <p className="wb-web-trust-note" role="status">{note}</p>}
    </WidgetFrame>
  );
}
