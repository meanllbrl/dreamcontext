import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setExcalidrawAssetPath } from './assetPath';

// The font path is set first, then the viewer (and Excalidraw with it) is loaded: a static import
// would be evaluated before this line (the bundler hoists Excalidraw's chunk above the entry's
// own code), and Excalidraw builds its font list from the path when it is evaluated.
setExcalidrawAssetPath();
void import('./ShareViewer').then(({ default: ShareViewer }) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ShareViewer />
    </StrictMode>,
  );
});
