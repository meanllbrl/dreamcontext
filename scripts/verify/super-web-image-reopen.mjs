#!/usr/bin/env node
/**
 * A report card's pictures open again and again (owner 2026-11-03: "I open a picture, close it,
 * click another one: it does not open. Click somewhere else and back: it opens once, then stuck").
 * The viewer's gate arms on the window's blur into the card's frame; WebKit (the desktop app)
 * ignored the old `frame.blur()`, so focus stayed in the page and no later click armed it.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/super-web-image-reopen.mjs [--webkit]
 *
 * Real mouse clicks (not element clicks) on a fictional 4-picture report: 5 open/close cycles across
 * different pictures, closing by the close button, Esc and a click outside, then once more after a
 * click elsewhere in the app. Screenshots + a video: tmp/verify-super-web-image-reopen/<pid>/.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { spawn, spawnSync as spawnSync2 } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = process.argv.includes('--webkit') ? webkit : chromium;
// API from DC_API_DIST (default dist/index.js; a worktree without fresh node_modules points it at
// another checkout's build: the API is not what changed), the UI from THIS tree's Vite.
const API_DIST = process.env.DC_API_DIST || join(REPO, 'dist', 'index.js');
const freePort = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const REPORTS = join(tmpdir(), `dc-img-reopen-reports-${process.pid}.ndjson`);
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
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(API_DIST)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [
      cli('super', 'open', 'web', '_dream_context/tmp/report-v1/report.html'),
    ];
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  const m = text.match(/GO-CLI\\s+(.+)$/);
  if (m) {
    const steps = [cli(...m[1].trim().split(/\\s+/))];
    report({ kind: 'verb', steps });
    return 'did ' + m[1];
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
    if (role === 'super') report({ kind: 'turn', text: blocks.join(' | ').slice(0, 400) });
    try { said = role === 'super' ? superTurn(blocks.find((b) => /GO-CLI|\\[super handover\\]/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
  }
});
process.stdin.on('end', () => process.exit(0));
`;
async function openApp() {
  const scratch = join(tmpdir(), `dc-verify-img-reopen-${process.pid}`);
  if (!process.env.DC_DEBUG) rmSync(scratch, { recursive: true, force: true });
  const home = join(scratch, 'home'); const proj = join(scratch, 'proj'); const shots = join(REPO, 'tmp', 'verify-super-web-image-reopen', String(process.pid));
  for (const d of [join(home, '.dreamcontext'), join(home, '.local', 'bin'), join(proj, '_dream_context', 'state'), shots]) mkdirSync(d, { recursive: true });
  spawnSync2('git', ['init', '-q'], { cwd: proj });
  writeFileSync(join(home, '.local', 'bin', 'claude'), STANDIN, { mode: 0o755 });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
  const env = { ...clean, HOME: home, PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0' };
  spawnSync2('node', [API_DIST, 'vaults', 'add', 'proj', proj], { cwd: proj, env, stdio: 'ignore' });
  const apiPort = await freePort(); const vitePort = await freePort();
  const procs = [];
  const run = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: process.env.DC_DEBUG ? ['ignore', openSync(join(scratch, 'server.log'), 'a'), openSync(join(scratch, 'server.log'), 'a')] : 'ignore', detached: true, ...opts }); p.on('error', () => {}); procs.push(p); return p; };
  run('node', [API_DIST, 'dashboard', '--no-open', '-p', String(apiPort)], { cwd: proj, env });
  // The UI comes from the BUILT dashboard the API serves (the merged build under test); the Vite dev
  // server stays available with DC_VITE=1, but its websocket proxy never connected the chat here.
  if (process.env.DC_VITE === '1') run(join(REPO, 'dashboard', 'node_modules', '.bin', 'vite'), ['--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], { cwd: join(REPO, 'dashboard'), env: { ...clean, DC_API_TARGET: `http://localhost:${apiPort}` } });
  const base = process.env.DC_VITE === '1' ? `http://127.0.0.1:${vitePort}` : `http://127.0.0.1:${apiPort}`;
  for (const url of [`http://127.0.0.1:${apiPort}/api/health`, base]) {
    const end = Date.now() + 90000;
    while (Date.now() < end) { try { if ((await fetch(url)).status < 500) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  }
  return { base, home, proj, shots, stop: async () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } } };
}
const app = await openApp();
let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
  return !!cond;
};
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
let browser;
try {
  const rel = '_dream_context/tmp/report-v1';
  const dir = join(app.proj, rel);
  mkdirSync(dir, { recursive: true });
  const pics = ['diagram-recall.png', 'diagram-loop.png', 'diagram-memory.png', 'diagram-council.png'];
  pics.forEach((p, i) => copyFileSync(join(REPO, 'public', 'image', p), join(dir, `${i + 1}.png`)));
  writeFileSync(join(dir, 'report.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Report</title>
<style>.g{display:grid;grid-template-columns:1fr 1fr;gap:12px}.g img{width:100%;height:160px;object-fit:cover}</style></head><body>
<h1>Weekly report</h1><div class="g">${pics.map((_, i) => `<img id="p${i + 1}" src="${i + 1}.png" alt="Picture ${i + 1}">`).join('')}</div>
</body></html>`);
  writeFileSync(join(app.home, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }, null, 2)}\n`);
  browser = await engine.launch();
  console.log(`\n── desktop (${engine.name()})`);
  const shots = join(app.shots, engine.name());
  mkdirSync(shots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: shots, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('[data-testid="super-surface"]:visible').count())) {
    await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
    const handover = page.locator('[data-testid="super-handover-btn"]:visible').first();
    if (await handover.count()) await handover.click().catch(() => {});
  }
  ok('the stage shows', await until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the report card has its frame', await until(async () => (await page.locator('iframe.doc-reader-html-frame').count()) > 0, 60000));
  await page.waitForTimeout(1500);
  const frameEl = page.locator('iframe.doc-reader-html-frame').first();
  const frame = await (await frameEl.elementHandle()).contentFrame();
  await frame.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => {});
  const viewer = page.locator('.image-viewer');
  // A real pointer click at the picture's centre, the way the owner clicks (no element focus help).
  const clickPicture = async (id) => {
    const el = frame.locator(`#${id}`);
    await el.scrollIntoViewIfNeeded();
    const b = await el.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  const closers = [
    ['the close button', async () => page.mouse.click(...(await viewer.locator('.image-viewer-close').boundingBox().then((b) => [b.x + b.width / 2, b.y + b.height / 2])))],
    ['Esc', async () => page.keyboard.press('Escape')],
    ['a click outside the picture', async () => page.mouse.click(720, 120)],
  ];
  const order = ['p1', 'p2', 'p3', 'p4', 'p2'];
  for (let n = 0; n < order.length; n++) {
    const id = order[n];
    const [how, close] = closers[n % closers.length];
    await page.waitForTimeout(700); // past the 500 ms reopen cooldown, like a person
    await clickPicture(id);
    const opened = await until(async () => (await viewer.count()) === 1, 4000);
    ok(`cycle ${n + 1}: ${id} opens`, opened, `focus: ${await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className)}`);
    if (opened) {
      ok(`cycle ${n + 1}: …on its own picture (${Number(id.slice(1))} / 4)`, (await viewer.locator('.image-viewer-pos').innerText()) === `${Number(id.slice(1))} / 4`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, `cycle-${n + 1}-${id}-open.png`) });
      await close();
      ok(`cycle ${n + 1}: ${how} closes it`, await until(async () => (await viewer.count()) === 0, 3000));
      ok(`cycle ${n + 1}: focus is back in the app, not in the page`, await page.evaluate(() => document.activeElement?.tagName !== 'IFRAME'), await page.evaluate(() => document.activeElement?.tagName));
    }
  }
  // "Click somewhere else and come back": still opens, then again right after.
  await page.mouse.click(720, 20);
  await page.waitForTimeout(700);
  await clickPicture('p3');
  ok('after a click elsewhere: p3 opens', await until(async () => (await viewer.count()) === 1, 4000));
  await page.keyboard.press('Escape');
  await until(async () => (await viewer.count()) === 0, 3000);
  await page.waitForTimeout(700);
  await clickPicture('p1');
  ok('…and the next picture (p1) opens too', await until(async () => (await viewer.count()) === 1, 4000));
  await page.screenshot({ path: join(shots, 'after-elsewhere-p1-open.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await context.close();
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await app.stop();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots + video: ${app.shots}`);
process.exit(fails.length === 0 ? 0 : 1);
