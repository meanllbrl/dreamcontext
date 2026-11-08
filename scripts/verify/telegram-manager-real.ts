#!/usr/bin/env -S npx tsx
/**
 * Settings → Telegram manager bot, end to end against the REAL server (2026-11-08 fix):
 *
 *   dreamcontext builder heavy -- npx tsx scripts/verify/telegram-manager-real.ts [outDir]
 *
 * The owner pressed Start for the manager bot and the "Bağla" confirm never came: the harness of
 * telegram-w3.mjs faked the server's answers, so nothing ever checked that the REAL status route
 * says `pending` for a manager pairing. Here:
 *  - the real dashboard server runs in launcher mode (nothing pinned), desktop on, a scratch HOME;
 *  - its Telegram hub talks to an in-process fake Bot API (tests/helpers/fake-telegram.ts);
 *  - the REAL TelegramSettings component runs on Vite (the telegram harness, `real=1`), /api
 *    proxied to that server, with NO vault header (the strictest case);
 *  - `confirm_telegram_binding` goes to a stand-in for the Rust command that does what
 *    telegram_confirm.rs does: GET the pairing preview, then POST the confirm with the owner key,
 *    both with no vault header.
 * Flow at 390 and 1440 px: token → Devam → link shown, waiting → /start arrives in Telegram →
 * the page raises the confirm (once, pairingId only) → "Hazır". Fails on any console error,
 * failed request, sideways overflow or failed check.
 * HONEST LIMIT: Chromium, not the app's WKWebView; the native NSAlert is the stand-in's preview.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as netServer } from 'node:net';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || join(REPO, 'tmp', 'verify-telegram-manager-real');
mkdirSync(OUT, { recursive: true });

// Before any server module reads them: a scratch home, the desktop server's switches.
const scratch = mkdtempSync(join(tmpdir(), 'dc-tg-mgr-real-'));
const home = join(scratch, 'home');
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
// Playwright finds its browsers under the REAL home; only the server gets the scratch one.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
process.env.HOME = home;
process.env.DREAMCONTEXT_DESKTOP = '1';

const freePort = (): Promise<number> => new Promise((done, fail) => {
  const srv = netServer();
  srv.once('error', fail);
  srv.listen(0, '127.0.0.1', () => { const a = srv.address(); srv.close(() => done(typeof a === 'object' && a ? a.port : 0)); });
});
const step = (m: string) => process.stderr.write(`[tg-mgr-real] ${m}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { FakeTelegram, textUpdate } = await import('../../tests/helpers/fake-telegram.js');
const { startTelegramHub, stopTelegramHub } = await import('../../src/server/telegram/start.js');
const { startDashboardServer } = await import('../../src/server/index.js');
const { setOwnerKey } = await import('../../src/server/owner-key.js');

const MANAGER = '900001:MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
const OWNER = 777;
const KEY = 'k'.repeat(64);
const tg = new FakeTelegram();
tg.addBot(MANAGER, 'orbit_manager_bot');
// The hub first, with the fake Bot API: the server's own start finds it and keeps it.
step('hub');
await startTelegramHub({ home, fetchImpl: tg.fetch, pollTimeoutS: 0, sleep: () => sleep(50) });
const apiPort = await freePort();
step('server');
// Resolves only when the server shuts down: start it, then wait until it answers.
void startDashboardServer({ port: apiPort, contextRoot: null, open: false });
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).status < 500) break; } catch { /* not up yet */ }
  if (i > 100) throw new Error('the server did not answer');
  await sleep(200);
}
setOwnerKey(KEY);
const api = `http://127.0.0.1:${apiPort}`;

/** What telegram_confirm.rs sends: Host/Origin of the server, same-origin, no vault header. */
const rustHeaders = { Origin: api, 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json' };
const previews: unknown[] = [];
async function rustConfirm(pairingId: string): Promise<unknown> {
  const pre = await fetch(`${api}/api/telegram-pairing/${pairingId}`, { headers: rustHeaders });
  const preview = await pre.json();
  previews.push({ status: pre.status, preview });
  if (pre.status !== 200) throw new Error(`preview ${pre.status}`);
  const res = await fetch(`${api}/api/telegram-pairing/${pairingId}/confirm`, {
    method: 'POST', headers: { ...rustHeaders, 'Content-Type': 'application/json', 'X-Dreamcontext-Owner-Key': KEY },
    body: JSON.stringify({ botId: preview.botId, userId: preview.userId }),
  });
  if (res.status !== 200) throw new Error(`confirm ${res.status}`);
  return { ok: true };
}

// Vite: the telegram harness, /api proxied to the real server.
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'telegram');
const fromDash = (p: string) => import(pathToFileURL(join(DASH, 'node_modules', p)).href);
const { createServer } = await fromDash('vite/dist/node/index.js');
const react = (await fromDash('@vitejs/plugin-react/dist/index.js')).default;
const vitePort = await freePort();
const vite = await createServer({
  configFile: false, root: HARNESS, logLevel: 'error', plugins: [react()],
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
  server: { port: vitePort, strictPort: true, host: '127.0.0.1', fs: { allow: [REPO] }, proxy: { '/api': { target: api, changeOrigin: false } } },
  optimizeDeps: { entries: [join(HARNESS, 'index.html')] },
});
step('vite');
await vite.listen();
step('browser');
const base = vite.resolvedUrls.local[0];

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const findings: string[] = [];
const checks: { name: string; pass: boolean }[] = [];
const shots: string[] = [];
let lastDeepLink: string | null = null;
const ok = (name: string, pass: boolean, detail = '') => { checks.push({ name, pass }); if (!pass) findings.push(`check failed: ${name} ${detail}`); };

try {
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errors.push(`crash: ${String(e).slice(0, 200)}`));
    page.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
      // The deep link the page shows (QR + button) comes from its own bind POST.
      if (r.url().endsWith('/api/telegram-manager/bind') && r.status() === 200) void r.json().then((j) => { lastDeepLink = j.deepLink; });
    });
    await page.exposeFunction('__rustConfirm', rustConfirm);
    const shot = async (name: string) => { const f = join(OUT, `${name}-${width}.png`); await page.screenshot({ path: f, fullPage: true }); shots.push(f); };
    const over = async (id: string) => {
      const px = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (px > 1) findings.push(`${id}-${width}: overflows sideways by ${px}px`);
    };

    step(`width ${width}`);
    await page.goto(`${base}?view=settings-real&real=1&vault=&theme=light&lang=tr`, { timeout: 180_000 });
    await page.getByTestId('tg-manager-next').waitFor({ timeout: 20_000 });
    await shot('1-not-set-up'); await over('1');
    await page.locator('.masked-secret-input').fill(MANAGER);
    await page.getByTestId('tg-manager-next').click();
    await page.getByTestId('tg-open-link').waitFor({ timeout: 10_000 });
    await sleep(2_500); // a few polls with no /start yet: never a confirm before it
    await shot('2-waiting-for-start'); await over('2');
    let invoked = await page.evaluate(() => (window as unknown as { __invoked: { cmd: string; args: unknown }[] }).__invoked);
    ok(`${width}: no confirm before /start`, !invoked.some((c) => c.cmd === 'confirm_telegram_binding'), JSON.stringify(invoked));
    // The owner taps the link in Telegram and presses Start: the deep link's payload arrives.
    const status = await (await fetch(`${api}/api/telegram-manager/status`, { headers: rustHeaders })).json();
    ok(`${width}: status says waiting (no manager yet)`, status.manager === null, JSON.stringify(status));
    const start = lastDeepLink;
    if (!start) throw new Error('no deep link seen');
    tg.push(MANAGER, textUpdate(OWNER, `/start ${new URL(start).searchParams.get('start')}`));
    await page.getByText('Hazır').first().waitFor({ timeout: 15_000 });
    await sleep(400);
    await shot('3-ready'); await over('3');
    invoked = await page.evaluate(() => (window as unknown as { __invoked: { cmd: string; args: unknown }[] }).__invoked);
    const confirms = invoked.filter((c) => c.cmd === 'confirm_telegram_binding');
    ok(`${width}: the page raised the confirm exactly once, with the pairingId only`, confirms.length === 1 && Object.keys(confirms[0].args as object).join() === 'pairingId', JSON.stringify(invoked));
    const last = previews[previews.length - 1] as { status: number; preview: Record<string, unknown> } | undefined;
    ok(`${width}: the Rust preview named the manager and the owner`, last?.status === 200 && last.preview.target === '@manager' && last.preview.userLabel === '@owner', JSON.stringify(last));
    const after = await (await fetch(`${api}/api/telegram-manager/status`, { headers: rustHeaders })).json();
    ok(`${width}: the manager is active after the confirm`, after.manager?.state === 'active' && after.manager?.botUsername === 'orbit_manager_bot', JSON.stringify(after));
    ok(`${width}: the bot told the owner to confirm on the Mac`, tg.texts().some((t) => t.includes('Mac')));
    for (const e of errors) findings.push(`${width} console/request: ${e}`);
    await ctx.close();
    // Reset for the next width: Kaldır, as the page would.
    await fetch(`${api}/api/telegram-manager`, { method: 'DELETE', headers: { ...rustHeaders, 'X-Dreamcontext-Owner-Key': KEY } });
    lastDeepLink = null;
  }
} finally {
  await browser.close();
  await vite.close();
  stopTelegramHub();
}

writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ findings, checks, shots, previews }, null, 1)}\n`);
for (const c of checks) process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}: ${c.name}\n`);
for (const f of findings) process.stdout.write(`FINDING: ${f}\n`);
process.stdout.write(`${shots.length} screenshots in ${OUT}\n${findings.length === 0 ? 'CLEAN' : `${findings.length} finding(s)`}\n`);
process.exit(findings.length === 0 ? 0 : 1);
