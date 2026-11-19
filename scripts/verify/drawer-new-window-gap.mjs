#!/usr/bin/env node
/** The New window control takes no row in the left drawer: no gap idle, no jump on hover, shown on focus; in both themes from the REAL
 * components on staged facts (`harness/drawer-sade/`):
 *   dreamcontext builder heavy -- node scripts/verify/drawer-new-window-gap.mjs <outDir> <prefix> [width]
 * Writes one PNG per state and theme; exits 1 on a failed check.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as netServer } from 'node:net';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'drawer-sade');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify-new-window-gap'));
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


const ok = (n, v) => { console.log((v ? 'ok   ' : 'FAIL ') + n); if (!v) findings.push(`check failed: ${n}`); };
try {
  for (const [theme, scn] of [['dark', 'super-2'], ['light', 'super-2'], ['dark', 'idle'], ['light', 'idle']]) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 720 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${base}?s=${scn}&theme=${theme}&w=${WIDTH}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="drawer-project-row"]', { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.mouse.move(850, 700);
    const proj = page.locator('.ns-dr-project').first();
    const ys = () => proj.evaluate((el) => [...el.querySelectorAll('.ns-dr-children > *')].map((c) => [c.className.slice(0, 30), Math.round(c.getBoundingClientRect().y), Math.round(c.getBoundingClientRect().height)]));
    const idle = await ys();
    console.log(theme, JSON.stringify(idle));
    ok(`${theme}: no New window row in layout`, (await proj.locator('.ns-dr-newchat-wrap').count()) === 0);
    for (let i = 1; i < idle.length; i++) { const gap = idle[i][1] - (idle[i - 1][1] + idle[i - 1][2]); ok(`${theme}: gap ${i} = ${gap}px`, gap <= 8); }
    const shot = (n) => page.locator('[data-testid="harness-drawer"]').screenshot({ path: join(OUT, `${PREFIX}-${scn}-${theme}-${n}.png`), animations: 'disabled' });
    await shot('idle');
    await proj.locator('.ns-dr-proj').first().hover(); await page.waitForTimeout(300);
    ok(`${theme}: hover moves no row`, JSON.stringify(idle) === JSON.stringify(await ys()));
    ok(`${theme}: + shown on hover`, await proj.locator('[data-testid="drawer-project-add"]').evaluate((e) => getComputedStyle(e.parentElement).opacity === '1'));
    await shot('hover');
    await page.mouse.move(850, 700); await page.waitForTimeout(300);
    await proj.locator('[data-testid="drawer-project-row"]').focus(); await page.keyboard.press('Tab'); await page.waitForTimeout(300);
    ok(`${theme}: + shown on keyboard focus`, await proj.locator('[data-testid="drawer-project-add"]').evaluate((e) => getComputedStyle(e.parentElement).opacity === '1'));
    await shot('focus');
    // The member picker is an item of the project's "..." menu (owner 2026-11-16), no chevron.
    await proj.locator('.ns-dr-proj').first().hover();
    ok(`${theme}: no chevron and no eye on the row`, (await proj.locator('.ns-dr-newchat-menu, .ns-dr-hide').count()) === 0);
    await proj.locator('[data-testid="drawer-project-more"]').click();
    const chev = page.locator('[data-testid="drawer-project-newchat-item"]');
    if (await chev.count()) {
      await chev.first().click(); await page.mouse.move(850, 700); await page.waitForTimeout(300);
      ok(`${theme}: + stays shown while member menu is open`, await proj.locator('[data-testid="drawer-project-add"]').evaluate((e) => getComputedStyle(e.parentElement).opacity === '1'));
      await shot('menu');
    } else console.log('(no member picker in this scenario)');
    await ctx.close();
  }
} catch (err) { findings.push(`could not finish: ${err instanceof Error ? err.message : err}`); }
finally { await browser.close(); await server.close(); }
console.log(`shots in ${OUT}`);
for (const f of findings) console.log(`FINDING ${f}`);
process.exit(findings.length ? 1 : 0);
