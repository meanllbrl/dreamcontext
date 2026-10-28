#!/usr/bin/env node
/**
 * The Super Agent chat card's head stays one row at every width (owner 2026-10-28: "make this
 * Super Agent part responsive, it keeps overflowing" — the name wrapped to two lines and spilled
 * under the head's border).
 *
 *   npm run build && node scripts/verify/super-head.mjs              (ENGINES=chromium,webkit)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1) and the real dashboard; a
 * scripted `claude` hands over and delegates two children with long titles. Then:
 *
 *   H1  the centre card is set to 760 … 200 px wide (the sizes it takes beside a card in the
 *       half / compare / review / spotlight layouts): at each, the head is 40 px tall, the name
 *       is ONE line, nothing in the head leaves it or overlaps a neighbour, and the head does not
 *       scroll sideways;
 *   H2  the subtitle gives way first (shown wide, hidden narrow); New session keeps its glyph and
 *       an aria-label when its word is gone;
 *   H3  the same at a 390 px phone viewport, and every child card's head on the stage;
 *   Screenshots of the head at each width into OUT (default tmp/super-head/).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-head-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = process.env.OUT ? resolve(process.env.OUT) : join(REPO, 'tmp', 'super-head');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const WIDTHS = [760, 620, 520, 440, 380, 320, 260, 200];

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let convo = at('--resume') || at('--session-id') || '';
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), ...o }) + '\\n');
report({ kind: 'spawn', tab: process.env.DREAMCONTEXT_TAB_SESSION || '' });
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
let session = 'v-' + process.pid;
let inited = false;
let rotations = 0;
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [];
    for (const n of ['one', 'two']) steps.push(cli('super', 'delegate', '--prompt', 'CHILD ' + n, '--brief', 'Child ' + n + ' rebuilds the invoice export with a very long title that cannot fit'));
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  return 'ok';
}
function clear() {
  // What the CLI does with /clear: a new conversation, SessionStart(source=clear) in the pane's env.
  rotations += 1;
  const from = session;
  session = 'v-' + process.pid + '-r' + rotations;
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  const hook = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, 'hook', 'session-start'], {
    env: process.env, encoding: 'utf-8', timeout: 60000, cwd: process.cwd(),
    input: JSON.stringify({ source: 'clear', session_id: session, hook_event_name: 'SessionStart', cwd: process.cwd() }),
  });
  report({ kind: 'clear', from, to: session, hookStatus: hook.status, banner: (hook.stdout || '').split('\\n').filter((l) => l.startsWith('>> HANDOFF') || l.includes('.super/handoff.md')).slice(0, 4) });
}
async function turn(blocks) {
  const text = blocks[0] ?? '';
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  if (text === '/clear') {
    clear();
    out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
    return;
  }
  let said = 'ok';
  try { said = role === 'super' ? superTurn(text) : 'ok'; } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }], usage: { input_tokens: 10, cache_read_input_tokens: 40000, output_tokens: 5 } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
}
let buf = '';
let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    chain = chain.then(() => turn(blocks));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
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
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
}

/** What the eye checks on one head: its height, the name's line count, every item inside the
 *  head's box and clear of its neighbours, no sideways scroll. Painted boxes, not styles. */
function measureHead(head) {
  const box = head.getBoundingClientRect();
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const items = [...head.querySelectorAll('*')].filter((el) => shown(el) && !el.closest('.super-fresh-error'))
    .filter((el) => el.parentElement === head || el.parentElement?.classList.contains('super-fresh') || el.parentElement?.classList.contains('super-dock-actions'));
  const outside = [];
  for (const el of items) {
    const r = el.getBoundingClientRect();
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) outside.push(`${el.className || el.tagName} ${Math.round(r.left)}-${Math.round(r.right)}x${Math.round(r.top)}-${Math.round(r.bottom)}`);
  }
  const rows = items.filter((el) => el.parentElement === head).map((el) => ({ el, r: el.getBoundingClientRect() })).sort((a, b) => a.r.left - b.r.left);
  const overlaps = [];
  for (let i = 1; i < rows.length; i++) if (rows[i].r.left < rows[i - 1].r.right - 0.5) overlaps.push(`${rows[i - 1].el.className} / ${rows[i].el.className}`);
  const lines = (el) => { if (!el) return 0; const range = document.createRange(); range.selectNodeContents(el); return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size; };
  const name = head.querySelector('.super-centre-name, .super-card-large-title, .super-card-title');
  const sub = head.querySelector('.super-centre-sub');
  const fresh = head.querySelector('[data-testid="super-fresh-btn"]');
  const label = fresh?.querySelector('.super-fresh-btn-label');
  return {
    height: Math.round(box.height), width: Math.round(box.width),
    nameLines: lines(name), nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
    subShown: !!sub && shown(sub), freshLabel: !!label && shown(label), freshAria: fresh?.getAttribute('aria-label') ?? null,
    scrolls: head.scrollWidth > head.clientWidth + 1, outside, overlaps,
  };
}

async function checkHead(page, tag, what, w) {
  const m = await page.locator('[data-testid="super-centre"] .super-centre-head').evaluate(measureHead);
  ok(tag(`${what} @${w}: one 40 px row, name on one line, nothing outside or overlapping`),
    m.height === 40 && m.nameLines === 1 && !m.scrolls && m.outside.length === 0 && m.overlaps.length === 0, JSON.stringify(m));
  return m;
}

async function run(engineName, base) {
  const { chromium, webkit } = await import('playwright');
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const tag = (s) => `[${engineName}] ${s}`;

  console.log(`\n── ${engineName}: hand over, two children`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('the handover arranged the stage'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
  const centre = page.getByTestId('super-centre');
  ok(tag('the centre head is drawn'), await until(page, async () => (await centre.locator('.super-centre-head .super-fresh-btn').count()) === 1, 20000));
  await page.waitForTimeout(1500);

  console.log(`── ${engineName}: the centre at every card width`);
  const seen = [];
  for (const w of WIDTHS) {
    await centre.evaluate((el, px) => { el.style.setProperty('width', `${px}px`, 'important'); }, w);
    await page.waitForTimeout(250);
    const m = await checkHead(page, tag, 'centre', w);
    seen.push({ w, ...m });
    await centre.locator('.super-centre-head').screenshot({ path: join(OUT, `${engineName}-head-${w}.png`) });
  }
  const wide = seen[0];
  const narrow = seen[seen.length - 1];
  ok(tag('H2 wide: the whole name, the subtitle and New session with its word'), wide.subShown && wide.freshLabel && !wide.nameClipped, JSON.stringify(wide));
  ok(tag('H2 narrow: the subtitle is gone, New session is its glyph with an aria-label'), !narrow.subShown && !narrow.freshLabel && !!narrow.freshAria, JSON.stringify(narrow));
  const firstNoSub = seen.find((s) => !s.subShown)?.w ?? 0;
  const firstClip = seen.find((s) => s.nameClipped)?.w ?? 0;
  ok(tag('H2 the subtitle goes before the name is cut'), firstNoSub >= firstClip, JSON.stringify(seen.map(({ w, subShown, freshLabel, nameClipped }) => ({ w, subShown, freshLabel, nameClipped }))));
  await centre.evaluate((el) => { el.style.removeProperty('width'); });

  console.log(`── ${engineName}: phone 390 px, and the child cards`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  if (await centre.locator('.super-centre-head:visible').count()) {
    await checkHead(page, tag, 'H3 centre on a phone', 390);
  } else ok(tag('H3 the phone draws the centre head'), false);
  await page.screenshot({ path: join(OUT, `${engineName}-phone-390.png`) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1200);
  const cardHeads = await page.locator('.super-card-head:visible, .super-card-large-head:visible').evaluateAll((els, fn) => els.map((el) => {
    const m = new Function(`return (${fn})`)()(el);
    return { h: m.height, lines: m.nameLines, scrolls: m.scrolls, outside: m.outside, overlaps: m.overlaps };
  }), measureHead.toString());
  ok(tag(`H3 ${cardHeads.length} child card heads: title one line, nothing spills`), cardHeads.length > 0 && cardHeads.every((c) => c.lines <= 1 && !c.scrolls && c.outside.length === 0 && c.overlaps.length === 0), JSON.stringify(cardHeads));
  await page.screenshot({ path: join(OUT, `${engineName}-stage-1440.png`) });

  ok(tag('no console errors'), errors.length === 0, errors.slice(0, 5).join('\n'));
  await browser.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const engine of ENGINES) {
    setupScratch();
    const port = await freePort();
    const srv = await startServer(port);
    try { await run(engine, `http://127.0.0.1:${port}`); }
    catch (e) { ok(`[${engine}] ran to the end`, false, e?.stack ?? e); }
    finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
  }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  console.log(`screenshots: ${OUT}`);
  if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
