import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ShareViewer from './ShareViewer';

// Excalidraw's fonts from this share's own origin (the build copies them under
// excalidraw-assets/), never a CDN: the viewer's CSP allows only 'self'.
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = import.meta.env.DEV
  ? '/node_modules/@excalidraw/excalidraw/dist/prod/'
  : '/excalidraw-assets/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShareViewer />
  </StrictMode>,
);
