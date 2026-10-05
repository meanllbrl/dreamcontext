#!/usr/bin/env node
/**
 * Hands-free mode, the LAPTOP UI (wave 3 lane G), driven end to end:
 *
 *   U1  home, set up: the chrome button, the go sheet's step 1 from the real
 *       `GET /api/handsfree/preflight` (scope table + estimate, Go enabled), nothing started;
 *   U2  home, NOT set up: the sheet disables Go with the reason and offers the setup run card;
 *   U3  returning with a return journal that already wrote: the banner offers EXACTLY Resume +
 *       Roll back (no Abandon) on two different pages; Roll back asks in the page first;
 *   U4  the receipt from Settings → GitHub (last trip): repos, files, sessions, finalization, and
 *       the auto-exec diff rendered as PLAIN TEXT (a `<script>` in the diff stays text);
 *   U5  away: the banner says the project is on the cloud machine with Return; the button
 *       brings the banner forward; "Show link" opens the link view with a QR of the URL only.
 *
 *   npm run build && node scripts/verify/handsfree-ui.mjs
 *
 * The real dashboard server (`dist/index.js dashboard`) runs against an isolated scratch HOME
 * and vault; trip states are seeded as the files the laptop itself writes
 * (`~/.dreamcontext/handsfree/{config,state}.json`, `trips/<trip>/…`), so every surface reads
 * them through the real routes. No GitHub token exists in the scratch HOME: nothing can reach
 * GitHub, and the status reports that as a warning. The desktop bridge is faked with
 * `__TAURI_INTERNALS__` (the button and the card are desktop-only).
 *
 * Collect, don't fail fast: every check prints ✓/✗; exit 0 iff all passed. Screenshots go to
 * tmp/develop/<task>/w3-G-shots/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASK = 'hands-free-mode-moves-the-active-project-to-a-cloud-machine-the-phone-drives-it-through-a-link-and-password-and-return-brings-every-diff-and-session-back-to-the-laptop';
const SHOTS = join(REPO, 'tmp', 'develop', TASK, 'w3-G-shots');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-handsfree-ui');
const HOME = join(SCRATCH, 'home');
const PROJ = join(HOME, 'projects', 'proj');
const HF = join(HOME, '.dreamcontext', 'handsfree');
const TRIP = 't-20261004-0a1b2c3d';
const URL_CLOUD = 'https://fake-hf-1-8080.app.github.dev';
const FIXTURE = join(REPO, 'scripts', 'verify', 'fixtures', 'handsfree-ui', 'receipt.json');

const results = [];
const report = {
  check(name, ok, evidence = '') {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? '✓' : '✗'} ${name}${!ok && evidence ? `\n    evidence: ${String(evidence).slice(0, 400)}` : ''}`);
  },
  note(s) { console.log(`  ${s}`); },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const writeJson = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); };

function config(over = {}) {
  return {
    version: 1,
    laptopId: 'lp-verify0000000001',
    machine: 'basicLinux32gb',
    owner: 'verify-user',
    repo: { fullName: 'verify-user/dreamcontext-handsfree', fileShas: {} },
    codespace: { name: 'fake-hf-1', machine: 'basicLinux32gb', url: URL_CLOUD, webUrl: 'https://github.com/codespaces/fake-hf-1', retentionExpiresAt: null },
    verifier: { push: { generation: 3 }, confirmed: 2, pending: { kind: 'revoke', generation: 3, since: '2026-10-04T08:00:00.000Z' } },
    uptime: { period: '2026-10', coreMinutes: 240, runningSince: null },
    budgetCoreMinutes: 7200,
    tripEstimateHours: 4,
    queued: null,
    lastTrip: null,
    ...over,
  };
}

function seed(kind) {
  rmSync(HF, { recursive: true, force: true });
  mkdirSync(HF, { recursive: true });
  if (kind === 'not-setup') return;
  if (kind === 'home') { writeJson(join(HF, 'config.json'), config()); return; }
  const dir = join(HF, 'trips', TRIP);
  mkdirSync(dir, { recursive: true });
  const roots = [{ rootId: 'r-proj', path: PROJ }];
  if (kind === 'away') {
    writeJson(join(HF, 'config.json'), config({ lastTrip: { tripId: TRIP, status: 'away', at: '2026-10-04T08:00:00.000Z' } }));
    writeJson(join(HF, 'state.json'), { version: 1, phase: 'away', tripId: TRIP, roots, updatedAt: new Date().toISOString() });
    return;
  }
  // returning, with a return journal whose first write op already ran: only Resume / Roll back.
  writeJson(join(HF, 'config.json'), config({
    lastTrip: { tripId: TRIP, status: 'away', at: '2026-10-04T08:00:00.000Z' },
    queued: { tripId: TRIP, epoch: 4, steps: ['stop'], since: '2026-10-04T09:31:00.000Z' },
  }));
  writeJson(join(HF, 'state.json'), { version: 1, phase: 'returning', tripId: TRIP, roots, updatedAt: new Date().toISOString() });
  writeJson(join(dir, 'return-journal.json'), {
    version: 1, trip: TRIP, direction: 'return', createdAt: '2026-10-04T09:20:00.000Z',
    ops: [
      { id: 'files.apply:r-proj', kind: 'files.apply', params: {}, writes: true, state: 'done' },
      { id: 'session.merge:r-proj', kind: 'session.merge', params: {}, writes: true, state: 'pending' },
    ],
  });
  copyFileSync(FIXTURE, join(dir, 'receipt.json'));
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'core'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'core', '0.soul.md'), '# proj\n\nA scratch vault for the hands-free UI check.\n');
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
  mkdirSync(SHOTS, { recursive: true });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', DREAMCONTEXT_PARENT_PID: String(process.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = join(SCRATCH, 'server.log');
  srv.stdout.on('data', (d) => writeFileSync(log, d, { flag: 'a' }));
  srv.stderr.on('data', (d) => writeFileSync(log, d, { flag: 'a' }));
  srv.on('exit', (code, sig) => writeFileSync(log, `\n[server exited code=${code} signal=${sig}]\n`, { flag: 'a' }));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function openProject(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  await page.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  return page;
}

const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const until = async (page, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
  return false;
};

let server = null;
let browser = null;
try {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`· real dashboard server on ${port}, scratch HOME ${HOME}`);
  server = await startServer(port);
  browser = await chromium.launch();

  // ── U1: home, set up ────────────────────────────────────────────────────────────
  console.log('\n── U1: home → button → sheet step 1 (preflight)');
  seed('home');
  const p1 = await openProject(browser, base);
  const btn = p1.getByTestId('hf-button');
  report.check('the chrome shows the hands-free button (desktop, active vault)', await until(p1, async () => (await btn.count()) > 0));
  report.check('no trip banner at home', (await p1.getByTestId('hf-banner').count()) === 0);
  const preflightResp = p1.waitForResponse((r) => r.url().includes('/api/handsfree/preflight'), { timeout: 20_000 });
  await btn.click();
  const pre = await preflightResp.catch(() => null);
  const preBody = pre ? await pre.json().catch(() => null) : null;
  report.check('the sheet calls GET /api/handsfree/preflight for the active vault (200)', pre?.status() === 200, pre ? `${pre.status()} ${JSON.stringify(preBody)}` : 'no request');
  const step1 = p1.getByTestId('hf-step-scope');
  report.check('step 1 shows the scope table with the vault and an estimate',
    await until(p1, async () => (await step1.locator('.hf-table').count()) > 0)
      && (await step1.locator('.hf-table tbody').innerText()).includes(PROJ)
      && /\d/.test(await p1.getByTestId('hf-total').innerText()));
  report.check('the preflight answered a machine estimate and no refusal', preBody?.machine?.name === 'basicLinux32gb' && preBody?.refusal === null, JSON.stringify(preBody));
  report.check('the GitHub warning (no token in this HOME) is shown, not hidden',
    preBody?.warnings?.length > 0 && (await step1.locator('.hf-warning').count()) > 0);
  report.check('Go is enabled when the preflight does not refuse', await p1.getByTestId('hf-go').isEnabled());
  await shot(p1, 'U1-sheet-step1-preflight');
  const tripState = (() => { try { return JSON.parse(readFileSync(join(HF, 'state.json'), 'utf8')).phase; } catch { return 'home (no state file)'; } })();
  report.check('opening the sheet started nothing (the laptop is still home)', tripState.startsWith('home'), tripState);
  await p1.keyboard.press('Escape');
  report.check('Esc closes the sheet', await until(p1, async () => (await p1.getByTestId('hf-sheet').count()) === 0, 3000));
  await p1.close();

  // ── U2: not set up ──────────────────────────────────────────────────────────────
  console.log('\n── U2: not set up → Go disabled with the reason + setup run card');
  seed('not-setup');
  const p2 = await openProject(browser, base);
  await p2.getByTestId('hf-button').click();
  const refusal = p2.getByTestId('hf-refusal');
  report.check('the sheet names the refusal (not_setup)', await until(p2, async () => (await refusal.count()) > 0) && (await refusal.getAttribute('data-code')) === 'not_setup');
  report.check('Go is disabled', !(await p2.getByTestId('hf-go').isEnabled()));
  report.check('the setup run card offers `dreamcontext handsfree setup`', (await refusal.locator('.chat-runcard-cmd').innerText()).trim() === 'dreamcontext handsfree setup');
  await shot(p2, 'U2-sheet-not-setup');
  await p2.close();

  // ── U3: returning, write started ────────────────────────────────────────────────
  console.log('\n── U3: returning (a return write happened) → banner with exactly Resume + Roll back, on two pages');
  seed('returning');
  const p3 = await openProject(browser, base);
  const banner = p3.getByTestId('hf-banner');
  report.check('the banner shows on the first page', await until(p3, async () => (await banner.count()) > 0));
  const offers = async () => ({
    resume: await banner.getByTestId('hf-resume').count(),
    rollback: await banner.getByTestId('hf-rollback').count(),
    abandon: await banner.getByTestId('hf-abandon').count(),
    ret: await banner.getByTestId('hf-return').count(),
  });
  const o1 = await offers();
  report.check('it offers exactly Resume and Roll back (no Abandon, no Return)', o1.resume === 1 && o1.rollback === 1 && o1.abandon === 0 && o1.ret === 0, JSON.stringify(o1));
  report.check('the queued cloud step rides as a quiet line', (await banner.innerText()).includes('stop'));
  await shot(p3, 'U3-banner-page1');
  await banner.getByTestId('hf-rollback').click();
  report.check('Roll back asks in the page first (no browser dialog)', (await banner.getByTestId('hf-rollback-confirm').count()) === 1);
  await banner.getByRole('button', { name: 'Cancel' }).click();
  await p3.locator('.sidebar-item', { hasText: /^Settings$/ }).first().click();
  await p3.waitForTimeout(800);
  await p3.locator('.settings-nav-item', { hasText: /^GitHub/ }).first().click();
  await p3.waitForTimeout(800);
  report.check('the banner is still there on a second page (Settings)', (await banner.count()) > 0 && (await p3.locator('.settings-nav').count()) > 0);
  await shot(p3, 'U3-settings-github-section');
  const card = p3.getByTestId('hf-settings');
  report.check('the Settings card shows setup, phase and the pending verifier',
    await until(p3, async () => (await card.count()) > 0)
      && (await p3.getByTestId('hf-settings-phase').innerText()).includes(TRIP)
      && (await p3.getByTestId('hf-settings-verifier').innerText()).includes('generation 3'));
  report.check('the Settings card has run cards for setup, password, account-login --all, teardown',
    (await card.locator('.chat-runcard-cmd').allInnerTexts()).join('|') === 'dreamcontext handsfree setup|dreamcontext handsfree password|dreamcontext handsfree account-login --all|dreamcontext handsfree teardown');
  report.check('"Sign out every phone" is offered', (await card.getByTestId('hf-revoke-all').count()) === 1);
  await card.scrollIntoViewIfNeeded();
  await shot(p3, 'U3-banner-page2-settings');

  // ── U4: the receipt ─────────────────────────────────────────────────────────────
  console.log('\n── U4: receipt from Settings (last trip): auto-exec diff as plain text');
  await card.getByTestId('hf-settings-receipt').click();
  const rec = p3.getByTestId('hf-receipt');
  report.check('the receipt opens', await until(p3, async () => (await rec.count()) > 0));
  const recText = await rec.innerText();
  report.check('it lists repos with outcome, branches, conflicts and parked refs',
    recText.includes('/Users/sample/projects/acme-app') && recText.includes('Parked') && recText.includes('refs/heads/feature/onboarding')
      && recText.includes('src/config.ts') && recText.includes('refs/handsfree/t-20261004-0a1b2c3d/heads/main'));
  report.check('files: secret NAMES, not-returned, deleted-on-the-phone, refused',
    recText.includes('.env') && recText.includes('.env.local') && recText.includes('drafts/scratch.md') && recText.includes('_dream_context/state/.secrets.json'));
  report.check('sessions and the finalization are shown', recText.includes('Phone: fix login') && (await p3.getByTestId('hf-finalization').innerText()).includes('queued: stop'));
  const diff = rec.getByTestId('hf-autoexec-diff');
  const diffText = await diff.textContent();
  report.check('the auto-exec diff is plain text in a <pre> (the <script> and <b> stay literal)',
    (await diff.evaluate((el) => el.tagName)) === 'PRE' && diffText.includes("<script>alert('x')</script><b>bold</b>")
      && (await diff.locator('script, b').count()) === 0);
  report.check('the receipt offers Resume / Roll back while this trip is returning',
    (await rec.getByRole('button', { name: 'Resume' }).count()) === 1 && (await rec.getByTestId('hf-receipt-rollback').count()) === 1);
  await shot(p3, 'U4-receipt');
  await p3.keyboard.press('Escape');
  await p3.close();

  // ── U5: away ────────────────────────────────────────────────────────────────────
  console.log('\n── U5: away → banner + Return; button brings the banner forward; Show link → QR of the URL');
  seed('away');
  const p5 = await openProject(browser, base);
  const b5 = p5.getByTestId('hf-banner');
  report.check('the banner says the project is on the cloud machine, with Return',
    await until(p5, async () => (await b5.count()) > 0)
      && (await b5.innerText()).includes('This project is on the cloud machine') && (await b5.getByTestId('hf-return').count()) === 1);
  report.check('away offers Abandon (two-step) beside Return', (await b5.getByTestId('hf-abandon').count()) === 1);
  report.check('the chrome button says where the project is', (await p5.getByTestId('hf-button').innerText()).includes('On the cloud machine'));
  await p5.getByTestId('hf-button').click();
  report.check('the button brings the banner forward (no second sheet)', (await p5.getByTestId('hf-sheet').count()) === 0
    && await until(p5, async () => (await b5.getAttribute('data-pulse')) !== null, 2000));
  await b5.getByRole('button', { name: 'Show link' }).click();
  const done = p5.getByTestId('hf-step-done');
  report.check('"Show link" opens the link view', await until(p5, async () => (await done.count()) > 0));
  report.check('the link is the cloud URL', (await p5.getByTestId('hf-url').innerText()).trim() === URL_CLOUD);
  const qrCells = await done.locator('svg.hf-qr rect.hf-qr-cell').count();
  report.check('a QR code is drawn offline as SVG cells', qrCells > 100, `cells=${qrCells}`);
  report.check('the passphrase is never shown, only the reminder it was shown once', (await done.innerText()).includes('shown once, at setup'));
  const cover = await p5.evaluate(() => {
    const bd = document.querySelector('.hf-backdrop');
    const bn = document.querySelector('[data-testid="hf-banner"]');
    if (!bd || !bn) return { bg: null, top: null };
    const r = bn.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
    return { bg: getComputedStyle(bd).backgroundColor, top: top === bd || bd.contains(top) ? 'backdrop' : (top?.className ?? String(top)) };
  });
  report.check('the modal\'s backdrop dims the page and covers the banner (portalled above the chrome)',
    cover.top === 'backdrop' && !!cover.bg && cover.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(cover));
  await shot(p5, 'U5-away-link-qr');
  await p5.keyboard.press('Escape');
  await p5.waitForTimeout(300);
  await shot(p5, 'U5-away-banner');
  await p5.close();
} catch (err) {
  report.check('the run completed without an exception', false, err?.stack ?? String(err));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${results.length - failed}/${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
