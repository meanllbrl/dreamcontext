#!/usr/bin/env node
/**
 * Super stage card window controls (owner 2026-11-08): red close, yellow minimise, green full
 * screen at a card's top left, always in colour, glyphs on hover; "ask about this" larger on the
 * trailing side; a minimised card draws only red and green (no inert middle dot).
 *
 *   node scripts/verify/super-kart-isiklari.mjs --repo <checkout or install with dist> --out <dir> --tag before|after
 *
 * Real dashboard server, scratch HOME, a fictional project (acme), a scripted `claude` stand-in
 * (no tokens). Writes TAG-THEME-*.png into OUT, light and dark: resting, hover, minimised (and,
 * after, keyboard focus and a phone width). Checks are enforced with --tag after; exit 1 on a
 * failed check or a console error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const REPO = resolve(arg('repo', '.'));
const OUT = resolve(arg('out', 'tmp/develop/kart-isiklari'));
const TAG = arg('tag', 'after');
const PORT = Number(arg('port', TAG === 'before' ? 45871 : 45872));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-kart-isiklari-${TAG}-${process.pid}`);
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;margin:0;padding:28px 32px;color:#292d34}h1{font-size:30px;margin:0 0 12px}p{font-size:15px;line-height:1.5;color:#555;max-width:640px}</style></head>
<body><h1>Why did the checkout plan take 29 rounds?</h1><p>Each review round reopened the same finding, so the plan went back to the start every time.</p></body></html>`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });
const RECORD = join(ACME, '_dream_context', 'state', '.super-agent.json');

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(ACME, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(ACME, 'docs'), { recursive: true });
  writeFileSync(join(ACME, 'docs', 'plan.html'), PAGE);
  spawnSync('git', ['-C', ACME, 'init', '-q']);
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme'], projectOrder: ['acme'], lastVault: 'acme' }));
  dc(ACME, 'vaults', 'add', 'acme', ACME);
  const kids = { [randomUUID()]: 'Fix the checkout', [randomUUID()]: 'Write the pricing page' };
  const children = Object.fromEntries(Object.entries(kids).map(([k, brief]) => [k, { sessionId: k, brief, adopted: false, startedAt: Date.now() - 60000, row: 'working', rowAt: Date.now() }]));
  const sessions = Object.entries(kids).map(([k, title], i) => ({ title, kind: 'chat', sessionId: k, pane: i, active: true, window: 'main', size: 1 }));
  writeFileSync(join(ACME, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows: [{ id: 'main', name: 'Chat', activePane: 0 }], generation: 1 }));
  const containers = [
    ...Object.entries(kids).map(([k, title], i) => ({ id: `c${i}`, kind: 'chat', ref: k, shape: 'portrait', place: 'float', by: 'super', title })),
    { id: 'w0', kind: 'web', ref: 'docs/plan.html', shape: 'square', place: 'float', by: 'super', title: 'Why the plan took so long' },
  ];
  writeFileSync(RECORD, JSON.stringify({
    v: 1, session: randomUUID(), enabled: true, containers,
    groups: [], view: { mode: 'float' }, children, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [],
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
const shot = (name) => join(OUT, `${TAG}-${name}.png`);
const card = (p, id) => p.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
const whereOf = (p, id) => card(p, id).getAttribute('data-where').catch(() => null);
function around(box, vp, padX = 40, padY = 40) {
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  return { x, y, width: Math.min(vp.width - x, box.width + 2 * padX), height: Math.min(vp.height - y, box.height + 2 * padY) };
}

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
  await wait(p, 1200);
  return { ctx, p };
}

async function sceneDesktop(browser, dark) {
  const theme = dark ? 'dark' : 'light';
  console.log(`\n── 1440 ${theme}`);
  const { ctx, p } = await openStage(browser, { w: 1440, h: 900, dark });
  const vp = p.viewportSize();
  const b = await card(p, 'w0').boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  check(`[${theme}] the page card opens side by side`, await until(p, async () => (await whereOf(p, 'w0')) === 'half', 6000));
  await wait(p, 1800);
  const big = card(p, 'w0');
  const head = async () => { const bb = await big.boundingBox(); return { x: bb.x, y: bb.y, width: bb.width, height: 120 }; };
  await p.mouse.move(5, vp.height - 5);
  await wait(p, 300);
  await p.screenshot({ path: shot(`${theme}-1-resting`), clip: around(await head(), vp, 24, 24) });

  if (after) {
    const lights = big.getByTestId('super-card-lights');
    check(`[${theme}] the card has its three lights`, (await lights.locator('button.super-light').count()) === 3);
    const info = await lights.evaluate((el) => [...el.querySelectorAll('button')].map((btn) => {
      const dot = btn.querySelector('.super-light-dot'); const svg = dot.querySelector('svg');
      const r = btn.getBoundingClientRect();
      return { label: btn.getAttribute('aria-label'), w: r.width, h: r.height, bg: getComputedStyle(dot).backgroundColor, glyph: svg ? getComputedStyle(svg).opacity : null, disabled: btn.disabled };
    }));
    console.log('    ' + JSON.stringify(info));
    check(`[${theme}] red, yellow, green in that order`, info[0]?.bg === 'rgb(255, 95, 87)' && info[1]?.bg === 'rgb(254, 188, 46)' && info[2]?.bg === 'rgb(40, 200, 64)', JSON.stringify(info.map((i) => i.bg)));
    check(`[${theme}] every light is at least 24 px`, info.every((i) => i.w >= 24 && i.h >= 24));
    check(`[${theme}] glyphs hidden at rest`, info.filter((i) => i.glyph !== null).every((i) => i.glyph === '0'));
    check(`[${theme}] close and minimise work on a large card`, info[0] && !info[0].disabled && info[1] && !info[1].disabled);
    check(`[${theme}] no word ever slides out`, (await p.locator('.super-icon-btn-caption').count()) === 0);
    const ask = big.getByTestId('super-card-ask');
    const askInfo = await ask.evaluate((el) => ({ w: el.getBoundingClientRect().width, color: getComputedStyle(el).color, title: el.title }));
    check(`[${theme}] ask about this is 28 px, accent, with its tooltip`, askInfo.w >= 28 && /rgb\((123, 104, 238|157, 140, 255)\)/.test(askInfo.color) && !!askInfo.title, JSON.stringify(askInfo));
    // The head text starts after the lights.
    const overlap = await big.evaluate((el) => {
      const l = el.querySelector('[data-testid="super-card-lights"]').getBoundingClientRect();
      const t = el.querySelector('.wb-widget-title, .super-card-title, .super-card-large-title');
      return t ? t.getBoundingClientRect().left - l.right : null;
    });
    check(`[${theme}] the title starts after the lights`, overlap === null || overlap >= 0, String(overlap));
    await lights.hover();
    await wait(p, 300);
    const glyphs = await lights.evaluate((el) => [...el.querySelectorAll('svg')].map((s) => getComputedStyle(s).opacity));
    check(`[${theme}] hover shows the glyphs`, glyphs.length > 0 && glyphs.every((o) => o === '1'), JSON.stringify(glyphs));
  } else {
    await big.getByTestId('super-card-minimize').hover();
    await wait(p, 400);
  }
  await p.screenshot({ path: shot(`${theme}-2-hover`), clip: around(await head(), vp, 24, 24) });

  if (after && !dark) {
    await p.mouse.move(5, vp.height - 5);
    await big.getByTestId('super-card-minimize').evaluate((el) => el.focus({ focusVisible: true }));
    await wait(p, 200);
    const ring = await big.getByTestId('super-card-minimize').evaluate((el) => getComputedStyle(el).outlineStyle);
    check('[light] keyboard focus draws a ring', ring === 'solid', ring);
    await p.screenshot({ path: shot(`${theme}-4-focus`), clip: around(await head(), vp, 24, 24) });
    await p.evaluate(() => document.activeElement?.blur());
  }

  await big.getByTestId('super-card-minimize').click();
  check(`[${theme}] minimise takes the card back to the stage`, await until(p, async () => (await whereOf(p, 'w0')) === 'float', 6000));
  await wait(p, 1200);
  const small = card(p, 'w0');
  const sb = await small.boundingBox();
  await p.mouse.move(sb.x + 30, sb.y + 18);
  await wait(p, 500);
  if (after) {
    const mini = await small.getByTestId('super-card-lights').evaluate((el) => [...el.querySelectorAll('button')].map((btn) => ({ disabled: btn.disabled, label: btn.getAttribute('aria-label') })));
    check(`[${theme}] minimised: no grey middle dot, only red and green`, mini.length === 2 && mini[0]?.disabled === false && mini[1]?.disabled === false, JSON.stringify(mini));
    const gap = await small.evaluate((el) => el.querySelector('.super-card-actions').getBoundingClientRect().left - el.querySelector('[data-testid="super-card-lights"]').getBoundingClientRect().right);
    check(`[${theme}] on a small tile the lights and the buttons do not overlap`, gap >= 0, String(gap));
  }
  await p.screenshot({ path: shot(`${theme}-3-minimised`), clip: around(sb, vp, 40, 40) });
  if (after) {
    await small.getByTestId('super-card-restore').click();
    check(`[${theme}] green shows it side by side again`, await until(p, async () => (await whereOf(p, 'w0')) === 'half', 6000));
  }
  await ctx.close();
}

async function scenePhone(browser) {
  console.log('\n── 390 light');
  const { ctx, p } = await openStage(browser, { w: 390, h: 844, dark: false });
  await p.screenshot({ path: shot('light-5-phone') });
  await ctx.close();
}

seed();
const srv = await server();
const browser = await chromium.launch();
try {
  for (const dark of [false, true]) {
    try { await sceneDesktop(browser, dark); } catch (e) { check(`scene ${dark ? 'dark' : 'light'} ran to the end`, false, String(e).slice(0, 300)); }
  }
  if (after) { try { await scenePhone(browser); } catch (e) { check('phone scene ran', false, String(e).slice(0, 300)); } }
} finally {
  await browser.close();
  srv.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\nconsole errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}`);
if (after && consoleErrors.length) failures.push('console errors');
console.log(failures.length ? `FAIL: ${failures.join(', ')}` : 'PASS');
process.exit(failures.length ? 1 : 0);
