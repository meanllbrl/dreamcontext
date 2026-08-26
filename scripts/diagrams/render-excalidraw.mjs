// Headless renderer: .excalidraw.md (Obsidian board) → PNG for docs (README / deep-dive wiki).
// Parses the plain-JSON scene from the board's `## Drawing` block and exports it via
// @excalidraw/excalidraw's exportToBlob in a headless Chromium (Playwright).
//
// CLI:  node scripts/diagrams/render-excalidraw.mjs <board.excalidraw.md> <out.png> [scale]
// API:  import { withRenderer } from './render-excalidraw.mjs'
//       await withRenderer(async (render) => { await render(boardMd, outPng, 2) })
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const EXCALIDRAW_CDN = 'https://esm.sh/@excalidraw/excalidraw@0.18.0';

export function sceneFromBoard(mdPath) {
  const md = readFileSync(mdPath, 'utf8');
  // The generator writes: `## Drawing\n```json\n{ ...scene... }\n``` (plain JSON).
  const m = md.match(/##\s*Drawing\s*```json\s*([\s\S]*?)```/);
  if (!m) throw new Error(`No plain-JSON Drawing block in ${mdPath} (Obsidian may have re-compressed it — re-run the board script).`);
  const scene = JSON.parse(m[1]);
  if (!Array.isArray(scene.elements)) throw new Error('Scene has no elements[]');
  return scene;
}

/** Launch one headless excalidraw page, hand a `render(boardMd, outPng, scale)` fn to `fn`, then close. */
export async function withRenderer(fn) {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  import * as Excalidraw from "${EXCALIDRAW_CDN}";
  window.ExcalidrawLib = Excalidraw;
  window.__ready = true;
</script></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('[page]', msg.text().slice(0, 200)); });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  await page.evaluate(async () => { try { await document.fonts.ready; } catch {} });
  await page.waitForTimeout(600);

  // `band` = [y0, y1] in BOARD coordinates: render only the elements whose vertical extent overlaps
  // that strip. A finished board is often 10,000px tall, and the skill's "render it and LOOK at it"
  // step is unusable on one 10k-tall PNG — you cannot see anything, and cropping after the fact needs
  // the exported image's own coordinate space, which is not the board's. Slicing by board y is what
  // makes inspecting a tall board a normal thing to do.
  const render = async (boardMd, outPng, scale = 2, band = null) => {
    let scene = sceneFromBoard(boardMd);
    if (band) {
      const [y0, y1] = band;
      const kept = scene.elements.filter((e) => {
        const top = e.y, bot = e.y + (e.height || 0);
        return bot >= y0 && top <= y1;
      });
      scene = { ...scene, elements: kept };
    }
    const dataUrl = await page.evaluate(async ({ scene, scale }) => {
      const { exportToBlob } = window.ExcalidrawLib;
      const blob = await exportToBlob({
        elements: scene.elements,
        files: scene.files || null,
        mimeType: 'image/png',
        quality: 1,
        appState: {
          ...(scene.appState || {}),
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor: '#ffffff',
          exportScale: scale,
        },
        getDimensions: (w, h) => ({ width: w * scale, height: h * scale, scale }),
      });
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
    }, { scene, scale });
    writeFileSync(outPng, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    console.log(`  rendered ${outPng}  (${scene.elements.length} elements, scale ${scale}${band ? `, band y ${band[0]}..${band[1]}` : ''})`);
  };

  // Single-page PDF sized exactly to the diagram: export the same PNG blob, read its
  // natural pixel size, lay it full-bleed in a throwaway page, and print to PDF.
  render.pdf = async (boardMd, outPdf, scale = 2) => {
    const scene = sceneFromBoard(boardMd);
    const { dataUrl, w, h } = await page.evaluate(async ({ scene, scale }) => {
      const { exportToBlob } = window.ExcalidrawLib;
      const blob = await exportToBlob({
        elements: scene.elements,
        files: scene.files || null,
        mimeType: 'image/png',
        quality: 1,
        appState: {
          ...(scene.appState || {}),
          exportBackground: true,
          exportWithDarkMode: false,
          viewBackgroundColor: '#ffffff',
          exportScale: scale,
        },
        getDimensions: (w, h) => ({ width: w * scale, height: h * scale, scale }),
      });
      const dataUrl = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
      const dim = await new Promise((res) => {
        const im = new Image();
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
        im.src = dataUrl;
      });
      return { dataUrl, w: dim.w, h: dim.h };
    }, { scene, scale });

    const pdfCtx = await browser.newContext();
    const pdfPage = await pdfCtx.newPage();
    await pdfPage.setContent(
      `<!doctype html><html><body style="margin:0;padding:0">` +
      `<img src="${dataUrl}" style="display:block;width:${w}px;height:${h}px"/></body></html>`,
      { waitUntil: 'networkidle' },
    );
    await pdfPage.pdf({
      path: outPdf,
      width: `${w}px`,
      height: `${h}px`,
      printBackground: true,
      pageRanges: '1',
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    await pdfPage.close();
    await pdfCtx.close();
    console.log(`  pdf ${outPdf}  (${w}x${h}px)`);
  };

  try {
    await fn(render);
  } finally {
    await browser.close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , boardPath, outPath, scaleArg, y0, y1] = process.argv;
  if (!boardPath || !outPath) {
    console.error('usage: render-excalidraw.mjs <board.excalidraw.md> <out.png> [scale] [y0 y1]');
    console.error('  y0/y1 (optional) render only the horizontal band of the board between those');
    console.error('  BOARD y coordinates — the way to inspect a tall board section by section.');
    process.exit(1);
  }
  const band = y0 != null && y1 != null ? [Number(y0), Number(y1)] : null;
  await withRenderer(async (render) => { await render(boardPath, outPath, Number(scaleArg) || 2, band); });
}
