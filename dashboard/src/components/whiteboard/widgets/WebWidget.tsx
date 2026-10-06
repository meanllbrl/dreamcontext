import { useCallback, useEffect, useState } from 'react';
import { agentFileUrl } from '../../../api/client';
import { useApi, useVault } from '../../../context/VaultContext';
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

export function WebWidget({ elementId, payload, active, size }: WidgetProps) {
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
    return <WebFile elementId={elementId} file={check} title={payload.title || check.name} active={active} size={size} />;
  }
  return <WebPage page={check} title={payload.title || check.unicodeHost} active={active} size={size} />;
}

type PageCheck = Extract<WebUrlCheck, { kind: 'url' }>;
type FileCheck = Extract<WebUrlCheck, { kind: 'file' }>;
type FrameProps = Pick<WidgetProps, 'active' | 'size'> & { title: string };

function WebPage({ page, title, active, size }: FrameProps & { page: PageCheck }) {
  const tx = useWbText();
  const [loaded, setLoaded] = useState(() => isTrustedHost(page.host));

  const openInBrowser = (
    <WidgetButton onClick={() => void openExternalUrl(page.href)}>
      {tx('whiteboard.web.openInBrowser', 'Open in browser')}
    </WidgetButton>
  );

  return (
    <WidgetFrame kind="web" title={title} active={active} size={size} actions={openInBrowser}>
      {loaded ? (
        <iframe
          className="wb-web-frame"
          title={title}
          src={page.href}
          sandbox={WEB_WIDGET_SANDBOX}
          allow=""
          referrerPolicy="no-referrer"
        />
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
  | { state: 'failed' };

function useFileAccess(src: string, attempt: number): FileAccess {
  const [access, setAccess] = useState<FileAccess>({ state: 'checking' });
  useEffect(() => {
    let cancelled = false;
    setAccess({ state: 'checking' });
    void fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then(async (r): Promise<FileAccess> => {
        if (r.ok || r.status === 206) return { state: 'ok' };
        if (r.status === 404) return { state: 'missing' };
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

function WebFile({ elementId, file, title, active, size }: FrameProps & { elementId: string; file: FileCheck }) {
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
        />
      </div>
    );
  }

  return (
    <WidgetFrame kind="web" title={title} active={active} size={size} actions={access.state === 'ok' ? openOnComputer : null}>
      {body}
      {note && <p className="wb-web-trust-note" role="status">{note}</p>}
    </WidgetFrame>
  );
}
