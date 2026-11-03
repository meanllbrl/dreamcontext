#!/usr/bin/env node
/**
 * Settings > Claude accounts: "Keep for my chats only" explains itself, and a list where every
 * account is kept that way warns, with a one-click fix (owner, 2026-11-03).
 *
 *   npm run build && node scripts/verify/only-mine-accounts.mjs [outDir]
 *
 * Drives the BUILT dashboard server against an isolated scratch vault (fake HOME), real Chromium,
 * English (the product's only language), 1440 light and dark, and a narrow 760 light. The hint is
 * never louder than its label and reads at AA in both themes. Two fictional accounts. Each run:
 *   1. one account open: the label and its hint are visible on every row, inside the account's
 *      own column (no middle column of their own), nothing overflows the row; no warning;
 *   2. both kept for the owner: the warning stands at the top of the list;
 *   3. the fix opens the top account: the warning goes, the register on disk agrees.
 * Screenshots: <outDir>/accounts-en-{one-open,all-closed}.png (1440 light
 * only). Exit 1 on any FAIL or
 * console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { contrast, distIndex, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

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

async function main() {
  setupScratch();
  writeRegister([false, true]);
  const port = await freePort();
  const srv = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const consoleErrors = [];
  const browser = await chromium.launch();
  try {
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [760, 'light']]) {
      const tag = `${width}-${theme}`;
      const keepShots = width === 1440 && theme === 'light';
      writeRegister([false, true]);
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      await setTheme(context, theme);
      await markAnnouncementsSeen(context, base);
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${tag}: ${m.text()}`); });
      page.on('pageerror', (e) => consoleErrors.push(`${tag} pageerror: ${e.message}`));
      const wait = (ms) => page.waitForTimeout(ms);
      const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };
      const shot = async (name) => {
        const el = page.locator('.dc-accts').first();
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await wait(500);
        if (keepShots) await el.screenshot({ path: join(SHOTS, `accounts-en-${name}.png`) });
      };
      const openAccounts = async () => {
        await page.goto(`${base}/?vault=lumen&page=settings`, { waitUntil: 'domcontentloaded' });
        await wait(2000);
        for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
        await page.locator('[data-sw-nav="models"]').click();
        await wait(500);
        await page.locator('[data-sw-tab="claude"]').click();
        await page.locator('[data-only-mine="team-example-test"]').waitFor({ timeout: 15000 });
        await until(async () => /could not be re-read|Updated \d+ account/.test(await page.locator('.dc-acct-foot, .settings-section').first().innerText()), 30000);
      };
      const label = 'Keep for my chats only';
      const hint = "Routines and background jobs won't use this account.";
      const warn = 'No account is open to routines: they will not start.';

      await openAccounts();
      const listText = await page.locator('.dc-acct-list').innerText();
      check(`${tag}: every row carries the label`, listText.split(label).length - 1 === 2, label);
      check(`${tag}: every row shows the hint, not only as a tooltip`, (await page.locator('.dc-acct-onlymine-hint:visible').count()) === 2);
      check(`${tag}: …and the hint reads`, listText.includes(hint));
      const ink = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
      check(`${tag}: the hint is the label's colour, never louder`, (await ink('.dc-acct-onlymine-hint')) === (await ink('.dc-acct-onlymine span')), `${await ink('.dc-acct-onlymine-hint')} vs ${await ink('.dc-acct-onlymine span')}`);
      const ratio = await contrast(page.locator('.dc-acct-onlymine-hint').first());
      check(`${tag}: the hint reads at AA`, ratio >= 4.5, ratio.toFixed(2));
      // Compact: the control lives in the account's own column; the right side keeps only the
      // arrows and Remove; nothing in a row is wider than the row.
      check(`${tag}: the control sits in the account's column`, (await page.locator('.dc-acct-main .dc-acct-onlymine-row').count()) === 2 && (await page.locator('.dc-acct-side [data-only-mine]').count()) === 0);
      const geo = await page.locator('.dc-acct-list > li').evaluateAll((lis) => lis.map((li) => {
        const box = li.getBoundingClientRect();
        const side = li.querySelector('.dc-acct-side')?.getBoundingClientRect();
        const spill = [...li.querySelectorAll('*')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5);
        }).length;
        const label = li.querySelector('.dc-acct-onlymine')?.getBoundingClientRect();
        return { sideShare: side ? side.width / box.width : 1, spill, over: li.scrollWidth > li.clientWidth + 1, labelLines: label ? Math.round(label.height / 14) : 0 };
      }));
      check(`${tag}: nothing overflows a row`, geo.every((g) => g.spill === 0 && !g.over), JSON.stringify(geo));
      check(`${tag}: the right side is narrow (arrows and Remove only)`, geo.every((g) => g.sideShare < 0.2), geo.map((g) => g.sideShare.toFixed(2)).join(','));
      check(`${tag}: the label stays on one line`, geo.every((g) => g.labelLines <= 1), geo.map((g) => g.labelLines).join(','));
      check(`${tag}: one account open: no warning`, (await page.locator('[data-none-open]').count()) === 0);
      await shot('one-open');

      // Close the open one too, through the control itself.
      await page.locator('[data-only-mine="owner-example-test"]').click();
      check(`${tag}: all closed: the warning stands`, await until(() => page.locator('[data-none-open]').isVisible(), 8000));
      check(`${tag}: …in plain words`, (await page.locator('[data-none-open]').innerText()).includes(warn));
      const listBox = await page.locator('.dc-acct-list').boundingBox();
      const warnBox = await page.locator('[data-none-open]').boundingBox();
      check(`${tag}: …at the top of the list`, warnBox && listBox && warnBox.y < listBox.y);
      await shot('all-closed');

      // The one-click fix opens the top account.
      await page.locator('[data-none-open] button').click();
      check(`${tag}: the fix clears the warning`, await until(async () => (await page.locator('[data-none-open]').count()) === 0, 8000));
      const reg = JSON.parse(readFileSync(REGISTER, 'utf-8'));
      check(`${tag}: …and opens the top account on disk`, !reg.accounts[0].ownerOnly && reg.accounts[1].ownerOnly === true, JSON.stringify(reg.accounts.map((a) => !!a.ownerOnly)));
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
