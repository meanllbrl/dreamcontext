#!/usr/bin/env node
/**
 * W4 (Telegram, remote runs): the run and secret cards in a CHAT host, on the Mac and on the
 * hands-free phone page, photographed light and dark at 390 and 1440 px, with their real CSS and
 * the dashboard's own Vite (no app build, no server: the card records and the terminal socket are
 * fakes, `scripts/verify/harness/runcards/`). States: open card, a run started from Telegram
 * attached, a finished card, a card replaced by a newer copy, a run cut off by an app stop, a card
 * with no server record. Flows checked:
 *   - the terminal socket names the RECORD ({session, card}), never a command or a vault; the
 *     phone uses /api/agent/run-terminal, the Mac /api/agent/terminal; Run again is Mac only;
 *   - a run going for the card is attached with no second Run button;
 *   - the secret card posts its record's {sessionId, cardRef};
 *   - a refused start (a first Run, or a Run again on a finished card) says it did not start and
 *     keeps its button (never "finished", never the old exit chip);
 *   - a finished run keeps its terminal on screen;
 *   - a terminal that attached by itself does not take the keyboard;
 *   - a replaced card never says it ran or was saved.
 * Fails on a console error, a page error, sideways overflow or a failed check.
 * HONEST LIMIT: Chromium, not the app's WKWebView; the server is faked.
 *
 *   dreamcontext builder heavy -- node scripts/verify/telegram-w4.mjs [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer as netServer } from 'node:net';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASH = join(REPO, 'dashboard');
const HARNESS = join(REPO, 'scripts', 'verify', 'harness', 'runcards');
const OUT = process.argv[2] || join(REPO, 'tmp', 'verify-telegram-w4');
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


const STATES = ['idle', 'live-telegram', 'done', 'superseded', 'interrupted', 'unrecorded'];

async function open(host, theme, width, view, sock = 'live') {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`crash: ${String(e).slice(0, 200)}`));
  await page.goto(`${base}?host=${host}&view=${view}&theme=${theme}&sock=${sock}`, { timeout: 180_000 });
  await page.getByTestId('harness').waitFor({ timeout: 20_000 });
  await page.locator('.chat-runcard[data-card-state]:not([data-card-state="loading"])').waitFor({ timeout: 10_000 });
  return { ctx, page, errors };
}
const sockets = (page) => page.evaluate(() => window.__sockets);

try {
  for (const host of ['mac', 'phone']) for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const view of STATES) {
    const { ctx, page, errors } = await open(host, theme, width, view);
    const id = `${host}-${view}-${theme}-${width}`;
    try {
      await sleep(500);
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

  const run = (page) => page.locator('.chat-runcard-play:not([disabled])');
  // Phone: ▶ opens the phone's own run-terminal path naming the record.
  {
    const { ctx, page, errors } = await open('phone', 'light', 390, 'idle');
    await run(page).click();
    await page.locator('.chat-runterm').waitFor();
    await sleep(600);
    const s = await sockets(page);
    ok('phone ▶ opens /api/agent/run-terminal with session + card + start', s.length === 1 && s[0].startsWith('/api/agent/run-terminal?') && s[0].includes('start=1') && s[0].includes('card=aaaa'), JSON.stringify(s));
    ok('phone ▶ sends no command and no vault', !/[?&](cmd|vault|cwd)=/.test(s[0] ?? ''), s[0]);
    shots.push(join(OUT, 'flow-phone-running.png'));
    await page.screenshot({ path: shots[shots.length - 1], fullPage: true });
    for (const e of errors) findings.push(`flow-phone console: ${e}`);
    await ctx.close();
  }
  // Mac: ▶ opens the chat-host mode of /api/agent/terminal; the output switch rides as withheld.
  {
    const { ctx, page, errors } = await open('mac', 'light', 1440, 'idle');
    await page.locator('.chat-runcard-share input').uncheck();
    await run(page).click();
    await page.locator('.chat-runterm').waitFor();
    const s = await sockets(page);
    ok('Mac ▶ opens /api/agent/terminal naming the record, withheld on', s.length === 1 && s[0].startsWith('/api/agent/terminal?session=') && s[0].includes('withheld=1'), JSON.stringify(s));
    ok('Mac ▶ sends no cmd=', !/[?&]cmd=/.test(s[0] ?? ''), s[0]);
    for (const e of errors) findings.push(`flow-mac console: ${e}`);
    await ctx.close();
  }
  // A run started from Telegram: attached, no second Run.
  for (const host of ['mac', 'phone']) {
    const { ctx, page, errors } = await open(host, 'light', 1440, 'live-telegram');
    await page.locator('.chat-runterm').waitFor();
    await sleep(300);
    const s = await sockets(page);
    ok(`${host}: a Telegram-started run is attached (no start)`, s.length === 1 && !s[0].includes('start=1'), JSON.stringify(s));
    ok(`${host}: no Run button while it runs`, (await page.locator('.chat-runcard-play').count()) === 0);
    ok(`${host}: says it was started from Telegram`, (await page.locator('.chat-runcard-note').innerText()).includes('Telegram'));
    ok(`${host}: the attached terminal does not take the keyboard`, await page.evaluate(() => !document.activeElement?.closest('.chat-runterm')));
    for (const e of errors) findings.push(`flow-live-${host} console: ${e}`);
    await ctx.close();
  }
  // Finished: Run again on the Mac only.
  {
    const { ctx, page, errors } = await open('mac', 'light', 1440, 'done');
    await run(page).click();
    await page.locator('.chat-runterm').waitFor();
    const s = await sockets(page);
    ok('Mac Run again carries rerun=1', s.length === 1 && s[0].includes('rerun=1'), JSON.stringify(s));
    for (const e of errors) findings.push(`flow-again console: ${e}`);
    await ctx.close();
    const ph = await open('phone', 'light', 390, 'done');
    ok('phone: a finished card has no Run button', (await ph.page.locator('.chat-runcard-play').count()) === 0);
    for (const e of ph.errors) findings.push(`flow-phone-done console: ${e}`);
    await ph.ctx.close();
  }
  // A refused start (busy, too many starts): never shown as finished; Run stays.
  for (const host of ['mac', 'phone']) {
    const width = host === 'mac' ? 1440 : 390;
    const { ctx, page, errors } = await open(host, 'light', width, 'idle', 'refuse');
    await run(page).click();
    await page.locator('.chat-runcard-note', { hasText: 'did not start' }).waitFor({ timeout: 5000 });
    ok(`${host}: a refused start stays idle`, (await page.locator('.chat-runcard').getAttribute('data-phase')) === 'idle');
    ok(`${host}: …says nothing about finishing or the agent`, !/Finished|agent gets/.test(await page.locator('.chat-runcard').innerText()));
    ok(`${host}: …and keeps an enabled Run`, (await run(page).count()) === 1);
    shots.push(join(OUT, `flow-${host}-refused.png`));
    await page.screenshot({ path: shots[shots.length - 1], fullPage: true });
    for (const e of errors) findings.push(`flow-refused-${host} console: ${e}`);
    await ctx.close();
  }
  // Run again on a finished card, refused: the refusal shows, the old exit chip does not.
  {
    const { ctx, page, errors } = await open('mac', 'light', 1440, 'done', 'refuse');
    await run(page).click();
    await page.locator('.chat-runcard-note', { hasText: 'did not start' }).waitFor({ timeout: 5000 });
    const text = await page.locator('.chat-runcard').innerText();
    ok('Mac: a refused Run again says it did not start', !/Finished|agent gets/.test(text), text.slice(0, 200));
    ok('Mac: …with no old exit chip', (await page.locator('.chat-runcard-exit').count()) === 0);
    ok('Mac: …and Run again stays', (await run(page).count()) === 1);
    shots.push(join(OUT, 'flow-mac-refused-again.png'));
    await page.screenshot({ path: shots[shots.length - 1], fullPage: true });
    for (const e of errors) findings.push(`flow-refused-again console: ${e}`);
    await ctx.close();
  }
  // A run that exits: the card says it ran AND its terminal stays on screen; the user's own ▶ focused it.
  {
    const { ctx, page, errors } = await open('mac', 'light', 1440, 'idle', 'exit');
    await run(page).click();
    await page.locator('.chat-runterm').waitFor();
    ok('Mac: the terminal the user opened takes the keyboard', await page.waitForFunction(() => !!document.activeElement?.closest('.chat-runterm'), null, { timeout: 3000 }).then(() => true, () => false));
    await page.locator('.chat-runcard[data-phase="done"]').waitFor({ timeout: 5000 });
    await sleep(300);
    ok('Mac: a finished run keeps its terminal on screen', (await page.locator('.chat-runterm').count()) === 1);
    ok('Mac: …with its exit code', (await page.locator('.chat-runcard-exit').innerText()) === 'exit 0');
    shots.push(join(OUT, 'flow-mac-exited.png'));
    await page.screenshot({ path: shots[shots.length - 1], fullPage: true });
    for (const e of errors) findings.push(`flow-exit console: ${e}`);
    await ctx.close();
  }
  // Replaced by a newer copy: neither card claims it ran or was saved.
  for (const host of ['mac', 'phone']) {
    const { ctx, page, errors } = await open(host, 'light', 390, 'superseded');
    const runText = await page.locator('.chat-runcard').innerText();
    ok(`${host}: a replaced run card never says it ran`, !/Ran in chat|Finished|exit 0/.test(runText) && runText.includes('newer copy'), runText.slice(0, 160));
    ok(`${host}: …and offers nothing to run`, (await page.locator('.chat-runcard-play').count()) === 0);
    const secretText = await page.locator('.chat-secretcard').innerText();
    ok(`${host}: a replaced secret card never says it was saved`, !/Already saved/.test(secretText) && secretText.includes('Nothing was saved'), secretText.slice(0, 160));
    for (const e of errors) findings.push(`flow-superseded-${host} console: ${e}`);
    await ctx.close();
  }
  // No record: Copy only.
  {
    const { ctx, page, errors } = await open('mac', 'light', 1440, 'unrecorded');
    ok('an unrecorded card has no Run button', (await page.locator('.chat-runcard-play').count()) === 0);
    ok('…and keeps Copy', (await page.locator('.chat-runcard-copy').count()) === 1);
    for (const e of errors) findings.push(`flow-unrecorded console: ${e}`);
    await ctx.close();
  }
  // Secret on the phone: the record goes with the value's POST.
  {
    const { ctx, page, errors } = await open('phone', 'light', 390, 'idle');
    await page.locator('.chat-secretcard input').first().fill('sk_test_fixture_value_12');
    await page.locator('.chat-secretcard-foot .chat-btn').click();
    await page.locator('.chat-secretcard[data-phase="saved"]').waitFor({ timeout: 5000 });
    const posts = await page.evaluate(() => window.__posts);
    ok('the phone secret POST names the record', posts.length === 1 && posts[0].sessionId === '11111111-2222-4333-8444-555555555555' && posts[0].cardRef === 'b'.repeat(32), JSON.stringify(posts).replace(/sk_test_[^"]*/, 'sk_test_…'));
    shots.push(join(OUT, 'flow-phone-secret-saved.png'));
    await page.screenshot({ path: shots[shots.length - 1], fullPage: true });
    for (const e of errors) findings.push(`flow-secret console: ${e}`);
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
