#!/usr/bin/env node
/**
 * A live job is always a floating card on the Super stage (task super-canli-kart-sahnede, owner
 * 2026-10-23, said many times: "running jobs' cards keep not being floating on the stage").
 *
 *   npm run build && node scripts/verify/super-live-card.mjs
 *
 * WHAT IT DRIVES — the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium, and a scripted stand-in `claude`: as the Super Agent it fills the stage
 * with 12 pictures on hand-over and hands this script its window token; as a child it works for
 * CHILD_WORK_MS on every message (a long build: no owner touch). No tokens spent; everything is
 * fictional ("Pocket Ledger").
 *
 * WHAT IT PROVES, each one path that used to put a live job's card in Others:
 *  1. stage cap: delegating on a full stage (12) floats the child's card; a picture gives way;
 *  2. the Super cannot stack it (409 live_child);
 *  3. the tidy (idle bar shortened to 15 s for the check) moves untouched pictures, never the
 *     working child's card;
 *  4. side by side: the child's card is DRAWN floating, left of the centre, beside the page
 *     (1440 px), and leads the Others stack on a narrow (390 px) window;
 *  5. a finished job may go to Others; when it runs again (`super send`) its card comes back.
 * Screenshots: tmp/super-live-card/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-live-card-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-live-card');
const TOKEN_FILE = join(SCRATCH, 'super-env.json');
const PICS = Array.from({ length: 12 }, (_, i) => `mockups/shot-${String(i + 1).padStart(2, '0')}.png`);
const IDLE_MS = 20_000;
const CHILD_WORK_MS = 75_000;

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
    cwd: PROJ, env: { ...env(), PATH, DREAMCONTEXT_SUPER_TIDY_IDLE_MS: String(IDLE_MS), DREAMCONTEXT_SUPER_TIDY_TICK_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'],
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

/** The card as the stage DRAWS it: visible, and its box. */
const drawn = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return { w: r.width, h: r.height, x: r.x, visible: r.width > 40 && r.height > 40 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.2 };
}).catch(() => null);
/** The owner's hand: press a card, move it in steps, release at (x, y) (page coordinates). */
async function dragTo(page, id, x, y) {
  const el = page.locator(`[data-testid="super-container"][data-container-id="${id}"]`).first();
  const b = await el.boundingBox();
  // Pressed low on the card: its hover toolbar (buttons) sits at the top.
  const sx = b.x + b.width / 2;
  const sy = b.y + b.height * 0.75;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(sx + ((x - sx) * i) / 12, sy + ((y - sy) * i) / 12);
  await page.mouse.up();
  await page.waitForTimeout(1500);
}
const centreBox = (page) => page.locator('.super-centre').first().evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, w: r.width }; }).catch(() => null);

let server = null;
let browser = null;
let lastPage = null;
const errors = [];
try {
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  lastPage = page;
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── hand over: the super fills the stage with 12 pictures');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super filled the stage with pictures (12 floating items)', await until(async () => floatCount(record()) === 12 && record().containers.some((c) => c.kind === 'image'), 60000),
    JSON.stringify(record().containers.map((c) => [c.kind, c.place])));

  console.log('\n── 1. the stage cap: a new job on a full stage floats');
  const d = superCli('delegate', '--prompt', 'Build the Pocket Ledger export and run its tests.', '--brief', 'export build');
  const child = d.json?.sessionId;
  ok('delegate answered card: opened', d.status === 0 && d.json?.card === 'opened', d.out);
  const chatId = d.json?.container;
  const rec1 = record();
  ok('the child\'s card floats in the record', rec1.containers.find((c) => c.id === chatId)?.place === 'float', JSON.stringify(rec1.containers.find((c) => c.id === chatId)));
  ok('…a picture went to Others to make room; the stage holds 12', rec1.containers.filter((c) => c.kind === 'image' && c.place === 'others').length === 1 && floatCount(rec1) === 12, `float ${floatCount(rec1)}`);
  ok('the child works', await until(async () => record().children?.[child]?.row === 'working', 30000), JSON.stringify(record().children?.[child]));
  await page.waitForTimeout(2500);
  const full = await drawn(page, chatId);
  const floatingDrawn = await page.locator('[data-testid="super-container"][data-where="float"]').count();
  // More floats in the record than the stage can draw: the stage draws the overflow in Others
  // (pictures, in record order) and keeps the working job, added last, on the stage (AC5).
  const recordFloats = record().containers.filter((c) => c.place === 'float').length;
  ok('the over-full stage still DRAWS the working job floating (others overflowed instead)', !!full?.visible && floatingDrawn < recordFloats,
    JSON.stringify({ full, floatingDrawn, recordFloats }));
  await page.screenshot({ path: join(OUT, '0-full-stage-live-1440.png') });

  console.log('\n── 2. the Super cannot stack a live job');
  const st = superCli('stack', chatId);
  ok('super stack answers live_child', st.status !== 0 && /live_child/.test(st.out), st.out);
  ok('…and the card still floats', record().containers.find((c) => c.id === chatId)?.place === 'float');
  // Two more jobs, for the presentation with three live jobs.
  const more = ['Write the ledger import.', 'Fix the share sheet.'].map((prompt, i) => superCli('delegate', '--prompt', prompt, '--brief', ['import', 'share sheet'][i]));
  const moreIds = more.map((m) => m.json?.container).filter(Boolean);
  ok('two more jobs started with floating cards', moreIds.length === 2 && moreIds.every((id) => record().containers.find((c) => c.id === id)?.place === 'float'), more.map((m) => m.out).join('\n'));

  console.log(`\n── 3. the tidy (idle bar ${IDLE_MS / 1000} s): untouched pictures go, the working job stays`);
  const tidied = await until(async () => record().containers.filter((c) => c.kind === 'image' && c.place === 'others').length >= 4, 45000);
  const rec3 = record();
  ok('the tidy ran (untouched pictures are in Others)', tidied, JSON.stringify(rec3.containers.map((c) => [c.kind, c.place])));
  ok('the working child\'s card is still floating', rec3.containers.find((c) => c.id === chatId)?.place === 'float' && rec3.children?.[child]?.row === 'working', JSON.stringify(rec3.children?.[child]));

  console.log('\n── 4. side by side: the live job is drawn beside the page');
  const page1 = rec3.containers.find((c) => c.kind === 'image' && c.place === 'float') ?? rec3.containers.find((c) => c.kind === 'image');
  const h = superCli('half', page1.id);
  ok('super half opened a picture side by side', h.status === 0, h.out);
  await page.waitForTimeout(3500);
  const box = await drawn(page, chatId);
  const centre = await centreBox(page);
  ok('the child\'s card is drawn (visible) while a page is side by side', !!box?.visible, JSON.stringify(box));
  ok('…left of the centre, not over it', !!box && !!centre && box.x + box.w <= centre.x + 1, JSON.stringify({ box, centre }));
  await page.screenshot({ path: join(OUT, '1-half-live-1440.png') });
  // A rail tile dropped on the page is no move: no hidden position, no group (end review r1).
  const pageBox = await page.locator(`[data-testid="super-container"][data-container-id="${page1.id}"]`).first().boundingBox();
  await dragTo(page, chatId, pageBox.x + pageBox.width / 2, pageBox.y + pageBox.height / 2);
  const afterDrag = record().containers.find((c) => c.id === chatId);
  ok('a rail tile dropped on the page wrote no position and no group', afterDrag && !afterDrag.pos && !(record().groups ?? []).some((g) => g.cards.includes(chatId)), JSON.stringify(afterDrag));
  const pics = record().containers.filter((c) => c.kind === 'image').map((c) => c.id).slice(0, 2);
  const pr = superCli('present', ...pics);
  ok('super present opened two pictures', pr.status === 0, pr.out);
  await page.waitForTimeout(3500);
  const pc = await centreBox(page);
  const three = await Promise.all([chatId, ...moreIds].map((id) => drawn(page, id)));
  ok('present: all three live jobs are drawn, left of the centre', three.every((b) => b?.visible && pc && b.x + b.w <= pc.x + 1), JSON.stringify({ three, pc }));
  await page.screenshot({ path: join(OUT, '1b-present-3-live-1440.png') });
  superCli('present', '--off');
  h.status === 0 && superCli('half', page1.id);
  await page.waitForTimeout(1500);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, '2-narrow-390.png') });
  const othersOpen = page.locator('[data-testid="super-others"]').first();
  if (await othersOpen.count()) { await othersOpen.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
  await page.screenshot({ path: join(OUT, '3-narrow-others-390.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  superCli('half', '--off');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT, '4-float-live-1440.png') });

  console.log('\n── 5. a finished job may go; running again, it comes back');
  ok('the child finished its build', await until(async () => record().children?.[child]?.row === 'done', CHILD_WORK_MS + 60000), JSON.stringify(record().children?.[child]));
  const st2 = superCli('stack', chatId);
  ok('super stack of the finished job works', st2.status === 0 && record().containers.find((c) => c.id === chatId)?.place === 'others', st2.out);
  const s = superCli('send', child, 'Run the export tests once more.');
  ok('super send woke it', s.status === 0, s.out);
  ok('running again, its card is back on the stage', await until(async () => record().containers.find((c) => c.id === chatId)?.place === 'float', 30000),
    JSON.stringify({ card: record().containers.find((c) => c.id === chatId), child: record().children?.[child] }));
  await page.waitForTimeout(2500);
  ok('…and drawn floating', !!(await drawn(page, chatId))?.visible);
  await page.screenshot({ path: join(OUT, '5-back-1440.png') });

  console.log('\n── 6. the owner\'s own hand: a working job he drags to Others stays there');
  ok('the job works again', record().children?.[child]?.row === 'working', JSON.stringify(record().children?.[child]));
  // The drop corner is drawn only during a drag; it sits over the Others stack (bottom right).
  const zone = await page.locator('[data-testid="super-others"]').first().boundingBox();
  await dragTo(page, chatId, zone.x + zone.width / 2, zone.y + zone.height / 2);
  const held = record().containers.find((c) => c.id === chatId);
  ok('his drag put the working job in Others, held as his', held?.place === 'others' && typeof held?.heldAt === 'number', JSON.stringify(held));
  superCli('brief', child, 'export tests, second pass');
  await page.waitForTimeout(2500);
  ok('…and the next write leaves it there', record().containers.find((c) => c.id === chatId)?.place === 'others');
  await page.screenshot({ path: join(OUT, '6-owner-held-1440.png') });
  ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}  (server log: ${join(SCRATCH, 'server.log')})`);
process.exit(fails.length === 0 ? 0 : 1);
