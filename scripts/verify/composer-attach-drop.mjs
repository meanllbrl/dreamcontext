#!/usr/bin/env node
/**
 * The composer's + menu and file drops on the Super chat (task composer-attach-menu-picker-never-
 * crashes-glass-menu-no-attach-task-drop-on-super-everywhere, owner 2026-10-29).
 *
 *   npm run build && node scripts/verify/composer-attach-drop.mjs        (ENGINES=chromium,webkit)
 *
 * The real dashboard server from this checkout's dist (scratch HOME, DREAMCONTEXT_DESKTOP=1),
 * fictional project "acme-app", a stand-in `claude` (no tokens). Per engine:
 *   - the + menu: exactly "Attach files…" and "Attach folders…" (no "Attach task…"), drawn on the
 *     glass tokens (translucent --glass-bg fill, --glass-border, a backdrop blur), light and dark;
 *   - "Attach files…" asks POST /api/agent/pick-paths (the browser's picker; intercepted here so no
 *     dialog opens on the Mac) and never a typed-path prompt; the picked file becomes a chip;
 *   - a file dropped on the Super chat attaches on the Chat stage, in the docked Super window on a
 *     whiteboard (board open) and on Tasks, and on the dock's pill (the window opens and takes it);
 *     a file dropped on the board's own canvas is NOT taken by the Super chat.
 * Screenshots in $SHOTS_DIR (default tmp/verify-composer-attach-drop)/<engine>/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = process.env.SHOTS_DIR || join(REPO, 'tmp', 'verify-composer-attach-drop');

const standin = (FRAMES, REPORTS) => `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-drop-' + process.pid;
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
let chain = Promise.resolve();
function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  const text = blocks[0] ?? '';
  const said = text.startsWith('[super handover]') ? 'arranged' : 'ok';
  if (text.startsWith('[super handover]')) report({ kind: 'handover' });
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
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, blocks }) + '\\n');
    chain = chain.then(() => turn(blocks));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const fails = [];
const ok = (label, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); if (!cond) fails.push(label); return !!cond; };
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); } return false; };
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** Drop a PNG and a text file on the element under `selector`, the way the OS hands them over. */
const dropFiles = (page, selector, tag) => page.evaluate(async ([sel, t]) => {
  const el = document.querySelector(sel);
  if (!el) return 'no target';
  const cv = document.createElement('canvas'); cv.width = 120; cv.height = 80;
  const g = cv.getContext('2d'); g.fillStyle = '#2471a3'; g.fillRect(0, 0, 120, 80);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], `${t}.png`, { type: 'image/png' }));
  dt.items.add(new File([`notes for ${t}\n`], `${t}.txt`, { type: 'text/plain' }));
  const r = el.getBoundingClientRect();
  const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, cancelable: true, composed: true, dataTransfer: dt };
  el.dispatchEvent(new DragEvent('dragenter', at));
  const over = new DragEvent('dragover', at);
  el.dispatchEvent(over);
  const drop = new DragEvent('drop', at);
  el.dispatchEvent(drop);
  return { overTaken: over.defaultPrevented, dropTaken: drop.defaultPrevented };
}, [selector, tag]);

/** What a composer holds: picture chips in the text and file chips in the row, by name. */
const held = (page, scope) => page.evaluate((sc) => {
  const root = document.querySelector(sc);
  if (!root) return { pics: [], files: [] };
  return {
    pics: [...root.querySelectorAll('.chat-cmp-hl mark.chat-cmp-hl-img')].map((m) => m.textContent.trim()),
    files: [...root.querySelectorAll('.chat-cmp-attachments .chat-cmp-attachment-file')].map((m) => m.textContent.trim()),
  };
}, scope);
const holds = async (page, scope, tag) => { const h = await held(page, scope); return h.pics.some((p) => p.includes(tag)) && h.files.some((f) => f.includes(tag)); };

async function runEngine(engineName) {
  const SCRATCH = join(tmpdir(), `dc-verify-attach-drop-${engineName}-${process.pid}`);
  const HOME = join(SCRATCH, 'home');
  const PROJ = join(SCRATCH, 'acme-app');
  const OUT = join(SHOTS, engineName);
  const FRAMES = join(SCRATCH, 'frames.ndjson');
  const REPORTS = join(SCRATCH, 'reports.ndjson');
  const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
  const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
  const must = (what, r) => { if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`); };
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
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
  const DESK = join(SCRATCH, 'Desktop');
  mkdirSync(DESK, { recursive: true });
  const pickedPdf = join(DESK, 'brief.pdf');
  writeFileSync(pickedPdf, '%PDF-1.4\n%fake\n');

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
  const engine = engineName === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  let prompts = 0;
  page.on('dialog', (d) => { prompts += 1; void d.dismiss(); });
  // The browser's picker: the separate-process route, answered here so no dialog opens on the Mac.
  const pickCalls = [];
  await page.route('**/api/agent/pick-paths', async (route) => {
    pickCalls.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paths: [pickedPdf] }) });
  });
  const dock = page.locator('[data-testid="super-dock"]');
  const pill = dock.locator('[data-testid="super-dock-pill"]');
  const win = dock.locator('[data-testid="super-dock-window"]');
  const CENTRE = '[data-super-slot="centre"]';
  const DOCK = '[data-super-slot="dock"]';
  const nav = async (label) => {
    await page.locator('nav button').filter({ has: page.locator('.sidebar-label', { hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }) }).first().click();
    await page.waitForTimeout(700);
  };
  const clean = () => page.evaluate(() => {
    document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove());
    if (!document.getElementById('cap-kill')) {
      const s = document.createElement('style'); s.id = 'cap-kill';
      s.textContent = '.announcements-modal-scrim,.sleep-tracker-wrap{display:none!important}';
      document.head.appendChild(s);
    }
  });
  const shot = async (name) => { await clean(); await page.screenshot({ path: join(OUT, `${name}.png`) }); console.log(`    saved ${engineName}/${name}.png`); };
  const shotBoth = async (name) => {
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((s) => { try { localStorage.setItem('dreamcontext-theme', s); } catch {} document.documentElement.setAttribute('data-theme', s); }, scheme);
      await page.waitForTimeout(400);
      await shot(`${name}-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => { try { localStorage.setItem('dreamcontext-theme', 'dark'); } catch {} document.documentElement.setAttribute('data-theme', 'dark'); });
  };

  try {
    console.log(`\n══ ${engineName}`);
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await clean();
    await nav('Chat');
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 60000));
    await page.locator('.chat-cmp-input:visible').first().fill('hello');
    await page.keyboard.press('Enter');
    await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    ok('the super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    ok('the Super chat is in the stage centre', await until(page, async () => (await page.locator(`${CENTRE} .chat-cmp-input`).count()) > 0, 20000));
    await until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
    await page.waitForTimeout(800);

    console.log('── the + menu');
    await page.locator(`${CENTRE} button[aria-label="Attach"]`).first().click();
    const menu = page.locator('.agent-composer-menu[role="menu"]');
    await until(page, async () => (await menu.count()) === 1 && (await menu.evaluate((m) => getComputedStyle(m).visibility)) === 'visible', 3000);
    const items = await menu.getByRole('menuitem').allInnerTexts();
    ok('the menu holds exactly Attach files… and Attach folders…', JSON.stringify(items.map((s) => s.trim())) === JSON.stringify(['Attach files…', 'Attach folders…']), JSON.stringify(items));
    const look = async () => menu.evaluate((m) => {
      const cs = getComputedStyle(m);
      const probe = document.createElement('div');
      probe.style.background = 'var(--glass-bg)'; probe.style.borderColor = 'var(--glass-border)'; probe.style.borderStyle = 'solid';
      document.body.appendChild(probe);
      const pcs = getComputedStyle(probe);
      const want = { bg: pcs.backgroundColor, border: pcs.borderTopColor };
      probe.remove();
      return { glass: m.classList.contains('agent-composer-menu--glass'), bg: cs.backgroundColor, border: cs.borderTopColor, blur: cs.backdropFilter || cs.webkitBackdropFilter || '', font: cs.fontFamily, want };
    });
    const dark = await look();
    ok('dark: glass fill and border are the --glass-* tokens, translucent, with a backdrop blur', dark.glass && dark.bg === dark.want.bg && dark.border === dark.want.border && /rgba\(.*0\.\d+\)/.test(dark.bg) && /blur\(16px\)/.test(dark.blur), JSON.stringify(dark));
    ok('the menu uses the UI face, not the terminal mono', !/mono/i.test(dark.font.split(',')[0]), dark.font);
    await shotBoth('01-glass-menu-chat-stage');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(300);
    const light = await look();
    ok('light: the glass re-tints from the same tokens (a different, still translucent fill)', light.bg === light.want.bg && light.bg !== dark.bg && /rgba\(.*0\.\d+\)/.test(light.bg), JSON.stringify(light));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    await menu.getByRole('menuitem', { name: 'Attach files…' }).click();
    ok('Attach files… asks the separate-process picker for files (multi-select)', await until(page, async () => pickCalls.length === 1, 5000) && pickCalls[0].directory === false && pickCalls[0].multiple === true, JSON.stringify(pickCalls));
    ok('…and never a typed-path prompt', prompts === 0, `${prompts} dialogs`);
    ok('the picked file is a chip in the Super composer', await until(page, async () => (await held(page, CENTRE)).files.some((f) => f.includes('brief.pdf')), 8000), JSON.stringify(await held(page, CENTRE)));
    await page.locator(`${CENTRE} button[aria-label="Attach"]`).first().click();
    await menu.getByRole('menuitem', { name: 'Attach folders…' }).click();
    ok('Attach folders… asks for folders', await until(page, async () => pickCalls.length === 2, 5000) && pickCalls[1].directory === true, JSON.stringify(pickCalls));

    console.log('── drop on the Super chat: the Chat stage');
    const r1 = await dropFiles(page, `${CENTRE} .chat-cmp-input`, 'stage-drop');
    ok('the drop is taken on the stage', r1.dropTaken === true, JSON.stringify(r1));
    ok('Chat stage: the dropped picture and file attach to the Super composer', await until(page, () => holds(page, CENTRE, 'stage-drop'), 10000), JSON.stringify(await held(page, CENTRE)));
    await shot('02-drop-chat-stage-dark');

    console.log('── drop on the docked Super chat: a whiteboard');
    await nav('Whiteboard');
    const boardLink = page.getByText('launch-plan', { exact: false }).first();
    if (await boardLink.count()) { await boardLink.click().catch(() => {}); await page.waitForTimeout(1500); }
    ok('a board is open', await until(page, async () => (await page.locator('.excalidraw').count()) > 0, 15000));
    ok('the dock pill is there', await until(page, async () => (await pill.count()) === 1, 8000));
    // On the pill, window closed: the window opens and takes the files.
    const r2 = await dropFiles(page, '[data-testid="super-dock-pill"]', 'pill-drop');
    ok('a drop on the pill is taken (not left to the board)', r2.dropTaken === true, JSON.stringify(r2));
    ok('…the Super window opens', await until(page, async () => (await win.count()) === 1 && (await page.locator(`${DOCK} .chat-cmp-input`).count()) === 1, 8000));
    ok('…and the files attach in it', await until(page, () => holds(page, DOCK, 'pill-drop'), 10000), JSON.stringify(await held(page, DOCK)));
    const r3 = await dropFiles(page, `${DOCK} .chat-cmp-input`, 'board-drop');
    ok('whiteboard: a drop on the docked composer is taken before the board sees it', r3.dropTaken === true && r3.overTaken === true, JSON.stringify(r3));
    ok('whiteboard: the files attach to the docked Super chat', await until(page, () => holds(page, DOCK, 'board-drop'), 10000), JSON.stringify(await held(page, DOCK)));
    await page.waitForTimeout(500);
    await shotBoth('03-drop-dock-whiteboard');
    // The board's own canvas keeps its drops: the Super chat takes nothing from there.
    const before = JSON.stringify(await held(page, DOCK));
    await dropFiles(page, '.excalidraw canvas.interactive, .excalidraw canvas', 'canvas-drop');
    await page.waitForTimeout(1200);
    ok('a drop on the board itself is not taken by the Super chat', !JSON.stringify(await held(page, DOCK)).includes('canvas-drop') && JSON.stringify(await held(page, DOCK)) === before, JSON.stringify(await held(page, DOCK)));

    console.log('── drop on the docked Super chat: another page (Tasks)');
    await nav('Tasks');
    if (!(await win.count())) await pill.first().click();
    ok('the Super window is open on Tasks', await until(page, async () => (await win.count()) === 1 && (await page.locator(`${DOCK} .chat-cmp-input`).count()) === 1, 8000));
    const r4 = await dropFiles(page, `[data-testid="super-dock-window"] .super-dock-window, [data-testid="super-dock-window"]`, 'tasks-drop');
    ok('Tasks: a drop anywhere on the Super window is taken', r4.dropTaken === true, JSON.stringify(r4));
    ok('Tasks: the files attach to the docked Super chat', await until(page, () => holds(page, DOCK, 'tasks-drop'), 10000), JSON.stringify(await held(page, DOCK)));
    await page.waitForTimeout(500);
    await shotBoth('04-drop-dock-tasks');
    await page.locator(`${DOCK} button[aria-label="Attach"]`).first().click();
    await until(page, async () => (await menu.count()) === 1 && (await menu.evaluate((m) => getComputedStyle(m).visibility)) === 'visible', 3000);
    await page.waitForTimeout(300);
    await shotBoth('05-glass-menu-dock-tasks');
    await page.keyboard.press('Escape');

    ok('zero page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  } catch (e) {
    ok('the run completed', false, String(e?.stack ?? e));
    await page.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  } finally {
    await browser.close();
    srv.kill();
  }
}

for (const e of ENGINES) await runEngine(e);
console.log(fails.length ? `\n${fails.length} check(s) failed:\n - ${fails.join('\n - ')}` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
