import { useState } from 'react';
import { openExternalUrl } from '../../../lib/desktop';
import { WEB_URL_REASON_TEXT, isTrustedHost, trustHost, validateWebUrl } from '../webUrl';
import { useWbText } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * A web page on the board (D7).
 *
 * The URL is re-checked here even though the server checked it at write time: `https:` only,
 * no userinfo, never the dashboard's own origin. A host the user has not approved on this
 * machine never loads on its own: the widget shows the host (Unicode AND punycode, so a
 * look-alike domain cannot pass for the real one) and waits for Load.
 *
 * The frame gets no popups and no top navigation (nothing in the desktop shell handles a new
 * window) and an empty permissions policy. "Open in browser" goes through the app's external
 * opener instead.
 */
export const WEB_WIDGET_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

export function WebWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const check = validateWebUrl(payload.url, window.location.origin);
  const [loaded, setLoaded] = useState(() => check.ok && isTrustedHost(check.host));
  const title = payload.title || (check.ok ? check.unicodeHost : tx('whiteboard.kind.web', 'Web'));

  if (!check.ok) {
    return (
      <WidgetFrame kind="web" title={title} active={active} size={size}>
        <WidgetNotice tone="error">{tx(`whiteboard.web.reason.${check.reason}`, WEB_URL_REASON_TEXT[check.reason])}</WidgetNotice>
      </WidgetFrame>
    );
  }

  const openInBrowser = (
    <WidgetButton onClick={() => void openExternalUrl(check.href)}>
      {tx('whiteboard.web.openInBrowser', 'Open in browser')}
    </WidgetButton>
  );

  return (
    <WidgetFrame kind="web" title={title} active={active} size={size} actions={openInBrowser}>
      {loaded ? (
        <iframe
          className="wb-web-frame"
          title={title}
          src={check.href}
          sandbox={WEB_WIDGET_SANDBOX}
          allow=""
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="wb-web-prompt">
          <span className="wb-web-host">{check.unicodeHost}</span>
          {check.unicodeHost !== check.host && <span className="wb-web-puny">{check.host}</span>}
          <div className="wb-web-buttons">
            <WidgetButton onClick={() => setLoaded(true)}>{tx('whiteboard.web.load', 'Load')}</WidgetButton>
            <WidgetButton onClick={() => { trustHost(check.host); setLoaded(true); }}>
              {tx('whiteboard.web.trust', 'Trust {host} on this machine').replace('{host}', check.unicodeHost)}
            </WidgetButton>
          </div>
          <p className="wb-web-trust-note">
            {tx('whiteboard.web.trustNote', 'Trust {host} on this machine: every board URL on this host will load automatically.')
              .replace('{host}', check.unicodeHost)}
          </p>
        </div>
      )}
    </WidgetFrame>
  );
}
