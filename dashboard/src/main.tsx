import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installExternalLinkHandler } from './lib/externalLinks';

// A link is the one thing on the page that can destroy the app: the desktop shell has
// no back button, so following a URL in-place leaves nothing to return with. Install
// the interceptor before the first render so no surface can be clicked without it.
installExternalLinkHandler();

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
