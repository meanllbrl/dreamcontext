#!/usr/bin/env node
/**
 * "Attach files…" puts pictures IN the text like a paste, and the sent bubble draws them (task
 * attach-files-pictures-become-inline-chips-and-sent-bubble-draws-pictures, owner 2026-10-28).
 * The real dashboard server from this checkout's dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), the
 * stand-in `claude` of composer-picture-chips.mjs (no tokens), fictional project "orbit". The
 * browser build's picker is a prompt (desktop.ts `pickFiles`), answered with real PNGs that live
 * OUTSIDE the project, as a native pick would.
 *
 *   npm run build && node scripts/verify/composer-attach-picked.mjs
 *
 * Chat: type, + → Attach files… one picture: a chip at the caret, thumbnail, none in the row.
 * Then + → three pictures at once: three chips; a PDF picked stays in the row. A comment after
 * each chip; sent: four `[Picture N: <copy in agent-drops>]` + its comment, the PDF's path too.
 * The sent bubble: four thumbnails, each with its comment, no `[Picture` text; a click opens the
 * viewer. Super: one picture via its + menu, sent and drawn the same. 1440 and 390 screenshots.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-attach-picked-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-composer-attach-picked');
const LOGS = join(OUT, 'logs');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;
const NOTES = [['now', 'Açılış sayfası']];

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, mkdirSync as mk } from 'node:fs';
import { randomUUID } from 'node:crypto';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'cap-' + process.pid;
const convo = at('--resume') || at('--session-id') || '';
const dir = process.env.HOME + '/.claude/projects/verify-picture-chips';
/** Rows this process wrote, by uuid: a rewind gives his message back from here. */
const rows = new Map();
function row(o) {
  if (role !== 'super' || !/^[0-9a-f-]{36}$/.test(convo)) return;
  mk(dir, { recursive: true });
  const uuid = randomUUID();
  rows.set(uuid, o);
  appendFileSync(dir + '/' + convo + '.jsonl', JSON.stringify({ ...o, sessionId: convo, uuid, timestamp: new Date().toISOString() }) + '\\n');
}
const cli = (...args) => spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
};
let seq = 0;
const toolCall = (name, input, result) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  const use = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
  out(use); row(use);
  const res = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result }], is_error: false }] } };
  out(res); row(res);
};
const NOTES = ${JSON.stringify(NOTES)};
async function superTurn(text, parts) {
  if (text.startsWith('[super handover]')) {
    for (const [sec, line] of NOTES) cli('super', 'note', 'add', sec, line);
    report({ kind: 'handover' });
    return 'Devraldım.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 200) }); return null; }
  if (/^HAZIR/.test(text)) return 'Planı yazdım: ödeme formu iki adımda bitiyor, testler yeşil.';
  if (/^MESGUL/.test(text)) {
    say('Uzun bir iş yapıyorum.');
    toolCall('Bash', { command: 'sleep 9', description: 'Long job' }, '');
    report({ kind: 'busy' });
    await sleep(9000);
    return 'Bitti.';
  }
  if (parts.length >= 3) {
    // A section per part, in his order; the stacked pair (2 and 3) one mark per line.
    report({ kind: 'parts', parts });
    return '<!-- re:' + parts[0] + ' -->\\nİlk parçana: Windows testlerini yalnız CLI için ekliyorum.\\n\\n<!-- re:' + parts[1] + ' -->\\n<!-- re:' + parts[2] + ' -->\\nİkisine: anlaştık, devam ediyorum.';
  }
  report({ kind: 'owner', text: text.slice(0, 600) });
  return 'Not aldım.';
}
async function childTurn() { return 'Fatura toplamları yeni ledger API üstünde.'; }
let inited = false;
let running = false;
let chain = Promise.resolve();
async function turn(blocks, parts) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '', parts) : await childTurn(); } catch (e) { said = 'error ' + e; }
  if (said) say(said);
  out({ type: 'result', subtype: 'success', is_error: false, result: said ?? '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said: (said ?? '').slice(0, 80) });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      const req = o.request || {};
      let response = {};
      if (req.subtype === 'rewind_conversation') {
        const r = rows.get(req.target_message_uuid);
        const t = r && r.message && r.message.content && r.message.content[0] && r.message.content[0].text;
        response = { rewound: !!t, prefillText: t || '' };
        report({ kind: 'rewind', ok: !!t });
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } });
      continue;
    }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    let parts = [];
    for (const b of blocks) { const m = /^<owner-msg ref="([0-9a-z]{6})"(?: parts="([0-9a-z ]+)")?\\/>$/.exec(b); if (m && m[2]) parts = m[2].split(' '); }
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    if (running) row({ type: 'attachment', attachment: { type: 'queued_command', prompt: blocks.map((text) => ({ type: 'text', text })) } });
    else row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: blocks[0] }] } });
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks, parts)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT, LOGS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'orbit', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(LOGS, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const frames = () => readNd(FRAMES);
const log = (...a) => console.log(...a);
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };

async function clean(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove());
    if (!document.getElementById('cap-kill')) {
      const s = document.createElement('style'); s.id = 'cap-kill';
      s.textContent = '.announcements-modal-scrim,.sleep-tracker-wrap{display:none!important}';
      document.head.appendChild(s);
    }
  });
}
async function shot(page, name) { await clean(page); await page.screenshot({ path: join(OUT, name) }); log(`  saved ${name}`); }
const motionIdle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };

const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return {}; } };

/** Paste a generated PNG (a flat colour) into the focused field, the way a screenshot paste arrives. */
const pastePicture = (page, sel, colour, name) => page.evaluate(async ([s, c, n]) => {
  const el = document.querySelector(s);
  const cv = document.createElement('canvas'); cv.width = 160; cv.height = 100;
  const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 160, 100); g.fillStyle = '#fff'; g.fillRect(20, 20, 50, 30);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], n, { type: 'image/png' }));
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [sel, colour, name]);

const PIC_RE = /\[Picture (\d+): '?([^\]']+)'?\]\n([^\n]*)/g;
const pictures = (msg) => [...(msg ?? '').matchAll(PIC_RE)].map((m) => ({ n: Number(m[1]), path: m[2], words: m[3] }));

async function chipState(page, scope) {
  return page.evaluate((sc) => {
    const root = document.querySelector(sc);
    const marks = [...root.querySelectorAll('.chat-cmp-hl mark.chat-cmp-hl-img')];
    return {
      marks: marks.map((m) => {
        const th = m.querySelector('.chat-cmp-hl-thumb');
        const r = th.getBoundingClientRect();
        return { state: m.getAttribute('data-state'), bg: getComputedStyle(th).backgroundImage.slice(0, 10), w: Math.round(r.width), h: Math.round(r.height), lines: m.getClientRects().length };
      }),
      stripImages: root.querySelectorAll('.chat-cmp-attachments .chat-cmp-attachment-image').length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, scope);
}


const DESK = join(SCRATCH, 'Desktop');
/** A real PNG on disk outside the project, a flat colour, made by the browser's canvas. */
async function makePng(page, colour, name) {
  const b64 = await page.evaluate(async (c) => {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 100;
    const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 160, 100); g.fillStyle = '#fff'; g.fillRect(20, 20, 50, 30);
    return cv.toDataURL('image/png').split(',')[1];
  }, colour);
  mkdirSync(DESK, { recursive: true });
  const p = join(DESK, name);
  writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}
let answer = '';
/** + → "Attach files…" in the given composer, the picker answered with these paths. */
async function attachVia(page, scope, paths) {
  answer = paths.join(',');
  await page.locator(`${scope} button[aria-label="Attach"]`).first().click();
  await page.getByRole('menuitem', { name: 'Attach files…' }).click();
  await page.waitForTimeout(400);
}
const tokenEnds = (v) => [...v].map((ch, i) => (ch === '⁩' ? i : -1)).filter((i) => i >= 0);

async function bubbleState(page, scope) {
  return page.evaluate((sc) => {
    const rows = [...document.querySelectorAll(`${sc} .chat-msg-user-row`)];
    const last = rows[rows.length - 1];
    if (!last) return null;
    const pics = [...last.querySelectorAll('[data-testid="chat-msg-picture"]')];
    return {
      text: last.innerText,
      pics: pics.map((p) => {
        const img = p.querySelector('img');
        const r = img?.getBoundingClientRect();
        return { loaded: !!img && img.complete && img.naturalWidth > 0, w: Math.round(r?.width ?? 0), words: p.querySelector('.chat-msg-pic-words')?.textContent ?? '' };
      }),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, scope);
}

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'en-US' });
  await context.addInitScript(() => { try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'dark'); } catch {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => { void d.accept(answer); });
  try {
    await page.goto(`${base}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await clean(page);
    if (!(await page.locator('.agent-surface.expanded').count())) {
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 90000);
    // The visible chat pane (composer AND transcript), so every step addresses the same one.
    await page.evaluate(() => {
      const ta = [...document.querySelectorAll('.chat-cmp-input')].find((t) => t.offsetParent);
      let pane = ta.parentElement;
      while (pane && !pane.querySelector('.chat-msg-list, [class*="transcript"], [class*="chat-scroll"]')) pane = pane.parentElement;
      (pane ?? document.body).setAttribute('data-verify', 'chat');
      ta.setAttribute('data-verify-input', 'chat');
    });
    const SCOPE = '[data-verify="chat"]';
    const input = page.locator('[data-verify-input="chat"]');
    const pA = await makePng(page, '#c0392b', 'kirmizi ekran.png');
    const pB = await makePng(page, '#2471a3', 'mavi.png');
    const pC = await makePng(page, '#27ae60', 'yesil.png');
    const pD = await makePng(page, '#8e44ad', 'mor.png');
    const pdf = join(DESK, 'brief.pdf');
    writeFileSync(pdf, '%PDF-1.4\n%fake\n');

    // 1. One picture via + at the caret, after typed words.
    await input.click();
    await page.keyboard.type('önce bak:', { delay: 6 });
    await attachVia(page, SCOPE, [pA]);
    const one = await until(page, async () => { const s = await chipState(page, SCOPE); return s.marks.length === 1 && s.marks[0].state === 'ready'; }, 15000);
    const s1 = await chipState(page, SCOPE);
    ok('+ Attach files… with one picture: a chip IN the text, copied', one, JSON.stringify(s1));
    ok('the chip shows its thumbnail, on one line', s1.marks.length === 1 && s1.marks[0].bg.startsWith('url(') && s1.marks[0].w >= 24 && s1.marks[0].lines === 1, JSON.stringify(s1.marks));
    ok('no picture in the row above the box', s1.stripImages === 0, String(s1.stripImages));
    const v1 = await input.inputValue();
    ok('the chip stands at the caret, after the typed words', /^önce bak: ?⁨[^⁩]*⁩/.test(v1), JSON.stringify(v1));
    await input.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await page.keyboard.type(' birinci yorum', { delay: 6 });
    await page.keyboard.press('Shift+Enter');
    await shot(page, '1-chat-one-picked-1440.png');

    // 2. Three at once, plus a PDF: three chips in pick order; the PDF in the row.
    await attachVia(page, SCOPE, [pB, pC, pD]);
    await attachVia(page, SCOPE, [pdf]);
    const four = await until(page, async () => { const s = await chipState(page, SCOPE); return s.marks.length === 4 && s.marks.every((m) => m.state === 'ready' && m.bg.startsWith('url(')); }, 15000);
    const s2 = await chipState(page, SCOPE);
    ok('+ with three pictures: three more chips in the text, each with its thumbnail', four, JSON.stringify(s2));
    const rowFiles = await page.locator(`${SCOPE} .chat-cmp-attachments .chat-cmp-attachment-file`).count();
    ok('a picked PDF keeps its path chip in the row (unchanged)', rowFiles === 1 && s2.stripImages === 0, `${rowFiles} files, ${s2.stripImages} images`);
    // A comment after each of the three new chips, last first so the offsets hold.
    const ends = tokenEnds(await input.inputValue());
    const words = ['ikinci yorum', 'üçüncü yorum', 'dördüncü yorum'];
    for (let k = 3; k >= 1; k -= 1) {
      await input.evaluate((el, at) => { el.focus(); el.setSelectionRange(at, at); }, ends[k] + 1);
      await page.keyboard.type(` ${words[k - 1]}`, { delay: 4 });
    }
    await shot(page, '2-chat-four-picked-1440.png');

    // 3. Send: each picture (a copy in the drop folder) and its comment, the PDF's path too.
    const before = frames().length;
    await input.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await page.keyboard.press('Enter');
    ok('the chat sent one message', await until(page, async () => frames().length > before, 30000));
    const msg = frames().slice(before).find((f) => f.role === 'child')?.blocks?.[0] ?? '';
    writeFileSync(join(OUT, 'sent-chat.txt'), msg);
    const pics = pictures(msg);
    const want = [['kirmizi', 'birinci yorum'], ['mavi', 'ikinci yorum'], ['yesil', 'üçüncü yorum'], ['mor', 'dördüncü yorum']];
    ok('the agent reads Picture 1..4, each with the comment written after its chip', pics.length === 4
      && pics.every((p, i) => p.n === i + 1 && p.words.trim() === want[i][1] && p.path.includes(want[i][0])), JSON.stringify(msg));
    ok('each picture path is a real copy in the project\'s agent-drops', pics.length === 4 && pics.every((p) => p.path.includes('/_dream_context/tmp/agent-drops/') && existsSync(p.path)), JSON.stringify(pics.map((p) => p.path)));
    ok('the picked PDF\'s own path rides the message', msg.includes(pdf), JSON.stringify(msg));

    // 4. The sent bubble: four thumbnails with their comments, never the marker.
    const drawn = await until(page, async () => { const b = await bubbleState(page, SCOPE); return b && b.pics.length === 4 && b.pics.every((p) => p.loaded); }, 15000);
    const b = await bubbleState(page, SCOPE);
    ok('the sent bubble draws four pictures, each loaded', drawn, JSON.stringify(b));
    ok('each picture has its own comment beside it', b && b.pics.map((p) => p.words).join('|') === want.map((e) => e[1]).join('|'), JSON.stringify(b?.pics));
    ok('no raw [Picture N: path] text in the bubble', b && !/\[Picture/.test(b.text) && !b.text.includes('agent-drops'), JSON.stringify(b?.text));
    await page.waitForTimeout(800);
    await shot(page, '3-chat-sent-bubble-1440.png');
    await page.locator(`${SCOPE} [data-testid="chat-msg-picture"] img`).first().click();
    ok('a click on a sent picture opens it large', await until(page, async () => (await page.locator('.image-viewer').count()) > 0, 5000));
    await shot(page, '4-chat-viewer-1440.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    const bp = await bubbleState(page, SCOPE);
    ok('at 390 px the bubble keeps its pictures, no horizontal overflow', bp && bp.pics.length === 4 && !bp.overflow, JSON.stringify(bp));
    await shot(page, '5-chat-sent-bubble-390.png');
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(500);

    // 5. The Super view: its own + menu, the same chip, the same bubble.
    await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'turn-end'), 30000);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    const SUPER = '[data-super-slot="centre"]';
    const centreIn = page.locator(`${SUPER} .chat-cmp-input`).first();
    ok('the super took over', await until(page, async () => (await centreIn.count()) === 1 && reports().some((r) => r.role === 'super' && r.kind === 'turn-end'), 90000));
    await motionIdle(page);
    await page.waitForTimeout(800);
    await centreIn.click();
    await page.keyboard.type('bu ekranda', { delay: 6 });
    await attachVia(page, SUPER, [pB]);
    ok('Super: + Attach files… makes a chip in its text too', await until(page, async () => { const s = await chipState(page, SUPER); return s.marks.length === 1 && s.marks[0].state === 'ready' && s.marks[0].bg.startsWith('url(') && s.stripImages === 0; }, 15000), JSON.stringify(await chipState(page, SUPER)));
    await centreIn.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await page.keyboard.type(' hero kesik görünüyor', { delay: 6 });
    await shot(page, '6-super-picked-1440.png');
    const sb = frames().length;
    await page.keyboard.press('Enter');
    ok('the super got one message', await until(page, async () => frames().slice(sb).some((f) => f.role === 'super'), 30000));
    const smsg = (frames().slice(sb).find((f) => f.role === 'super')?.blocks ?? []).join('\n');
    writeFileSync(join(OUT, 'sent-super.txt'), smsg);
    const sp = pictures(smsg);
    ok('the super reads Picture 1 + its comment', sp.length === 1 && sp[0].words.trim() === 'hero kesik görünüyor' && existsSync(sp[0].path), JSON.stringify(smsg));
    const sdrawn = await until(page, async () => { const x = await bubbleState(page, SUPER); return x && x.pics.length === 1 && x.pics[0].loaded; }, 15000);
    const sbub = await bubbleState(page, SUPER);
    ok('Super: the sent bubble draws the picture with its comment, no marker', sdrawn && sbub.pics[0].words === 'hero kesik görünüyor' && !/\[Picture/.test(sbub.text), JSON.stringify(sbub));
    await page.waitForTimeout(800);
    await shot(page, '7-super-sent-1440.png');

    ok('zero page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  } catch (e) {
    ok('the run completed', false, String(e?.stack ?? e));
    await page.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  } finally {
    await browser.close();
    srv.kill();
  }
  log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
main();
