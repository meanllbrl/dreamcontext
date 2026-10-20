#!/usr/bin/env node
/**
 * The hands-free brand, observed: the new mark (the real gem + two sound waves) on every surface
 * the owner picked, in real Chromium against a scratch vault, light and dark.
 *
 *   npm run build && node scripts/verify/handsfree-brand.mjs
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, a `claude` stand-in, the power runner
 * only logging, `DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL=1` so the "tunnel" is the phone listener on
 * loopback). Mac mode is set up and started for two projects; a laptop socket starts one chat so
 * the list has a row.
 *
 * CHECKS
 *   icons      the three PNGs at their sizes; nothing painted outside the maskable safe circle;
 *              the gem part pixel-matches the REAL mark (main's icon-512.png) within antialiasing
 *   pairing    the phone's sign-in page (390, light + dark): the mark leads, the card, the corner
 *              outlines, no overflow, AA text and button
 *   list       the Sohbetler header (390, light + dark): the mark, the live badge (pulsing,
 *              AA), the corner outlines behind the rows; the badge's pulse is ONE endless
 *              animation, held by the motion clock (paused, stepped), gone under reduced motion;
 *              a dropped link turns the badge hollow and still ("Reaching your Mac…")
 *   mac panel  the laptop's Hands-free sheet (1440, light + dark), off and on: the mark in the
 *              header and the hero card, the same live badge; its pulse rests in Light mode and
 *              in an unfocused window (ambient)
 * Across the run: no console error, no 403 from the pages' own calls.
 *
 * Screenshots: /tmp/hf-brand-shots/ (DC_SHOTS overrides). FAILURE POLICY: collect, exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { contrast, fillContrast, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-brand');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OTHER = join(SCRATCH, 'other');
const POWER_LOG = join(SCRATCH, 'power.log');
const SPAWNS = join(HOME, 'spawns.log');
const SHOTS = process.env.DC_SHOTS || '/tmp/hf-brand-shots';
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const ICONS = join(REPO, 'dashboard', 'public', 'icons');

const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
fs.appendFileSync(path.join(process.env.HOME, 'spawns.log'), JSON.stringify({ pid: process.pid, sid }) + '\\n');
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Drafted: ' + text }] };
    row({ type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
const spawns = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, 'utf-8').trim().split('\n').filter(Boolean) : []);
const LIVE = crypto.randomUUID();

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, OTHER, SHOTS]) mkdirSync(d, { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  // Fictional projects (synthetic-fixtures-for-published-artifacts): these screenshots are shown.
  for (const [name, dir] of [['proj', PROJ], ['other', OTHER]]) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    cli(['init', '-y', '--name', name, '--description', `A scratch project for the brand check (${name})`], dir);
    const r = cli(['vaults', 'add', name, dir], dir);
    if (r.status !== 0) throw new Error(`vaults add ${name}: ${r.stderr || r.stdout}`);
  }
  const tdir = join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const ts = new Date(Date.now() - 3600_000).toISOString();
  const rows = (sid, title) => [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: title }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Working on: ${title}` }] } },
  ].map((o) => JSON.stringify({ ...o, cwd: PROJ, uuid: crypto.randomUUID(), timestamp: ts, sessionId: sid }));
  writeFileSync(join(tdir, `${LIVE}.jsonl`), `${rows(LIVE, 'Release notes for the lantern app').join('\n')}\n`);
  for (const title of ['Tidy the onboarding copy', 'Why does the sync badge flicker?']) {
    const sid = crypto.randomUUID();
    writeFileSync(join(tdir, `${sid}.jsonl`), `${rows(sid, title).join('\n')}\n`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG, DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function mac(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const dismiss = async (page) => {
  for (let i = 0; i < 3; i++) { const x = page.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await page.waitForTimeout(300); }
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** The badge pulse's animations on screen: play state, iterations, current time. (A project tab
 *  the phone is not showing keeps its own list, display:none, which runs nothing.) */
const pulses = (page) => page.evaluate(() => document.getAnimations()
  .filter((a) => a.animationName === 'dc-hf-live' && (a.effect?.target?.getClientRects().length ?? 0) > 0)
  .map((a) => ({ state: a.playState, iterations: a.effect?.getComputedTiming().iterations, t: Number(a.currentTime) })));

let server = null;
let browser = null;
let port = 0;
const errors = [];
const refused = [];
const watch = (page, name) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${String(e).slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() === 403) refused.push(`${name}: ${r.request().method()} ${new URL(r.url()).pathname}`); });
};

try {
  const { chromium, devices } = await import('@playwright/test');
  console.log(`· build: ${CLI}\n· shots: ${SHOTS}`);
  setupScratch();
  browser = await chromium.launch();

  // ── Icons ───────────────────────────────────────────────────────────────────────────
  console.log('\n· icons');
  const sizes = { 'icon-512.png': 512, 'icon-192.png': 192, 'apple-touch-icon-180.png': 180 };
  for (const [file, size] of Object.entries(sizes)) {
    const b = readFileSync(join(ICONS, file));
    report.check(`${file} is ${size}x${size}`, b.readUInt32BE(16) === size && b.readUInt32BE(20) === size);
    copyFileSync(join(ICONS, file), join(SHOTS, file));
  }
  const oldIcon = spawnSync('git', ['show', 'refs/heads/main:dashboard/public/icons/icon-512.png'], { cwd: REPO, maxBuffer: 1 << 24 }).stdout;
  const iconPage = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const b64 = (buf) => `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
  const icon = (f) => b64(readFileSync(join(ICONS, f)));
  const iconSvg = readFileSync(join(REPO, 'dashboard/src/assets/handsfree/handsfree-icon.svg'), 'utf8');
  const measured = await iconPage.evaluate(async ({ icon512, old512, svg }) => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const pixels = async (src, w) => { const img = await load(src); const c = document.createElement('canvas'); c.width = c.height = w; const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, w); return x.getImageData(0, 0, w, w).data; };
    // 1) nothing painted outside the 40 % safe circle of the new 512 icon (1 px for antialiasing)
    const a = await pixels(icon512, 512);
    let outside = 0;
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      if (a[(y * 512 + x) * 4 + 3] > 8 && Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 0.4 * 512 + 1) outside++;
    }
    // 2) the gem part against main's icon-512 (the real mark): the same tree with the waves
    //    removed, drawn in the master PNG's own frame (0 0 1024 1024) at 512.
    const gemOnly = svg.replace(/<path[^>]*data-wave="[^"]+"[^>]*\/>/g, '').replace(/viewBox="[^"]+"/, 'viewBox="0 0 1024 1024"');
    const g = await pixels(`data:image/svg+xml;base64,${btoa(gemOnly)}`, 512);
    const o = await pixels(old512, 512);
    const onWhite = (d, i) => { const al = d[i + 3] / 255; return [0, 1, 2].map((k) => d[i + k] * al + 255 * (1 - al)); };
    let sum = 0; let n = 0; let far = 0;
    for (let i = 0; i < g.length; i += 4) {
      if (g[i + 3] <= 10 && o[i + 3] <= 10) continue;
      const p = onWhite(g, i); const q = onWhite(o, i);
      const d = (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3;
      sum += d; n++; if (d > 40) far++;
    }
    return { outside, meanDiff: sum / n, farShare: far / n, gemPixels: n };
  }, { icon512: icon('icon-512.png'), old512: b64(oldIcon), svg: iconSvg });
  report.check('icon-512 paints nothing outside the maskable safe circle', measured.outside === 0, JSON.stringify(measured));
  report.check(`the gem part matches the real mark (mean |Δ| ${measured.meanDiff.toFixed(2)}/255 over ${measured.gemPixels} px, ${(measured.farShare * 100).toFixed(2)} % edge pixels off)`,
    measured.meanDiff < 8 && measured.farShare < 0.03, JSON.stringify(measured));
  // A board: the new icons as a Home Screen shows them (rounded square, light and dark), with the real mark beside.
  const tile = (src, px, bg) => `<div style="width:${px}px;height:${px}px;border-radius:${px * 0.2237}px;overflow:hidden;background:${bg};box-shadow:0 1px 3px rgba(0,0,0,.25)"><img src="${src}" width=${px} height=${px} style="display:block"></div>`;
  await iconPage.setContent(`<body style="margin:0;font:13px -apple-system,system-ui;color:#333">
    <div style="display:flex;gap:24px;padding:24px;background:#f2f2f7;align-items:flex-end">
      <figure style="margin:0">${tile(icon('icon-512.png'), 256, '#fff')}<figcaption>icon-512 (Home Screen mask)</figcaption></figure>
      <figure style="margin:0">${tile(icon('icon-192.png'), 192, '#fff')}<figcaption>icon-192</figcaption></figure>
      <figure style="margin:0">${tile(icon('apple-touch-icon-180.png'), 180, '#fff')}<figcaption>apple-touch-icon-180</figcaption></figure>
      <figure style="margin:0">${tile(icon('apple-touch-icon-180.png'), 60, '#fff')}<figcaption>60 pt</figcaption></figure>
      <figure style="margin:0"><img src="${b64(oldIcon)}" width=192 style="background:#fff;border-radius:42px"><figcaption>the real mark (main's icon-512)</figcaption></figure>
    </div>
    <div style="display:flex;gap:24px;padding:24px;background:#1c1c1e;color:#ddd;align-items:flex-end">
      <figure style="margin:0">${tile(icon('icon-512.png'), 256, '#2c2c2e')}<figcaption>on a dark launcher</figcaption></figure>
      <figure style="margin:0">${tile(icon('icon-192.png'), 96, '#2c2c2e')}<figcaption>96</figcaption></figure>
      <figure style="margin:0"><img src="${icon('icon-192.png')}" width=48><figcaption>48 (notification)</figcaption></figure>
      <figure style="margin:0;position:relative"><img src="${icon('icon-512.png')}" width=256 style="background:#fff;border-radius:128px"><figcaption>maskable circle</figcaption></figure>
    </div></body>`);
  await iconPage.screenshot({ path: join(SHOTS, 'icons-board.png'), fullPage: true });
  await iconPage.close();

  // ── Server + Mac mode ───────────────────────────────────────────────────────────────
  port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const { WebSocket: NodeWs } = await import('ws');
  const laptop = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&resume=${LIVE}`);
  laptop.on('error', () => {});
  await new Promise((r) => laptop.on('open', r));
  laptop.send(JSON.stringify({ type: 'user', text: 'draft the notes' }));
  report.check('the laptop started a running chat', await until(() => spawns().length === 1, 15000));
  await sleep(800);
  laptop.terminate();

  const setup = await mac(port, 'POST', 'setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));

  // ── The Mac panel, off (ready) ──────────────────────────────────────────────────────
  const openSheet = async (theme, label) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    await ctx.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await setTheme(ctx, theme);
    await markAnnouncementsSeen(ctx, base);
    const page = await ctx.newPage();
    watch(page, label);
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismiss(page);
    await page.locator('[data-testid="hf-button"]').click();
    await until(async () => (await page.locator('[data-testid="hf-sheet"]').count()) === 1, 8000);
    await page.waitForTimeout(800);
    return { ctx, page };
  };
  console.log('\n· the Mac panel, off');
  {
    const { ctx, page } = await openSheet('light', 'mac-off');
    report.check('mac off: the sheet header carries the mark', (await page.locator('.hf-sheet-head [data-testid="handsfree-mark"]').count()) === 1);
    report.check('mac off: the hero card leads with the mark', (await page.locator('[data-testid="hf-mac-hero"] [data-testid="handsfree-mark"]').count()) === 1);
    const heroTitle = await contrast(page.locator('.hf-hero-title').first());
    report.check(`mac off: hero title contrast ${heroTitle} >= 4.5`, heroTitle >= 4.5);
    const start = await fillContrast(page.locator('[data-testid="hf-mac-start"]'));
    report.check(`mac off: Start button contrast ${start} >= 4.5`, start >= 4.5);
    await page.locator('[data-testid="hf-sheet"]').screenshot({ path: join(SHOTS, 'mac-panel-off-1440-light.png') });
    await page.screenshot({ path: join(SHOTS, 'mac-panel-off-1440-light-window.png') });
    await ctx.close();
  }

  const started = await mac(port, 'POST', 'start', { vaults: ['proj', 'other'] });
  report.check('Mac mode starts (loopback stand-in tunnel)', started.status === 200 && !!started.json.url, JSON.stringify(started.json).slice(0, 200));
  const phoneUrl = started.json.url;

  // ── The Mac panel, on ───────────────────────────────────────────────────────────────
  for (const theme of ['light', 'dark']) {
    console.log(`\n· the Mac panel, on (${theme})`);
    const { ctx, page } = await openSheet(theme, `mac-${theme}`);
    report.check(`mac ${theme}: the live badge says the link is live and pulses`, (await page.locator('[data-testid="hf-mac-live"][data-live="true"]').count()) === 1);
    const badge = await contrast(page.locator('[data-testid="hf-mac-live"]'));
    report.check(`mac ${theme}: badge text contrast ${badge} >= 4.5`, badge >= 4.5);
    for (const sel of ['.hf-mac-address .hf-quiet', '.hf-mac-power .hf-quiet', '.hf-mac-devices .hf-quiet']) {
      const c = await contrast(page.locator(sel).first());
      report.check(`mac ${theme}: ${sel} contrast ${c} >= 4.5`, c >= 4.5);
    }
    const ret = await fillContrast(page.locator('[data-testid="hf-mac-return"]'));
    report.check(`mac ${theme}: Return button contrast ${ret} >= 4.5`, ret >= 4.5);
    // The pulse is endless: the motion clock holds it (paused, stepped from its interval).
    const held = await until(async () => { const p = await pulses(page); return p.length === 1 && p[0].state === 'paused' && p[0].iterations === Infinity; }, 4000);
    const t0 = (await pulses(page))[0]?.t ?? NaN;
    await page.waitForTimeout(400);
    const t1 = (await pulses(page))[0]?.t ?? NaN;
    report.check(`mac ${theme}: the pulse is one endless animation, held by the 15 fps motion clock and stepped`, held && t1 > t0, JSON.stringify({ held, t0, t1, now: await pulses(page) }));
    await page.locator('[data-testid="hf-sheet"]').screenshot({ path: join(SHOTS, `mac-panel-1440-${theme}.png`) });
    await page.screenshot({ path: join(SHOTS, `mac-panel-1440-${theme}-window.png`) });
    if (theme === 'light') {
      // AMBIENT: Light mode and an unfocused window remove it (the dot rests).
      await page.evaluate(() => document.documentElement.setAttribute('data-light', 'true'));
      report.check('mac: Light mode rests the pulse (no animation left)', await until(async () => (await pulses(page)).length === 0, 3000), JSON.stringify(await pulses(page)));
      await page.evaluate(() => document.documentElement.removeAttribute('data-light'));
      report.check('mac: it comes back when Light mode ends', await until(async () => (await pulses(page)).length === 1, 3000));
      await page.evaluate(() => document.documentElement.setAttribute('data-window-active', 'false'));
      report.check('mac: an unfocused window rests the pulse', await until(async () => (await pulses(page)).length === 0, 3000), JSON.stringify(await pulses(page)));
      await page.evaluate(() => document.documentElement.setAttribute('data-window-active', 'true'));
    }
    await ctx.close();
  }

  // ── The phone: pairing, list, badge ─────────────────────────────────────────────────
  for (const theme of ['light', 'dark']) {
    console.log(`\n· the phone (${theme})`);
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: theme });
    await setTheme(ctx, theme);
    await markAnnouncementsSeen(ctx, phoneUrl);
    const page = await ctx.newPage();
    watch(page, `phone-${theme}`);

    await page.goto(`${phoneUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    report.check(`pairing ${theme}: the mark leads the page (an image named dreamcontext)`, (await page.locator('.hf-hero > svg.hf-hero-mark[role="img"][aria-label="dreamcontext"]').count()) === 1);
    report.check(`pairing ${theme}: the form is one tinted card`, (await page.locator('form#f.hf-card').count()) === 1);
    report.check(`pairing ${theme}: two gem outlines in the corners`, (await page.locator('.hf-backdrop .hfm-decor').count()) === 2);
    report.check(`pairing ${theme}: no horizontal overflow`, (await overflow(page)) <= 0, String(await overflow(page)));
    for (const [sel, min] of [['h1', 4.5], ['.hf-hero > p:not(.hf-eyebrow)', 4.5], ['.hf-eyebrow', 4.5], ['label[for="p"]', 4.5]]) {
      const c = await contrast(page.locator(sel).first());
      report.check(`pairing ${theme}: ${sel} contrast ${c} >= ${min}`, c >= min);
    }
    const go = await fillContrast(page.locator('#go'));
    report.check(`pairing ${theme}: Sign in button contrast ${go} >= 4.5`, go >= 4.5);
    const markBox = await page.locator('.hf-hero-mark').boundingBox();
    report.check(`pairing ${theme}: the mark is centred and sized (${Math.round(markBox?.width ?? 0)}x${Math.round(markBox?.height ?? 0)})`, !!markBox && Math.abs(markBox.x + markBox.width / 2 - 195) <= 2 && markBox.height >= 80);
    await page.screenshot({ path: join(SHOTS, `phone-pairing-390-${theme}.png`) });
    if (theme === 'light') {
      // The offline page reloads as soon as the Mac answers: hold its probe down, as when the Mac is away.
      await page.route('**/api/health', (r) => r.abort('internetdisconnected'));
      await page.goto(`${phoneUrl}/handsfree-offline.html`, { waitUntil: 'load' });
      report.check('offline page: the mark leads it too', (await page.locator('.hf-hero > svg.hf-hero-mark').count()) === 1);
      report.check('offline page: says the Mac is not reachable after two probes', await until(async () => (await page.locator('#more:not([hidden])').count()) === 1, 15000));
      await page.screenshot({ path: join(SHOTS, 'phone-offline-390-light.png') });
      await page.unroute('**/api/health');
    }

    const qr = (await mac(port, 'POST', 'qr')).json.url;
    await page.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    report.check(`list ${theme}: signed in, the Sohbetler list is on screen`, await until(async () => (await page.locator('[data-testid="phone-list"]:visible').count()) === 1, 25000));
    await page.waitForTimeout(1200);
    await dismiss(page);
    report.check(`list ${theme}: the header carries the mark before the title`, await page.locator('.mlist-head:visible').evaluate((h) => {
      const kids = [...h.children];
      return kids[0]?.getAttribute('data-testid') === 'handsfree-mark' && kids[1]?.classList.contains('mlist-h');
    }));
    report.check(`list ${theme}: the live badge is up and pulsing`, await until(async () => (await page.locator('.mlist-head [data-testid="phone-live-badge"][data-live="true"]:visible').count()) === 1, 15000),
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="phone-live-badge"]')].map((b) => {
        const chain = []; for (let n = b; n && chain.length < 8; n = n.parentElement) chain.push(`${n.tagName.toLowerCase()}.${[...n.classList].join('.')}`);
        return `${b.getClientRects().length ? 'shown' : 'hidden'}: ${chain.join(' < ')}`;
      }).join('\n      ')));
    const badgeText = await page.locator('.mlist-head [data-testid="phone-live-badge"]:visible').innerText().catch(() => '');
    const srText = await page.locator('.mlist-head [data-testid="phone-live-badge"]:visible >> .dc-hf-sr').textContent().catch(() => '');
    report.check(`list ${theme}: the badge reads "${srText} ${badgeText}" to a screen reader`, /Connected to your Mac/.test(srText ?? '') && /Mac/.test(badgeText));
    const bc = await contrast(page.locator('.mlist-head [data-testid="phone-live-badge"]:visible'));
    report.check(`list ${theme}: badge text contrast ${bc} >= 4.5`, bc >= 4.5);
    const hc = await contrast(page.locator('.mlist-h:visible'));
    report.check(`list ${theme}: title contrast ${hc} >= 4.5`, hc >= 4.5);
    const head = await page.locator('.mlist-head:visible').boundingBox();
    report.check(`list ${theme}: the header stays 44 px`, Math.round(head?.height ?? 0) === 44, String(head?.height));
    report.check(`list ${theme}: the corner outlines sit behind the list`, await page.locator('[data-testid="handsfree-backdrop"]:visible').evaluate((b) => getComputedStyle(b).zIndex === '-1' && getComputedStyle(b).pointerEvents === 'none'));
    const rowC = await contrast(page.locator('.mlist-title-text:visible').first());
    report.check(`list ${theme}: a row title over the outlines keeps contrast ${rowC} >= 4.5`, rowC >= 4.5);
    report.check(`list ${theme}: no horizontal overflow`, (await overflow(page)) <= 0, String(await overflow(page)));
    report.check(`list ${theme}: the open chat's header badge (under the list) is quiet`, (await page.locator('.agent-overlay-head [data-testid="phone-live-badge"][data-quiet="true"]').count()) >= 1);
    const held = await until(async () => { const p = await pulses(page); return p.length === 1 && p[0].state === 'paused' && p[0].iterations === Infinity; }, 4000);
    report.check(`list ${theme}: the pulse is ONE endless animation, held by the motion clock`, held, JSON.stringify(await pulses(page)));
    await page.screenshot({ path: join(SHOTS, `phone-list-390-${theme}.png`) });
    await page.screenshot({ path: join(SHOTS, `phone-list-header-390-${theme}.png`), clip: { x: 0, y: 0, width: 390, height: 120 } });

    if (theme === 'light') {
      // A dropped link: the badge goes hollow and still, and says it is reaching the Mac.
      await page.route('**/api/handsfree/phone', (r) => r.abort('internetdisconnected'));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      report.check('list: a dropped link turns the badge to "Reaching your Mac…", no pulse', await until(async () => (await page.locator('.mlist-head [data-testid="phone-live-badge"][data-live="false"]:visible').count()) === 1, 8000));
      report.check('list: nothing pulses on a dropped link', (await pulses(page)).length === 0, JSON.stringify(await pulses(page)));
      await page.screenshot({ path: join(SHOTS, 'phone-badge-reaching-390-light.png'), clip: { x: 0, y: 0, width: 390, height: 120 } });
      await page.unroute('**/api/handsfree/phone');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      report.check('list: the badge comes back live once the Mac answers', await until(async () => (await page.locator('.mlist-head [data-testid="phone-live-badge"][data-live="true"]:visible').count()) === 1, 8000));

      // The background shapes, clearest on a project with no chats yet.
      await page.locator('[data-testid="list-projects"]:visible .mlist-project', { hasText: 'other' }).click();
      await until(async () => page.url().includes('vault=other') || (await page.locator('[data-testid="list-empty"]').count()) > 0, 10000);
      await page.waitForTimeout(1500);
      await dismiss(page);
      report.check('backdrop: the empty project\'s list shows both corner outlines', (await page.locator('[data-testid="handsfree-backdrop"]:visible .hfm-decor').count()) === 2);
      await page.screenshot({ path: join(SHOTS, 'phone-backdrop-390-light.png') });
    }
    await ctx.close();
  }

  // ── Reduced motion: nothing pulses ──────────────────────────────────────────────────
  console.log('\n· reduced motion');
  {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await markAnnouncementsSeen(ctx, phoneUrl);
    const page = await ctx.newPage();
    watch(page, 'phone-reduced');
    await page.goto((await mac(port, 'POST', 'qr')).json.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await until(async () => (await page.locator('.mlist-head [data-testid="phone-live-badge"]:visible').count()) === 1, 20000);
    await page.waitForTimeout(800);
    const p = await pulses(page);
    report.check('reduced motion: the badge is up and nothing pulses', p.every((a) => a.iterations !== Infinity), JSON.stringify(p));
    await ctx.close();
  }

  const errs = errors.filter((e) => !/__TAURI|status of 401|ERR_INTERNET_DISCONNECTED|internetdisconnected/i.test(e));
  report.check('no console errors', errs.length === 0, errs.slice(0, 8).join('\n      '));
  report.check('no 403 from the pages\' own calls', refused.length === 0, refused.slice(0, 8).join('\n      '));
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err));
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  if (port) { try { await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/stop`, { method: 'POST' }); } catch { /* gone */ } }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed`);
if (report.fails.length) { for (const f of report.fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
