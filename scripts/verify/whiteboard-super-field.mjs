#!/usr/bin/env node
/**
 * The board's writing field to the Super Agent (task whiteboard-sayfasi-sekme-satiri-ve-super-
 * hapi-kalkar-alta-super-e-yazma-alani-sol-listede-sag-tik-menusu, owner 2026-11-11).
 *
 *   npm run build && node scripts/verify/whiteboard-super-field.mjs      (SHOTS_DIR=<dir>)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), Chromium, the real chat
 * sockets; `claude` is a scripted stand-in (no tokens) that records every frame. With Super mode
 * on it proves the six drawn states: the empty field (no tabs row, no pill, no help button,
 * clear of the zoom controls and of the open dock window at 1440 and 1024), one and several
 * selected (the selection chip, × clears, keys stay in the field), the send (one frame with the
 * page block and its selection, the working pill, the outline, the bubble's one chip, both gone
 * when the work ends), and right-click on the Boards list; plus the phone at 390.
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const SHOTS = process.env.SHOTS_DIR || join(REPO, 'tmp', 'verify-whiteboard-super-field');

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
  if (text.includes('BOARD-WORK')) { report({ kind: 'board', text }); await sleep(9000); return 'Done on the board.'; }
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

const fails = [];
const ok = (label, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); if (!cond) fails.push(label); return !!cond; };
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const overlaps = (a, b, gap = 0) => a && b && !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);

/** The live scene from Excalidraw's App (the same fiber walk the explorer check uses). */
const sceneOf = (page) => page.evaluate(() => {
  const root = document.querySelector('.wbp-canvas .excalidraw');
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
  for (let f = key ? root[key] : null; f; f = f.return) {
    const app = f.stateNode;
    if (app?.scene && app.state?.zoom) {
      const r = root.getBoundingClientRect();
      return {
        left: r.left, top: r.top, zoom: app.state.zoom.value, scrollX: app.state.scrollX, scrollY: app.state.scrollY,
        tool: app.state.activeTool?.type,
        selected: Object.keys(app.state.selectedElementIds || {}).filter((k) => app.state.selectedElementIds[k]),
        elements: app.scene.getNonDeletedElements().map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.width, h: e.height, containerId: e.containerId ?? null })),
      };
    }
  }
  return null;
});

async function main() {
  const SCRATCH = join(tmpdir(), `dc-verify-wb-field-${process.pid}`);
  const HOME = join(SCRATCH, 'home');
  const PROJ = join(SCRATCH, 'acme-app');
  const FRAMES = join(SCRATCH, 'frames.ndjson');
  const REPORTS = join(SCRATCH, 'reports.ndjson');
  const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
  const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
  const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); return r; };
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), SHOTS]) mkdirSync(d, { recursive: true });
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
  must('whiteboard', dc('whiteboard', 'create', 'Launch plan'));
  let x = 0;
  for (const text of ['1 · Spotlight', '2 · Side by side', '3 · Grid', '4 · Film strip']) {
    must('note', dc('whiteboard', 'add', 'launch-plan', 'note', '--text', text, '--at', `${x},0`));
    x += 420;
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const reports = () => readNd(REPORTS);
  const superFrames = () => readNd(FRAMES).filter((f) => f.role === 'super');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const dock = page.locator('[data-testid="super-dock"]');
  const pill = dock.locator('[data-testid="super-dock-pill"]');
  const win = dock.locator('[data-testid="super-dock-window"]');
  const field = page.locator('[data-testid="board-super-field"]');
  const input = field.locator('.bsf-input');
  const selChip = page.locator('[data-testid="board-super-sel"]');
  const outline = page.locator('[data-testid="board-work-outline"]');
  const workingPill = page.locator('[data-testid="board-super-working"]');
  // The new shell (the default, and what the owner sees): its rail buttons are `ns-rail-<page>`.
  const nav = async (pageId) => {
    await page.getByTestId(`ns-rail-${pageId}`).first().click();
    await page.waitForTimeout(700);
  };
  const shotPair = async (name) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'dark' });
  };
  const centreOf = async (id) => {
    const s = await sceneOf(page);
    const el = s.elements.find((e) => e.id === id);
    return { x: s.left + (el.x + el.w / 2 + s.scrollX) * s.zoom, y: s.top + (el.y + el.h / 2 + s.scrollY) * s.zoom };
  };
  const emptySpot = async () => {
    const r = await page.locator('.wbp-canvas').boundingBox();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.78 };
  };

  try {
    console.log('── Super on: hand one chat over');
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await nav('chat');
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
    await page.locator('.chat-cmp-input:visible').first().fill('hello');
    await page.keyboard.press('Enter');
    await until(page, async () => readNd(FRAMES).some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1200);
    // The new shell turns the Super on from its row in the chat drawer; the classic hand-over
    // button is the fallback.
    if (await page.getByTestId('drawer-super-row').first().isVisible().catch(() => false)) await page.getByTestId('drawer-super-row').first().click();
    else await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));

    console.log('── 1 the empty field');
    await nav('whiteboards');
    await page.locator('.wbx .wbx-row-open', { hasText: 'Launch plan' }).first().click();
    ok('the board is open', await until(page, async () => (await sceneOf(page))?.elements.length >= 4, 15000));
    ok('no tabs row (criterion 1)', await page.locator('.wbp-bar, .wbt-tab').count() === 0);
    ok('the field is drawn, the corner pill is not (criterion 4)', await until(page, async () => (await field.count()) === 1 && (await pill.count()) === 0, 10000));
    ok('Excalidraw\'s help button is not drawn', await page.evaluate(() => [...document.querySelectorAll('.excalidraw .help-icon')].every((el) => el.getBoundingClientRect().width === 0)));
    ok('"Saved" and "Agents" sit top-right (criterion 3)', await page.locator('.wbp-canvas .wbp-status').count() === 1 && await page.locator('.wbp-canvas .wbp-agent-toggle').count() === 1);
    const measureField = async (tag) => {
      const fb = await field.boundingBox();
      const cb = await page.locator('.wbp-canvas').boundingBox();
      const controls = await page.evaluate(() => [...document.querySelectorAll('.excalidraw .layer-ui__wrapper__footer-left > *, .excalidraw .zoom-actions, .excalidraw .undo-redo-buttons')]
        .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }).filter((r) => r.width > 0));
      ok(`${tag}: ≤ 640 px wide, centred at the bottom`, !!fb && fb.width <= 640.5 && Math.abs((fb.x + fb.width / 2) - (cb.x + cb.width / 2)) <= 2 && cb.y + cb.height - (fb.y + fb.height) < 90, JSON.stringify({ fb, cb }));
      ok(`${tag}: clear of the zoom and undo controls`, controls.length > 0 && controls.every((r) => !overlaps(fb, r, 4)), JSON.stringify({ fb, controls }));
    };
    await measureField('1440');
    await page.locator('[data-testid="board-super-mark"]').click();
    ok('the field\'s Super mark opens the dock window (criterion 5)', await until(page, async () => (await win.count()) === 1, 6000));
    for (const [w, h] of [[1440, 900], [1366, 768], [1024, 768]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(600);
      const wb = await win.boundingBox();
      const fb = await field.boundingBox();
      // Review r1: never under the window. Beside it, or stepped aside when there is no room.
      ok(`${w}: the open dock window never covers the field (beside it, or the field steps aside)`, !!wb && (!fb || !overlaps(wb, fb)), JSON.stringify({ wb, fb }));
      await page.screenshot({ path: join(SHOTS, `dock-acik-${w}-dark.png`) });
    }
    await page.setViewportSize({ width: 1024, height: 768 });
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    await page.waitForTimeout(500);
    await measureField('1024');
    ok('1024: the field is back once the window closes', !!(await field.boundingBox()));
    // Review r1: the save state and Agents stay inside the canvas and clickable at every width.
    for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(600);
      const cb = await page.locator('.wbp-canvas').boundingBox();
      const parts = await page.evaluate(() => [...document.querySelectorAll('.wbp-canvas .wbp-status, .wbp-canvas .wbp-agent-toggle')]
        .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
      ok(`${w}: "Saved" and "Agents" sit whole inside the canvas`, parts.length === 2 && parts.every((r) => r.width > 0 && r.x >= cb.x && r.x + r.width <= cb.x + cb.width + 0.5), JSON.stringify({ cb, parts }));
    }
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(600);
    await page.locator('.wbp-canvas .wbp-agent-toggle').click();
    ok('1024: Agents opens the board agents panel', await until(page, async () => (await page.locator('.wb-agent-panel-head').count()) >= 1, 4000));
    await page.locator('.wbp-canvas .wbp-agent-toggle').click();
    // Review r2: a page overlay never paints over Excalidraw's Library sidebar.
    {
      const aside = page.locator('[data-testid="wbp-controls-aside"]');
      ok('1024: the save state and Agents stand aside in their own group', (await aside.count()) === 1);
      const trigger = page.locator('.excalidraw .default-sidebar-trigger').first();
      const tb = await trigger.boundingBox().catch(() => null);
      const cb = await page.locator('.wbp-canvas').boundingBox();
      // Excalidraw's own trigger may spill past the canvas edge at this width (its row, not ours).
      if (tb && tb.x + tb.width <= cb.x + cb.width) {
        await trigger.click();
        await page.waitForTimeout(500);
      }
      const sidebarOpen = (await page.locator('.excalidraw .sidebar').count()) > 0;
      if (sidebarOpen) {
        const ab = await aside.boundingBox();
        const onTop = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.excalidraw .sidebar'), { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 });
        ok('1024: the open Library sidebar is on top of the aside group, not under it', onTop, JSON.stringify(ab));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        if ((await page.locator('.excalidraw .sidebar').count()) > 0 && tb) await trigger.click().catch(() => {});
      } else {
        console.log('  · Library trigger not reachable at 1024 (Excalidraw\'s own row spills): sidebar check skipped');
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(600);
    // Review r1: Excalidraw's "Scroll back to content" stays above the field after a pan away.
    {
      const cb = await page.locator('.wbp-canvas').boundingBox();
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 2500);
      const back = page.locator('.excalidraw .scroll-back-to-content');
      ok('the scroll-back button appears after a pan away', await until(page, async () => (await back.count()) === 1, 4000));
      const bb = await back.boundingBox();
      const fb = await field.boundingBox();
      ok('the scroll-back button is not under the field', !!bb && !!fb && !overlaps(bb, fb), JSON.stringify({ bb, fb }));
      if (bb) await back.click();
      await page.waitForTimeout(500);
    }
    ok('the pill stays hidden after the window closes', (await pill.count()) === 0 && (await field.count()) === 1);
    await shotPair('1-bos');

    console.log('── 2 one shape selected');
    const s0 = await sceneOf(page);
    const units = s0.elements.filter((e) => !e.containerId);
    const one = units[0];
    const c = await centreOf(one.id);
    await page.mouse.click(c.x, c.y);
    ok('a click selects one element', await until(page, async () => (await sceneOf(page)).selected.length >= 1, 4000));
    ok('…and the field shows its own selection chip, beside the board chip (criterion 6)', await until(page, async () => /^(Selected|Seçili): /.test((await selChip.innerText().catch(() => '')).trim()) && (await field.locator('.bsf-chip').count()) === 2, 4000), await selChip.innerText().catch(() => ''));
    await input.click();
    await input.fill('Make this one simpler');
    await page.keyboard.press('r');
    ok('keys typed in the field never reach Excalidraw (r did not pick the rectangle)', (await sceneOf(page)).tool !== 'rectangle' && (await input.inputValue()).endsWith('r'));
    await input.fill('Make this one simpler, drop the two lines under it');
    await shotPair('2-tek-secim');

    console.log('── 3 several selected');
    await page.mouse.click((await emptySpot()).x, (await emptySpot()).y);
    await page.keyboard.press('ControlOrMeta+a');
    ok('select all: the chip counts every unit', await until(page, async () => new RegExp(`${units.length}`).test(await selChip.innerText().catch(() => '')), 4000), await selChip.innerText().catch(() => ''));
    await page.locator('.bsf-chip-x').click();
    ok('× clears the canvas selection, and the chip goes', await until(page, async () => (await sceneOf(page)).selected.length === 0 && (await selChip.count()) === 0, 4000));
    await page.mouse.click((await emptySpot()).x, (await emptySpot()).y);
    await page.keyboard.press('ControlOrMeta+a');
    await until(page, async () => (await selChip.count()) === 1, 4000);
    await input.click();
    await input.fill('BOARD-WORK turn these into 3 slides');
    await page.keyboard.press('Shift+Enter');
    ok('Shift+Enter is a newline, nothing sent', (await input.inputValue()).endsWith('\n') && !superFrames().some((f) => f.blocks.join('\n').includes('BOARD-WORK')));
    await input.fill('BOARD-WORK turn these into 3 slides');
    await shotPair('3-coklu-secim');

    console.log('── 4 sent: the pill and the outline');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    ok('Enter sends it to the Super, once', await until(page, async () => superFrames().filter((f) => f.blocks.join('\n').includes('BOARD-WORK')).length === 1, 20000));
    const sent = superFrames().find((f) => f.blocks.join('\n').includes('BOARD-WORK'))?.blocks.join('\n') ?? '';
    ok('the frame is the words, a blank line, the page block with board, sel, box, ids (criterion 8)', new RegExp(`^BOARD-WORK turn these into 3 slides\\n\\n\\[On page whiteboards board=launch-plan sel=${units.length} box=-?\\d+,-?\\d+,\\d+,\\d+ ids=[A-Za-z0-9_,-]+\\](\\n<owner-msg |$)`).test(sent), JSON.stringify(sent));
    ok('the field emptied', (await input.inputValue()) === '');
    ok('the working pill and the outline show (criterion 12)', await until(page, async () => (await workingPill.count()) === 1 && (await outline.count()) === 1, 5000));
    await shotPair('4-gonderildi');
    await page.locator('[data-testid="board-super-mark"]').click();
    await until(page, async () => (await win.count()) === 1, 6000);
    ok('in the Super chat the bubble shows one page chip with the count, never the raw block (criterion 11)', await until(page, async () => {
      const chip = dock.locator('[data-testid="chat-msg-page"]').last();
      return /Whiteboard · launch-plan · \d+ selected/.test(await chip.innerText()) && !(await dock.locator('.chat-msg-user-row').last().innerText()).includes('[On page');
    }, 10000), await dock.locator('[data-testid="chat-msg-page"]').last().innerText().catch(() => ''));
    await page.screenshot({ path: join(SHOTS, '4b-sohbette-dark.png') });
    await dock.locator('[data-testid="super-dock-minimize"]').click();
    ok('the outline and the pill go once the work is over', await until(page, async () => (await outline.count()) === 0 && (await workingPill.count()) === 0, 45000));

    console.log('── 5/6 right-click on the Boards list');
    await page.locator('.wbx-row:not(.wbx-row--group)', { hasText: 'Launch plan' }).first().click({ button: 'right' });
    ok('right-click on a board row opens its menu at the pointer', await until(page, async () => (await page.locator('.wbx-menu[data-at-point]').count()) === 1, 3000));
    await shotPair('5-sag-tik-tahta');
    await page.keyboard.press('Escape');

    console.log('── phone 390');
    for (const scheme of ['light', 'dark']) {
      const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
      const phone = await phoneCtx.newPage();
      await phone.goto(`${base}/?vault=acme-app#wb=launch-plan`, { waitUntil: 'domcontentloaded' });
      await phone.waitForTimeout(3500);
      // The "What's new" sheet first, then the page through the bottom bar's More menu.
      await phone.getByRole('button', { name: /^Got it$/ }).click({ timeout: 3000 }).catch(() => {});
      await phone.keyboard.press('Escape').catch(() => {});
      await phone.waitForTimeout(400);
      await phone.getByTestId('ns-rail-more').click({ timeout: 5000 }).catch(() => {});
      await phone.waitForTimeout(400);
      await phone.getByTestId('ns-more-menu').getByText(/Whiteboard/).first().click({ timeout: 5000 }).catch(() => {});
      await phone.waitForTimeout(2500);
      ok(`390 ${scheme}: the board page is open`, await phone.locator('.wbp-editor').count() === 1);
      ok(`390 ${scheme}: no tabs row on the phone either`, await phone.locator('.wbp-bar, .wbt-tab').count() === 0);
      await phone.screenshot({ path: join(SHOTS, `telefon-390-${scheme}.png`) });
      await phoneCtx.close();
    }

    const real = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(e));
    ok('no console errors', real.length === 0, real.join('\n'));
  } catch (e) {
    ok('run finished', false, e?.stack || String(e));
    await page.screenshot({ path: join(SHOTS, 'zz-crash.png') }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', bin]);
  }
}

await main();
console.log(`\n${fails.length ? `✗ ${fails.length} failed` : '✓ all passed'} — screenshots in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
