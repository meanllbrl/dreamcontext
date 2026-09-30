#!/usr/bin/env node
/**
 * Multiple fire slots + calendar cadences — runtime proof on the real surface.
 *
 *   npm run build && npm run verify:agent-slots
 *
 * Driven against the REAL dashboard server, the REAL `/api/automations*`
 * routes and the REAL React surface in Chromium, on a scratch vault with an
 * isolated HOME. No `claude` is ever spawned.
 *
 * WHAT IT PROVES:
 *   1. Agents made with the CLI's `--slot` (a two-slot funnel agent, a
 *      biweekly one, a monthly one) show EVERY slot on their card, and a
 *      "next …" line whose time is the server's earliest upcoming fire — the
 *      same `nextFireAt` `automations list --json` prints.
 *   2. The Edit dialog opens with one row per saved slot, "Add another time"
 *      adds a row, a Days-of-the-month row with a bad day names the problem
 *      and disables Save, and a good one saves: the manifest on disk then has
 *      three slots and the agent is still approved.
 *   3. Remove takes a row out and the save drops that slot.
 *   4. Nothing in the dialog overflows its width, in light and in dark.
 *
 * Exit 0 iff every check passed. Screenshots land in test-results/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, scratchDir, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-ui-agent-slots');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const SHOTS = shotsDir(REPO, 'agent-schedule-slots');

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function cli(args) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'automations'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  cli(['vaults', 'add', 'proj', PROJ]);
  cli(['automations', 'create', 'funnel-watch', '--title', 'Funnel watch', '--slot', 'mon@09:30', '--slot', 'mon-fri@16:30']);
  cli(['automations', 'create', 'biweekly-review', '--title', 'Biweekly review', '--slot', '2w/2026-09-28:mon@10:00']);
  cli(['automations', 'create', 'month-close', '--title', 'Month close', '--slot', 'month:1,15,last@09:00']);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

function approved(slug) {
  const p = join(HOME, '.dreamcontext', 'automations.json');
  if (!existsSync(p)) return false;
  const reg = JSON.parse(readFileSync(p, 'utf-8'));
  return Object.values(reg.projects ?? {}).some((proj) => proj?.approvals?.[slug]);
}

const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function main() {
  seed();
  const listed = Object.fromEntries(JSON.parse(cli(['automations', 'list', '--json'])).map((r) => [r.slug, r]));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await page.waitForTimeout(150); }
    return false;
  };
  const dismissOverlays = async () => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      if (await page.locator('.announcements-modal-scrim').count() === 0) break;
    }
  };
  const showRoster = async () => {
    if ((await page.locator('.agent-card').count()) > 0) return;
    await page.locator('.agents-switch-opt', { hasText: 'Agents' }).click();
    await until(async () => (await page.locator('.agent-card').count()) > 0);
  };
  const card = (title) => page.locator('.agent-card', { hasText: title }).first();
  const openEdit = async (title) => {
    await showRoster();
    await card(title).locator('.agent-card-btn', { hasText: 'Edit' }).click();
    await until(async () => (await page.locator('.agent-modal').count()) > 0);
  };
  const scheduleOf = (slug) => JSON.parse(cli(['automations', 'schedule', slug, '--json']));
  const overflow = () => page.evaluate(() => {
    const modal = document.querySelector('.agent-modal');
    if (!modal) return 'no modal';
    const m = modal.getBoundingClientRect();
    const bad = [...modal.querySelectorAll('.agent-slot *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > m.right + 0.5 || r.left < m.left - 0.5);
    }).map((el) => el.className).slice(0, 4);
    return bad.length === 0 && modal.scrollWidth <= modal.clientWidth ? null : JSON.stringify({ bad, sw: modal.scrollWidth, cw: modal.clientWidth });
  });

  try {
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissOverlays();
    await page.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
    await page.waitForTimeout(1000);
    await showRoster();

    console.log('\n═══ 1. Cards show every slot and the earliest next fire ═══');
    for (const [slug, title, label] of [
      ['funnel-watch', 'Funnel watch', 'mon 09:30 · mon–fri 16:30'],
      ['biweekly-review', 'Biweekly review', 'every 2 weeks mon 10:00'],
      ['month-close', 'Month close', 'monthly 1, 15, last 09:00'],
    ]) {
      const text = (await card(title).innerText()).replace(/\s+/g, ' ');
      check(`${title}: the card reads "${label}"`, text.includes(label), text.slice(0, 200));
      const next = listed[slug]?.nextFireAt;
      check(`${title}: …and "next … ${next ? hhmm(next) : '?'}", the CLI's own next fire`,
        !!next && new RegExp(`next [^·]*${hhmm(next)}`).test(text), `nextFireAt=${next} card="${text.slice(0, 200)}"`);
    }
    await page.screenshot({ path: join(SHOTS, '1-cards.png') });

    console.log('\n═══ 2. The Edit dialog edits slots ═══');
    await openEdit('Funnel watch');
    check('the dialog opens with one row per saved slot', await page.locator('.agent-slot').count() === 2,
      `rows=${await page.locator('.agent-slot').count()}`);
    const times = await page.locator('.agent-slot .agent-time').evaluateAll((els) => els.map((e) => e.value));
    check('…each with its own time', JSON.stringify(times) === JSON.stringify(['09:30', '16:30']), JSON.stringify(times));
    await page.locator('.agent-slot-add').click();
    check('"Add another time" adds a row', await page.locator('.agent-slot').count() === 3);
    const third = page.locator('.agent-slot').nth(2);
    await third.locator('.agent-cadence').selectOption('monthdays');
    await third.locator('.agent-slot-text').fill('0');
    await page.waitForTimeout(200);
    check('a bad month day names the problem on its row', (await third.locator('.agent-slot-error').innerText().catch(() => '')).includes('monthdays'));
    check('…and Save is disabled', await page.locator('.agent-btn--primary').isDisabled());
    await third.locator('.agent-slot-text').fill('1, last');
    await third.locator('.agent-time').fill('08:15');
    await page.waitForTimeout(200);
    const summary = (await page.locator('.agent-summary').innerText()).replace(/\s+/g, ' ');
    check('the summary sentence names all three times', summary.includes('mon 09:30 · mon–fri 16:30 · monthly 1, last 08:15'), summary);
    check('[light] nothing in the slot rows overflows the dialog', (await overflow()) === null, String(await overflow()));
    await page.screenshot({ path: join(SHOTS, '2-dialog-three-slots-light.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(200);
    check('[dark] nothing in the slot rows overflows the dialog', (await overflow()) === null, String(await overflow()));
    await page.screenshot({ path: join(SHOTS, '2-dialog-three-slots-dark.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.locator('.agent-btn--primary').click();
    const saved = await until(async () => scheduleOf('funnel-watch').schedule?.slots?.length === 3, 15000);
    const afterAdd = scheduleOf('funnel-watch');
    check('saved: the manifest on disk has three slots', saved, JSON.stringify(afterAdd.schedule));
    check('…labelled as the dialog said', afterAdd.label === 'mon 09:30 · mon–fri 16:30 · monthly 1, last 08:15', afterAdd.label);
    check('…and the agent is still approved here', approved('funnel-watch'));

    console.log('\n═══ 3. Remove drops a slot ═══');
    await until(async () => (await page.locator('.agent-modal').count()) === 0, 8000);
    await openEdit('Funnel watch');
    await until(async () => (await page.locator('.agent-slot').count()) === 3);
    await page.locator('.agent-slot').nth(2).locator('.agent-slot-remove').click();
    check('Remove takes the row out', await page.locator('.agent-slot').count() === 2);
    await page.locator('.agent-btn--primary').click();
    const removed = await until(async () => scheduleOf('funnel-watch').schedule?.slots?.length === 2, 15000);
    check('saved: back to two slots', removed, JSON.stringify(scheduleOf('funnel-watch').schedule));
    await until(async () => (await page.locator('.agent-modal').count()) === 0, 8000);
    await showRoster();
    const funnelText = (await card('Funnel watch').innerText()).replace(/\s+/g, ' ');
    check('…and the card reads the two slots again', funnelText.includes('mon 09:30 · mon–fri 16:30') && !funnelText.includes('monthly'), funnelText.slice(0, 200));

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
  console.log(`  screenshots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
