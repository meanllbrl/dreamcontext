#!/usr/bin/env node
/**
 * A CROWDED SUPER STAGE KEEPS THE CHAT'S WIDTH (owner 2026-11-06 00:21: "bu size paylaşımı yine
 * saçmaladı, birden buna döndü" + a recording of his hands fixing it). Eight live jobs, the agenda
 * and a large web card stood beside a wide chat; a ninth job opened a third column on one side and
 * the chat lost about 370 px. His drags re-ran the same solve and the chat jumped wide and narrow.
 *
 *   npm run build && node scripts/verify/super-stage-crowd.mjs
 *   DC_CLI=<a build before the change>/dist/index.js TAG=before node scripts/verify/super-stage-crowd.mjs
 *
 * WHAT IT DRIVES: the real dashboard on a scratch HOME (Chromium, dark), a stand-in `claude` (no
 * tokens, everything fictional, "Pocket Ledger"): the window hands over, then the script plays the
 * Super through its CLI: the agenda opened large with notes, a web page opened large and floated,
 * three pictures put in Others, and HOLD jobs delegated one by one (each keeps working).
 *
 * WHAT IT PROVES, at 1800x1080 and 1440x900: (1) from 8 to 12 live jobs the chat's width does not
 * change; (2) every live job is on the stage or in the "more" pill beside Others, never only in the
 * Others stack; (3) no card over the chat or another card; (4) the owner's dropped job and his
 * sized web card (through the window's own route, POST /api/super/layout) keep their place and
 * size as more jobs open, and the chat its width. Screenshots: $OUT/<tag>-<w>-<n>.png.
 * Exit 0 iff all pass (TAG=before only records: the old build is expected to fail).
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const TAG = process.env.TAG || 'after';
const OUT = process.env.OUT || join(REPO, 'tmp', 'verify-super-stage-crowd');
const STRICT = TAG !== 'before';
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-super-crowd-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const TOKEN_FILE = join(SCRATCH, 'super-env.json');
const PICS = ['mockups/checkout.png', 'mockups/receipts.png', 'mockups/ledger.png'];
const BRIEFS = [
  'Coupon field on checkout', 'Receipt currency setting', 'Export receipts as CSV', 'Monthly report layout',
  'Login rate limit', 'Invoice PDF footer', 'Budget alerts copy', 'Category icons', 'Recurring payments',
  'Search by merchant', 'Dark mode chart colors', 'Backup reminder',
];

const STANDIN = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = (await import('node:fs')).readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || ('verify-' + role + '-' + process.pid);
let busy = false;
let buf = '';
const finish = (said) => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  busy = false;
};
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user' || busy) continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    busy = true;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    if (role === 'super') {
      if (blocks.some((b) => b.startsWith('[super handover]'))) writeFileSync(${JSON.stringify(TOKEN_FILE)}, JSON.stringify({ url: process.env.DREAMCONTEXT_WINDOW_URL, token: process.env.DREAMCONTEXT_WINDOW_TOKEN }));
      finish('On it.');
      continue;
    }
    // Every job keeps working: a tool call that never returns.
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-' + Date.now(), name: 'Bash', input: { command: 'npm test' } }] } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(250); }
  return false;
};
let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (!STRICT) { console.log(`  ${cond ? '·' : '!'} ${label}${cond ? '' : ` — ${String(detail ?? '').slice(0, 400)}`}`); return !!cond; }
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 700)}` : ''}`); }
  return !!cond;
};

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, 'mockups'), join(PROJ, 'pages'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'classic' }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, titleMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  spawnSync(process.execPath, [CLI, 'init', '-y', '--name', 'pocket-ledger', '--description', 'A fictional ledger app for the crowded-stage check'], { cwd: PROJ, env: env(), encoding: 'utf-8' });
  const claude = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(claude, STANDIN);
  chmodSync(claude, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  const imgs = ['diagram-loop.png', 'diagram-memory.png', 'diagram-loop.png'];
  PICS.forEach((p, i) => copyFileSync(join(REPO, 'public', 'image', imgs[i]), join(PROJ, p)));
  writeFileSync(join(PROJ, 'pages', 'missed.html'), '<!doctype html><html><body style="font:16px system-ui;background:#111;color:#eee;padding:24px"><h1>Pocket Ledger: missed topics</h1><p>Five topics got no answer in the last hour.</p></body></html>');
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
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

const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [], children: {} }; } };
const superCli = (...args) => {
  const e = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  const r = spawnSync(process.execPath, [CLI, 'super', ...args], { cwd: PROJ, env: { ...env(), DREAMCONTEXT_WINDOW_URL: e.url, DREAMCONTEXT_WINDOW_TOKEN: e.token }, encoding: 'utf-8', timeout: 90_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, json };
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
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
const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
};

/** The stage as drawn: the centre, every floating card, the Others and "more" pills. */
const measure = (page) => page.evaluate(() => {
  const st = document.querySelector('[data-testid="super-surface"]');
  const s = st.getBoundingClientRect();
  const rel = (r) => ({ x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), w: Math.round(r.width), h: Math.round(r.height) });
  const centre = rel(st.querySelector('[data-testid="super-centre"]').getBoundingClientRect());
  const cards = [...st.querySelectorAll('[data-testid="super-container"]')].map((e) => ({
    id: e.dataset.containerId, where: e.dataset.where, size: e.dataset.size, owner: e.dataset.owner === 'true', ...rel(e.getBoundingClientRect()),
  }));
  const pill = (id) => { const e = st.querySelector(`[data-testid="${id}"]`); return e ? { ...rel(e.getBoundingClientRect()), n: Number(e.querySelector('.super-others-count')?.textContent || 0) } : null; };
  return { stage: { w: Math.round(s.width), h: Math.round(s.height) }, centre, cards, others: pill('super-others'), more: pill('super-more') };
});
const hit = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

async function owner(page, patch) {
  return page.evaluate(async (p) => {
    const res = await fetch('/api/super/layout', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Dreamcontext-Vault': 'pocket-ledger' }, body: JSON.stringify(p) });
    return res.status;
  }, patch);
}

let server = null;
let browser = null;
const errors = [];
try {
  const { chromium } = await import('@playwright/test');
  console.log(`· build: ${CLI}  tag: ${TAG}`);
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1080 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));

  console.log('\n── hand over; the agenda, a large web page, three pictures in Others');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the Super stage is drawn', await until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the Super is up', await until(async () => existsSync(TOKEN_FILE), 60000));
  superCli('open', 'agenda', '--size', 'large');
  for (const [sec, text] of [['waiting', 'Pick the receipt currency'], ['waiting', 'Approve the coupon copy'], ['now', 'Eight jobs are running'], ['now', 'Export check after the CSV job']]) superCli('note', 'add', sec, text);
  const w = superCli('open', 'web', 'pages/missed.html', '--size', 'large', '--title', 'Pocket Ledger: missed topics');
  const webId = () => record().containers.find((c) => c.kind === 'web')?.id;
  ok('the web card opened', await until(async () => !!webId(), 20000), w.out);
  superCli('float', webId());
  superCli('open', 'image', ...PICS, '--no-group');
  await until(async () => record().containers.filter((c) => c.kind === 'image').length === 3, 20000);
  for (const c of record().containers.filter((k) => k.kind === 'image')) superCli('stack', c.id);
  await dismiss(page);
  // As on his screen: the web card floating among the jobs (not side by side), the agenda open.
  await owner(page, { view: { mode: 'float' }, agenda: 'open', cards: [{ id: webId(), place: 'float' }] });
  await page.waitForTimeout(1500);
  const rec = record();
  ok('the agenda and the web card float on the stage', rec.view?.mode === 'float' && rec.containers.some((c) => c.kind === 'agenda' && c.place === 'float' && !c.min)
    && rec.containers.some((c) => c.kind === 'web' && c.place === 'float'), JSON.stringify({ view: rec.view, cards: rec.containers.map((c) => [c.kind, c.place, c.size, c.min]) }));

  const jobs = [];
  const delegate = async (i) => {
    const d = superCli('delegate', '--prompt', `HOLD ${BRIEFS[i]}.`, '--brief', BRIEFS[i]);
    jobs.push({ sid: d.json?.sessionId, card: d.json?.container });
    return d.status === 0 && !!d.json?.sessionId;
  };
  const live = () => jobs.filter((j) => record().children?.[j.sid]?.row === 'working').length;
  for (let i = 0; i < 8; i++) await delegate(i);
  ok('eight jobs are working', await until(async () => live() === 8, 60000), String(live()));

  const runs = {};
  for (const [vw, vh] of [[1800, 1080], [1440, 900]]) {
    await page.setViewportSize({ width: vw, height: vh });
    await page.waitForTimeout(1500);
    runs[vw] = await measure(page);
    await page.screenshot({ path: join(OUT, `${TAG}-${vw}-8.png`) });
  }
  console.log('\n── the ninth to the twelfth job open; the chat keeps its width');
  for (let n = 9; n <= 12; n++) {
    await delegate(n - 1);
    await until(async () => live() === n, 30000);
    for (const [vw, vh] of [[1800, 1080], [1440, 900]]) {
      await page.setViewportSize({ width: vw, height: vh });
      await page.waitForTimeout(1500);
      const m = await measure(page);
      if (n === 9 || n === 12) await page.screenshot({ path: join(OUT, `${TAG}-${vw}-${n}.png`) });
      ok(`${vw}: ${n} jobs, the chat keeps ${runs[vw].centre.w} px`, Math.abs(m.centre.w - runs[vw].centre.w) <= 1, `now ${m.centre.w}`);
      const floating = m.cards.filter((c) => c.where === 'float');
      const placed = jobs.filter((j) => floating.some((c) => c.id === j.card)).length;
      ok(`${vw}: ${n} jobs, each on the stage or in the "more" pill`, placed + (m.more?.n ?? 0) >= n, `on stage ${placed}, more ${m.more?.n ?? 0}`);
      const bad = floating.filter((c) => hit(c, m.centre) || floating.some((d) => d.id < c.id && hit(c, d)));
      ok(`${vw}: ${n} jobs, nothing over the chat or another card`, bad.length === 0, JSON.stringify(bad.map((c) => c.id)));
    }
  }

  console.log('\n── the owner drops a job and sizes the web card; more jobs open');
  await page.setViewportSize({ width: 1800, height: 1080 });
  await page.waitForTimeout(500);
  await owner(page, { cards: [{ id: jobs[0].card, pos: { x: 0, y: 0 } }, { id: webId(), place: 'float', pos: { x: 0, y: 0.45 }, size: 'large' }] });
  await page.waitForTimeout(2500);
  const mine = await measure(page);
  await page.screenshot({ path: join(OUT, `${TAG}-1800-owner-before.png`) });
  const pick = (m, id) => m.cards.find((c) => c.id === id);
  for (const extra of ['Spending forecast', 'Shared wallets', 'Receipt scanner']) { BRIEFS.push(extra); await delegate(BRIEFS.length - 1); }
  await page.waitForTimeout(4000);
  const after = await measure(page);
  await page.screenshot({ path: join(OUT, `${TAG}-1800-owner-after.png`) });
  const same = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
  ok('his dropped job stays where he put it', same(pick(mine, jobs[0].card), pick(after, jobs[0].card)), JSON.stringify([pick(mine, jobs[0].card), pick(after, jobs[0].card)]));
  ok('his web card keeps its place and size', same(pick(mine, webId()), pick(after, webId())), JSON.stringify([pick(mine, webId()), pick(after, webId())]));
  ok('the chat keeps its width', Math.abs(mine.centre.w - after.centre.w) <= 1, `${mine.centre.w} -> ${after.centre.w}`);
  writeFileSync(join(OUT, `${TAG}-metrics.json`), JSON.stringify({ runs, mine, after }, null, 2));
  ok('no console error', errors.length === 0, errors.join('\n'));
} catch (err) {
  fails.push(String(err?.stack || err));
  console.log(`  ✗ ${String(err?.stack || err).slice(0, 900)}`);
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  await sleep(500);
  spawnSync('pkill', ['-f', SCRATCH]);
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\n${STRICT ? `${pass} passed ${fails.length} failed` : 'recorded (before)'}  shots: ${OUT}`);
process.exit(STRICT && fails.length ? 1 : 0);
