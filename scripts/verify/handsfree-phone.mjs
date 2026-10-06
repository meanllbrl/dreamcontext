#!/usr/bin/env node
/**
 * Hands-free PHONE side, end to end (AC3 phone part, AC4 login, AC16 service worker rules).
 *
 *   npm run build && node scripts/verify/handsfree-phone.mjs
 *   (HFPH_KEEP=1 keeps the scratch dir)
 *
 * WHAT RUNS FOR REAL
 *  - the CLOUD: the built CLI `dreamcontext cloud serve --same-uid-worker --mirror-prefix <dir>
 *    --port <n>` with DREAMCONTEXT_CLOUD=1 in a scratch HOME, its dcserver dir holding a
 *    bootstrap verifier (generation 1, scrypt hash of a generated passphrase, made by the real
 *    `hashPassphrase`) and a trip record in phase active;
 *  - the LAPTOP's push: revoke-all goes over the real bearer channel (`HttpCloudClient`,
 *    HMAC over the server nonce), exactly as `handsfree devices revoke --all` sends it;
 *  - the PHONE: Chromium with Playwright's iPhone 13 profile (viewport, touch, mobile UA) on
 *    http://localhost:<n> (a secure context, so the __Host- cookie and the service worker work).
 *
 * "The machine is asleep" is this server process stopped (connection refused: the network-error
 * leg of the SW rule); "it wakes" is the same server started again on the same port.
 * Sealed is the trip record rewritten to phase sealed between a stop and a start.
 *
 * Every check prints PASS/FAIL with evidence; exit 0 iff all passed. Screenshots go to
 * tmp/develop/<task>/w3-H-shots/. Never touches the real ~/.dreamcontext.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASK = 'hands-free-mode-moves-the-active-project-to-a-cloud-machine-the-phone-drives-it-through-a-link-and-password-and-return-brings-every-diff-and-session-back-to-the-laptop';
const SHOTS = join(REPO, 'tmp', 'develop', TASK, 'w3-H-shots');
const SCRATCH = join(REPO, 'tmp', 'develop', TASK, 'w3-H-run');
const HOME = join(SCRATCH, 'home');
const SERVER_DIR = join(SCRATCH, 'dc-server');
const PUBLIC_DIR = join(SCRATCH, 'dc-server-pub');
const MIRROR = join(SCRATCH, 'mirror');
/** The laptop path of the trip's project, and where the cloud keeps it (the --mirror-prefix seam). */
const VAULT = join(HOME, 'projects', 'phone-verify');
const M = (p) => join(MIRROR, p);
const rootIdFor = (p) => 'r-' + createHash('sha256').update(p).digest('hex').slice(0, 16);
const CLI = join(REPO, 'dist', 'index.js');

// ─── reporting ──────────────────────────────────────────────────────────────

const results = [];
function check(name, ok, evidence) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `\n        ${String(evidence).split('\n').join('\n        ')}` : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch { /* page navigating */ }
    await sleep(stepMs);
  }
  return last;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** Run a TS snippet against the repo's own src (tsx), returning its JSON stdout. */
function tsx(code) {
  const file = join(SCRATCH, `snippet-${randomBytes(4).toString('hex')}.mts`);
  writeFileSync(file, code);
  const r = spawnSync('npx', ['--no-install', 'tsx', file], { cwd: REPO, encoding: 'utf8', timeout: 120_000 }); // pure helpers: they read and write no home state
  rmSync(file, { force: true });
  if (r.status !== 0) throw new Error(`tsx failed (${r.status ?? r.signal ?? r.error}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// ─── scratch cloud ──────────────────────────────────────────────────────────

const PASSPHRASE = 'orbit maple velvet canyon pickle lantern';
const TRANSFER_SECRET = randomBytes(32).toString('hex');
let PORT = 0;
let ORIGIN = '';
let server = null;
let serverLog = '';

function writeTrip(phase) {
  const now = Date.now();
  writeFileSync(join(SERVER_DIR, 'cloud-trip.json'), JSON.stringify({
    version: 1, phase, epoch: 1, tripId: 'phone-verify', laptopId: 'laptop-verify', supersededLaptopIds: [],
    // The go manifest as the laptop sends it: the active vault first. The server reads the
    // trip's chat from this (and adopts the mirrored home as its HOME), never from a request.
    go: { version: 1, tripId: 'phone-verify', laptopId: 'laptop-verify', createdAt: new Date(now).toISOString(), home: HOME,
      roots: [{ rootId: rootIdFor(VAULT), kind: 'vault', absPath: VAULT }] },
    rootIds: [rootIdFor(VAULT)], goingSince: null, quiescingSince: null, servedEpoch: null, sealedEpoch: phase === 'sealed' ? 1 : null,
    noRevert: false, sealBlocked: null, lastLaptopProgressAt: null, updatedAt: now,
  }, null, 2));
}

async function startServer() {
  const env = {
    // A stub `claude` first on PATH (no tokens spent; the chat only needs the CLI to exist).
    PATH: [join(SCRATCH, 'bin'), process.env.PATH].join(':'), HOME, LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp',
    DREAMCONTEXT_CLOUD: '1', DC_HF_SERVER_DIR: SERVER_DIR, DC_HF_PUBLIC_DIR: PUBLIC_DIR, DC_HF_ORIGIN: ORIGIN,
    DREAMCONTEXT_AUTO_DASHBOARD: '0',
  };
  server = spawn(process.execPath, [CLI, 'cloud', 'serve', '--same-uid-worker', '--mirror-prefix', MIRROR, '--port', String(PORT)], { cwd: SCRATCH, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => { serverLog += c; });
  server.stderr.on('data', (c) => { serverLog += c; });
  const up = await waitFor(async () => {
    const r = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.headers.get('x-dreamcontext-cloud') === '1';
  }, 60_000, 300);
  if (!up) throw new Error(`cloud serve did not come up:\n${serverLog.slice(-2000)}`);
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  const gone = new Promise((r) => s.once('exit', r));
  s.kill('SIGTERM');
  const t = setTimeout(() => s.kill('SIGKILL'), 5000);
  await gone;
  clearTimeout(t);
  await waitFor(async () => { try { await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }, 10_000);
}

async function prepare() {
  if (!existsSync(CLI)) throw new Error('dist/index.js missing: run npm run build first');
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [HOME, SERVER_DIR, PUBLIC_DIR, MIRROR, M(join(VAULT, '_dream_context', 'state')), M(join(HOME, '.dreamcontext')), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(M(join(VAULT, '_dream_context', '0.soul.md')), '---\nname: phone-verify\ntype: soul\n---\n\nA fictional project for the phone verify.\n');
  // The mirrored home's registry (what go carries), pointed at the mirror copy as in lane I's seam.
  writeFileSync(M(join(HOME, '.dreamcontext', 'vaults.json')), JSON.stringify({ vaults: [{ name: 'phone-verify', path: M(VAULT) }] }, null, 2));
  const verifier = tsx(`import { hashPassphrase } from ${JSON.stringify(join(REPO, 'src/server/handsfree-auth.ts'))};
console.log(JSON.stringify(await hashPassphrase(${JSON.stringify(PASSPHRASE)})));`);
  writeFileSync(join(SERVER_DIR, 'bootstrap-verifiers.json'), JSON.stringify({
    generation: 1, passphrase: verifier, transferSha256: createHash('sha256').update(TRANSFER_SECRET).digest('hex'),
  }));
  mkdirSync(join(SCRATCH, 'bin'), { recursive: true });
  // Lane I's inert stream-json stand-in (read, never edited): a live session, no tokens.
  writeFileSync(join(SCRATCH, 'bin', 'claude'), readFileSync(join(REPO, 'scripts', 'verify', 'handsfree-roundtrip', 'stub-claude.cjs'), 'utf8')
    .replace('__MIRROR__', MIRROR).replace('__SPAWN_LOG__', join(SCRATCH, 'spawns.log')), { mode: 0o755 });
  writeTrip('active');
  PORT = await freePort();
  ORIGIN = `http://localhost:${PORT}`;
}

/** The laptop's revoke-all, over the real bearer channel. */
function revokeAll(generation) {
  return tsx(`import { HttpCloudClient } from ${JSON.stringify(join(REPO, 'src/lib/handsfree/cloud-client.ts'))};
const c = new HttpCloudClient({ origin: ${JSON.stringify(ORIGIN)}, secret: ${JSON.stringify(TRANSFER_SECRET)}, attempts: 3 });
console.log(JSON.stringify(await c.revokeAll(${generation})));`);
}

// ─── the phone ──────────────────────────────────────────────────────────────

const swState = (page) => page.evaluate(async () => {
  const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
  const keys = window.caches ? await caches.keys() : [];
  return {
    registrations: regs.map((r) => (r.active || r.waiting || r.installing)?.scriptURL ?? '(none)'),
    controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
    caches: keys,
  };
});

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The chat composer, after closing the What's New popup if it covers the chat and opening a
 *  chat when the project has none yet (a fresh project shows "Start chat"). */
async function composerVisible(page) {
  return waitFor(async () => {
    const gotIt = page.getByRole('button', { name: 'Got it' });
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click().catch(() => null);
    const start = page.getByRole('button', { name: /Start chat/ });
    if (await start.first().isVisible().catch(() => false)) await start.first().click().catch(() => null);
    return page.locator('.chat-cmp-input').first().isVisible();
  }, 60_000, 700);
}

async function signIn(page, pass) {
  await page.fill('#p', pass);
  await page.click('#go');
}

async function main() {
  await prepare();
  await startServer();
  console.log(`cloud serve up at ${ORIGIN} (scratch ${SCRATCH})`);

  const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...iphone, locale: 'en-US', serviceWorkers: 'allow' });
  const page = await context.newPage();

  try {
    // 1. Signed out: / lands on /login.
    await page.goto(`${ORIGIN}/`);
    await page.waitForURL(/\/login$/, { timeout: 30_000 });
    const loginOk = await page.locator('#p').isVisible();
    const attrs = await page.locator('#p').evaluate((el) => ({ ac: el.getAttribute('autocomplete'), cap: el.getAttribute('autocapitalize'), sc: el.getAttribute('spellcheck') }));
    await shot(page, '01-login');
    check('signed-out / -> /login (standalone page, one hardened field)', loginOk && attrs.ac === 'off' && attrs.cap === 'off' && attrs.sc === 'false', `${page.url()} ${JSON.stringify(attrs)}`);
    const noSwYet = await swState(page);
    check('no service worker before sign-in', noSwYet.registrations.length === 0, JSON.stringify(noSwYet));

    // 2. Wrong passphrase: an honest error, still on /login.
    await signIn(page, 'wrong words entirely here now please');
    const wrongMsg = await waitFor(async () => {
      const t = await page.locator('#m').textContent();
      return t && t.includes('not right') ? t : null;
    }, 30_000);
    await shot(page, '02-wrong-passphrase');
    check('wrong passphrase -> error, stays on /login', !!wrongMsg && page.url().endsWith('/login'), wrongMsg);

    // 3. Right passphrase: the chat with the chip.
    await signIn(page, PASSPHRASE);
    await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    // AC3: the login opens Chat. Its redirect goes to '/', which the cloud sends on to the
    // trip's project chat; no '?vault=' is typed here.
    await page.waitForURL((u) => u.searchParams.get('vault') === 'phone-verify', { timeout: 30_000 });
    const landed = page.url();
    const composer = await composerVisible(page);
    const chip = await waitFor(async () => (await page.locator('.dc-hf-chip').first().isVisible()) && (await page.locator('.dc-hf-chip').first().textContent()), 45_000);
    await shot(page, '03-chat-with-chip');
    check('right passphrase -> / -> the trip\'s chat (composer visible) with the chip ("Cloud · sleeps at HH:MM")', !!composer && !!chip && /^Cloud · sleeps at \d{2}:\d{2}$/.test(chip), `landed=${landed} composer=${!!composer} chip=${JSON.stringify(chip)}`);
    const direct = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    const directComposer = await composerVisible(page);
    check('a signed-in navigation to / opens the trip\'s chat, not the launcher', new URL(page.url()).searchParams.get('vault') === 'phone-verify' && !!directComposer,
      `url=${page.url()} status=${direct?.status()} composer=${!!directComposer}`);
    const phone = await page.evaluate(async () => { const r = await fetch('/api/handsfree/phone', { cache: 'no-store' }); return { status: r.status, body: await r.json() }; });
    check('GET /api/handsfree/phone answers { phase, stopAt } to the signed-in phone', phone.status === 200 && phone.body.phase === 'active' && typeof phone.body.stopAt === 'string' && !Number.isNaN(Date.parse(phone.body.stopAt)), JSON.stringify(phone));

    // 4. The service worker registers and controls the page.
    const sw = await waitFor(async () => {
      const s = await swState(page);
      return s.controller && s.controller.endsWith('/handsfree-sw.js') && s.caches.some((k) => k.startsWith('dc-hf-offline-')) ? s : null;
    }, 45_000, 500);
    check('SW registered (scope /), controlling, offline page cached', !!sw, JSON.stringify(sw ?? await swState(page)));

    // 5. The machine stops: the SW shows the cached offline page (after its retries).
    await stopServer();
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null);
    const offline = await waitFor(async () => {
      const h = await page.locator('h1#h').textContent({ timeout: 1000 });
      return h ? h : null;
    }, 30_000);
    const firstHeading = offline;
    const asleep = await waitFor(async () => {
      const h = await page.locator('h1#h').textContent({ timeout: 1000 });
      return h && h.includes('asleep') ? h : null;
    }, 30_000);
    const wakeHref = await page.locator('#wake').getAttribute('href').catch(() => null);
    const wakeTarget = await page.locator('#wake').getAttribute('target').catch(() => null);
    const step3 = await page.locator('#step3').textContent().catch(() => null);
    await shot(page, '04-offline-asleep');
    check('server stopped -> SW serves the cached offline page (checking, then asleep)', !!firstHeading && !!asleep,
      `first="${firstHeading}" then="${asleep}" after ${Date.now() - t0} ms; url=${page.url()}`);
    check('offline page: Wake link in a new tab + "come back to this tab"', !!wakeHref && wakeTarget === '_blank' && /THIS tab/.test(step3 ?? ''),
      `href=${wakeHref} target=${wakeTarget} step3="${step3}"`);

    // 6. The machine starts again: the tab returns to the app by itself.
    await startServer();
    const back = await waitFor(async () => (await page.locator('.dc-hf-chip').first().isVisible()) ? page.url() : null, 60_000, 500);
    await shot(page, '05-back-by-itself');
    check('server started again -> the offline page returns to the chat by itself', !!back, `url=${back ?? page.url()}`);

    // 7. Revoke-all from the laptop: the next navigation lands on /login?revoked=1 and the SW is gone.
    const rv = revokeAll(2);
    check('laptop revoke-all over the bearer channel', rv && rv.ok === true, JSON.stringify(rv));
    await page.goto(`${ORIGIN}/`, { timeout: 60_000 });
    await page.waitForURL(/\/login\?revoked=1$/, { timeout: 30_000 });
    const revokedText = await page.locator('main p').first().textContent();
    const afterRevoke = await waitFor(async () => { const s = await swState(page); return s.registrations.length === 0 && !s.caches.some((k) => k.startsWith('dc-hf-')) ? s : null; }, 15_000);
    await shot(page, '06-revoked');
    check('revoke-all -> /login?revoked=1, signed-out copy, SW unregistered and cache gone', !!afterRevoke && /signed out/.test(revokedText ?? ''),
      `url=${page.url()} text="${revokedText}" sw=${JSON.stringify(afterRevoke ?? await swState(page))}`);

    // 3b. Smoke #3 (AC16): a phone that signs in but never reaches the chat (the launcher: no
    // cloud chip ever mounts) must still get the offline worker, or a later self-stop shows the
    // browser's own error page instead of Wake. The SPA's scripts are blocked for this phone,
    // so only the login page itself can have registered the worker.
    const bare = await browser.newContext({ ...iphone, locale: 'en-US', serviceWorkers: 'allow' });
    const bp = await bare.newPage();
    let blocked = 0;
    await bp.route('**/assets/**', (r) => { blocked++; return r.abort(); });
    await bp.goto(`${ORIGIN}/login`);
    await signIn(bp, PASSPHRASE);
    await bp.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
    const bareSw = await waitFor(async () => {
      const st = await swState(bp);
      return st.registrations.some((u) => u.endsWith('/handsfree-sw.js')) && st.caches.some((k) => k.startsWith('dc-hf-offline-')) ? st : null;
    }, 45_000, 500);
    await shot(bp, '03b-no-chat-still-sw');
    check('a sign-in that never reaches the chat (SPA blocked) still installs the SW and caches the offline page', !!bareSw && blocked > 0,
      `blockedAssets=${blocked} sw=${JSON.stringify(bareSw ?? await swState(bp))}`);
    await bare.close();

    // 8. Sign in again (the SW comes back), then the laptop seals the cloud.
    await signIn(page, PASSPHRASE);
    await page.waitForURL((u) => u.searchParams.get('vault') === 'phone-verify', { timeout: 30_000 });
    const swAgain = await waitFor(async () => { const s = await swState(page); return s.controller ? s : null; }, 45_000, 500);
    check('signing in again registers the SW again', !!swAgain, JSON.stringify(swAgain ?? await swState(page)));
    await stopServer();
    writeTrip('sealed');
    await startServer();
    await page.goto(`${ORIGIN}/`, { timeout: 60_000 });
    const sealedText = await waitFor(async () => { const t = await page.locator('h1').first().textContent({ timeout: 1000 }); return t && t.includes('back on your laptop') ? t : null; }, 30_000);
    const afterSeal = await waitFor(async () => { const s = await swState(page); return s.registrations.length === 0 && !s.caches.some((k) => k.startsWith('dc-hf-')) ? s : null; }, 15_000);
    await shot(page, '07-sealed');
    check('sealed -> the sealed page, SW unregistered and cache gone', !!sealedText && !!afterSeal,
      `h1="${sealedText}" sw=${JSON.stringify(afterSeal ?? await swState(page))}`);
    const api = await page.evaluate(async () => { const r = await fetch('/api/agent/chat-history', { cache: 'no-store' }); return { status: r.status, type: r.headers.get('content-type') }; });
    check('sealed: an API call still gets the JSON answer, not the page', api.type?.includes('application/json') && api.status >= 400, JSON.stringify(api));

    // 9. TR copy for a Turkish phone.
    const tr = await browser.newContext({ ...iphone, locale: 'tr-TR' });
    const trPage = await tr.newPage();
    await trPage.goto(`${ORIGIN}/login`);
    const trText = await trPage.locator('h1').first().textContent();
    await shot(trPage, '08-sealed-tr');
    check('a Turkish phone gets the TR page', /laptopuna döndü|Bulut projene/.test(trText ?? ''), trText);
    await tr.close();
  } finally {
    await browser.close();
    await stopServer();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nhandsfree-phone: ${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`screenshots: ${SHOTS}`);
  if (!process.env.HFPH_KEEP) rmSync(SCRATCH, { recursive: true, force: true });
  if (failed.length) {
    console.log(`server log tail:\n${serverLog.slice(-3000)}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  console.log(`server log tail:\n${serverLog.slice(-3000)}`);
  await stopServer().catch(() => {});
  process.exit(1);
});
