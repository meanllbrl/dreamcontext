#!/usr/bin/env node
/**
 * PDFs and clips on the Super stage (owner 2026-10-25: "the Super Agent must be able to show a PDF
 * and, for sure, a VIDEO on the stage as floating cards").
 *
 *   npm run build && node scripts/verify/super-pdf-video.mjs
 *
 * WHAT IT DRIVES — the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Google Chrome (`channel: 'chrome'`: H.264 and the built-in PDF viewer) at 1440×900,
 * light and dark, and a scripted stand-in `claude` that, as the Super Agent, runs
 * `super open pdf` / `super open video` / `super present` / `super stack`. A 2-page PDF and three
 * 3-second H.264 clips are made on the spot (ffmpeg). No tokens spent; everything is fictional
 * ("Pocket Ledger").
 *
 * WHAT IT PROVES — a PDF card opens large and draws the chat's PdfViewer; a clip card opens wide
 * and draws the chat's player paused (no autoplay, no sound); shown side by side it plays on the
 * owner's click and its card's full screen is the player's own; stacked to Others it stops; one
 * PDF presents as a spotlight and its full screen is the chat's full-window PdfViewer; two clips
 * in one call are one group and three clips present as a filmstrip. Screenshots:
 * tmp/super-pdf-video/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-pdf-video-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-pdf-video');
const REPORTS = join(SCRATCH, 'reports.ndjson');

const PDF = 'docs/ledger-handbook.pdf';
const CLIP = 'clips/share-demo.mp4';
const CLIPS = ['clips/takes/take-a.mp4', 'clips/takes/take-b.mp4'];
const idFor = (kind, ref) => `${kind}-${createHash('sha1').update(ref).digest('hex').slice(0, 12)}`;

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
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
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    report({ kind: 'handover', steps: [
      cli('super', 'open', 'pdf', ${JSON.stringify(PDF)}, '--title', 'Ledger handbook'),
      cli('super', 'open', 'video', ${JSON.stringify(CLIP)}, '--title', 'Share demo'),
    ] });
    return 'opened the handbook and the demo';
  }
  const m = text.match(/^(STACK|PRESENT|CLIPS|OFF)(?: (.*))?$/);
  if (!m) return 'ok';
  const args = (m[2] || '').split(' ').filter(Boolean);
  const steps = m[1] === 'STACK' ? [cli('super', 'stack', ...args)]
    : m[1] === 'PRESENT' ? [cli('super', 'present', ...args)]
    : m[1] === 'OFF' ? [cli('super', 'present', '--off')]
    : [cli('super', 'open', 'video', ...args)];
  report({ kind: m[1], steps });
  return 'done ' + m[1];
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
    try { said = role === 'super' ? superTurn(blocks.find((b) => /^\\[super handover\\]|^(STACK|PRESENT|CLIPS|OFF)\\b/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
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

/** A two-page PDF written by hand (no dependency): each page one line of text. */
function tinyPdf(lines) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + lines.length * 2;
  const kids = [];
  for (const text of lines) {
    const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

function clip(rel, color) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=3`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-vf', `drawbox=x=0:y=0:w=640:h=24:color=${color}:t=fill`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', join(PROJ, rel)], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'docs'), join(PROJ, 'clips', 'takes'), OUT]) mkdirSync(d, { recursive: true });
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
  writeFileSync(join(PROJ, PDF), tinyPdf(['Pocket Ledger handbook', 'Page two: exports']));
  clip(CLIP, 'orange');
  clip(CLIPS[0], 'green');
  clip(CLIPS[1], 'purple');
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
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

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [], groups: [], view: {} }; } };

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));

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

/** Every `<video>` on the page: where it sits and whether it plays. */
const videos = (page) => page.evaluate(() => [...document.querySelectorAll('video')].map((v) => ({
  card: v.closest('[data-container-id]')?.getAttribute('data-container-id') ?? null,
  paused: v.paused, muted: v.muted, autoplay: v.autoplay, t: v.currentTime, ready: v.readyState, w: v.videoWidth,
})));

let server = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw.chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const say = async (text) => {
    const n = readNd(REPORTS).length;
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill(text);
    await page.keyboard.press('Enter');
    await until(page, async () => readNd(REPORTS).length > n, 30000);
    return readNd(REPORTS).at(-1);
  };

  console.log('\n── hand over: the super opens a PDF and a clip');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super opened both', await until(page, async () => readNd(REPORTS).some((r) => r.kind === 'handover'), 60000));
  const hand = readNd(REPORTS).find((r) => r.kind === 'handover');
  ok('both open calls succeeded', hand?.steps?.every((s) => s.status === 0), JSON.stringify(hand?.steps));
  const PDF_ID = idFor('pdf', PDF);
  const CLIP_ID = idFor('video', CLIP);
  const rec = record();
  const byId = (id) => rec.containers.find((c) => c.id === id);
  ok('the PDF card opened large', byId(PDF_ID)?.kind === 'pdf' && byId(PDF_ID)?.size === 'large', JSON.stringify(byId(PDF_ID)));
  ok('the clip card opened wide', byId(CLIP_ID)?.kind === 'video' && byId(CLIP_ID)?.size === 'wide', JSON.stringify(byId(CLIP_ID)));

  await settle(page);
  const card = (id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
  ok('the PDF card draws the chat\'s PdfViewer, its frame loaded', await until(page, async () => (await card(PDF_ID).locator('.pdf-viewer--embedded iframe.pdf-viewer-frame').count()) === 1, 15000),
    await card(PDF_ID).innerText().catch(() => ''));
  ok('the clip card draws the chat\'s player, its first frame loaded', await until(page, async () => (await videos(page)).some((v) => v.card === CLIP_ID && v.ready >= 1 && v.w === 640), 15000), JSON.stringify(await videos(page)));
  let v0 = (await videos(page)).find((v) => v.card === CLIP_ID);
  ok('…paused, never autoplaying', v0 && v0.paused && !v0.autoplay && v0.t === 0, JSON.stringify(v0));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, '1-float-light-1440.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, '1-float-dark-1440.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  console.log('\n── full screen from the floating card: the player\'s controls work');
  await card(CLIP_ID).hover();
  await card(CLIP_ID).locator('[data-testid="super-card-fullscreen"]').click();
  ok('the floating clip goes full screen', await until(page, async () => page.evaluate(() => document.fullscreenElement?.tagName === 'VIDEO'), 5000));
  ok('…and takes the pointer there (its controls can be clicked)', await page.evaluate(() => getComputedStyle(document.fullscreenElement).pointerEvents !== 'none'),
    await page.evaluate(() => document.fullscreenElement && getComputedStyle(document.fullscreenElement).pointerEvents));
  const viewBefore = JSON.stringify(record().view);
  const posBefore = JSON.stringify(record().containers.find((c) => c.id === CLIP_ID)?.pos ?? null);
  await page.mouse.click(720, 450);
  ok('…one click there plays it, still full screen', await until(page, async () => page.evaluate(() => document.fullscreenElement?.tagName === 'VIDEO' && !document.fullscreenElement.paused), 5000),
    await page.evaluate(() => ({ fs: document.fullscreenElement?.tagName ?? null })));
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  ok('…the click and a drag in there neither show the card side by side nor move it',
    JSON.stringify(record().view) === viewBefore && JSON.stringify(record().containers.find((c) => c.id === CLIP_ID)?.pos ?? null) === posBefore,
    JSON.stringify({ viewBefore, view: record().view, posBefore, pos: record().containers.find((c) => c.id === CLIP_ID)?.pos }));
  await page.evaluate(() => { const v = document.fullscreenElement; v?.pause(); if (v) v.currentTime = 0; return document.exitFullscreen?.(); }).catch(() => {});
  await page.waitForTimeout(600);
  ok('…and back out of full screen the card still floats', await until(page, async () => (await card(CLIP_ID).getAttribute('data-where')) === 'float', 4000));

  console.log('\n── the owner clicks the clip: side by side, then it plays on his click');
  await card(CLIP_ID).click({ position: { x: 40, y: 12 } });
  ok('the clip is shown side by side', await until(page, async () => record().view?.mode === 'half' && record().view?.card === CLIP_ID, 10000), JSON.stringify(record().view));
  await settle(page);
  const half = page.locator(`[data-container-id="${CLIP_ID}"][data-where="half"] video`);
  ok('…its player is there, still paused', await until(page, async () => (await half.count()) === 1 && (await half.evaluate((v) => v.paused && v.readyState >= 1)), 10000));
  const box = await half.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  ok('one click on the clip plays it', await until(page, async () => half.evaluate((v) => !v.paused && v.currentTime > 0.6), 8000), JSON.stringify(await videos(page)));
  await page.screenshot({ path: join(OUT, '2-playing-light-1440.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '2-playing-dark-1440.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator(`[data-container-id="${CLIP_ID}"] [data-testid="super-card-fullscreen"]`).click();
  ok('the card\'s full screen is the player\'s own', await until(page, async () => page.evaluate(() => document.fullscreenElement?.tagName === 'VIDEO'), 5000));
  await page.evaluate(() => document.exitFullscreen?.()).catch(() => {});
  await page.waitForTimeout(500);

  console.log('\n── stacked to Others, it stops');
  const st = await say(`STACK ${CLIP_ID}`);
  ok('super stack succeeded', st?.steps?.[0]?.status === 0, JSON.stringify(st));
  ok('the clip went to Others', await until(page, async () => record().containers.find((c) => c.id === CLIP_ID)?.place === 'others', 8000));
  await settle(page);
  ok('…and nothing plays any more', await until(page, async () => (await videos(page)).every((v) => v.paused), 5000), JSON.stringify(await videos(page)));

  console.log('\n── one PDF presented: a spotlight; its full screen is the chat\'s PdfViewer');
  const pr = await say(`PRESENT ${PDF_ID}`);
  ok('super present succeeded', pr?.steps?.[0]?.status === 0, JSON.stringify(pr));
  ok('the layout is spotlight', await until(page, async () => record().view?.layout === 'spotlight', 8000), JSON.stringify(record().view));
  await settle(page);
  ok('…the PDF fills the spotlight card', await until(page, async () => (await page.locator(`[data-container-id="${PDF_ID}"][data-where="present"] iframe.pdf-viewer-frame`).count()) === 1, 10000));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, '3-pdf-spotlight-light-1440.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '3-pdf-spotlight-dark-1440.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator(`[data-container-id="${PDF_ID}"] [data-testid="super-card-fullscreen"]`).click();
  ok('the card\'s full screen opens the full-window PdfViewer', await until(page, async () => (await page.locator('.pdf-viewer[role="dialog"] iframe.pdf-viewer-frame').count()) === 1, 5000));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, '4-pdf-fullscreen-1440.png') });
  await page.keyboard.press('Escape');
  ok('…Esc closes it', await until(page, async () => (await page.locator('.pdf-viewer[role="dialog"]').count()) === 0, 5000));
  await say('OFF');

  console.log('\n── two clips in one call are one group; three clips present as a filmstrip');
  const cl = await say(`CLIPS ${CLIPS.join(' ')}`);
  let opened = {};
  try { opened = JSON.parse(cl?.steps?.[0]?.out ?? '{}'); } catch { /* shown below */ }
  ok('super open video with two refs grouped them', cl?.steps?.[0]?.status === 0 && opened.autoGroup === true && opened.group?.name === 'takes' && opened.group?.cards?.length === 2, cl?.steps?.[0]?.out);
  const ids = [CLIP_ID, ...CLIPS.map((r) => idFor('video', r))];
  const fp = await say(`PRESENT ${ids.join(' ')}`);
  ok('super present of three clips succeeded', fp?.steps?.[0]?.status === 0, JSON.stringify(fp));
  ok('…and the clips picked the filmstrip', await until(page, async () => record().view?.layout === 'filmstrip', 8000), JSON.stringify(record().view));
  await settle(page);
  await page.waitForTimeout(1500);
  const vs = await videos(page);
  ok('the big card draws a player; nothing plays by itself', vs.length >= 1 && vs.every((v) => v.paused), JSON.stringify(vs));
  await page.screenshot({ path: join(OUT, '5-filmstrip-light-1440.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '5-filmstrip-dark-1440.png') });
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
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}`);
process.exit(fails.length === 0 ? 0 : 1);
