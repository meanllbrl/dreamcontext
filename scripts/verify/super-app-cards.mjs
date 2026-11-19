#!/usr/bin/env node
/**
 * An app card waits on the Super Agent's screen whether or not an agent pasted its block (owner
 * 2026-11-13, onay-karti-yok: the Super said "press Onayla on the cards" and there was no card).
 *
 *   npm run build && node scripts/verify/super-app-cards.mjs        (OUT=<dir> for the shots)
 *
 * The real dashboard server from dist (scratch HOME, an owner key, a local stand-in for GitHub),
 * the real dashboard and the real CLI; `claude` is the scripted stand-in (no tokens).
 *
 *   C1  a job runs `apps publish <slug> --ask` and pastes nothing: the card opens by itself as a
 *       pop-up over the Super screen, with Onayla and Reddet (owner 2026-11-16, "bu istek pop up
 *       olarak gelsin"; shots 1440 light + dark, 390).
 *   C5  Esc closes it without deciding: the request still waits, a one-line row stays above the
 *       chat, and the pop-up does not come back by itself (shot 1440 row).
 *   C6  the row's Open brings the pop-up back.
 *   C7  a second request while one is open queues: one pop-up at a time; after the first is
 *       decided, the second opens.
 *   C2  the CLI's Shown: line names the Super Agent screen, and only once it was drawn.
 *   C3  an agent's bare decide (no owner key) is refused; the card still waits.
 *   C4  the owner's Onayla: the band says it, the card leaves, the request is approved.
 *   No console errors, no failed requests.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTheme, cleanEnv, freePort, readNd, reporter, stage, superStandin, toMainStage, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-app-cards-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const HOST = join(SCRATCH, 'host');
const CLI = process.env.CLI || join(REPO, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'verify', 'super-app-cards');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const KEY = randomBytes(32).toString('base64url');
const SLUG = 'rakip';
const SLUG2 = 'kitap';

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
    if (text.startsWith('[super')) { report({ kind: 'events', text: text.slice(0, 4000) }); return 'noted'; }
    return 'ok';`,
});

const reports = () => readNd(REPORTS);
const APPS_ENV = { DREAMCONTEXT_APPS_LOCAL_HOST: HOST, DREAMCONTEXT_APPS_LOCAL_LOGIN: 'ornek-ayse', GITHUB_TOKEN: 'verify-dummy-token', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Ayse Yilmaz', GIT_AUTHOR_EMAIL: 'ayse@ornek.co', GIT_COMMITTER_NAME: 'Ayse Yilmaz', GIT_COMMITTER_EMAIL: 'ayse@ornek.co' };
const env = (extra = {}) => cleanEnv(HOME, { ...APPS_ENV, ...extra });
const dc = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(extra), encoding: 'utf-8' });
const { ok, result, summary } = reporter();

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), HOST, OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' })],
    ['apps new', dc(['apps', 'new', SLUG, '--name', 'Rakip app'])],
    ['apps new 2', dc(['apps', 'new', SLUG2, '--name', 'Kitap app'])],
  ];
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  for (const slug of [SLUG, SLUG2]) {
    const code = join(`${PROJ}-apps`, slug);
    execFileSync('git', ['add', '-A'], { cwd: code, env: env() });
    execFileSync('git', ['commit', '-qm', 'ready', '--allow-empty'], { cwd: code, env: env() });
  }
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env({ DREAMCONTEXT_OWNER_KEY_STDIN: '1' }), PATH }, stdio: ['pipe', 'ignore', 'ignore'] });
  srv.stdin.write(`${KEY}\n`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) {
        // The CLI finds the running desktop server through this file.
        writeFileSync(join(HOME, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: srv.pid, port, launchToken: 'x'.repeat(43), appBundleId: 'com.dreamcontext.trial' }), { mode: 0o600 });
        return srv;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// The desktop shell hands the page its owner key (Tauri); the stand-in does the same.
const SHELL = `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'owner_key' ? ${JSON.stringify(KEY)} : cmd === 'confirm_dialog' ? true : null), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;

async function handOver(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await toMainStage(page);
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => reports().some((r) => r.kind === 'handover'), 90000);
}

const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

async function main() {
  setup();
  const port = await freePort();
  const server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(SHELL);
    const page = await context.newPage();
    const watch = watchPage(page, 'main');
    ok('handed over to the Super Agent', await handOver(page, base));
    await until(page, async () => (await stage(page, 'main').count()) > 0, 15000);
    await page.waitForTimeout(1500);

    // C1: a job (not the Super's own chat) asks, and pastes nothing anywhere.
    const ask = dc(['apps', 'publish', SLUG, '--ask'], { CLAUDE_CODE_SESSION_ID: 'bir-is-cocugu-1' });
    const out = `${ask.stdout}${ask.stderr}`;
    console.log(`apps publish --ask →\n${out.split('\n').map((l) => `    ${l}`).join('\n')}`);
    const request = /apps grant (\S+)/.exec(out)?.[1];
    ok('C1 the CLI opened a request', ask.status === 0 && !!request, out);
    ok('C2 its first Shown: line already names the Super Agent screen', /Shown: the card is drawn on his Super Agent screen/.test(out), out);
    const popup = page.locator('[data-testid="app-request-popup"]');
    const appCard = popup.locator('[data-view-kind="app-request"]');
    const row = stage(page, 'main').locator('[data-testid="super-approvals-top"] [data-testid="super-app-row"]');
    const waiting = async () => (await (await fetch(`${base}/api/apps/requests/waiting`, { headers: { 'X-Dreamcontext-Vault': 'acme-app' } })).json()).cards ?? [];
    ok('C1 the card opens by itself as a pop-up, with nobody pasting it', await until(page, async () => (await appCard.count()) === 1, 20000));
    ok('C1 the pop-up is a modal dialog over the window', (await popup.getAttribute('aria-modal')) === 'true' && (await popup.getAttribute('role')) === 'dialog');
    const text = await appCard.innerText();
    ok('C1 it names the app and has Onayla and Reddet', /Rakip app/.test(text) && (await appCard.getByRole('button').count()) === 2, text);
    ok('C1 the band above the chat is one line, not the card', (await row.count()) === 1 && (await stage(page, 'main').locator('[data-testid="super-approvals-top"] [data-view-kind="app-request"]').count()) === 0);
    await applyTheme(page, 'light');
    await page.waitForTimeout(500);
    await shot(page, '1440-light-popup');
    await applyTheme(page, 'dark');
    await page.waitForTimeout(300);
    await shot(page, '1440-dark-popup');
    await applyTheme(page, 'light');

    // C2
    const g = dc(['apps', 'grant', request, '--wait', '0']);
    ok('C2 Shown: names the Super Agent screen', /Shown: the card is drawn on his Super Agent screen/.test(`${g.stdout}${g.stderr}`), `${g.stdout}${g.stderr}`);

    // C3: an agent's bare decide, no owner key.
    const proposal = (await waiting())[0];
    const forged = await fetch(`${base}/api/assistant/proposals/${proposal}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'acme-app' }, body: JSON.stringify({ action: 'approve', hash: 'x' }) });
    ok('C3 an agent cannot press it (no owner key)', forged.status === 403, String(forged.status));
    ok('C3 the card still waits', (await appCard.count()) === 1);

    // 390
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    ok('390 no horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    const box = await popup.boundingBox();
    ok('390 the pop-up fits the width', !!box && box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
    await shot(page, '390-light-popup');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(800);

    // C5: Esc closes it and decides nothing.
    await page.keyboard.press('Escape');
    ok('C5 Esc closes the pop-up', await until(page, async () => (await popup.count()) === 0, 5000));
    ok('C5 the stage is still open (Esc did not fold it)', (await stage(page, 'main').count()) > 0);
    ok('C5 the request still waits', (await waiting()).includes(proposal));
    ok('C5 its one-line row stays above the chat', (await row.count()) === 1 && /Rakip app/.test(await row.innerText()), await row.innerText().catch(() => ''));
    await page.waitForTimeout(3500);
    ok('C5 it does not pop up again by itself', (await popup.count()) === 0);
    await shot(page, '1440-light-row');

    // C6: the row's Open brings it back.
    await row.getByRole('button').click();
    ok('C6 the row reopens the pop-up', await until(page, async () => (await appCard.count()) === 1, 5000));

    // C7: a second request while one is open waits its turn.
    const ask2 = dc(['apps', 'publish', SLUG2, '--ask'], { CLAUDE_CODE_SESSION_ID: 'bir-is-cocugu-2' });
    const request2 = /apps grant (\S+)/.exec(`${ask2.stdout}${ask2.stderr}`)?.[1];
    ok('C7 a second request is opened', ask2.status === 0 && !!request2, `${ask2.stdout}${ask2.stderr}`);
    ok('C7 two rows wait above the chat', await until(page, async () => (await row.count()) === 2, 15000));
    ok('C7 still one pop-up, still the first card', (await popup.count()) === 1 && /Rakip app/.test(await appCard.innerText()));

    // C4: the owner's Onayla (after the pop-up's short guard), then the second one opens.
    await page.waitForTimeout(800);
    await appCard.getByRole('button', { name: /Onayla|Approve/ }).click();
    ok('C4 the band says it was approved', await until(page, async () => /approved|onaylandı/i.test(await page.locator('[data-testid="super-approvals-toast"]').innerText().catch(() => '')), 10000));
    const after = dc(['apps', 'grant', request, '--wait', '0']);
    ok('C4 the request is approved, with the one command to run', /owner approved it/i.test(`${after.stdout}${after.stderr}`), `${after.stdout}${after.stderr}`);
    ok('C7 the second card opens next, alone', await until(page, async () => (await popup.count()) === 1 && /Kitap app/.test(await appCard.innerText().catch(() => '')), 15000));
    await shot(page, '1440-light-second');

    ok('no console errors or failed requests', watch.errors.length === 0 && watch.failed.length === 0, [...watch.errors, ...watch.failed].join('\n'));
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    if (!process.env.KEEP) rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n${summary()}`);
  console.log(`shots: ${OUT}`);
  process.exit(result.fails.length === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(2); });
