#!/usr/bin/env node
/**
 * A picture on a Super web card (a report page opened with `super open web`) opens in the app's
 * full-screen viewer on a click (owner 2026-11-01: "I can't click or zoom the pictures in the
 * reports"). Drives the real dashboard (Vite dev + tsx API on a scratch HOME) with a fictional
 * report: three big pictures, one in an <a>, one 24px icon, and a page click handler.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/super-web-image-viewer.mjs [--webkit]
 *
 * Proves: click opens the viewer (1440 and 390); the icon does not; the page's own handler still
 * ran and the <a> did not tear the frame down; wheel zoom, drag pan, double click fit; → / ←
 * step, Esc closes; the frame's CSP is unchanged. Screenshots: tmp/verify-super-web-image-viewer/.
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
const REPORTS = join(tmpdir(), `dc-img-viewer-reports-${process.pid}.ndjson`);
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
  const scratch = join(tmpdir(), `dc-verify-img-viewer-${process.pid}`);
  if (!process.env.DC_DEBUG) rmSync(scratch, { recursive: true, force: true });
  const home = join(scratch, 'home'); const proj = join(scratch, 'proj'); const shots = join(REPO, 'tmp', 'verify-super-web-image-viewer', String(process.pid));
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
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
let browser;
try {
  const rel = '_dream_context/tmp/report-v1';
  const dir = join(app.proj, rel);
  mkdirSync(dir, { recursive: true });
  const png = join(REPO, 'public', 'image', 'diagram-recall.png');
  for (const n of ['1.png', '2.png', '3.png']) copyFileSync(png, join(dir, n));
  writeFileSync(join(dir, 'report.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Report</title></head><body>
<h1>Weekly report</h1>
<p><img id="a" src="1.png" alt="Recall diagram one" style="width:100%"></p>
<p><a href="2.png"><img id="b" src="2.png" alt="Recall diagram two" style="width:100%"></a></p>
<p><img id="c" src="3.png" alt="Recall diagram three" style="width:100%"></p>
<p><img id="icon" src="1.png" alt="icon" width="24" height="24"></p>
<script>document.body.dataset.clicks='0';document.addEventListener('click',function(e){if(e.target.tagName==='IMG')document.body.dataset.clicks=String(+document.body.dataset.clicks+1);});</script>
</body></html>`);
  writeFileSync(join(app.home, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }, null, 2)}\n`);
  browser = await engine.launch();
  for (const w of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
    console.log(`\n── ${w.name} (${engine.name()})`);
    const context = await browser.newContext({ viewport: { width: w.width, height: w.height } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy|favicon|ERR_BLOCKED|\/api\/.*ws/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    // The new shell opens the Super stage from its drawer row (the old in-chat hand-over button is gone).
    const handover = page.locator('[data-testid="super-handover-btn"]:visible').first();
    if (!(await page.locator('[data-testid="super-surface"]:visible').count())) {
      await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(1200);
      if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await handover.click().catch(() => {});
    }
    await page.screenshot({ path: join(app.shots, `0-before-stage-${w.name}.png`) });
    ok('the stage shows', await until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
    ok('the report card has its frame', await until(async () => (await page.locator('iframe.doc-reader-html-frame').count()) > 0, 60000));
    await page.waitForTimeout(1500);
    const frame = await (await page.locator('iframe.doc-reader-html-frame').first().elementHandle()).contentFrame();
    await frame.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
    const viewer = page.locator('.image-viewer');
    const shots = join(app.shots, w.name);
    mkdirSync(shots, { recursive: true });
    ok('a big picture shows the zoom-in cursor', await (async () => { await frame.hover('#a'); return (await frame.evaluate(() => getComputedStyle(document.getElementById('a')).cursor)) === 'zoom-in'; })());
    await frame.locator('#icon').click();
    await page.waitForTimeout(500);
    ok('the 24px icon does not open the viewer', (await viewer.count()) === 0);
    await frame.locator('#a').click();
    ok('clicking a big picture opens the viewer', await until(async () => (await viewer.count()) === 1, 8000));
    ok("the page's own click handler still ran", Number(await frame.evaluate(() => document.body.dataset.clicks)) >= 2);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots, '1-open.png') });
    const level = () => viewer.locator('.viewer-tool--level').innerText();
    const l0 = await level();
    const c = await page.locator('.image-viewer-stage').boundingBox();
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(500);
    const l1 = await level();
    ok(`wheel zooms in (${l0} → ${l1})`, parseInt(l1) > parseInt(l0));
    await page.screenshot({ path: join(shots, '2-zoomed.png') });
    const t0 = await viewer.locator('.image-viewer-img').evaluate((e) => e.style.transform);
    await page.mouse.down(); await page.mouse.move(c.x + c.width / 2 - 120, c.y + c.height / 2 - 60, { steps: 6 }); await page.mouse.up();
    const t1 = await viewer.locator('.image-viewer-img').evaluate((e) => e.style.transform);
    ok('dragging pans the zoomed picture', t0 !== t1, `${t0} → ${t1}`);
    await page.mouse.dblclick(c.x + c.width / 2, c.y + c.height / 2);
    await page.waitForTimeout(400);
    ok('double click fits again', parseInt(await level()) === parseInt(l0), await level());
    ok('shows "1 / 3"', (await viewer.locator('.image-viewer-pos').innerText()) === '1 / 3');
    await page.keyboard.press('ArrowRight');
    ok('→ goes to the next picture (2 / 3)', await until(async () => (await viewer.locator('.image-viewer-pos').innerText()) === '2 / 3', 3000));
    await page.screenshot({ path: join(shots, '3-next.png') });
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    ok('← wraps to the last (3 / 3)', await until(async () => (await viewer.locator('.image-viewer-pos').innerText()) === '3 / 3', 3000));
    await page.keyboard.press('Escape');
    ok('Esc closes it', await until(async () => (await viewer.count()) === 0, 3000));
    // A page cannot reopen the viewer for half a second after a close (frameImageBridge: mayOpenFromFrame).
    await page.waitForTimeout(700);
    await frame.locator('#b').click();
    ok('a picture inside an <a> opens it too', await until(async () => (await viewer.count()) === 1, 8000));
    ok('…at its own place (2 / 3)', (await viewer.locator('.image-viewer-pos').innerText()) === '2 / 3');
    await viewer.locator('.image-viewer-stage').click({ position: { x: 6, y: 6 } });
    ok('a click outside the picture closes it', await until(async () => (await viewer.count()) === 0, 3000));
    ok('the frame was not torn away by the link', (await page.locator('iframe.doc-reader-html-frame').count()) >= 1 && (await page.locator('[role="alert"]').count()) === 0);
    // Security (review of 6b31f817): a page that posts the message on its own, with no click behind it,
    // opens nothing. The transient user activation lapses after about 5 s; wait it out, then post.
    await page.waitForTimeout(6500);
    await frame.locator('#a').evaluate(() => parent.postMessage({ __dreamFrameImage: { index: 0, images: [{ src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'forged' }] } }, '*'));
    await page.waitForTimeout(800);
    ok('a message the page posts with no click behind it opens nothing', (await viewer.count()) === 0);
    const csp = await frame.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
    ok("the frame's CSP is unchanged (default-src 'none')", csp.includes("default-src 'none'") && !/https?:|'self'|blob:/.test(csp), csp);
    ok('no console errors', errors.length === 0, errors.slice(0, 4).join('\n'));
    await context.close();
  }
} catch (e) {
  fails.push(`crashed: ${e?.stack || e}`);
  console.log(`  ✗ crashed: ${e?.stack || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await app.stop();
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${app.shots}`);
process.exit(fails.length === 0 ? 0 : 1);
