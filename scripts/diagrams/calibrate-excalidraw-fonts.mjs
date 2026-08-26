// Calibrate the glyph-advance constants used by the excalidraw skill's text measurer.
//
// The skill wraps text WITHOUT a browser: it estimates a line's pixel width as
// `sum(fontSize * advance(ch))`. That constant is per-font — swap Excalifont for Nunito and every
// wrap decision shifts. This script measures the REAL advance in the same font stack Excalidraw
// ships, so the constant is measured, not guessed.
//
//   node scripts/diagrams/calibrate-excalidraw-fonts.mjs
//
// Prints, per font family: mean advance over a Latin+Turkish+digit corpus (as a multiple of
// fontSize), plus the worst-case single-line error over sample sentences.
import { chromium } from '@playwright/test';

const EXCALIDRAW_CDN = 'https://esm.sh/@excalidraw/excalidraw@0.18.0';

// Excalidraw FONT_FAMILY ids → the CSS family the renderer actually uses.
const FAMILIES = [
  { id: 5, css: 'Excalifont' },
  { id: 6, css: 'Nunito' },
  { id: 8, css: 'Comic Shanns' },
  { id: 3, css: 'Cascadia' },
  { id: 2, css: 'Helvetica' },
];

const CORPUS = [
  'The quick brown fox jumps over the lazy dog',
  'abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '0123456789 %99,8 17.613 10,8 saniye',
  'Paywall görünümü lead\'den SONRA geliyor — ölçülmesi gereken şey sayfada KALMAK',
  'analytics_kitup.all_merged_analytics / checkout / plan_selection',
  'Şiğüöç ŞİĞÜÖÇ ıI',
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(
  `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
     import * as E from "${EXCALIDRAW_CDN}"; window.EX = E; window.__ready = true;
   </script></body></html>`,
  { waitUntil: 'networkidle' },
);
await page.waitForFunction('window.__ready === true', { timeout: 30000 });

// Excalidraw registers its @font-face rules lazily, on first export — without this warm-up every
// family silently falls back to the same system sans and every measurement comes out identical.
await page.evaluate(async ({ FAMILIES }) => {
  for (const f of FAMILIES) {
    const el = {
      id: 't' + f.id, type: 'text', x: 0, y: 0, width: 400, height: 25, angle: 0,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0',
      roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null,
      updated: 1, link: null, locked: false, text: 'Merhaba dünya', fontSize: 20, fontFamily: f.id,
      textAlign: 'left', verticalAlign: 'top', containerId: null, originalText: 'Merhaba dünya',
      autoResize: true, lineHeight: 1.25,
    };
    try { await window.EX.exportToBlob({ elements: [el], files: null, mimeType: 'image/png', appState: { exportBackground: true } }); } catch {}
  }
  try { await document.fonts.ready; } catch {}
}, { FAMILIES });
await page.waitForTimeout(500);

// Every character the tables cover: printable ASCII + the Latin-1/Turkish letters and the
// punctuation these boards actually use. Anything outside falls back to the wide-glyph heuristic.
const CHARS = [
  ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)),
  ...'çğıöşüÇĞİÖŞÜâîûÂÎÛ',
  ...'áéíóúàèìòùäëïÿãñõåæøÁÉÍÓÚÀÈÌÒÙÄËÏÑÕÅÆØßœŒ',
  ...'—–…·•‚„“”‘’«»→←↑↓⇒≈≠≤≥±×÷°€£₺©®™§¶†‡',
].filter((c, i, a) => a.indexOf(c) === i);

const rows = await page.evaluate(async ({ FAMILIES, CORPUS, CHARS }) => {
  const ctx = document.createElement('canvas').getContext('2d');
  const SIZE = 100; // measure big, divide down — kills rounding noise in the per-glyph table
  const out = [];
  for (const f of FAMILIES) {
    try { await document.fonts.load(`${SIZE}px "${f.css}"`); } catch {}
    ctx.font = `${SIZE}px "${f.css}", sans-serif`;
    const table = {};
    for (const c of CHARS) table[c] = ctx.measureText(c).width / SIZE;
    // How far a naive sum-of-advances drifts from the browser's real (kerned) measurement.
    const lines = CORPUS.map((s) => {
      const real = ctx.measureText(s).width / SIZE;
      let sum = 0;
      for (const ch of s) sum += table[ch] != null ? table[ch] : 0.5;
      return { s: s.slice(0, 30), real, sum, chars: [...s].length };
    });
    out.push({ id: f.id, css: f.css, table, lines });
  }
  return out;
}, { FAMILIES, CORPUS, CHARS });

for (const r of rows) {
  const drift = r.lines.map((l) => l.sum / l.real);
  const flat = r.lines.map((l) => l.real / l.chars);
  console.log(`\n── fontFamily ${r.id}  ${r.css} ─────────────────────────────`);
  console.log(`   flat-constant range ${Math.min(...flat).toFixed(3)}–${Math.max(...flat).toFixed(3)}` +
    `   per-glyph-table drift ${(Math.min(...drift) * 100 - 100).toFixed(2)}%…${(Math.max(...drift) * 100 - 100).toFixed(2)}%`);
  // Emit the table grouped by advance, so the shipped constant stays readable in source.
  const byAdv = new Map();
  for (const [c, w] of Object.entries(r.table)) {
    const k = (Math.round(w * 1000) / 1000).toFixed(3);
    if (!byAdv.has(k)) byAdv.set(k, '');
    byAdv.set(k, byAdv.get(k) + c);
  }
  const groups = [...byAdv.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log(`   ${groups.length} distinct advances`);
  console.log('   ' + JSON.stringify(Object.fromEntries(groups)));
}

await browser.close();
