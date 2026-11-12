#!/usr/bin/env node
/**
 * The agenda card keeps its size when the owner leaves the stage and comes back (owner
 * 2026-11-11, "burada agenda doğru düzgün gözükmüyor ... özellikle window'a git gel yaptığında"):
 * on his stage a large agenda (its list) came back from a chat window as the 1x1 counts tile, the
 * centre moved, nothing else had changed.
 *
 *   node scripts/verify/super-ajanda-gorunum.mjs --repo <checkout with dist> --out <dir> --tag before|after
 *
 * Real dashboard server, scratch HOME, a fictional project (acme), a scripted `claude` stand-in
 * (no tokens). For each window size (the owner's 1888x1000, 1440x900, 1024x768) and theme: open the
 * stage, read the agenda's drawn size and the centre's place; then go away and back three ways
 * (a chat window in the drawer and back to Super Agent; the window hidden and shown; the window
 * blurred and focused) and read them again. They must match. Screenshots TAG-WxH-THEME-*.png.
 * Exit 1 on a mismatch (with --tag after) or a console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const REPO = resolve(arg('repo', '.'));
const require = createRequire(join(REPO, 'package.json'));
const { chromium } = require('playwright');
const OUT = resolve(arg('out', 'tmp/develop/ajanda-gorunum'));
const TAG = arg('tag', 'after');
const ONLY = arg('only', '');
/** A copy of a real stage record to draw instead of the fictional one (containers, pad, children only). */
const RECORD_IN = arg('record', '');
/** The owner's own move first: he drags the agenda a little and drops it (his recording). */
const TOUCH = process.argv.includes('--touch');
const PORT = Number(arg('port', TAG === 'before' ? 45881 : 45882));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-ajanda-gorunum-${TAG}-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const ACME = join(SCRATCH, 'acme');
const after = TAG === 'after';
const failures = [];
const consoleErrors = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${detail ?? ''}`}`);
  if (!ok && after) failures.push(name);
};
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'v-' + process.pid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });
const RECORD = join(ACME, '_dream_context', 'state', '.super-agent.json');

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(ACME, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', ACME, 'init', '-q']);
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme'], projectOrder: ['acme'], lastVault: 'acme' }));
  dc(ACME, 'vaults', 'add', 'acme', ACME);
  const kids = { [randomUUID()]: 'Checkout is live, demo ready', [randomUUID()]: 'Pricing page goes live' };
  const children = Object.fromEntries(Object.entries(kids).map(([k, brief], i) => [k, { sessionId: k, brief, adopted: false, startedAt: Date.now() - 60000, row: i ? 'working' : 'saved', rowAt: Date.now() }]));
  const plain = randomUUID();
  const sessions = [
    ...Object.entries(kids).map(([k, title], i) => ({ title, kind: 'chat', sessionId: k, pane: i, active: true, window: 'main', size: 1 })),
    { title: 'Release notes', kind: 'chat', sessionId: plain, pane: 0, active: true, window: 'w2', size: 1 },
  ];
  writeFileSync(join(ACME, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }, { id: 'w2', name: 'Notes', activePane: 0 }], generation: 1 }));
  const now = Date.now();
  const pad = [
    ['waiting', 'Live funnel: walk the local site (school branch, homework screen, paywall), then approve going live'],
    ['waiting', 'The cell lock and colour question from Robin is still open (9 Nov, founder: do not write yet)'],
    ['waiting', 'Institution calendar: look at the demo, then approve live and tell Robin'],
    ['waiting', 'Pricing for the partner: the founder writes them later, we do not write to the teacher'],
    ['waiting', 'Founder tests: live funnel (1), calendar and closed hours (4), payouts (9), student count (10)'],
    ['now', 'Payouts go live: merging, then release and the November fix list'],
    ['done', 'Payouts (absent and cancelled): approve going live before 14 Nov'],
    ['done', 'Payout plan answered on its card (10 Nov)'],
  ].map(([section, text], i) => ({ id: `n${i + 1}`, section, text, at: now - (10 - i) * 60000 }));
  const containers = [
    { id: `agenda-${createHash('sha1').update('agenda').digest('hex').slice(0, 12)}`, kind: 'agenda', ref: 'agenda', shape: 'square', size: 'large', place: 'float', by: 'super' },
    ...Object.entries(kids).map(([k, title], i) => ({ id: `c${i}`, kind: 'chat', ref: k, shape: 'portrait', place: 'float', by: 'super', title })),
  ];
  const real = RECORD_IN ? JSON.parse(readFileSync(RECORD_IN, 'utf-8')) : null;
  writeFileSync(RECORD, JSON.stringify({
    v: 1, session: randomUUID(), enabled: true,
    containers: real ? real.containers : containers, pad: real ? real.pad : pad,
    groups: real?.groups ?? [], view: real?.view ?? { mode: 'float' }, children: real ? real.children : children, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
  }));
}

async function server() {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(PORT)], { cwd: ACME, env: { ...env(), PATH }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const wait = (p, ms = 800) => p.waitForTimeout(ms);
const until = async (p, fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(p, 150); } return false; };
const agenda = (p) => p.locator('[data-testid="super-container"][data-kind="agenda"]').first();

/** What the owner sees of the agenda and the centre. */
async function look(p) {
  return p.evaluate(() => {
    const ag = document.querySelector('[data-testid="super-container"][data-kind="agenda"]');
    const centre = document.querySelector('[data-testid="super-centre"]');
    const stage = document.querySelector('[data-testid="super-surface"]');
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { where: ag?.getAttribute('data-where') ?? null, size: ag?.getAttribute('data-size') ?? null, agenda: r(ag), centre: r(centre), stage: r(stage), list: !!ag?.querySelector('.super-agenda:not(.super-agenda--tile)') };
  });
}
const same = (a, b) => a.size === b.size && a.where === b.where && JSON.stringify(a.agenda) === JSON.stringify(b.agenda) && JSON.stringify(a.centre) === JSON.stringify(b.centre);

async function openStage(browser, { w, h, dark }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2 });
  await ctx.addInitScript((d) => { try { localStorage.setItem('theme', d ? 'dark' : 'light'); localStorage.setItem('dreamcontext-theme', d ? 'dark' : 'light'); } catch { /* */ } }, dark);
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) consoleErrors.push(`${w}: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => consoleErrors.push(`${w}: ${String(e).slice(0, 200)}`));
  await p.route('**/api/onboarding/readiness**', async (r) => { try { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); } catch { /* page closed */ } });
  await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
  await wait(p, 2200);
  const g = p.getByRole('button', { name: 'Got it' });
  if (await g.isVisible().catch(() => false)) { await g.click(); await wait(p, 300); }
  await p.keyboard.press('Escape');
  await until(p, async () => (await p.locator('[data-testid="super-centre"]:visible').count()) > 0, 20000);
  await wait(p, 2500);
  return { ctx, p };
}

/** Hidden then shown, the way macOS hides the app (Cmd+H, another Space). */
async function hideShow(p) {
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  await wait(p, 1500);
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await wait(p, 1500);
}

async function blurFocus(p) {
  await p.evaluate(() => window.dispatchEvent(new Event('blur')));
  await wait(p, 1200);
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(p, 1200);
}

/** A chat window in the drawer, then Super Agent again (the owner's own path). */
async function toWindowAndBack(p) {
  const nav = p.locator('aside, nav');
  const win = nav.getByText('Notes', { exact: true }).first();
  if (!(await win.isVisible().catch(() => false))) return false;
  await win.click();
  await until(p, async () => (await p.locator('[data-testid="super-surface"]:visible').count()) === 0, 6000);
  await wait(p, 1200);
  await nav.getByText('Super Agent', { exact: true }).first().click();
  await until(p, async () => (await p.locator('[data-testid="super-centre"]:visible').count()) > 0, 10000);
  await wait(p, 2500);
  return true;
}

async function scene(browser, w, h, dark) {
  const theme = dark ? 'dark' : 'light';
  const name = `${w}x${h}-${theme}`;
  console.log(`\n── ${name}`);
  const { ctx, p } = await openStage(browser, { w, h, dark });
  if (TOUCH && await agenda(p).isVisible().catch(() => false)) {
    // His own move (his recording): he takes the agenda and puts it down where it stands.
    const b = await agenda(p).boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height - 12);
    await p.mouse.down();
    for (let i = 1; i <= 8; i++) { await p.mouse.move(b.x + b.width / 2 + i * 3, b.y + b.height - 12 + i * 2); await wait(p, 30); }
    await p.mouse.up();
    await wait(p, 2000);
  }
  await p.mouse.move(5, h - 5);
  check(`[${name}] at most one agenda on the stage`, (await p.locator('[data-testid="super-container"][data-kind="agenda"]').count()) <= 1);
  const first = await look(p);
  console.log('    first   ' + JSON.stringify(first));
  await p.screenshot({ path: join(OUT, `${TAG}-${name}-1-first.png`) });
  const went = await toWindowAndBack(p);
  check(`[${name}] the drawer has the Notes window`, went);
  await p.mouse.move(5, h - 5);
  const back = await look(p);
  console.log('    window  ' + JSON.stringify(back));
  await p.screenshot({ path: join(OUT, `${TAG}-${name}-2-window-back.png`) });
  check(`[${name}] window and back: the agenda and the centre stand as before`, same(first, back), JSON.stringify({ first, back }));
  await hideShow(p);
  const shown = await look(p);
  console.log('    hidden  ' + JSON.stringify(shown));
  check(`[${name}] hidden and shown: the same`, same(first, shown), JSON.stringify(shown));
  await blurFocus(p);
  const focused = await look(p);
  check(`[${name}] blurred and focused: the same`, same(first, focused), JSON.stringify(focused));
  await toWindowAndBack(p);
  const twice = await look(p);
  console.log('    twice   ' + JSON.stringify(twice));
  check(`[${name}] window and back again: the same`, same(first, twice), JSON.stringify(twice));
  await p.screenshot({ path: join(OUT, `${TAG}-${name}-3-again.png`) });
  await ctx.close();
}

seed();
const srv = await server();
const browser = await chromium.launch();
const SIZES = [[1888, 1000], [1440, 900], [1024, 768]].filter(([w]) => !ONLY || ONLY.split(',').includes(String(w)));
try {
  for (const [w, h] of SIZES) {
    for (const dark of [true, false]) {
      try { await scene(browser, w, h, dark); } catch (e) { check(`scene ${w} ${dark ? 'dark' : 'light'} ran to the end`, false, String(e).slice(0, 300)); }
    }
  }
} finally {
  await browser.close();
  srv.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\nconsole errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}`);
if (after && consoleErrors.length) failures.push('console errors');
console.log(failures.length ? `FAIL: ${failures.join(', ')}` : 'PASS');
process.exit(failures.length ? 1 : 0);
