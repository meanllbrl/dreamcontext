#!/usr/bin/env node
/**
 * The Super dock on every screen, with the page context (task super-dock-on-every-screen-with-
 * page-context, owner 2026-10-25).
 *
 *   npm run build && node scripts/verify/super-dock.mjs        (ENGINES=chromium,webkit)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard in Chromium
 * and WebKit, the real chat sockets and the real CLI run from INSIDE the spawned chats. `claude` is
 * a scripted stand-in (no tokens) that records every user frame it receives. It proves, per engine:
 *   - Super ON with the overlay folded: one pill (the stage's Others pill, the dreamcontext logo
 *     and name), never the old stack, on Tasks, Insights, an insight, Knowledge, a whiteboard and
 *     AI Team; nothing on the Chat screen; a reload never paints the old stack first;
 *   - the pill opens THE Super chat as a right-hand column (its container moved, no chat spawned),
 *     caret in the composer; Escape minimizes and focus returns to the pill; a draft survives
 *     minimize/re-open and Büyüt (the Chat screen, the chat in the stage centre);
 *   - the page chip and the frames the super receives: tasks view + filters, a board, Insights,
 *     an open insight; the sent bubble's page strip; ✕ drops it for that message; the Chat screen
 *     composer never has one;
 *   - a Super question: the pill asks and bounces (reduced motion: no bounce, the badge stays),
 *     answered in the dock's card; a finished turn with the dock closed: the news dot;
 *   - a child's permission in the dock's band (one band in the page), allowed there; its name
 *     opens the stage with the child beside the agenda;
 *   - on a whiteboard (board open) and AI Team the pill and window stay >= 12 px clear of the page's
 *     bottom-right controls; the window never runs off the top at 1280 x 720;
 *   - take-back from this window: the old stack is back.
 * Screenshots at 1440 x 900 and 1280 x 800, light and dark, in tmp/verify-super-dock/<engine>/.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = process.env.SHOTS_DIR || join(REPO, 'tmp', 'verify-super-dock');

const standin = (FRAMES, REPORTS) => `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-dock-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let awaiting = null;
let seq = 0;
const ask = (request) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: request.tool_name, input: request.input }] } });
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', ...request, tool_use_id: id } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'done' }] }] } }); resolve(r); };
});
const shq = (a) => /^[A-Za-z0-9_.\\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\\\''") + "'";
const bashCall = (...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description: 'Ask the owner' } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim() }], is_error: r.status !== 0 }] } });
  return r;
};
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', children: Object.keys(cli('super', 'state').json?.children ?? {}) }); return 'arranged'; }
  if (text.startsWith('[super event')) return 'noted';
  if (text.includes('GO-ASKOWNER')) { const r = bashCall('super', 'ask', 'Ship the login fix now?', '--options', 'Ship it|Wait'); report({ kind: 'asked', r }); return 'Ship the login fix now?'; }
  if (text.includes('GO-SLOW')) { await sleep(4000); return 'The release notes are ready.'; }
  const perm = text.match(/GO-CHILDPERM (\\S+)/);
  if (perm) { report({ kind: 'sent', r: cli('super', 'send', perm[1], 'PERM-Q') }); return 'asked the child'; }
  if (text.startsWith('[super answer]')) { report({ kind: 'answer', text }); return 'noted'; }
  report({ kind: 'owner', text });
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('PERM-Q')) {
    const r = await ask({ tool_name: 'Bash', display_name: 'Bash', input: { command: 'npm run build', description: 'Build the app' } });
    report({ kind: 'perm', response: r });
    return 'built';
  }
  return 'ok';
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') { if (awaiting) { const r = awaiting; awaiting = null; r(o.response && o.response.response); } continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const wauScript = `export default async function () {
  return [{ name: 'Weekly active users', points: ${JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), v: 8200 + i * 140 })))} }];
}
`;

const fails = [];
const ok = (label, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); if (!cond) fails.push(label); return !!cond; };
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

async function runEngine(engineName) {
  const SCRATCH = join(tmpdir(), `dc-verify-super-dock-${engineName}-${process.pid}`);
  const HOME = join(SCRATCH, 'home');
  const PROJ = join(SCRATCH, 'acme-app');
  const OUT = join(SHOTS, engineName);
  const FRAMES = join(SCRATCH, 'frames.ndjson');
  const REPORTS = join(SCRATCH, 'reports.ndjson');
  const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
  const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
  const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); };
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, standin(FRAMES, REPORTS));
  chmodSync(bin, 0o755);
  must('vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' }));
  must('task', dc('tasks', 'create', 'Fix the login form', '-w', 'The login form loses its input on a slow network.'));
  must('whiteboard', dc('whiteboard', 'create', 'launch-plan'));
  must('whiteboard note', dc('whiteboard', 'add', 'launch-plan', 'note', '--text', 'Ship the beta to ten testers.'));
  must('lab create', dc('lab', 'create', 'weekly-active-users', '--title', 'Weekly active users', '--render', 'number', '--adapter', 'script', '--unit', 'users'));
  mkdirSync(join(PROJ, '_dream_context', 'lab', 'scripts'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'lab', 'scripts', 'weekly-active-users.mjs'), wauScript);
  must('lab sync', dc('lab', 'sync', 'weekly-active-users'));
  // One AI Team member, so the AI Team page draws its conversation and composer (criterion 16).
  must('agent', dc('agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'You read the product funnel and name what moved.'));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(OUT, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const reports = () => readNd(REPORTS);
  const frames = () => readNd(FRAMES);
  const superFrames = () => frames().filter((f) => f.role === 'super');
  const record = async () => (await fetch(`${base}/api/super/state`, { headers: { 'x-dreamcontext-vault': 'acme-app' } })).json();
  const engine = engineName === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  // Every animation frame, from the first one of every document: was the old stack ever painted
  // while Super was on? (criterion 2's "never painted before the pill").
  await context.addInitScript(() => {
    window.__oldStackFrames = 0;
    const tick = () => {
      if (window.__watchOldStack && document.querySelector('.agent-dock:not(.agent-dock--floating), .agent-fab')) window.__oldStackFrames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__watchOldStack = sessionStorage.getItem('verify-watch-old-stack') === '1';
  });
  const page = await context.newPage();
  let sockets = 0;
  page.on('websocket', () => { sockets += 1; });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const dock = page.locator('[data-testid="super-dock"]');
  const pill = dock.locator('[data-testid="super-dock-pill"]');
  const win = dock.locator('[data-testid="super-dock-window"]');
  const dockInput = dock.locator('[data-super-slot="dock"] .chat-cmp-input');
  const centreInput = page.locator('[data-super-slot="centre"] .chat-cmp-input');
  const oldStack = page.locator('.agent-dock:not(.agent-dock--floating), .agent-fab');
  const nav = async (label) => {
    await page.locator('nav button').filter({ has: page.locator('.sidebar-label', { hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }) }).first().click();
    await page.waitForTimeout(700);
  };
  const lastSuperText = () => superFrames().at(-1)?.blocks.join('\n') ?? '';
  const sendInDock = async (text) => {
    await dockInput.first().click();
    await dockInput.first().fill(text);
    await page.keyboard.press('Enter');
    return until(page, async () => superFrames().some((f) => f.blocks.join('\n').includes(text)), 20000);
  };
  const frameOf = (text) => superFrames().find((f) => f.blocks.join('\n').includes(text))?.blocks.find((b) => b.includes(text)) ?? '';
  const shot = async (name) => { await page.screenshot({ path: join(OUT, `${name}.png`) }); };
  const shotSet = async (name) => {
    for (const [w, h] of [[1440, 900], [1280, 800]]) {
      for (const scheme of ['light', 'dark']) {
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(450);
        await shot(`${name}-${w}-${scheme}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
  };
  const overlaps = (a, b, gap = 0) => a && b && !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);
  /** Every visible control of the page under the dock's corner (not the dock's own). */
  const pageControlsNear = () => page.evaluate(() => {
    const dockEl = document.querySelector('[data-testid="super-dock"]');
    const W = innerWidth; const H = innerHeight;
    return [...document.querySelectorAll('button, input, textarea, [role="button"], .excalidraw .layer-ui__wrapper__footer-right > *, .excalidraw .zoom-actions')]
      .filter((el) => !dockEl?.contains(el) && !el.closest('.agent-surface, [data-testid="super-dock"]'))
      .map((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { cls: String(el.className).slice(0, 60), x: r.x, y: r.y, width: r.width, height: r.height, vis: cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0 }; })
      .filter((r) => r.vis && r.x + r.width > W - 520 && r.y + r.height > H - 260);
  });

  try {
    console.log(`\n══ ${engineName}`);
    console.log('── one chat, handed over');
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    ok('Super OFF: today\'s stack/Chat button, no super dock', await until(page, async () => (await page.locator('.agent-fab, .agent-dock').count()) > 0 && (await dock.count()) === 0, 15000));
    await shotSet('00-super-off-tasks');
    await nav('Chat');
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
    await page.locator('.chat-cmp-input:visible').first().fill('hello');
    await page.keyboard.press('Enter');
    await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
    ok('the super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    const child = reports().find((r) => r.kind === 'handover')?.children?.[0];
    await until(page, async () => (await centreInput.count()) > 0, 20000);
    ok('Chat screen (stage): no pill, no window', (await dock.count()) === 0);
    // The Super chat's own container, tagged where it is homed now (the stage centre).
    ok('the stage centre holds the Super chat container', await page.evaluate(() => {
      const el = document.querySelector('[data-super-slot="centre"] > .agent-pane-chat');
      if (el) el.dataset.verifyTag = 'super-centre';
      return !!el;
    }));
    await shotSet('05-chat-screen-no-pill');

    console.log('── the pill on every page');
    const sessions0 = await page.locator('.agent-pane-chat').count();
    for (const [label, page_] of [['Tasks', 'tasks'], ['Insights', 'lab'], ['Knowledge', 'knowledge'], ['Whiteboard', 'whiteboards'], ['AI Team', 'agents']]) {
      await nav(label);
      const good = await until(page, async () => (await pill.count()) === 1 && (await oldStack.count()) === 0, 8000);
      ok(`${label}: exactly one pill, no old stack`, good, `${await pill.count()} pills, ${await oldStack.count()} old`);
      if (page_ === 'tasks') {
        const btn = pill.first();
        ok('the pill is the Others pill (super-others-stack, name, dots/count per the record)', (await btn.getAttribute('class'))?.includes('super-others-stack')
          && (await btn.locator('.super-others-name').innerText()).trim() === 'dreamcontext Super Agent');
        const st = await record();
        const live = Object.values(st.children ?? {}).filter((c) => c.endedAt === undefined).length;
        const countText = (await btn.locator('.super-others-count').count()) ? Number((await btn.locator('.super-others-count').innerText()).trim()) : 0;
        ok(`count = live jobs (${live})`, countText === live, `pill ${countText}`);
        ok('the dreamcontext logo leads it', (await btn.locator('.super-dock-logo img[src="/logo.png"]').count()) === 1);
        await shotSet('01-pill-tasks');
      }
    }

    console.log('── open on Tasks: the Super chat in the right-hand column');
    await nav('Tasks');
    const socketsBefore = sockets;
    await pill.first().click();
    ok('the window opens', await until(page, async () => (await win.count()) === 1 && (await dockInput.count()) === 1, 8000));
    ok('it is the SAME container the stage centre held (moved, not a new chat)', (await page.locator('[data-super-slot="dock"] > .agent-pane-chat[data-verify-tag="super-centre"]').count()) === 1);
    await page.waitForTimeout(800);
    ok('no chat socket opened by opening the dock', sockets === socketsBefore, `${socketsBefore} → ${sockets}`);
    const box = await win.boundingBox();
    ok('a right-hand column ~420 px, from under the top bar to the pill\'s inset', !!box && Math.abs(box.width - 420) <= 2 && box.x + box.width >= 1440 - 30 && box.y < 120 && box.y + box.height > 900 - 40, JSON.stringify(box));
    ok('the Super chat container moved there (the centre slot is empty), no chat spawned', (await centreInput.count()) === 0 && (await page.locator('.agent-pane-chat').count()) === sessions0);
    ok('caret in the dock composer', await until(page, async () => page.evaluate(() => !!document.activeElement?.closest('[data-super-slot="dock"]') && document.activeElement?.matches('.chat-cmp-input, textarea')), 3000));
    const chip = dock.locator('.chat-cmp-attachment-page');
    const chipText = async () => ((await chip.locator('.chat-cmp-attachment-name').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').replace(/\s*·\s*/, ' · ').trim();
    ok('the page chip reads the page and its view', await until(page, async () => /^Tasks · /.test(await chipText()), 5000), await chipText());
    const viewName = (await chipText()).replace(/^Tasks · /, '');
    await shotSet('03-dock-open-tasks');
    ok('sent from the dock: the frame ends with the tasks page block', await sendInDock('PAGE-TASKS what is left here?'));
    const tasksFrame = frameOf('PAGE-TASKS');
    ok(`…[On page tasks view="${viewName}"(…filters)] as the whole last paragraph`, new RegExp(`\\n\\n\\[On page tasks view="${viewName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"( filters=\\d+)?\\]$`).test(tasksFrame), JSON.stringify(tasksFrame));
    ok('the sent bubble shows the page strip, never the raw block', await until(page, async () => (await dock.locator('[data-testid="chat-msg-page"]').filter({ hasText: `Tasks · ${viewName}` }).count()) >= 1
      && !(await dock.locator('.chat-msg-user-row').last().innerText()).includes('[On page'), 8000));
    ok('the chip stays after the send', (await chip.count()) === 1);

    console.log('── ✕ on the chip, Escape, a draft');
    await chip.locator('.chat-cmp-chip-x').click();
    ok('✕: that message has no block', await sendInDock('NO-CHIP plain') && !frameOf('NO-CHIP').includes('[On page'), frameOf('NO-CHIP'));
    await dockInput.first().fill('draft-kept-123');
    await page.keyboard.press('Escape');
    ok('Escape minimizes; focus returns to the pill', await until(page, async () => (await win.count()) === 0 && await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'super-dock-pill'), 3000));
    await pill.first().click();
    ok('re-open: the draft is still there, the chip back', await until(page, async () => (await dockInput.first().inputValue()) === 'draft-kept-123' && (await chip.count()) === 1, 5000));

    console.log('── Büyüt: the Chat screen, the same chat, the draft');
    await dock.locator('[data-testid="super-dock-expand"]').click();
    ok('one click: the stage, the chat in the centre with the draft, the dock closed', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) === 1
      && (await centreInput.count()) === 1 && (await centreInput.first().inputValue()) === 'draft-kept-123' && (await dock.count()) === 0, 8000));
    ok('the centre composer has no page chip', (await page.locator('[data-super-slot="centre"] .chat-cmp-attachment-page').count()) === 0);
    ok('…the same container is back in the centre', (await page.locator('[data-super-slot="centre"] > .agent-pane-chat[data-verify-tag="super-centre"]').count()) === 1);
    await shotSet('07-after-buyut-chat-screen');
    await centreInput.first().fill('CENTRE-MSG from the stage');
    await page.keyboard.press('Enter');
    ok('a message sent on the Chat screen has no block', await until(page, async () => frameOf('CENTRE-MSG') !== '', 15000) && !frameOf('CENTRE-MSG').includes('[On page'));
    ok('the bubble shows no raw block on the Chat screen either', !(await page.locator('[data-super-slot="centre"]').innerText()).includes('[On page'));

    console.log('── a whiteboard, Insights, an insight');
    await nav('Whiteboard');
    await until(page, async () => (await page.locator('.excalidraw').count()) > 0, 15000);
    await page.waitForTimeout(1200);
    const near = await pageControlsNear();
    const pb = await pill.first().boundingBox();
    ok('whiteboard (board open): the board\'s bottom-right control is measured', near.some((r) => /help/.test(r.cls)), JSON.stringify(near));
    ok('…the corner is lifted for the board (data-lift="board")', (await dock.getAttribute('data-lift')) === 'board');
    ok('whiteboard (board open): the pill is >= 12 px clear of the board\'s bottom-right controls', near.every((r) => !overlaps(pb, r, 12)), JSON.stringify({ pb, near }));
    await pill.first().click();
    await until(page, async () => (await win.count()) === 1, 5000);
    const wb = await win.boundingBox();
    ok('…and so is the window', near.every((r) => !overlaps(wb, r, 12)), JSON.stringify({ wb, near: near.filter((r) => overlaps(wb, r, 12)) }));
    ok('the chip reads the open board', await until(page, async () => /^Whiteboard · [a-z0-9-]+$/.test(await chipText()), 5000), await chipText());
    const boardSlug = (await chipText()).replace(/^Whiteboard · /, '');
    await shotSet('04-dock-open-whiteboard');
    ok(`sent from a board: [On page whiteboards board=${boardSlug}]`, await sendInDock('PAGE-BOARD this one') && frameOf('PAGE-BOARD').endsWith(`\n\n[On page whiteboards board=${boardSlug}]`), frameOf('PAGE-BOARD'));
    await nav('Insights');
    await pill.first().click().catch(() => {});
    await until(page, async () => (await win.count()) === 1, 5000);
    ok('sent from Insights: [On page lab]', await sendInDock('PAGE-LAB how is it') && /\n\n\[On page lab\]$/.test(frameOf('PAGE-LAB')), frameOf('PAGE-LAB'));
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    const card = page.getByText('Weekly active users').first();
    if (await card.count()) { await card.click().catch(() => {}); await page.waitForTimeout(1000); }
    await pill.first().click().catch(() => {});
    await until(page, async () => (await win.count()) === 1, 5000);
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    ok('an open insight: exactly one pill, no old stack', await until(page, async () => (await pill.count()) === 1 && (await oldStack.count()) === 0, 5000));
    await shotSet('08-pill-over-insight');
    await pill.first().click();
    await until(page, async () => (await win.count()) === 1, 5000);
    ok('the chip reads the open insight', await until(page, async () => /weekly-active-users/.test(await chipText()), 5000), await chipText());
    ok('sent with an insight open: [On page lab insight=weekly-active-users]', await sendInDock('PAGE-INSIGHT this number') && /\n\n\[On page lab insight=weekly-active-users\]$/.test(frameOf('PAGE-INSIGHT')), frameOf('PAGE-INSIGHT'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (await win.count()) await dock.locator('[data-testid="super-dock-minimize"]').click();
    await page.keyboard.press('Escape');

    console.log('── AI Team: lifted above its composer');
    await nav('AI Team');
    // The only member opens by itself; otherwise pick it from the list.
    if (!(await until(page, async () => (await page.locator('.aiteam-composer').count()) > 0, 5000))) await page.getByText('Scout', { exact: true }).first().click();
    const teamComposer = page.locator('.aiteam-composer').first();
    ok('AI Team: the member\'s conversation and its composer are on screen', await until(page, async () => (await teamComposer.count()) === 1 && (await teamComposer.isVisible()), 15000));
    await page.waitForTimeout(800);
    const cb = await teamComposer.boundingBox();
    const pt = await pill.first().boundingBox();
    ok('…the corner is lifted for AI Team (data-lift="team")', (await dock.getAttribute('data-lift')) === 'team');
    ok('AI Team: the pill is >= 12 px clear of the composer (measured)', !!cb && !!pt && !overlaps(pt, cb, 12), JSON.stringify({ pt, cb }));
    await pill.first().click();
    await until(page, async () => (await win.count()) === 1, 5000);
    const wt = await win.boundingBox();
    ok('AI Team: the window is >= 12 px clear of the composer (measured)', !!cb && !!wt && !overlaps(wt, cb, 12), JSON.stringify({ wt, cb }));
    await shotSet('09-dock-open-ai-team');
    await dock.locator('[data-testid="super-dock-minimize"]').click();

    console.log('── a Super question: the pill asks and bounces until answered');
    await nav('Tasks');
    // No board open (and no other page with its own bottom control): no lift, the pill at the plain inset.
    const plain = await pill.first().boundingBox();
    const vh = page.viewportSize().height;
    ok('a page with no board open: no lift, the pill at the plain inset', (await dock.getAttribute('data-lift')) === null && !!plain && Math.abs(plain.y + plain.height - (vh - 20)) <= 1, JSON.stringify({ plain, vh }));
    await pill.first().click();
    await sendInDock('GO-ASKOWNER');
    ok('super ask ran', await until(page, async () => reports().some((r) => r.kind === 'asked'), 30000));
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    ok('the pill asks: data-asking, the ?, the bounce', await until(page, async () => (await pill.first().getAttribute('data-asking')) === 'true'
      && (await pill.first().locator('[data-testid="super-dock-q"]').count()) === 1
      && (await pill.first().evaluate((el) => getComputedStyle(el).animationName)) === 'super-dock-bounce', 15000), await pill.first().evaluate((el) => getComputedStyle(el).animationName).catch(() => ''));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    ok('reduced motion: no bounce, the badge stays', (await pill.first().evaluate((el) => getComputedStyle(el).animationName)) === 'none' && (await pill.first().locator('[data-testid="super-dock-q"]').count()) === 1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await shotSet('02-pill-question');
    await pill.first().click();
    const askCard = dock.locator('[data-super-slot="dock"] [data-testid="super-question-card"]').filter({ hasText: 'Ship the login fix now?' });
    ok('the question card is in the dock', await until(page, async () => (await askCard.count()) === 1, 10000));
    ok('…and the band\'s Answer brings it into view in the dock (one band in the page)', (await page.locator('[data-testid="super-queue-head"]').count()) === 1);
    await dock.locator('[data-testid="super-queue-answer"]').click().catch(() => {});
    ok('…focused', await until(page, async () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="super-question-card"]')), 3000));
    await askCard.locator('.chat-surveycard-opt').filter({ hasText: 'Ship it' }).click();
    await askCard.locator('.chat-btn.primary').click();
    ok('answered in the dock', await until(page, async () => reports().some((r) => r.kind === 'answer'), 15000));
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    const t0 = Date.now();
    ok('the pill stops asking within 1 s', await until(page, async () => (await pill.first().getAttribute('data-asking')) === null && (await pill.first().locator('[data-testid="super-dock-q"]').count()) === 0, 1000), `${Date.now() - t0} ms`);

    console.log('── a finished turn with the dock closed: the news dot');
    await pill.first().click();
    await dockInput.first().fill('GO-SLOW write the notes');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    ok('news dot once the turn ends, no bounce', await until(page, async () => (await pill.first().getAttribute('data-news')) === 'true' && (await pill.first().getAttribute('data-asking')) === null
      && (await pill.first().locator('[data-testid="super-dock-news"]').count()) === 1
      && (await pill.first().evaluate((el) => getComputedStyle(el).animationName)) === 'none', 15000));
    await shotSet('10-pill-news');
    await pill.first().click();
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    ok('opening the dock clears it', await until(page, async () => (await pill.first().getAttribute('data-news')) === null, 3000));

    if (child) {
      console.log('── a child\'s permission in the dock\'s band');
      await pill.first().click();
      await sendInDock(`GO-CHILDPERM ${child}`);
      ok('the band in the dock shows it, once in the page', await until(page, async () => (await dock.locator('[data-testid="super-queue-allow"]').count()) === 1 && (await page.locator('[data-testid="super-queue-head"]').count()) === 1, 30000));
      const head = await dock.locator('[data-testid="super-job-bar"]').boundingBox();
      const slot = await dock.locator('[data-super-slot="dock"]').boundingBox();
      ok('…a row between the head and the chat', !!head && !!slot && head.y + head.height <= slot.y + 1, JSON.stringify({ head, slot }));
      await shotSet('06-dock-permission');
      await dock.locator('[data-testid="super-queue-allow"]').click();
      ok('Allow there answers the child', await until(page, async () => reports().some((r) => r.kind === 'perm' && JSON.stringify(r.response).includes('allow')), 15000));
      await sendInDock(`GO-CHILDPERM ${child}`);
      await until(page, async () => (await dock.locator('[data-testid="super-queue-open-child"]').count()) === 1, 30000);
      const before = Date.now();
      await dock.locator('[data-testid="super-queue-open-child"]').click();
      ok('the child\'s name opens the stage with its card beside the agenda within 1.5 s', await until(page, async () => (await dock.count()) === 0
        && (await page.locator(`[data-testid="super-container"][data-kind="chat"]:not([data-where="others"])`).count()) >= 1
        && ((await record()).view?.mode === 'present' || (await record()).view?.mode === 'half'), 1500), `${Date.now() - before} ms, view ${JSON.stringify((await record()).view)}`);
      await page.locator('[data-testid="super-queue-allow"]').first().click().catch(() => {});
      await nav('Tasks');
    }

    console.log('── 1280 x 720: the window stays on screen');
    await page.setViewportSize({ width: 1280, height: 720 });
    await pill.first().click();
    await until(page, async () => (await win.count()) === 1, 5000);
    const small = await win.boundingBox();
    ok('never off the top', !!small && small.y >= 0 && small.y + small.height <= 720, JSON.stringify(small));
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    await page.setViewportSize({ width: 1440, height: 900 });

    console.log('── reload: the old stack is never painted first');
    await page.evaluate(() => sessionStorage.setItem('verify-watch-old-stack', '1'));
    await page.reload({ waitUntil: 'commit' });
    ok('after a reload: the pill shows', await until(page, async () => (await pill.count()) === 1, 15000));
    await page.waitForTimeout(1000);
    const frames0 = await page.evaluate(() => window.__oldStackFrames);
    const watching = await page.evaluate(() => window.__watchOldStack === true);
    ok('…and no animation frame from the first one on ever had the old stack (the watcher ran)', watching && frames0 === 0, `watching ${watching}, ${frames0} frames`);
    await page.evaluate(() => sessionStorage.removeItem('verify-watch-old-stack'));

    console.log('── take back from this window');
    await nav('Chat');
    await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) === 1, 10000);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await until(page, async () => (await page.locator('[data-testid="super-surface"]').count()) === 0, 20000);
    await nav('Tasks');
    ok('the old stack is back, no super dock', await until(page, async () => (await oldStack.count()) > 0 && (await dock.count()) === 0, 15000));

    const real = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(e));
    ok('no console errors', real.length === 0, real.join('\n'));
  } catch (e) {
    ok(`${engineName} run finished`, false, e?.stack || String(e));
    await page.screenshot({ path: join(OUT, 'zz-crash.png') }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', bin]);
  }
}

for (const e of ENGINES) await runEngine(e);
console.log(`\n${fails.length ? `✗ ${fails.length} failed` : '✓ all passed'} — screenshots in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
