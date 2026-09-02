// .excalidraw.md (Obsidian board) -> single self-contained .html with the REAL scene as inline SVG.
// Uses @excalidraw/excalidraw's own exportToSvg in headless Chromium, so what you get is the board,
// not a re-drawing of it.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium } from '@playwright/test';

const CDN = 'https://esm.sh/@excalidraw/excalidraw@0.18.0';
const [boardMd, outHtml] = process.argv.slice(2);
if (!boardMd || !outHtml) { console.error('usage: node export-excalidraw-html.mjs <board.excalidraw.md> <out.html>'); process.exit(1); }

const md = readFileSync(boardMd, 'utf8');
const m = md.match(/##\s*Drawing\s*```json\s*([\s\S]*?)```/);
if (!m) throw new Error('No plain-JSON Drawing block (Obsidian may have re-compressed it).');
const scene = JSON.parse(m[1]);
if (!Array.isArray(scene.elements)) throw new Error('Scene has no elements[]');

const fmName = (md.match(/^name:\s*(.+)$/m) || [, basename(boardMd, '.excalidraw.md')])[1].trim();

const shell = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  import * as Excalidraw from "${CDN}";
  window.ExcalidrawLib = Excalidraw; window.__ready = true;
</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text().slice(0, 300)); });
await page.setContent(shell, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
await page.evaluate(async () => { try { await document.fonts.ready; } catch {} });
await page.waitForTimeout(800);

const svg = await page.evaluate(async ({ scene }) => {
  const { exportToSvg } = window.ExcalidrawLib;
  const el = await exportToSvg({
    elements: scene.elements,
    files: scene.files || null,
    appState: {
      ...(scene.appState || {}),
      exportBackground: true,
      exportWithDarkMode: false,
      viewBackgroundColor: '#ffffff',
      exportEmbedScene: false,
    },
    exportPadding: 24,
  });
  el.setAttribute('style', 'max-width:100%;height:auto;display:block');
  return el.outerHTML;
}, { scene });

await browser.close();

const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${fmName}</title>
<style>
  html,body{margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{max-width:1200px;margin:0 auto;padding:24px}
  .board{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.12);overflow:auto}
  .board svg{width:100%;height:auto}
</style>
</head>
<body><div class="wrap"><div class="board">
${svg}
</div></div></body></html>`;

writeFileSync(outHtml, html, 'utf8');
console.log('wrote', outHtml, '·', (Buffer.byteLength(html)/1024).toFixed(0)+' KB', '·', scene.elements.length, 'elements');
