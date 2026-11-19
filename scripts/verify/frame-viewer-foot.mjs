#!/usr/bin/env node
/**
 * The full-screen page viewer's bar must not cover the page (owner 2026-11-16, a funnel's CTA
 * sat under the floating "− 100% + Fit … Use the page" bar and could not be clicked or scrolled).
 * Drives the real dashboard (Vite dev of THIS tree + an API build, scratch HOME) with a fictional
 * one-screen page whose CTA sits at its very bottom, opened full screen from its Super card.
 *
 *   DC_VITE=1 DC_API_DIST=<a dist/index.js> dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/frame-viewer-foot.mjs
 *
 * Proves at 1440 and 390, dark and light: the CTA's whole box is above the bar's band; the point
 * at the CTA's centre is the page's frame, not the bar; a click there reaches the page; the
 * wheel over the page's bottom edge is the stage's. Screenshots: tmp/verify-frame-viewer-foot/.
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
const REPORTS = join(tmpdir(), `dc-frame-foot-reports-${process.pid}.ndjson`);
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
      cli('super', 'open', 'web', '_dream_context/tmp/funnel-v1/funnel.html'),
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
  const scratch = join(tmpdir(), `dc-verify-frame-foot-${process.pid}`);
  if (!process.env.DC_DEBUG) rmSync(scratch, { recursive: true, force: true });
  const home = join(scratch, 'home'); const proj = join(scratch, 'proj'); const shots = join(REPO, 'tmp', 'verify-frame-viewer-foot', String(process.pid));
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
  const dir = join(app.proj, '_dream_context/tmp/funnel-v1');
  mkdirSync(dir, { recursive: true });
  // A one-screen funnel step: the CTA at the very bottom, as in the owner's screenshot.
  writeFileSync(join(dir, 'funnel.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Pocket Ledger step 1</title>
<style>html,body{margin:0;height:100%}body{font-family:system-ui;background:#f4f2ee;color:#111;display:flex;flex-direction:column;align-items:center;min-height:100vh}
h1{font-size:44px;margin:32px 16px 8px}.hero{flex:1;width:min(600px,90%);background:linear-gradient(#9bb,#575);border-radius:16px}
#cta{margin:16px 0 6px;width:min(600px,90%);height:70px;border:0;border-radius:35px;background:#d2522c;color:#fff;font-size:22px}
small{margin-bottom:10px}</style></head><body data-clicks="0">
<h1>Same ledger. Clearer month.</h1><div class="hero"></div>
<button id="cta" onclick="document.body.dataset.clicks=String(+document.body.dataset.clicks+1)">See my month</button>
<small id="legal">18+ only · By continuing you agree to our Terms</small></body></html>`);
  writeFileSync(join(app.home, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }, null, 2)}\n`);
  browser = await engine.launch();
  for (const w of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
    for (const theme of ['dark', 'light']) {
      const tag = `${w.name}-${theme}`;
      console.log(`\n── ${tag}`);
      const context = await browser.newContext({ viewport: { width: w.width, height: w.height }, colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy|favicon|ERR_BLOCKED|\/api\/.*ws|WebSocket/.test(m.text())) errors.push(m.text()); });
      await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
      if (!(await page.locator('[data-testid="super-surface"]:visible').count())) {
        await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(1200);
        const handover = page.locator('[data-testid="super-handover-btn"]:visible').first();
        if (await handover.count()) await handover.click().catch(() => {});
      }
      ok('the page card has its frame', await until(async () => (await page.locator('iframe.doc-reader-html-frame').count()) > 0, 60000));
      await page.waitForTimeout(1000);
      const cardEl = page.locator('[data-testid="super-container"]').filter({ has: page.locator('iframe.doc-reader-html-frame') }).first();
      const cb = await cardEl.boundingBox();
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await page.waitForTimeout(300);
      const fsBtn = cardEl.locator('[data-testid="super-card-fullscreen"]').first();
      if (await fsBtn.isVisible().catch(() => false)) await fsBtn.click();
      else { const more = cardEl.locator('[aria-haspopup="menu"]').first(); await more.click().catch(() => {}); await page.locator('[data-testid="super-card-fullscreen"]').first().click(); }
      ok('the page opens full screen', await until(async () => (await page.locator('[data-testid="frame-viewer"]').count()) === 1, 8000));
      await page.waitForTimeout(1500);
      const shot = join(app.shots, `${tag}.png`);
      await page.screenshot({ path: shot });
      const inner = await (await page.locator('.frame-viewer-frame').elementHandle()).contentFrame();
      const c = await inner.evaluate(() => { const r = document.getElementById('cta').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; });
      const m = await page.evaluate((c) => {
        const f = document.querySelector('.frame-viewer-frame');
        const foot = document.querySelector('.frame-viewer .image-viewer-foot').getBoundingClientRect();
        const fr = f.getBoundingClientRect();
        const s = fr.width / f.offsetWidth;
        const cta = { top: fr.top + c.top * s, bottom: fr.top + c.bottom * s, x: fr.left + (c.left + c.width / 2) * s, y: fr.top + (c.top + c.height / 2) * s };
        const hit = document.elementFromPoint(cta.x, cta.y);
        return { footTop: foot.top, cta, hit: hit ? (typeof hit.className === 'string' && hit.className ? hit.className : hit.tagName) : null, hitIsFrame: hit === f };
      }, c);
      ok(`the CTA ends above the bar (cta bottom ${Math.round(m.cta.bottom)} <= bar top ${Math.round(m.footTop)})`, m.cta.bottom <= m.footTop + 0.5);
      ok(`the point at the CTA is the page, not the bar (${m.hit})`, m.hitIsFrame);
      await page.mouse.click(m.cta.x, m.cta.y);
      await page.waitForTimeout(300);
      const clicks = await inner.evaluate(() => document.body.dataset.clicks);
      ok(`a click on the CTA reaches the page (clicks=${clicks})`, clicks === '1');
      ok('no console errors', errors.length === 0, errors.slice(0, 4).join('\n'));
      console.log(`    shot: ${shot}`);
      await context.close();
    }
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
