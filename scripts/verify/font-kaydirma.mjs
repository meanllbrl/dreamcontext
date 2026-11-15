#!/usr/bin/env node
/**
 * TYPE SIZE, UNREAD SCROLL, THE ↓ BUTTON AND THE ZOOM ICON (owner 2026-11-15, "Claude Desktop gibi"),
 * on the real dashboard server with a scratch HOME + vault and a scripted `claude`, in a normal chat:
 *   - T  the transcript's reading size and rhythm, and a side-menu row, measured on the rendered page;
 *   - K  a send at the bottom, a long streamed answer: the view stops with the answer's start on
 *        screen (his own message near the top), it does not ride to the bottom; ↓ shows;
 *   - D  ↓ is round and floats OVER the transcript (inside the scroller's box), centred; a click
 *        reaches the bottom and hides it;
 *   - Z  the title bar's zoom is one icon; a click opens a panel with finer steps and a reset; a
 *        step changes the one `--zoom` the type scale reads.
 * Screenshots light + dark into SHOTS_DIR.
 *
 *   npm run build && node scripts/verify/font-kaydirma.mjs
 *   SHOTS_DIR=<dir> PHASE=before|after   (before: only T + screenshots, the old build has no icon)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dc-verify-font-kaydirma-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = process.env.SHOTS_DIR || join(REPO, 'tmp', 'verify-font-kaydirma');
const PHASE = process.env.PHASE || 'after';
const CONV_ID = randomUUID();
mkdirSync(SHOTS, { recursive: true });

const STORY = Array.from({ length: 70 }, (_, i) => `${i + 1}. Fener Dede ${i + 1}. akşam da merdivenleri saydı, lambayı yaktı ve denize baktı.`).join('\n');

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STORY = ${JSON.stringify(STORY)};
let buf = '';
process.stdin.on('data', async (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: '${CONV_ID}', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
    out({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    const lines = STORY.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: lines[i] + '\\n' } } });
      await sleep(60);
    }
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: STORY }] } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: '${CONV_ID}' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function seed() {
  const lines = [];
  const at = (i) => new Date(Date.parse('2026-11-15T01:00:00Z') + i * 60_000).toISOString();
  const entry = (i, type, message) => JSON.stringify({ type, uuid: `${type}-${i}-${randomUUID().slice(0, 8)}`, timestamp: at(i), cwd: PROJ, sessionId: CONV_ID, version: '2.1.220', gitBranch: 'main', message });
  const para = 'Bir zamanlar, Karadeniz’in kuzeyinde küçük bir adada yaşlı bir deniz feneri bekçisi yaşarmış. Adı Rüstem’miş ama herkes ona “Fener Dede” dermiş. Gerçi adada ondan başka kimse yokmuş.';
  for (let t = 0; t < 4; t++) {
    lines.push(entry(t * 2, 'user', { role: 'user', content: [{ type: 'text', text: `bana bir hikaye anlat (${t + 1})` }] }));
    lines.push(entry(t * 2 + 1, 'assistant', { role: 'assistant', content: [{ type: 'text', text: `**Fener Dede ${t + 1}**\n\n${para}\n\n${para}\n\n- Her akşam 213 basamak\n- Lambayı yakar, camları siler\n\nSonra da sabaha kadar karanlık denize bakarmış.` }] }));
  }
  const dir = join(HOME, '.claude', 'projects', 'scratch-proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CONV_ID}.jsonl`), lines.join('\n') + '\n');
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  seed();
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...clean, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0' }, stdio: 'ignore',
  });
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
};

async function run(base) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'dark'); } catch { /* */ } });
  if (process.env.DEBUG_WRITES) await ctx.addInitScript(() => {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    window.__w = [];
    Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return d.get.call(this); }, set(v) {
      if (this.classList?.contains('chat-scroll')) window.__w.push({ t: Math.round(performance.now()), from: Math.round(d.get.call(this)), to: Math.round(v), sh: this.scrollHeight, ch: this.clientHeight, at: (new Error().stack || '').split('\n').slice(2, 4).join(' | ').slice(0, 220) });
      d.set.call(this, v);
    } });
  });
  const page = await ctx.newPage();
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 15000) => { const e = Date.now() + ms; while (Date.now() < e) { if (await fn()) return true; await page.waitForTimeout(120); } return false; };
  const shot = async (name) => { await page.screenshot({ path: join(SHOTS, `${PHASE}-${name}.png`) }); };
  const theme = async (t) => { await page.evaluate((v) => { localStorage.setItem('dreamcontext-theme', v); }, t); await page.reload({ waitUntil: 'domcontentloaded' }); };

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  const past = page.getByRole('button', { name: /Past chats/ }).first();
  ok('Past chats is offered', await until(async () => (await past.count()) > 0));
  await past.click();
  ok('the picker lists the seeded chat', await until(async () => (await vis('.chp-row').count()) > 0));
  await vis('.chp-row').first().click();
  ok('the chat opens with its history', await until(async () => (await vis('.chat-scroll .markdown-body').count()) > 2, 20000));
  await page.waitForTimeout(1200);

  if (process.env.DEBUG_WRITES) console.log('WRITES', JSON.stringify(await page.evaluate(() => { const w = window.__w; return { n: w.length, first: w.slice(0, 6), nonzeroFrom: w.filter((x) => x.from !== 0).slice(0, 5), last: w.slice(-3), el: (() => { const e = Array.from(document.querySelectorAll(".chat-scroll")).find((n) => n.clientHeight > 0); const cs = getComputedStyle(e); return { st: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight, ov: cs.overflowY, sb: cs.scrollBehavior, ct: cs.contain, disp: cs.display }; })() }; }), null, 1));
  // ── T: the type, measured where it is painted.
  const type = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.chat-scroll .markdown-body p')).find((n) => n.getBoundingClientRect().height > 0);
    const cs = p ? getComputedStyle(p) : null;
    let pitch = null;
    if (p) {
      const r = document.createRange(); r.selectNodeContents(p);
      const tops = [...new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top)))].sort((a, b) => a - b);
      if (tops.length > 1) pitch = tops[1] - tops[0];
    }
    if (pitch === null && cs) pitch = Math.round(parseFloat(cs.lineHeight));
    const row = Array.from(document.querySelectorAll('.ns-drawer *, .ns-rail *, nav *')).find((n) => n.childElementCount === 0 && (n.textContent || '').trim() === 'New chat window');
    const side = row ? getComputedStyle(row).fontSize : null;
    const zoom = getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim();
    const base = getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim();
    return { size: cs?.fontSize, lineHeight: cs?.lineHeight, pitch, side, family: cs?.fontFamily.split(',')[0], zoom, base };
  });
  console.log('  type:', JSON.stringify(type));
  writeFileSync(join(SHOTS, `${PHASE}-type.json`), JSON.stringify(type, null, 2));
  if (PHASE === 'after') {
    ok(`reading size is Claude Desktop's (≈14.5px, got ${type.size})`, parseFloat(type.size) >= 14 && parseFloat(type.size) <= 15);
    ok(`line pitch is Claude Desktop's (≈21-22px, got ${type.pitch})`, type.pitch >= 20 && type.pitch <= 23);
  }
  await shot('chat-dark');
  await theme('light');
  ok('the chat comes back after a reload', await until(async () => (await vis('.chat-scroll .markdown-body').count()) > 2, 20000));
  await page.waitForTimeout(1200);
  await shot('chat-light');
  await theme('dark');
  await until(async () => (await vis('.chat-scroll .markdown-body').count()) > 2, 20000);
  await page.waitForTimeout(1200);

  // ── K: a send at the bottom, a long answer.
  const input = vis('.chat-cmp-input').first();
  await input.click();
  await input.fill('bir 70 satırlık başka hikaye anlat');
  await page.keyboard.press('Enter');
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    samples.push(await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.chat-scroll')).find((n) => n.clientHeight > 0);
      if (!el) return null;
      const users = el.querySelectorAll('.chat-msg-user-row');
      const own = users[users.length - 1];
      const top = el.getBoundingClientRect().top;
      return { st: el.scrollTop, fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), ownTop: own ? Math.round(own.getBoundingClientRect().top - top) : null };
    }));
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);
  const end = samples.filter(Boolean).at(-1);
  console.log('  scroll end:', JSON.stringify(end));
  writeFileSync(join(SHOTS, `${PHASE}-scroll.json`), JSON.stringify(samples, null, 1));
  await shot('stream-end-dark');
  if (PHASE === 'after') {
    ok(`the view stops with his message on screen near the top (ownTop ${end?.ownTop})`, end && end.ownTop !== null && end.ownTop >= 0 && end.ownTop < 200, JSON.stringify(end));
    ok(`the view did not ride to the bottom (fromBottom ${end?.fromBottom})`, end && end.fromBottom > 200);
  }

  // ── D: the ↓ button.
  const btn = vis('.chat-jump').first();
  ok('↓ shows while the view is above the end', (await btn.count()) > 0);
  if (await btn.count()) {
    const geo = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.chat-jump')).find((n) => n.getBoundingClientRect().height > 0);
      const s = Array.from(document.querySelectorAll('.chat-scroll')).find((n) => n.clientHeight > 0);
      const br = b.getBoundingClientRect(); const sr = s.getBoundingClientRect();
      return { w: br.width, h: br.height, cx: br.left + br.width / 2, scx: sr.left + sr.width / 2, inside: br.top >= sr.top && br.bottom <= sr.bottom, radius: getComputedStyle(b).borderRadius };
    });
    console.log('  ↓:', JSON.stringify(geo));
    if (PHASE === 'after') {
      ok(`↓ is round (${geo.w}x${geo.h})`, Math.abs(geo.w - geo.h) < 1.5 && geo.w >= 28 && geo.w <= 40);
      ok('↓ floats over the transcript (inside the scroller)', geo.inside);
      ok('↓ is centred on the transcript', Math.abs(geo.cx - geo.scx) < 2);
    }
    await page.mouse.move(10, 10);
    const box = await btn.boundingBox();
    await page.screenshot({ path: join(SHOTS, `${PHASE}-jump-zoom-dark.png`), clip: { x: box.x - 160, y: box.y - 70, width: box.width + 320, height: box.height + 110 } });
    await btn.click();
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => { const el = Array.from(document.querySelectorAll('.chat-scroll')).find((n) => n.clientHeight > 0); return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight); });
    ok(`↓ reaches the bottom (fromBottom ${after})`, after < 4);
    ok('↓ hides at the bottom', (await vis('.chat-jump').count()) === 0);
  }

  // ── Z: the zoom icon.
  const zoomBtn = vis('[data-testid="zoom-button"]').first();
  if (PHASE === 'after') {
    ok('the title bar shows one zoom icon', (await zoomBtn.count()) > 0);
    if (await zoomBtn.count()) {
      await zoomBtn.click();
      const panel = vis('[data-testid="zoom-panel"]').first();
      ok('a click opens the zoom panel', await until(async () => (await panel.count()) > 0, 3000));
      await page.waitForTimeout(250);
      await shot('zoom-panel-dark');
      const pb = await panel.boundingBox();
      if (pb) await page.screenshot({ path: join(SHOTS, `${PHASE}-zoom-panel-crop-dark.png`), clip: { x: Math.max(0, pb.x - 40), y: 0, width: pb.width + 80, height: pb.y + pb.height + 30 } });
      await vis('[data-testid="zoom-in"]').first().click();
      const z1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim());
      ok(`a step is finer than 10% (--zoom ${z1})`, Math.abs(parseFloat(z1) - 1.05) < 0.001);
      const sz = await page.evaluate(() => getComputedStyle(Array.from(document.querySelectorAll('.chat-scroll .markdown-body p')).find((n) => n.getBoundingClientRect().height > 0)).fontSize);
      ok(`the reading size follows the zoom (${sz})`, parseFloat(sz) > parseFloat(type.size));
      await vis('[data-testid="zoom-reset"]').first().click();
      const z2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim());
      ok(`reset goes back to 100% (--zoom ${z2})`, parseFloat(z2) === 1);
      await theme('light');
      await vis('[data-testid="zoom-button"]').first().click();
      await page.waitForTimeout(300);
      await shot('zoom-panel-light');
    }
  } else {
    await shot('titlebar-dark');
  }
  await browser.close();
}

let server = null;
try {
  setup();
  const port = await freePort();
  server = await startServer(port);
  await run(`http://127.0.0.1:${port}`);
} catch (err) {
  fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  server?.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\n${fails.length ? '❌' : '✅'} ${pass} passed, ${fails.length} failed  (shots: ${SHOTS})`);
process.exit(fails.length ? 1 : 0);
