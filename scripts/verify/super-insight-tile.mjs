#!/usr/bin/env node
/**
 * The Super stage's insight cards (task super-insight-karti-okunur-kucuk-kutucuk-buyuk-halde-
 * ezilmeyen-tam-insight-karti, owner 2026-10-21): the small tile and the large card of a Lab insight.
 *
 *   npm run build && node scripts/verify/super-insight-tile.mjs        (SHOTS=before|after, default after)
 *
 * WHAT IT DRIVES — the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium, and a scripted stand-in `claude` that, as the Super Agent, runs
 * `dreamcontext super open insight …` and the half / present verbs (no tokens spent). The
 * insights are fictional ("Orbit Notes", a note-taking app): a 22-step onboarding funnel (the
 * Series[] funnel the Lab board draws as its bar list), a weekly-active-users number and a
 * daily trial-signups line.
 *
 * WHAT IT PROVES — each insight is a 160 px tile that reads (its name, its number, a sparkline or
 * a change, a status line), half page / presented it is the Lab's own card (title, freshness, the
 * registry body) whose rows keep their height and whose body scrolls instead of being crushed, and
 * both fit in 1280 and 1800 wide windows, light and dark. Screenshots land in
 * tmp/super-insight-tile/<SHOTS>/.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-insight-tile-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit-notes');
const CLI = join(REPO, 'dist', 'index.js');
const WHICH = process.env.SHOTS === 'before' ? 'before' : 'after';
const OUT = join(REPO, 'tmp', 'super-insight-tile', WHICH);
const REPORTS = join(SCRATCH, 'reports.ndjson');

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-super-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [
      cli('super', 'open', 'insight', 'onboarding-funnel'),
      cli('super', 'open', 'insight', 'weekly-active-users'),
      cli('super', 'open', 'insight', 'trial-signups'),
      cli('super', 'open', 'insight', 'never-synced-metric'),
      cli('super', 'open', 'task', 'fix-the-login-form'),
    ];
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  const m = text.match(/GO-(HALF|PRESENTOFF|PRESENT)\\s*(\\S*)\\s*(\\S*)/);
  if (m) {
    const [, verb, a, b] = m;
    const steps = [];
    if (verb === 'HALF') steps.push(cli('super', 'half', a));
    if (verb === 'PRESENT') steps.push(cli('super', 'present', a, b));
    if (verb === 'PRESENTOFF') steps.push(cli('super', 'present', '--off'), cli('super', 'half', '--off'));
    report({ kind: 'verb-' + verb.toLowerCase(), steps });
    return 'did ' + verb;
  }
  return 'ok';
}
let running = false;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user' || running) continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    running = true;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    let said = 'ok';
    try { said = role === 'super' ? superTurn(blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// ─── the fictional insights ──────────────────────────────────────────────────────────────
const STEPS = [
  'app_open · APP OPEN', 'onboarding · WELCOME', 'onboarding · GOAL PICKER', 'onboarding · NOTE STYLE',
  'onboarding · SYNC SETUP', 'onboarding · FIRST NOTE', 'onboarding · TAGS', 'onboarding · REMINDERS',
  'onboarding · WIDGET TIP', 'onboarding · THEME', 'onboarding · IMPORT NOTES', 'onboarding · TEAM INVITE',
  'onboarding · PRIVACY', 'onboarding · NOTIFICATIONS', 'onboarding · ACCOUNT', 'plan_reveal · PLAN REVEAL',
  'plan_reveal · PLAN COMPARE', 'paywall · PAYWALL SHOWN', 'paywall · PAYWALL FREE TRIAL', 'paywall · PAYWALL LAST CHANCE',
  'paywall · PAYWALL CLOSE', 'purchase · START TRIAL',
];
const FUNNEL_USERS = [4120, 3811, 3560, 3490, 3201, 3170, 1280, 1241, 2602, 2588, 2311, 2300, 2255, 2190, 2112, 1980, 1810, 1744, 1210, 903, 640, 38];
const funnelScript = `export default async function () {
  return [{ name: 'Orbit Notes onboarding', points: ${JSON.stringify(STEPS.map((t, i) => ({ t: `${String(i + 1).padStart(2, '0')} · ${t}`, v: FUNNEL_USERS[i] })))} }];
}
`;
const days = (n, f) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), v: Math.round(f(i)) }));
const wauScript = `export default async function () {
  return [{ name: 'Weekly active users', points: ${JSON.stringify(days(12, (i) => 8200 + i * 140 + (i % 3) * 90 - (i === 11 ? 260 : 0)))} }];
}
`;
const signupsScript = `export default async function () {
  return [{ name: 'Trial signups', points: ${JSON.stringify(days(30, (i) => 120 + 30 * Math.sin(i / 3) + i * 2.5))} }];
}
`;

const INSIGHTS = [
  { slug: 'onboarding-funnel', title: 'Orbit Notes — App-Içi Onboarding Funnel', render: 'funnel', script: funnelScript, unit: 'users' },
  { slug: 'weekly-active-users', title: 'Weekly active users', render: 'number', script: wauScript, unit: 'users' },
  { slug: 'trial-signups', title: 'Trial signups, daily', render: 'line', script: signupsScript, unit: 'signups' },
];

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); };
  must('vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'orbit-notes', PROJ], { env: env(), encoding: 'utf-8' }));
  must('task', dc('tasks', 'create', 'Fix the login form', '-w', 'The login form loses its input on a slow network.'));
  must('criteria', dc('tasks', 'insert', 'fix-the-login-form', 'acceptance_criteria', '--', '- [x] The form keeps its input\n- [ ] The draft survives a reload'));
  for (const i of INSIGHTS) {
    must(`lab create ${i.slug}`, dc('lab', 'create', i.slug, '--title', i.title, '--render', i.render, '--adapter', 'script', '--unit', i.unit, '--no-board'));
    writeFileSync(join(PROJ, '_dream_context', 'lab', 'scripts', `${i.slug}.mjs`), i.script);
    must(`lab sync ${i.slug}`, dc('lab', 'sync', i.slug));
  }
  // One insight that was never synced: the tile and the card must say so, not draw a blank.
  must('lab create never-synced', dc('lab', 'create', 'never-synced-metric', '--title', 'Churned workspaces', '--render', 'number', '--adapter', 'script', '--no-board'));
  writeFileSync(join(PROJ, '_dream_context', 'lab', 'scripts', 'never-synced-metric.mjs'), 'export default async function () { return []; }\n');
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [] }; } };
const idOf = (ref) => record().containers.find((c) => c.ref === ref)?.id;

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));

async function openChat(page, base) {
  await page.goto(`${base}/?vault=orbit-notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

const superComposer = (page) => page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
async function sayToSuper(page, text) {
  const input = superComposer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

/** What the owner reads: every insight container's frame, its box and text. */
const readCards = async (page) => (await page.evaluate(() => [...document.querySelectorAll('[data-testid="super-container"][data-kind="insight"]')].map((e) => {
  const b = e.getBoundingClientRect();
  return { id: e.dataset.containerId || '', where: e.dataset.where, w: Math.round(b.width), h: Math.round(b.height), text: (e.innerText || '').replace(/\s+/g, ' ').trim() };
}))).map((c) => ({ ...c, ref: record().containers.find((r) => r.id === c.id)?.ref ?? c.id }));

const SIZES = [[1280, 800], [1800, 1130]];
async function shoot(page, name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(1100);
      await page.screenshot({ path: join(OUT, `${name}-${w}-${scheme}.png`) });
    }
  }
}

let server = null;
let browser = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── hand over: the insights arrive as tiles');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super agent opened the four insights and the task', await until(page, async () => record().containers.filter((c) => c.kind === 'insight').length === 4, 60000),
    JSON.stringify(readNd(REPORTS).find((r) => r.kind === 'handover')?.steps));
  await settle(page);
  await page.locator('[data-testid="super-container"][data-kind="insight"]').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2500);

  const tiles = await readCards(page);
  for (const t of tiles) console.log(`  · tile ${t.ref}: ${t.w}x${t.h} "${t.text}"`);
  ok('every insight is a 160 px 1:1 tile', tiles.length === 4 && tiles.every((t) => Math.abs(t.w - 160) <= 1 && Math.abs(t.h - 160) <= 1), JSON.stringify(tiles.map((t) => [t.ref, t.w, t.h])));
  const tile = (ref) => tiles.find((t) => t.ref === ref)?.text ?? '';
  ok('the funnel tile reads: its name, the reach of the last step, the top-step count', /Onboarding Funnel/.test(tile('onboarding-funnel')) && /4[.,\s]?120/.test(tile('onboarding-funnel')), tile('onboarding-funnel'));
  ok('the number tile reads: its name and the figure', /Weekly active users/.test(tile('weekly-active-users')) && /9[.,\s]?\d{3}/.test(tile('weekly-active-users')), tile('weekly-active-users'));
  ok('the line tile reads: its name and its latest figure', /Trial signups/.test(tile('trial-signups')) && /\d{3}/.test(tile('trial-signups')), tile('trial-signups'));
  ok('a tile carries a sparkline (the trend) where a series exists', (await page.locator('[data-testid="super-container"][data-kind="insight"] .super-tile-trail').count()) >= 2);
  ok('a never-synced insight says so', /never synced/i.test(tile('never-synced-metric')), tile('never-synced-metric'));
  await shoot(page, '1-float');

  const verbs = (kind) => readNd(REPORTS).filter((r) => r.kind === kind).length;
  const say = async (text, kind) => {
    const before = verbs(kind);
    await sayToSuper(page, text);
    await until(page, async () => verbs(kind) > before, 40000);
    await settle(page);
  };

  console.log('\n── half page: the funnel is the Lab card, rows keep their height');
  await say(`GO-HALF ${idOf('onboarding-funnel')}`, 'verb-half');
  ok('the funnel is side by side', await until(page, async () => (await page.locator('[data-testid="super-container"][data-kind="insight"][data-where="half"]').count()) === 1, 10000));
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() => {
    const view = document.querySelector('[data-where="half"] .super-card-view') ?? document.querySelector('[data-where="half"]');
    const rs = [...(view?.querySelectorAll('.funnel-bars-row') ?? [])].map((r) => Math.round(r.getBoundingClientRect().height));
    const body = view?.querySelector('.wb-widget-body');
    // What does not fit must scroll: the body scrolls, or everything fits.
    const scrolls = !!body && (/auto|scroll/.test(getComputedStyle(body).overflowY) || body.scrollHeight <= body.clientHeight + 1);
    return { rows: rs, scrolls };
  });
  ok('all 22 funnel rows are drawn', rows.rows.length === 22, JSON.stringify(rows.rows));
  ok('no funnel row is crushed (>= 16 px each)', rows.rows.length > 0 && rows.rows.every((h) => h >= 16), JSON.stringify(rows.rows));
  ok('the card body scrolls what does not fit', rows.scrolls, JSON.stringify(rows));
  await shoot(page, '2-half-funnel');

  console.log('\n── half page: the number');
  await say(`GO-HALF ${idOf('weekly-active-users')}`, 'verb-half');
  await page.waitForTimeout(1500);
  await shoot(page, '3-half-number');

  console.log('\n── presented: the funnel beside the line');
  await say(`GO-PRESENT ${idOf('onboarding-funnel')} ${idOf('trial-signups')}`, 'verb-present');
  await page.waitForTimeout(1500);
  await shoot(page, '4-present');

  ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}`);
process.exit(fails.length === 0 ? 0 : 1);
