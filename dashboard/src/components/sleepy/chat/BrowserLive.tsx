import { useEffect, useState, type MouseEvent } from 'react';
import { Lightbox } from './Lightbox';
import { readBrowserLive, setBrowserCollapsed, subscribeBrowserLive, type BrowserLiveState } from './browserLiveStore';
import './BrowserLive.css';

/**
 * The agent's browser, live, drawn as a small macOS window inside the browser step that drives
 * it (placed by browserHost.tsx).
 *
 * The browser itself is headless (src/lib/browser-override.ts), so this is the only place it
 * can be seen, and it never takes the screen or the keyboard from the owner. It appears with
 * the first frame, keeps the last one when the page stops painting, and goes away when the
 * browser closes or the session ends.
 *
 * The window frame says "this is a browser" at a glance (owner, 2026-10-09). Its controls do
 * what they do on a Mac: the yellow light rolls the window up to its title bar and back, the
 * green one opens the frame full-window; red is drawn but does nothing, because closing is the
 * agent's call, not the view's. A click anywhere on the title bar also rolls it up or down, and
 * the chevron on the right says so for anyone who does not read traffic lights.
 *
 * The window hugs the page: its width is the frame's, from the frame's own ratio before the
 * image decodes, so a frame swap costs no layout shift; a ceiling on its height keeps the
 * transcript readable above it. Full-window
 * shows the frame AS CLICKED, not a moving one.
 */

/** No frame for this long reads as a still page, not a live one. */
const IDLE_AFTER_MS = 4000;

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : u.protocol.replace(/:$/, '');
  } catch {
    return url;
  }
}

export function BrowserLive({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<BrowserLiveState | null>(() => readBrowserLive(sessionId));
  const [idle, setIdle] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  useEffect(() => {
    setState(readBrowserLive(sessionId));
    return subscribeBrowserLive(sessionId, setState);
  }, [sessionId]);

  const frameAt = state?.frame.at ?? 0;
  useEffect(() => {
    if (!frameAt) return undefined;
    setIdle(false);
    const timer = setTimeout(() => setIdle(true), IDLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [frameAt, state?.frame.data]);

  if (!state) return null;
  const { frame, collapsed } = state;
  const src = `data:image/jpeg;base64,${frame.data}`;
  const where = hostOf(frame.url);
  const label = frame.title || where || 'Browser';
  const toggle = () => setBrowserCollapsed(sessionId, !collapsed);
  const openFull = () => setOpened(src);
  // The bar itself rolls the window up; its buttons do their own thing and stop there.
  const onBar = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    toggle();
  };

  return (
    <section className="chat-browser" data-collapsed={collapsed || undefined} aria-label="Agent browser">
      <div className="chat-browser-window">
        <header className="chat-browser-bar" onClick={onBar}>
          <span className="chat-browser-lights">
            <span className="chat-browser-light" data-light="close" aria-hidden="true" />
            <button
              type="button"
              className="chat-browser-light"
              data-light="min"
              onClick={toggle}
              title={collapsed ? 'Expand' : 'Collapse'}
              aria-label={collapsed ? 'Expand the browser' : 'Collapse the browser'}
            >
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 5h5" /></svg>
            </button>
            <button
              type="button"
              className="chat-browser-light"
              data-light="zoom"
              onClick={openFull}
              title="Open full window"
              aria-label="Open full window"
            >
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 7V3.6L6.4 7zM7 3v3.4L3.6 3z" /></svg>
            </button>
          </span>
          <span className="chat-browser-address" title={frame.url}>
            <span className="chat-browser-dot" data-idle={idle || undefined} aria-hidden="true" />
            <span className="chat-browser-title">{label}</span>
            {frame.title && where ? <span className="chat-browser-host">{where}</span> : null}
          </span>
          <button
            type="button"
            className="chat-browser-btn"
            onClick={toggle}
            title={collapsed ? 'Show the browser' : 'Hide the browser'}
            aria-label={collapsed ? 'Show the browser' : 'Hide the browser'}
            aria-expanded={!collapsed}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="chat-browser-chevron">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </header>
        <div className="chat-browser-body" inert={collapsed}>
          <div className="chat-browser-body-inner">
            <button
              type="button"
              className="chat-browser-stage"
              onClick={openFull}
              aria-label={`Open ${label} full window`}
            >
              <span className="chat-browser-frame" style={{ ['--browser-ratio' as string]: frame.width / frame.height }}>
                <img src={src} alt="" draggable={false} />
              </span>
            </button>
          </div>
        </div>
      </div>
      {opened && <Lightbox src={opened} caption={frame.url || label} onClose={() => setOpened(null)} />}
    </section>
  );
}
