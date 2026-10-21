import { useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { BrowserLive } from '../chat/BrowserLive';
import { readBrowserLive, subscribeBrowserLive, type BrowserLiveState } from '../chat/browserLiveStore';

/**
 * A child's live browser as a Super Agent card (jarvis plan r9, K6). The frames are already in
 * this window: the child is an ordinary chat with its own socket, and its session writes each
 * frame to `browserLiveStore` under its `ChatSession.id`. No new stream on the server.
 *
 *  - tile: the last frame, filling the 1:1 tile, the page's host under it.
 *  - large (half / present / sheet): the full Mac window (`BrowserLive`), its fold the card's own.
 *  - `live` false (over the budget of two, off screen, window unfocused): no subscription, the
 *    last frame stays drawn and nothing re-renders.
 *
 * Until the first frame, the card says so itself: `BrowserLive` draws nothing before it.
 */
export function BrowserCard({ sessionId, live, large }: { sessionId: string | undefined; live: boolean; large: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<BrowserLiveState | null>(() => (sessionId ? readBrowserLive(sessionId) : null));
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!sessionId) { setState(null); return undefined; }
    setState(readBrowserLive(sessionId));
    if (!live || large) return undefined;
    return subscribeBrowserLive(sessionId, setState);
  }, [sessionId, live, large]);

  const empty = <div className="super-browser-card is-empty" data-testid="super-browser-empty">{t('super.browser.waiting')}</div>;
  if (!sessionId) return empty;
  // Large: `BrowserLive` subscribes itself (also before the first frame), so the card turns live
  // the moment a frame lands; until then it draws the waiting line.
  if (large) {
    return (
      <div className="super-browser-card is-large" data-testid="super-browser-large">
        <BrowserLive sessionId={sessionId} collapsed={collapsed} onCollapsedChange={setCollapsed} frozen={!live} waiting={empty} />
      </div>
    );
  }
  if (!state) return empty;
  const { frame } = state;
  let host = '';
  try { host = new URL(frame.url).host; } catch { host = ''; }
  return (
    <div className="super-browser-card" data-testid="super-browser-tile" data-live={live || undefined}>
      <img className="super-browser-frame" src={`data:image/jpeg;base64,${frame.data}`} alt="" draggable={false} />
      <span className="super-browser-host">{frame.title || host || t('super.browser.label')}</span>
    </div>
  );
}
