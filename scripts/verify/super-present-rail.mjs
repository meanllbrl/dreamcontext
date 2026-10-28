#!/usr/bin/env node
/**
 * LIVE JOBS BESIDE A PRESENTATION KEEP ONE COLUMN (owner 2026-10-28, task super-sahnesi-pencere-
 * boyutunda-dogru-yerlesir…, item 5: "in Grid the live cards took two columns and squeezed the
 * Super chat"). Harness derived from super-live-card.mjs.
 *
 *   npm run build && node scripts/verify/super-present-rail.mjs
 *   ENGINE=webkit TAG=after OUT=<dir> node scripts/verify/super-present-rail.mjs
 *   DC_BUILD=<a checkout built before the change> TAG=before node scripts/verify/super-present-rail.mjs
 *
 * WHAT IT DRIVES: the real dashboard on a scratch HOME, Chromium or WebKit, a stand-in `claude`:
 * as the Super it opens four pictures on hand-over; seven children delegated by its token work a
 * long build the whole run. The Super presents the four pictures in Grid.
 *
 * WHAT IT PROVES, at 1140x710, 1440x900, 1600x1100 and 1920x1080: the live jobs left of the chat
 * stand in ONE column; the ones it cannot hold wait in the "more" tile at its foot, lit by their
 * live status, and open in its panel; none overlaps the chat; the chat keeps its 480 px floor and
 * its head one row; leaving the presentation the tile is gone. Screenshots: $OUT/<tag>-<engine>-
 * present-*.png. Exit 0 iff all pass (TAG=before only records).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD = process.env.DC_BUILD || REPO;
const ENGINE = process.env.ENGINE || 'chromium';
const TAG = process.env.TAG || 'after';
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-present-rail-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(BUILD, 'dist', 'index.js');
const OUT = process.env.OUT || join(REPO, 'tmp', 'super-present-rail');
const TOKEN_FILE = join(SCRATCH, 'super-env.json');
const PICS = Array.from({ length: 4 }, (_, i) => `mockups/shot-${String(i + 1).padStart(2, '0')}.png`);
const CHILD_WORK_MS = 900_000;

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-' + role + '-' + process.pid;
const cli = (...args) => spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
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
      if (blocks.some((b) => b.startsWith('[super handover]'))) {
        writeFileSync(${JSON.stringify(TOKEN_FILE)}, JSON.stringify({ url: process.env.DREAMCONTEXT_WINDOW_URL, token: process.env.DREAMCONTEXT_WINDOW_TOKEN }));
        // One by one until the stage is full (the agenda and the owner's chat float too).
        for (const pic of ${JSON.stringify(PICS)}) { if (cli('super', 'open', 'image', pic, '--no-group').status !== 0) break; }
      }
      finish('SUPER ok');
      continue;
    }
    // A child: a long build, quiet the whole time (a tool runs, nobody touches its card).
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-' + Date.now(), name: 'Bash', input: { command: 'npm run build' } }] } });
    setTimeout(() => finish('CHILD built'), ${CHILD_WORK_MS});
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'mockups'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  const src = ['diagram-recall.png', 'diagram-loop.png', 'diagram-memory.png', 'diagram-architecture.png', 'diagram-howitworks.png'];
  PICS.forEach((rel, i) => copyFileSync(join(REPO, 'public', 'image', src[i % src.length]), join(PROJ, rel)));
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'],
  });
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

const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [], groups: [], children: {} }; } };
const floatCount = (r) => {
  const grouped = new Set((r.groups ?? []).flatMap((g) => g.cards));
  return r.containers.filter((c) => c.place === 'float' && !c.min && !grouped.has(c.id)).length + (r.groups ?? []).filter((g) => g.place === 'float').length;
};
/** A `super` verb as the Super Agent (its window token). */
const superCli = (...args) => {
  const e = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  const r = spawnSync(process.execPath, [CLI, 'super', ...args], { cwd: PROJ, env: { ...env(), DREAMCONTEXT_WINDOW_URL: e.url, DREAMCONTEXT_WINDOW_TOKEN: e.token }, encoding: 'utf-8', timeout: 90_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, json };
};

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(250); }
  return false;
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


const shot = async (page, name) => { await page.waitForTimeout(900); const p = join(OUT, `${TAG}-${ENGINE}-present-${name}.png`); await page.screenshot({ path: p }); return p; };
const STRICT = TAG !== 'before';
const check = (label, cond, detail) => (STRICT ? ok(label, cond, detail) : (console.log(`  ${cond ? '·' : '!'} ${label}${cond ? '' : ` — ${String(detail ?? '').slice(0, 300)}`}`), cond));
const hit = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
const settle = (page) => until(async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));
const measure = (page, chats) => page.evaluate((chats) => {
  const st = document.querySelector('[data-testid="super-surface"]');
  const s = st.getBoundingClientRect();
  const rel = (r) => ({ x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), w: Math.round(r.width), h: Math.round(r.height) });
  const centre = rel(st.querySelector('[data-testid="super-centre"]').getBoundingClientRect());
  const head = st.querySelector('[data-testid="super-centre"] .super-centre-head');
  const name = st.querySelector('[data-testid="super-centre"] .super-centre-name');
  const tiles = chats.map((id) => st.querySelector(`[data-testid="super-container"][data-container-id="${id}"]`)).filter((e) => e && e.dataset.where === 'float').map((e) => ({ id: e.dataset.containerId, ...rel(e.getBoundingClientRect()) }));
  const more = st.querySelector('[data-testid="super-more"]');
  return {
    stage: { w: Math.round(s.width), h: Math.round(s.height) }, mode: st.dataset.mode, centre, tiles,
    headH: head ? Math.round(head.getBoundingClientRect().height) : null,
    nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '20')) : null,
    more: more ? { ...rel(more.getBoundingClientRect()), count: Number(more.querySelector('.super-others-count')?.textContent || 0), dots: more.querySelectorAll('[data-status="working"], .super-others-dot[data-status]').length } : null,
    others: Number(st.querySelector('[data-testid="super-others"] .super-others-count')?.textContent || 0),
  };
}, chats);

let server = null;
let browser = null;
let lastPage = null;
const errors = [];
try {
  const pw = await import('@playwright/test');
  setupScratch();
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw[ENGINE].launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, colorScheme: 'dark' });
  const page = await context.newPage();
  lastPage = page;
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\n── hand over (${ENGINE}, ${TAG}): four pictures, then seven jobs`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super opened four pictures', await until(async () => record().containers.filter((c) => c.kind === 'image').length === 4, 60000));
  const briefs = ['export build', 'ledger import', 'share sheet', 'crash fix', 'cleanup tool', 'screens', 'key metrics'];
  const kids = [];
  for (const b of briefs) {
    const d = superCli('delegate', '--prompt', `Work on the Pocket Ledger ${b}.`, '--brief', b);
    if (d.json?.sessionId) kids.push(d.json.sessionId);
  }
  ok('seven jobs delegated', kids.length === 7, kids.join(','));
  ok('all seven work', await until(async () => kids.every((k) => record().children?.[k]?.row === 'working'), 60000), JSON.stringify(kids.map((k) => record().children?.[k]?.row)));
  const chats = record().containers.filter((c) => c.kind === 'chat' && kids.includes(c.ref)).map((c) => c.id);
  ok('seven job cards', chats.length === 7, JSON.stringify(record().containers.map((c) => [c.kind, c.ref])));
  const pics = record().containers.filter((c) => c.kind === 'image').map((c) => c.id);
  const pr = superCli('present', ...pics, '--layout', 'grid');
  ok('the super presents the four pictures in Grid', pr.status === 0, pr.out);
  await until(async () => (await page.locator('[data-testid="super-surface"][data-mode="present"]').count()) === 1, 10000);
  await settle(page);

  for (const [w, h] of [[1140, 710], [1440, 900], [1600, 1100], [1920, 1080]]) {
    const name = `${w}x${h}`;
    console.log(`\n── Grid at ${name}`);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    await settle(page);
    const m = await measure(page, chats);
    await shot(page, `${name}-grid`);
    console.log(`  · stage ${m.stage.w}x${m.stage.h}; centre ${m.centre.w} wide, head ${m.headH}px; ${m.tiles.length} tiles in ${new Set(m.tiles.map((t) => t.x)).size} column(s); more ${JSON.stringify(m.more)}; others ${m.others}`);
    check(`${name}: the live jobs stand in at most one column`, new Set(m.tiles.map((t) => t.x)).size <= 1, JSON.stringify(m.tiles.map((t) => t.x)));
    check(`${name}: the chat keeps its 480 px floor and a one-row head`, m.centre.w >= 478 && (m.headH ?? 99) <= 42, JSON.stringify({ w: m.centre.w, head: m.headH }));
    const bad = m.tiles.filter((t) => hit(t, m.centre) || (m.more && hit(t, m.more)) || t.y < 0 || t.y + t.h > m.stage.h + 1).map((t) => t.id);
    check(`${name}: no job tile overlaps the chat or the tile, none off the stage`, bad.length === 0, bad.join(','));
    if (m.tiles.length) check(`${name}: every job is a tile or in the "more" tile (${m.tiles.length} + ${m.more?.count ?? 0} of 7)`, m.tiles.length + (m.more?.count ?? 0) === 7, JSON.stringify(m));
    else check(`${name}: no room for a column beside the chat: the jobs lead Others (${m.others})`, m.others >= 7, JSON.stringify(m));
    if (m.more) {
      check(`${name}: the "more" tile shows its jobs' live status`, m.more.dots > 0, JSON.stringify(m.more));
      check(`${name}: the "more" tile sits under the column, left of the chat`, m.more.x + m.more.w <= m.centre.x && m.more.y + m.more.h <= m.stage.h, JSON.stringify(m.more));
    }
  }

  await page.setViewportSize({ width: 1600, height: 1100 });
  await settle(page);
  const moreBtn = page.locator('[data-testid="super-more-stack"]').first();
  if (await moreBtn.count()) {
    await moreBtn.click();
    await page.waitForTimeout(700);
    const items = await page.locator('[data-testid="super-group-panel"] [data-testid="super-group-item"]').count();
    check('the "more" tile opens its jobs in a panel', items > 0, String(items));
    await shot(page, '1600x1100-more-open');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
    check('Escape closes the panel and gives focus back to the "more" tile', focused === 'super-more-stack', focused);
  } else check('the "more" tile is there at 1600x1100', false, 'none');

  console.log('\n── leaving the presentation');
  superCli('present', '--off');
  await until(async () => (await page.locator('[data-testid="super-surface"][data-mode="float"]').count()) === 1, 10000);
  await settle(page);
  await shot(page, '1600x1100-after-present');
  check('the "more" tile is gone with the presentation', (await page.locator('[data-testid="super-more"]').count()) === 0);
  const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|posthog|Content Security Policy|Refused to/i.test(e));
  ok('no console errors from the app', real.length === 0, real.slice(0, 5).join('\n'));
} catch (e) {
  fails.push(`crashed: ${e && e.stack ? e.stack : e}`);
  console.log(`  ✗ crashed: ${e && e.stack ? e.stack : e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, `${TAG}-${ENGINE}-present-crash.png`) }).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `:\n  - ${fails.join('\n  - ')}` : ''}\nScreenshots: ${OUT}`);
process.exit(fails.length ? 1 : 0);
