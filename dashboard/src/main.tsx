import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installExternalLinkHandler } from './lib/externalLinks';
import { sweepExpiredPins } from './lib/pinStore';
import { sweepExpired as sweepExpiredChecklists } from './lib/checklistStore';

// A link is the one thing on the page that can destroy the app: the desktop shell has
// no back button, so following a URL in-place leaves nothing to return with. Install
// the interceptor before the first render so no surface can be clicked without it.
installExternalLinkHandler();

// THE JANITOR. Both TTL sweeps run here, once per boot, because `localStorage` is one
// ~5MB quota shared by every project this origin has ever opened — and neither store has a
// natural moment of its own to run in (a chat pane only ever sees its OWN conversation; the
// checklist window only its own checklist). Left unwired, `dc.chatpins.v1.*` and
// `dc.checklist.*` grow monotonically, and the failure when the quota is reached is SILENT
// in the worst way: `setItem` throws, every writer's best-effort catch swallows it, and
// persistence just stops working everywhere at once.
//
// Boot is the right moment — it is the only point at which no surface owns the data, so a
// sweep can't race a live writer. Wrapped anyway: a janitor must never be the reason the app
// fails to start (both sweeps are internally hardened, this is the belt on top of that).
try {
  const now = Date.now();
  sweepExpiredPins(now);
  sweepExpiredChecklists(now);
} catch (err) {
  console.error('[boot] storage sweep failed (continuing):', err);
}

// Inside the desktop shell the window uses the macOS "overlay" title-bar style:
// the native title bar is transparent and the traffic-light buttons float over
// our own header. Flag the document so the header can reserve room for them.
const isTauri = !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
if (isTauri && navigator.platform.toLowerCase().includes('mac')) {
  document.documentElement.classList.add('tauri-overlay');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
