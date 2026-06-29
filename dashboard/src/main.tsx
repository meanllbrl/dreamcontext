import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

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
