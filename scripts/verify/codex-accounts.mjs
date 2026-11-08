#!/usr/bin/env node
/**
 * Several Codex accounts in the real app (Track T W2).
 *
 *   npm run build && node scripts/verify/codex-accounts.mjs
 *
 * Built app (dist/), scratch HOME, `codex` = scripts/verify/fake-codex.mjs (T3's recorded frames),
 * a stand-in `claude`. Two Codex accounts are laid out on disk the way the server leaves them
 * (#0 = ~/.codex, a second in ~/.dreamcontext/codex-accounts/<id>) with fresh readings, so the
 * panel draws without spawning a probe. Nothing signs in anywhere and no token exists.
 *
 * Checks:
 *   - Settings → Chat: a "Codex accounts" card, one row per account with its 5-hour and weekly
 *     bars, "new chats start here" on the top row, "Add an account";
 *   - a Codex chat: the usage chip lists the CODEX accounts (not Claude's) with the active one's
 *     windows; picking the second account reopens the pane on it, and its bridge child is told
 *     `--account <id>` (read from the trace the bridge writes);
 *   - the look: 1440 / 1024 / 390, dark and light, console errors and failed requests recorded.
 * Exit 0 iff every check passed. Screenshots go to $SHOTS_DIR (default: a scratch folder).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-codex-accounts');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');
const FIXTURES = join(REPO, 'src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');
const SECOND = 'acct-7a7a7a';
const FREE = 'acct-9b9b9b';

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const CLAUDE_STANDIN = `#!${process.execPath}
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
`;

function windows(session, weekly) {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  return [
    { id: 'primary', kind: 'session', label: 'Session', usedPercent: session, resetsAt: iso(2.5 * 3_600_000), windowDurationMins: 300 },
    { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: weekly, resetsAt: iso(4 * 86_400_000), windowDurationMins: 10080 },
  ];
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext', 'codex-usage'), join(HOME, '.local', 'bin'), join(HOME, '.codex', 'sessions'), join(HOME, '.dreamcontext', 'codex-accounts', SECOND), join(PROJ, '_dream_context', 'state'), SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), CLAUDE_STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.local', 'bin', 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(REPO, 'scripts/verify/fake-codex.mjs')}" "$@"\n`);
  chmodSync(join(HOME, '.local', 'bin', 'codex'), 0o755);
  // Two signed-in accounts, by the presence of their own sign-in record (placeholders, not credentials).
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"note":"verify placeholder"}');
  writeFileSync(join(HOME, '.dreamcontext', 'codex-accounts', SECOND, 'auth.json'), '{"note":"verify placeholder"}');
  mkdirSync(join(HOME, '.dreamcontext', 'codex-accounts', FREE), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'codex-accounts', FREE, 'auth.json'), '{"note":"verify placeholder"}');
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-6-luna"\n');
  writeFileSync(join(HOME, '.codex', 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
  ] }));
  writeFileSync(join(HOME, '.dreamcontext', 'codex-accounts.json'), JSON.stringify({ accounts: [
    { id: 'primary', email: 'owner@example.test', planType: 'plus', addedAt: 0 },
    { id: SECOND, email: 'second@example.test', planType: 'pro', addedAt: 1 },
    { id: FREE, email: 'free@example.test', planType: 'free', addedAt: 2 },
  ] }));
  const now = new Date().toISOString();
  writeFileSync(join(HOME, '.dreamcontext', 'codex-usage', 'primary.json'), JSON.stringify({ checkedAt: now, windows: windows(72, 41), source: 'probe' }));
  writeFileSync(join(HOME, '.dreamcontext', 'codex-usage', `${SECOND}.json`), JSON.stringify({ checkedAt: now, windows: windows(9, 18), source: 'probe' }));
  // A ChatGPT Free plan: T3 maps it to one monthly window, no 5-hour or weekly one.
  writeFileSync(join(HOME, '.dreamcontext', 'codex-usage', `${FREE}.json`), JSON.stringify({ checkedAt: now, windows: [{ id: 'primary', kind: 'monthly', label: 'Monthly', usedPercent: 32, resetsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), windowDurationMins: 43200 }], source: 'probe' }));
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME, PATH, DREAMCONTEXT_DESKTOP: '1', FAKE_CODEX_FIXTURES: FIXTURES, FAKE_CODEX_LOG: join(SCRATCH, 'fake-codex.log'), DREAMCONTEXT_T3_DEBUG: join(SCRATCH, 'bridge.log'), DREAMCONTEXT_CLI: join(REPO, 'dist', 'index.js') },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { process.kill(-srv.pid, 'SIGTERM'); } catch { /* gone */ }
  throw new Error('dashboard server did not come up');
}

const results = [];
const check = (ctx, label, cond, detail) => {
  results.push({ ctx, label, ok: !!cond });
  console.log(`  ${cond ? '✓' : '✗'} [${ctx}] ${label}${!cond && detail ? `  — ${String(detail).slice(0, 240)}` : ''}`);
};

async function openPage(browser, base, { width, height, theme }) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 200)}`); });
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`[${r.status()}] ${r.url()}`); });
  return { page, errors };
}

async function dismissModals(page) {
  for (let i = 0; i < 4; i += 1) {
    await page.waitForTimeout(400);
    if (await page.locator('.announcements-modal-scrim').count()) await page.keyboard.press('Escape');
  }
}

async function openSettingsCard(page, base) {
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await dismissModals(page);
  // The new shell: Settings is a rail page (in "more" on a narrow window), then its Chat section.
  const direct = page.getByTestId('ns-rail-settings');
  if (await direct.isVisible().catch(() => false)) await direct.click();
  else { await page.getByTestId('ns-rail-more').click().catch(() => {}); await page.waitForTimeout(300); await page.getByTestId('ns-more-settings').click().catch(() => {}); }
  await page.waitForTimeout(900);
  await dismissModals(page);
  const nav = page.locator('.settings-nav-item', { hasText: /^\s*Chat\s*/ }).first();
  if (await nav.count()) await nav.click().catch(() => {});
  else { await page.getByTestId('settings-search').fill('Codex').catch(() => {}); }
  const card = page.getByTestId('codex-accounts');
  await card.waitFor({ timeout: 15_000 }).catch(() => {});
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  return card;
}

async function main() {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  const allErrors = [];
  try {
    // ── Settings: the Codex card, at every width and theme ──
    for (const theme of ['dark', 'light']) {
      for (const [width, height] of [[1440, 900], [1024, 800], [390, 844]]) {
        const ctx = `${theme}-${width}`;
        const { page, errors } = await openPage(browser, base, { width, height, theme });
        const card = await openSettingsCard(page, base);
        const text = ((await card.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
        check(ctx, 'Settings shows a Codex accounts card', text.length > 0, text.slice(0, 120));
        check(ctx, 'one row per account, top row first', text.indexOf('owner@example.test') >= 0 && text.indexOf('owner@example.test') < text.indexOf('second@example.test'), text.slice(0, 200));
        check(ctx, 'each row has a 5-hour and a weekly bar with its percent', /5-hour session 72%/.test(text) && /Weekly 41%/.test(text) && /5-hour session 9%/.test(text) && /Weekly 18%/.test(text), text.slice(0, 300));
        check(ctx, 'the top row says new chats start there', text.includes('new chats start here'));
        check(ctx, 'a Free plan account draws its Monthly bar', /free@example\.test.*Monthly 32%/.test(text), text.slice(-260));
        check(ctx, '"Add an account" is offered', (await page.getByTestId('codex-add-account').count()) === 1);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(ctx, 'no sideways overflow', over <= 1, `${over}px`);
        await page.screenshot({ path: join(SHOTS, `settings-codex-${theme}-${width}.png`) });
        allErrors.push(...errors.map((e) => `${ctx} ${e}`));
        await page.close();
      }
    }

    // ── A Codex chat: its account chip ──
    const { page, errors } = await openPage(browser, base, { width: 1440, height: 900, theme: 'dark' });
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await dismissModals(page);
    const vis = (sel) => page.locator(`${sel}:visible`);
    const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(200); } return false; };
    if (!(await vis('.chat-cmp-input').count())) {
      const start = page.getByRole('button', { name: /Start chat/ }).first();
      if (await start.count()) await start.click().catch(() => {});
    }
    await until(async () => (await vis('.chat-cmp-input').count()) > 0);
    await vis('.chat-cmp-modeltrigger[title^="Model and reasoning effort"]').first().click();
    await page.waitForTimeout(400);
    await vis('.chat-cmp-modelmenu').first().getByRole('menuitemradio', { name: /Codex/ }).click();
    await until(async () => /Message Codex/.test((await vis('.chat-cmp-input').first().getAttribute('placeholder').catch(() => '')) ?? ''));
    await page.waitForTimeout(2500);
    await vis('.chat-cmp-usagebtn').first().click();
    await page.waitForTimeout(600);
    const menu = vis('.chat-cmp-usagemenu').first();
    const menuText = ((await menu.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    check('chip', 'the chip draws the Codex account\'s windows', /72%/.test(menuText) && /41%/.test(menuText), menuText.slice(0, 300));
    const head = menu.locator('.chat-cmp-acct.is-head');
    check('chip', 'the chip names the Codex account it runs on', (await head.innerText().catch(() => '')).includes('owner@example.test'), await head.innerText().catch(() => ''));
    await head.click().catch(() => {});
    await page.waitForTimeout(400);
    const list = menu.locator('.chat-cmp-acctlist');
    const listText = ((await list.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    // The rows name an account and its 5-hour percent (no plan): second@example.test exists only as a Codex account here.
    check('chip', 'the account list is Codex\'s, never Claude\'s', listText.includes('second@example.test') && /9%/.test(listText), listText);
    await page.screenshot({ path: join(SHOTS, 'chip-codex-accounts-dark-1440.png') });
    await list.getByText('second@example.test').first().click().catch(() => {});
    const moved = await until(async () => {
      await page.keyboard.press('Escape');
      const log = existsSync(join(SCRATCH, 'fake-codex.log')) ? readFileSync(join(SCRATCH, 'fake-codex.log'), 'utf-8') : '';
      return log.includes(join('codex-accounts', SECOND));
    }, 25_000);
    check('chip', 'picking the second account reopens the pane on its own Codex home', moved, existsSync(join(SCRATCH, 'fake-codex.log')) ? readFileSync(join(SCRATCH, 'fake-codex.log'), 'utf-8').slice(-400) : 'no fake-codex log');
    await page.waitForTimeout(2000);
    await vis('.chat-cmp-usagebtn').first().click().catch(() => {});
    await page.waitForTimeout(600);
    const after = ((await vis('.chat-cmp-usagemenu').first().locator('.chat-cmp-acct.is-head').innerText().catch(() => '')) || '');
    check('chip', 'the chip now names the second account', after.includes('second@example.test'), after);
    await page.screenshot({ path: join(SHOTS, 'chip-after-switch-dark-1440.png') });
    allErrors.push(...errors.map((e) => `chip ${e}`));
    await page.close();
  } finally {
    await browser.close().catch(() => {});
    try { process.kill(-srv.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  check('all', 'no console errors or failed requests', allErrors.length === 0, allErrors.slice(0, 6).join(' | '));
  writeFileSync(join(SHOTS, 'report.json'), JSON.stringify({ results, errors: allErrors }, null, 1));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${SHOTS}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
