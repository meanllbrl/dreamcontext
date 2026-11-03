#!/usr/bin/env node
/**
 * Settings > Claude accounts: "Keep for my chats only" explains itself, and a list where every
 * account is kept that way warns, with a one-click fix (owner, 2026-11-03).
 *
 *   npm run build && node scripts/verify/only-mine-accounts.mjs [outDir]
 *
 * Drives the BUILT dashboard server against an isolated scratch vault (fake HOME), real Chromium,
 * 1440 light, English and Turkish. Two fictional accounts. For each locale:
 *   1. one account open: the label and its hint are visible on every row, no warning;
 *   2. both kept for the owner: the warning stands at the top of the list;
 *   3. the fix opens the top account: the warning goes, the register on disk agrees.
 * Screenshots: <outDir>/accounts-<locale>-{one-open,all-closed}.png. Exit 1 on any FAIL or
 * console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = resolve(process.argv[2] ?? join(REPO, 'tmp', 'verify-only-mine'));
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-only-mine');
rmSync(SCRATCH, { recursive: true, force: true });
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'lumen');
const DC = join(PROJ, '_dream_context');
const REGISTER = join(HOME, '.dreamcontext', 'claude-accounts.json');
const IDS = ['owner-example-test', 'team-example-test'];

const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};

function writeRegister(ownerOnly) {
  const accounts = IDS.map((id, i) => {
    const dir = join(HOME, '.dreamcontext', 'claude-accounts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${id.split('-')[0]}@example.test` } }));
    return {
      id, accountUuid: '', email: `${id.split('-')[0]}@example.test`, organizationUuid: '', organizationName: 'Lumen Notes',
      tier: 'max', configDir: dir, preferred: i === 0, ...(ownerOnly[i] ? { ownerOnly: true } : {}),
    };
  });
  writeFileSync(REGISTER, `${JSON.stringify({ accounts }, null, 2)}\n`);
}

function setupScratch() {
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(DC, 'state')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(DC, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const r = spawnSync(process.execPath, [distIndex(REPO), 'vaults', 'add', 'lumen', PROJ], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}

async function freePort() {
  const { createServer } = await import('node:net');
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server did not come up: ${log.slice(-400)}`);
}

/** The dashboard has no locale switch on screen: set it through every I18n provider's own setter
 *  (the settings window mounts its own). */
async function setLocale(page, locale) {
  return await page.evaluate((loc) => {
    const host = document.getElementById('root');
    const key = Object.keys(host).find((k) => k.startsWith('__reactContainer'));
    const stack = [host[key]];
    let n = 0;
    let found = false;
    while (stack.length && n++ < 200000) {
      const f = stack.pop();
      const v = f?.memoizedProps?.value;
      if (v && typeof v.setLocale === 'function' && typeof v.t === 'function' && 'locale' in v) { v.setLocale(loc); found = true; }
      if (f?.sibling) stack.push(f.sibling);
      if (f?.child) stack.push(f.child);
    }
    return found;
  }, locale);
}

async function main() {
  setupScratch();
  writeRegister([false, true]);
  const port = await freePort();
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const consoleErrors = [];
  const browser = await chromium.launch();
  try {
    for (const locale of ['en', 'tr']) {
      writeRegister([false, true]);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 2 });
      await setTheme(context, 'light');
      await markAnnouncementsSeen(context, base);
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${locale}: ${m.text()}`); });
      page.on('pageerror', (e) => consoleErrors.push(`${locale} pageerror: ${e.message}`));
      const wait = (ms) => page.waitForTimeout(ms);
      const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };
      const shot = async (name) => {
        const el = page.locator('.dc-accts').first();
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await wait(500);
        await el.screenshot({ path: join(SHOTS, `accounts-${locale}-${name}.png`) });
      };
      const openAccounts = async () => {
        await page.goto(`${base}/?vault=lumen&page=settings`, { waitUntil: 'domcontentloaded' });
        await wait(2000);
        for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
        check(`${locale}: locale set`, await until(() => setLocale(page, locale), 8000));
        await page.locator('[data-sw-nav="models"]').click();
        await wait(500);
        await page.locator('[data-sw-tab="claude"]').click();
        await setLocale(page, locale);
        await wait(400);
        await page.locator('[data-only-mine="team-example-test"]').waitFor({ timeout: 15000 });
        await until(async () => /could not be re-read|Updated \d+ account/.test(await page.locator('.dc-acct-foot, .settings-section').first().innerText()), 30000);
      };
      const label = locale === 'tr' ? 'Yalnız benim sohbetlerim için' : 'Keep for my chats only';
      const hint = locale === 'tr' ? 'Rutinler ve arka plan işleri bu hesabı kullanmaz.' : "Routines and background jobs won't use this account.";
      const warn = locale === 'tr' ? 'Hiçbir hesap rutinlere açık değil: rutinler başlamaz.' : 'No account is open to routines: they will not start.';

      await openAccounts();
      const listText = await page.locator('.dc-acct-list').innerText();
      check(`${locale}: every row carries the label`, listText.split(label).length - 1 === 2, label);
      check(`${locale}: every row shows the hint, not only as a tooltip`, (await page.locator('.dc-acct-onlymine-hint:visible').count()) === 2);
      check(`${locale}: …and the hint reads`, listText.includes(hint));
      check(`${locale}: one account open: no warning`, (await page.locator('[data-none-open]').count()) === 0);
      await shot('one-open');

      // Close the open one too, through the control itself.
      await page.locator('[data-only-mine="owner-example-test"]').click();
      check(`${locale}: all closed: the warning stands`, await until(() => page.locator('[data-none-open]').isVisible(), 8000));
      check(`${locale}: …in plain words`, (await page.locator('[data-none-open]').innerText()).includes(warn));
      const listBox = await page.locator('.dc-acct-list').boundingBox();
      const warnBox = await page.locator('[data-none-open]').boundingBox();
      check(`${locale}: …at the top of the list`, warnBox && listBox && warnBox.y < listBox.y);
      await shot('all-closed');

      // The one-click fix opens the top account.
      await page.locator('[data-none-open] button').click();
      check(`${locale}: the fix clears the warning`, await until(async () => (await page.locator('[data-none-open]').count()) === 0, 8000));
      const reg = JSON.parse(readFileSync(REGISTER, 'utf-8'));
      check(`${locale}: …and opens the top account on disk`, !reg.accounts[0].ownerOnly && reg.accounts[1].ownerOnly === true, JSON.stringify(reg.accounts.map((a) => !!a.ownerOnly)));
      await context.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed; screenshots in ${SHOTS}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
