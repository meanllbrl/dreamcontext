#!/usr/bin/env node
/**
 * W3 (Telegram, window side): every screen the owner approved, photographed in every state,
 * without building the app and without W2's server (its routes are faked in the harness).
 *
 *   dreamcontext builder heavy -- node scripts/verify/telegram-w3.mjs [outDir]
 *
 * Drives the REAL components from `scripts/verify/harness/telegram/` on the dashboard's own Vite
 * in Chromium, light and dark, at 390 and 1440 px: the Super ⋯ menu (unbound, bound), the bind
 * sheet (manager one-step, no manager, connected), the member section (unbound, bound with its
 * routine list), Settings → Telegram (not set up, ready, alarm, browser tab), and a Telegram turn
 * card collapsed and open. Flows checked with the fake shell:
 *   - own token: typing a key and Devam POSTs it, the field is cleared, the QR shows; when the
 *     row turns pending the page invokes `confirm_telegram_binding` with the pairingId ONLY,
 *     and the connected view follows;
 *   - one tap: "Telegram'da oluştur" mints a creationId and invokes `start_telegram_creation`;
 *   - ticking a routine invokes `confirm_telegram_forward` with the request id only.
 * Fails on a console error, a page error, sideways overflow or a failed flow check.
 * HONEST LIMIT: Chromium, not the app's WKWebView; the server answers are fakes of W2's routes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer as netServer } from 'node:net';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'telegram');
const OUT = process.argv[2] || join(REPO, 'tmp', 'verify-telegram-w3');
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
const shots = [];
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name, pass, detail = '') => { checks.push({ name, pass }); if (!pass) findings.push(`check failed: ${name} ${detail}`); };

const VIEWS = [
  { view: 'menu-unbound', act: async (p) => { await p.getByTestId('super-head-more').click(); await p.getByTestId('super-head-telegram').waitFor(); } },
  { view: 'menu-bound', act: async (p) => { await p.getByTestId('super-head-more').click(); await p.locator('[data-testid="super-head-telegram"][data-bound]').waitFor(); } },
  { view: 'sheet-manager', act: async (p) => { await p.getByTestId('tg-create').waitFor(); await p.getByTestId('tg-readopt').waitFor(); } },
  { view: 'sheet-nomanager', act: async (p) => { await p.getByTestId('tg-open-settings').waitFor(); } },
  { view: 'sheet-token', url: 'sheet-nomanager', act: async (p) => { await p.getByTestId('tg-own-token').click(); await p.getByTestId('tg-token-next').waitFor(); } },
  { view: 'sheet-connected', act: async (p) => { await p.getByTestId('tg-connected').waitFor(); await p.locator('.tg-sees summary').click(); } },
  { view: 'member-unbound', act: async (p) => { await p.getByTestId('tg-member-bind').waitFor(); } },
  { view: 'member-bound', act: async (p) => { await p.getByTestId('tg-forward-list').waitFor(); } },
  { view: 'settings-none', act: async (p) => { await p.getByTestId('tg-manager-next').waitFor(); } },
  { view: 'settings-ready', act: async (p) => { await p.getByTestId('tg-manager-bots').waitFor(); } },
  { view: 'settings-alarm', act: async (p) => { await p.getByTestId('tg-manager-alarm').waitFor(); } },
  { view: 'settings-browser', url: 'settings-none&browser=1', act: async (p) => { await p.getByTestId('tg-settings-browser').waitFor(); } },
  { view: 'card-collapsed', url: 'card', act: async (p) => { await p.getByTestId('tg-turn-card').waitFor(); } },
  { view: 'card-open', url: 'card', act: async (p) => { await p.locator('.tg-card-head').click(); await p.locator('.tg-card-body').waitFor(); } },
];

async function open(theme, width, url) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`crash: ${String(e).slice(0, 200)}`));
  await page.goto(`${base}?view=${url}&theme=${theme}&lang=tr`);
  await page.getByTestId('harness').waitFor({ timeout: 20_000 });
  return { ctx, page, errors };
}

try {
  for (const theme of ['light', 'dark']) for (const width of [390, 1440]) {
    for (const v of VIEWS) {
      const { ctx, page, errors } = await open(theme, width, v.url ?? v.view);
      const id = `${v.view}-${theme}-${width}`;
      try {
        await v.act(page);
        await sleep(350);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) findings.push(`${id}: overflows sideways by ${over}px`);
        const file = join(OUT, `${id}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
      } catch (err) {
        findings.push(`${id}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      }
      for (const e of errors) findings.push(`${id} console: ${e}`);
      await ctx.close();
    }
  }

  // Flow: own token → pairing → native confirm (pairingId only) → connected.
  {
    const { ctx, page, errors } = await open('light', 1440, 'bindflow');
    await page.getByTestId('tg-own-token').click();
    const field = page.locator('.masked-secret-input');
    await field.fill('123456789:AAExampleExampleExampleExample123');
    await page.getByTestId('tg-token-next').click();
    await page.getByTestId('tg-open-link').waitFor({ timeout: 10_000 });
    shots.push(join(OUT, 'flow-own-token-pairing.png'));
    await page.screenshot({ path: shots[shots.length - 1] });
    ok('the token field is gone once the bind POST answered', (await page.locator('.masked-secret-input').count()) === 0);
    await page.getByTestId('tg-connected').waitFor({ timeout: 15_000 });
    shots.push(join(OUT, 'flow-own-token-connected.png'));
    await page.screenshot({ path: shots[shots.length - 1] });
    const invoked = await page.evaluate(() => window.__invoked);
    const confirm = invoked.filter((c) => c.cmd === 'confirm_telegram_binding');
    ok('the native confirm was asked exactly once', confirm.length === 1, JSON.stringify(invoked));
    ok('the shell got the pairingId and nothing else', JSON.stringify(confirm[0]?.args) === JSON.stringify({ pairingId: 'AbCdEfGhIjKlMnOpQrStUv' }));
    ok('no shell call ever carried the token', !JSON.stringify(invoked).includes('AAExample'));
    for (const e of errors) findings.push(`flow-own-token console: ${e}`);
    await ctx.close();
  }
  // Flow: one tap creation.
  {
    const { ctx, page, errors } = await open('light', 1440, 'sheet-manager');
    await page.getByTestId('tg-create').click();
    await page.locator('.tg-wait').waitFor({ timeout: 10_000 });
    shots.push(join(OUT, 'flow-create-waiting.png'));
    await page.screenshot({ path: shots[shots.length - 1] });
    const invoked = await page.evaluate(() => window.__invoked);
    const start = invoked.find((c) => c.cmd === 'start_telegram_creation');
    ok('creation invoked with the minted id only', JSON.stringify(start?.args) === JSON.stringify({ creationId: 'CrtAbCdEfGhIjKlMnOpQrS' }), JSON.stringify(invoked));
    ok('the create link opened through the shell', invoked.some((c) => c.cmd === 'plugin:shell|open' && String(c.args?.path).startsWith('https://t.me/newbot/')));
    for (const e of errors) findings.push(`flow-create console: ${e}`);
    await ctx.close();
  }
  // Flow: ticking a routine raises the native confirm (request id only); the box follows the server.
  {
    const { ctx, page, errors } = await open('light', 1440, 'member-bound');
    await page.getByTestId('tg-forward-list').waitFor();
    // Controlled by the server's answer: a click, then the box follows the refetched list.
    await page.locator('input[data-routine="weekly-creative"]').click();
    await sleep(1200);
    const invoked = await page.evaluate(() => window.__invoked);
    const fwd = invoked.filter((c) => c.cmd === 'confirm_telegram_forward');
    ok('ticking a routine asks the native confirm with the request id only', fwd.length === 1 && JSON.stringify(fwd[0].args) === JSON.stringify({ forwardRequestId: 'FwdReqAbCdEfGhIjKlMnOp' }), JSON.stringify(invoked));
    ok('the box reads the server after the confirm', await page.locator('input[data-routine="weekly-creative"]').isChecked());
    for (const e of errors) findings.push(`flow-forward console: ${e}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}

writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ findings, checks, shots }, null, 1)}\n`);
for (const c of checks) process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}\n`);
for (const f of findings) process.stdout.write(`FINDING: ${f}\n`);
process.stdout.write(`${shots.length} screenshots in ${OUT}\n${findings.length === 0 ? 'CLEAN' : `${findings.length} finding(s)`}\n`);
process.exit(findings.length === 0 ? 0 : 1);
