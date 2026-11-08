#!/usr/bin/env node
/**
 * The left drawer's project section, every state the owner judges, in both themes, from the REAL
 * components on staged facts (`harness/drawer-sade/`):
 *   dreamcontext builder heavy -- node scripts/verify/drawer-sade.mjs <outDir> <before|after> [width]
 * Writes one PNG per state and theme, plus <prefix>-pano-<width>.png (all of them on one board),
 * and fails on any console error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as netServer } from 'node:net';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'drawer-sade');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify-drawer-sade'));
const PREFIX = process.argv[3] || 'after';
const WIDTH = Number(process.argv[4] || 200);
mkdirSync(OUT, { recursive: true });

const fromDash = (p) => import(pathToFileURL(join(DASH, 'node_modules', p)).href);
const { createServer } = await fromDash('vite/dist/node/index.js');
const react = (await fromDash('@vitejs/plugin-react/dist/index.js')).default;
const freePort = () => new Promise((done, fail) => {
  const srv = netServer();
  srv.once('error', fail);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => done(port)); });
});
const port = await freePort();
const server = await createServer({
  configFile: false,
  root: HARNESS,
  logLevel: 'error',
  plugins: [react()],
  define: { __DC_VERSION__: JSON.stringify('0.0.0-harness') },
  resolve: {
    alias: [
      { find: /^react$/, replacement: join(DASH, 'node_modules', 'react') },
      { find: /^react\/(.*)$/, replacement: join(DASH, 'node_modules', 'react', '$1') },
      { find: /^react-dom$/, replacement: join(DASH, 'node_modules', 'react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: join(DASH, 'node_modules', 'react-dom', '$1') },
      { find: /^@tanstack\/react-query$/, replacement: join(DASH, 'node_modules', '@tanstack', 'react-query') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [REPO] } },
  optimizeDeps: { entries: [join(HARNESS, 'index.html')] },
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const findings = [];

const STATES = [
  ['idle', 'Boşta'],
  ['working', 'Üye çalışıyor'],
  ['member-asking', 'Üye soruyor'],
  ['super-asking', 'Super soruyor'],
  ['super-2', 'Super 2 iş'],
  ['team-folded-asking', 'Katlı Team, üyesi soruyor'],
  ['collapsed-asking', 'Kapalı proje, içinde soru'],
  ['selected-asking', 'Seçili soruyor, onay, okunmamış'],
  ['hover', 'Fare proje satırında'],
  ['focus', 'Klavye odağı proje satırında'],
];
const files = [];
try {
  for (const theme of ['dark', 'light']) {
    for (const [s, label] of STATES) {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 720 }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
      page.on('pageerror', (e) => errors.push(`crash: ${String(e).slice(0, 200)}`));
      const scenario = s === 'hover' || s === 'focus' ? 'idle' : s;
      await page.goto(`${base}?s=${scenario}&theme=${theme}&w=${WIDTH}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="drawer-project-row"]', { timeout: 15000 });
      await page.waitForTimeout(400);
      if (s === 'hover') await page.locator('.ns-dr-proj').first().hover();
      if (s === 'focus') { await page.locator('[data-testid="drawer-project-row"]').first().focus(); await page.keyboard.press('Tab'); }
      await page.waitForTimeout(250);
      const file = join(OUT, `${PREFIX}-${WIDTH}-${theme}-${s}.png`);
      await page.locator('[data-testid="harness-drawer"]').screenshot({ path: file, animations: 'disabled' });
      files.push({ file, theme, label });
      for (const e of errors) findings.push(`${theme}/${s} console: ${e}`);
      await ctx.close();
    }
  }
  // One board: every state, dark row over light row.
  const cell = (f) => `<figure><figcaption>${f.label}</figcaption><img src="${pathToFileURL(f.file).href}"></figure>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#888;font:13px -apple-system,system-ui;color:#111">
    <h2 style="margin:0 0 12px">${PREFIX === 'before' ? 'Önce' : 'Sonra'} (${WIDTH} px)</h2>
    ${['dark', 'light'].map((t) => `<div style="display:flex;gap:16px;margin-bottom:16px">${files.filter((f) => f.theme === t).map(cell).join('')}</div>`).join('')}
    <style>figure{margin:0}figcaption{margin-bottom:6px;font-weight:600}img{width:${WIDTH}px;display:block;border-radius:8px}</style></body></html>`;
  const board = join(OUT, `${PREFIX}-pano-${WIDTH}.html`);
  writeFileSync(board, html);
  const ctx = await browser.newContext({ viewport: { width: 48 + STATES.length * (WIDTH + 16), height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(board).href, { waitUntil: 'load' });
  await page.screenshot({ path: join(OUT, `${PREFIX}-pano-${WIDTH}.png`), fullPage: true });
  await ctx.close();
} catch (err) {
  findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(`${files.length} shots in ${OUT}`);
for (const f of findings) console.log(`FINDING ${f}`);
process.exit(findings.length ? 1 : 0);
