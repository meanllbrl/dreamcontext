import { cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { excalidrawWidgetLinkIcon } from './excalidraw-widget-link-icon';

// The CLI package version this bundle ships with. The app compares it against
// /api/health's `version` to detect a stale (upgraded-under) server process.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

// Excalidraw's fonts, self-hosted so the whiteboard draws text offline in the desktop app
// instead of fetching them from esm.sh. `components/whiteboard/LazyWhiteboardCanvas.tsx` points
// `window.EXCALIDRAW_ASSET_PATH` at `excalidraw-assets/`; dev serves the package's own copy.
function excalidrawFonts(): Plugin {
  const src = fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url));
  let outDir = 'dist';
  return {
    name: 'dc-excalidraw-fonts',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    writeBundle() { cpSync(src, join(outDir, 'excalidraw-assets', 'fonts'), { recursive: true }); },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawFonts(), excalidrawWidgetLinkIcon()],
  define: {
    __DC_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4173',
    },
  },
});
