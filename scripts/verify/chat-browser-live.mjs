#!/usr/bin/env node
/**
 * The agent's browser, live in the Chat pane, without ever taking the screen.
 *
 *   npm run build && npm run verify:chat-browser-live
 *
 * WHAT IT PROVES, in the real app:
 *
 *   0. The view lives inside the last browser step of the transcript and moves with it.
 *   1. A project whose `.mcp.json` declares a (headed, by default) Playwright MCP gets a spawn
 *      that re-declares it: `--mcp-config` LAST, the same server name, `--headless`, the
 *      canonical package (a project command is never re-emitted), and a config whose launch
 *      args open a loopback CDP port.
 *   2. Nothing is drawn until the agent calls a browser tool.
 *   3. Once it does, the view in that step shows the page live: a JPEG frame, the page's
 *      title, and a SECOND page's title after the agent navigates (frames keep coming).
 *   4. A frame swap does not move the layout: the view's height is the same across pages.
 *   5. Hide collapses it to its header line; a click on the frame opens it full-window.
 *   6. The browser closing removes the view.
 *
 * WHAT IT DRIVES: the real dashboard server, the real `/ws/agent-chat` route, the real React
 * surface in Chromium, and a REAL headless Chrome on the port the server picked, watched by the
 * real mirror over CDP. Only `claude` is a stand-in (in an isolated fake HOME, see
 * chat-toolrows.mjs): it plays the agent, and drives that Chrome the way @playwright/mcp would.
 * That Playwright MCP really launches headless with this config, and that a real `claude`
 * really runs our `--mcp-config` in place of the project's, was measured separately against
 * the real CLI (src/lib/browser-override.ts header).
 *
 * FAILURE POLICY: collect, don't fail fast. Exit 0 iff all checks pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-browser-live');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const ARGV_REPORT = join(SCRATCH, 'standin-argv.json');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
const { writeFileSync, readFileSync } = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(${JSON.stringify(ARGV_REPORT)}, JSON.stringify(process.argv.slice(2)));

// The port, read the way @playwright/mcp would: from the --config its server definition names.
function cdpPort() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--mcp-config');
  for (const file of at < 0 ? [] : argv.slice(at + 1)) {
    let servers; try { servers = JSON.parse(readFileSync(file, 'utf-8')).mcpServers || {}; } catch { continue; }
    for (const def of Object.values(servers)) {
      const args = def.args || [];
      const c = args.indexOf('--config');
      if (c < 0) continue;
      const cfg = JSON.parse(readFileSync(args[c + 1], 'utf-8'));
      const flag = (cfg.browser.launchOptions.args || []).find((a) => a.startsWith('--remote-debugging-port='));
      if (flag) return Number(flag.split('=')[1]);
    }
  }
  return null;
}

let browser = null, page = null, seq = 0, busy = false;
const inbox = [];
const page1 = 'data:text/html,' + encodeURIComponent('<title>Verify page one</title><body style="margin:0;background:#3a6;color:#fff;font:80px sans-serif">PAGE ONE</body>');
const page2 = 'data:text/html,' + encodeURIComponent('<title>Verify page two</title><body style="margin:0;background:#a36;color:#fff;font:80px sans-serif">PAGE TWO</body>');

async function tool(name, input, run) {
  const id = 'toolu_' + (++seq);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const text = await run();
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
}

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
  if (prompt === 'BROWSE') {
    await tool('mcp__playwright__browser_navigate', { url: 'page one' }, async () => {
      const { chromium } = require(${JSON.stringify(join(REPO, 'node_modules', 'playwright'))});
      browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--remote-debugging-port=' + cdpPort()] });
      page = await browser.newPage();
      await page.goto(page1);
      await sleep(3000);
      return 'navigated';
    });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ON-PAGE-ONE' }] } });
  } else if (prompt === 'NEXT') {
    await tool('mcp__playwright__browser_navigate', { url: 'page two' }, async () => { await page.goto(page2); await sleep(2000); return 'navigated'; });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ON-PAGE-TWO' }] } });
  } else if (prompt === 'CLOSE') {
    await tool('mcp__playwright__browser_close', {}, async () => { await browser.close(); browser = null; await sleep(800); return 'closed'; });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'BROWSER-CLOSED' }] } });
  } else {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'IDLE-ANSWER' }] } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  busy = false;
  pump();
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request' && o.request && o.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) { inbox.push(text.trim()); pump(); }
  }
});
let pumping = false;
async function pump() {
  if (pumping || busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  pumping = true;
  try { await runTurn(next); } finally { pumping = false; }
}
process.stdin.on('end', async () => { try { if (browser) await browser.close(); } catch {} process.exit(0); });
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  // The project's own Playwright MCP, as most projects declare it: headed by default.
  writeFileSync(join(PROJ, '.mcp.json'), JSON.stringify({
    mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
  }));

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const results = [];
const ok = (label, cond, detail) => {
  results.push(!!cond);
  console.log(`${cond ? '✓' : '✗'} ${label}${!cond && detail !== undefined ? `\n    ${String(detail).slice(0, 400)}` : ''}`);
};

async function main() {
  if (!existsSync(join(REPO, 'dist', 'index.js'))) throw new Error('run `npm run build` first');
  setupScratch();
  const port = await freePort();
  const srv = await startServer(port);
  const { chromium } = await import(join(REPO, 'node_modules', 'playwright', 'index.mjs'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => console.log(`  [page error] ${String(e).slice(0, 160)}`));
  const shots = process.env.VERIFY_SHOTS;

  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const paneText = async () => (await vis('.chat-pane').first().innerText()).replace(/\s+/g, ' ');
  const send = async (text) => {
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill(text);
    await page.keyboard.press('Enter');
  };

  try {
    await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
        if (await page.locator('.agent-surface.expanded').count()) break;
      }
    }
    if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
    ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0));

    console.log('── the spawn');
    await send('HELLO');
    ok('the stand-in answered', await until(async () => (await paneText()).includes('IDLE-ANSWER')));
    const argv = existsSync(ARGV_REPORT) ? JSON.parse(readFileSync(ARGV_REPORT, 'utf-8')) : [];
    const at = argv.indexOf('--mcp-config');
    const files = at < 0 ? [] : argv.slice(at + 1);
    const last = files[files.length - 1];
    const def = last ? JSON.parse(readFileSync(last, 'utf-8')).mcpServers?.playwright : null;
    ok('the spawn carries --mcp-config, last on the line, with the project server\'s NAME', !!def, JSON.stringify(argv));
    ok('…as the canonical package, headless, never the project\'s own command line',
      def && def.command === 'npx' && def.args[0] === '-y' && def.args[1] === '@playwright/mcp@latest' && def.args.includes('--headless'),
      JSON.stringify(def));
    const cfg = def ? JSON.parse(readFileSync(def.args[def.args.indexOf('--config') + 1], 'utf-8')) : null;
    ok('…whose config opens a loopback CDP port', /^--remote-debugging-port=\d+$/.test(cfg?.browser?.launchOptions?.args?.[0] ?? ''), JSON.stringify(cfg));
    ok('nothing is drawn before the agent browses', (await page.locator('.chat-browser').count()) === 0);

    console.log('── live');
    await send('BROWSE');
    ok('the live view appears once the agent calls a browser tool',
      await until(async () => (await vis('.chat-browser').count()) === 1, 25000));
    const src = await vis('.chat-browser-frame img').first().getAttribute('src').catch(() => '');
    ok('it shows a real frame (a JPEG from the screencast)', (src ?? '').startsWith('data:image/jpeg;base64,') && src.length > 1000, (src ?? '').slice(0, 60));
    ok('it names the page it shows by its TITLE, not its address', await until(async () => (await vis('.chat-browser-title').innerText()) === 'Verify page one', 10000),
      await vis('.chat-browser-address').innerText().catch(() => ''));
    // The box's ratio comes from the frame's metadata, before the image decodes; it must be the
    // ratio of the picture that then arrives, or every frame letterboxes.
    const fit = await vis('.chat-browser-frame').first().evaluate(async (e) => {
      const img = e.querySelector('img');
      if (img && !img.complete) await new Promise((r) => { img.onload = r; });
      const r = e.getBoundingClientRect();
      return { box: r.width / r.height, image: img.naturalWidth / img.naturalHeight, natural: [img.naturalWidth, img.naturalHeight] };
    });
    ok('the box reserves the ratio of the picture it shows', Math.abs(fit.box - fit.image) < 0.01, JSON.stringify(fit));
    // Where it lives (owner pick 2026-10-09): inside the browser step that drives it, the LAST
    // one, and only there.
    const hostIndex = () => page.evaluate(() => {
      const steps = [...document.querySelectorAll('.chat-toolcard[data-tool^="mcp__playwright__"]')].filter((e) => e.offsetParent);
      return { steps: steps.length, at: steps.findIndex((e) => e.querySelector('.chat-browser')), views: document.querySelectorAll('.chat-browser').length };
    });
    const h1host = await hostIndex();
    ok('…inside the Playwright step that drives it, and nowhere else', h1host.views === 1 && h1host.at === h1host.steps - 1, JSON.stringify(h1host));
    // The picture fills its box: no empty bands beside a frame narrower than the pane.
    const fill = await vis('.chat-browser-frame').first().evaluate((e) => {
      const box = e.getBoundingClientRect();
      const stage = e.parentElement.getBoundingClientRect();
      const img = e.querySelector('img');
      const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
      return { box: [Math.round(box.width), Math.round(box.height)], stage: Math.round(stage.width),
        drawn: [Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale)], natural: [img.naturalWidth, img.naturalHeight] };
    });
    const hug = await vis('.chat-browser-window').first().evaluate((w) => ({
      window: Math.round(w.getBoundingClientRect().width),
      frame: Math.round(w.querySelector('.chat-browser-frame').getBoundingClientRect().width),
    }));
    ok('the window hugs the page: as wide as the frame (plus its border), no bands', Math.abs(hug.window - hug.frame) <= 2, JSON.stringify(hug));
    ok('the picture fills its box, no empty bands beside it',
      Math.abs(fill.drawn[0] - fill.box[0]) <= 2 && Math.abs(fill.drawn[1] - fill.box[1]) <= 2, JSON.stringify(fill));
    if (shots) await vis('.chat-pane').first().screenshot({ path: `${shots}/browser-live-one.png` });
    const h1 = await vis('.chat-browser').first().evaluate((e) => e.getBoundingClientRect().height);

    await until(async () => (await paneText()).includes('ON-PAGE-ONE'));
    await send('NEXT');
    ok('the view follows the agent to the next page, live',
      await until(async () => (await vis('.chat-browser-title').innerText()) === 'Verify page two', 15000),
      `${await vis('.chat-browser-address').innerText().catch(() => '')} | pane: ${(await paneText()).slice(-300)}`);
    const src2 = await vis('.chat-browser-frame img').first().getAttribute('src').catch(() => '');
    ok('…with a new frame, not the old one', src2 && src2 !== src);
    const h2host = await hostIndex();
    ok('…and it moved with the agent into the NEW step, leaving the old one plain',
      h2host.views === 1 && h2host.steps >= 2 && h2host.at === h2host.steps - 1, JSON.stringify(h2host));
    const h2 = await vis('.chat-browser').first().evaluate((e) => e.getBoundingClientRect().height);
    ok('a frame swap does not move the layout (same height across pages)', Math.abs(h1 - h2) <= 1, `${h1} → ${h2}`);
    if (shots) await vis('.chat-pane').first().screenshot({ path: `${shots}/browser-live-two.png` });

    console.log('── controls');
    await vis('.chat-browser-stage').first().click();
    ok('a click on the frame opens it full-window', await until(async () => (await vis('.image-viewer').count()) === 1, 5000));
    await page.keyboard.press('Escape');
    await until(async () => (await vis('.image-viewer').count()) === 0, 5000);
    ok('it is drawn as a window: three lights and an address bar',
      (await vis('.chat-browser-light').count()) === 3 && (await vis('.chat-browser-address').count()) === 1);
    const collapsedOK = async () => (await vis('.chat-browser-stage').count()) === 0 && (await vis('.chat-browser-bar').count()) === 1;
    const expandedOK = async () => (await vis('.chat-browser-stage').count()) === 1;
    await vis('.chat-browser-light[data-light="min"]').first().click();
    ok('the yellow light rolls the window up to its title bar', await until(collapsedOK, 5000));
    if (shots) await vis('.chat-pane').first().screenshot({ path: `${shots}/browser-live-collapsed.png` });
    await vis('.chat-browser-light[data-light="min"]').first().click();
    ok('…and back down', await until(expandedOK, 5000));
    await vis('.chat-browser-address').first().click();
    ok('a click on the title bar rolls it up too', await until(collapsedOK, 5000));
    await vis('.chat-browser-btn[aria-label="Show the browser"]').first().click();
    ok('…and the chevron brings the frame back', await until(expandedOK, 5000));
    await vis('.chat-browser-light[data-light="zoom"]').first().click();
    ok('the green light opens the frame full-window', await until(async () => (await vis('.image-viewer').count()) === 1, 5000));
    await page.keyboard.press('Escape');
    await until(async () => (await vis('.image-viewer').count()) === 0, 5000);

    console.log('── closing');
    await until(async () => (await paneText()).includes('ON-PAGE-TWO'));
    await send('CLOSE');
    ok('the browser closing removes the view', await until(async () => (await page.locator('.chat-browser').count()) === 0, 15000));
  } finally {
    await browser.close();
    srv.kill();
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
