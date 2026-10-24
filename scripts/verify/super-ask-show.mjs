#!/usr/bin/env node
/**
 * verify:super-ask-show — a picture question presents its option pictures on the Super stage by
 * itself and puts them back after the answer (task a-picture-question…, V1-V7). Against the REAL
 * dashboard server (this worktree's `dist/`) in Chromium, a stand-in `claude` and a scratch
 * HOME; every phase is asserted on the record (`.super-agent.json`) AND the DOM.
 *
 *  V1  `super ask --json` with three `<img src>` previews: presenting, three cards in a grid, the
 *      question card open in the Super chat (no `super present` anywhere);
 *  V2  answered by clicking an option, then (a second question) by TYPING: the stage floats, the
 *      pictures' group tile is drawn inside the Others pile;
 *  V3  the owner presents two other cards himself, then a picture question: his presentation
 *      untouched, `show.state: skipped`;
 *  V4  a child raises AskUserQuestion with an `<img src>` preview, `super queue ask` presents it;
 *      the child's answer through the card puts it back;
 *  V4b a worktree child's preview is outside the project: `show.skipped`, `recent` from its
 *      `--for` pictures;
 *  V5  the Super forgets everything: `open image a b`, then a plain `super ask`: presented via
 *      `recent`;
 *  V6  a phone (390 px) watching the Super chat in Mac mode shows the pictures as its stage strip;
 *  V7  shape, at 1440x900 and 2000x1300: two wide pictures stack (picture area >= 1.4x 0.34.5's,
 *      fill >= 85 %), auto AND by plain `super present`; two portraits side by side (fill >= 90 %);
 *      three wide take a 2x2 with the last row centred; no empty band over 8 px in any picture
 *      card; three cards without a shape keep today's grid; an Exif-6 JPEG stands as a portrait;
 *      the switcher reads Compare.
 *  Zero console and page errors. Screenshots at 1440x900, 2000x1300, 1000x800 and the phone.
 *
 * Run: npm run build && npm run verify:super-ask-show. Output: tmp/super-ask-show/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-super-ask-show-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CODE = join(SCRATCH, 'ledger-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-ask-show');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const VAULT = 'pocket-ledger';
/** 0.34.5's measured picture areas for two wide 1600x960 mockups in compare (olcum/results.json). */
const BASELINE = { 1440: 407 * 244, 2000: 642 * 385 };

// ─── the stand-in `claude`: the super runs `GO-SUPER <verb> <args…>` (args split on spaces; a
// spec file for --json); a child given `ASKPIC:<src>` asks AskUserQuestion with that picture ──
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-askshow-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, cwd: process.cwd(), t: Date.now(), ...o }) + '\\n');
let awaiting = null;
let seq = 0;
const ask = (input) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } });
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: id, requires_user_interaction: true } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } }); resolve(r); };
});
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
  if (text.startsWith('[super answer]')) { report({ kind: 'answer', text }); return 'noted'; }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 400) }); return 'ok'; }
  const m = text.match(/GO-SUPER\\s+(.+)$/m);
  if (m) { const step = cli('super', ...m[1].trim().split(/\\s+/)); report({ kind: 'super', step }); return 'did ' + m[1].slice(0, 60); }
  report({ kind: 'owner', text });
  return 'ok';
}
async function childTurn(text) {
  const m = text.match(/ASKPIC:(\\S+)/);
  if (m) {
    const r = await ask({ questions: [{ question: 'Which header picture?', header: 'Picture', multiSelect: false, options: [{ label: 'This one', description: 'the shot', preview: '<img src="' + m[1] + '">' }, { label: 'Neither' }] }] });
    report({ kind: 'answered', response: r });
    return 'got answer';
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

// ─── harness ────────────────────────────────────────────────────────────────────────────
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const frames = () => readNd(FRAMES);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], groups: [], view: { mode: 'float' }, queue: [] }; } };

/** A solid PNG of any size, written without an image library. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { const edge = x < 8 || x >= w - 8; row[1 + x * 3] = edge ? 20 : r; row[2 + x * 3] = edge ? 20 : g; row[3 + x * 3] = edge ? 20 : b; }
  const rows = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
/** An Exif APP1 with Orientation = 6, little-endian. */
function exif6() {
  const t = Buffer.alloc(26);
  t.write('II', 0, 'ascii'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4); t.writeUInt16LE(1, 8);
  t.writeUInt16LE(0x0112, 10); t.writeUInt16LE(3, 12); t.writeUInt32LE(1, 14); t.writeUInt16LE(6, 18);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const h = Buffer.from([0xff, 0xe1, 0, 0]); h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}
const WIDE = [['wide-a.png', [238, 130, 51]], ['wide-b.png', [64, 148, 220]], ['wide-c.png', [90, 180, 120]], ['wide-d.png', [180, 90, 200]], ['wide-e.png', [200, 180, 60]], ['wide-f.png', [60, 170, 170]]];
const TALL = [['tall-a.png', [220, 90, 90]], ['tall-b.png', [90, 90, 220]]];
const POSTERS = [['poster-a.png', [240, 200, 200]], ['poster-b.png', [200, 240, 200]]];

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'mockups'), CODE, OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  for (const [name, rgb] of WIDE) writeFileSync(join(PROJ, 'mockups', name), png(1600, 960, rgb));
  for (const [name, rgb] of TALL) writeFileSync(join(PROJ, 'mockups', name), png(900, 1600, rgb));
  for (const [name, rgb] of POSTERS) writeFileSync(join(PROJ, 'mockups', name), png(1200, 800, rgb));
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  // A linked code repo with one commit: the worktree child's pictures live there (V4b).
  spawnSync('git', ['-C', CODE, 'init', '-q', '-b', 'main']);
  writeFileSync(join(CODE, 'shot.png'), png(400, 300, [10, 10, 10]));
  writeFileSync(join(CODE, 'README.md'), '# ledger app\n');
  spawnSync('git', ['-C', CODE, 'add', '-A']);
  spawnSync('git', ['-C', CODE, '-c', 'user.email=v@example.invalid', '-c', 'user.name=verify', 'commit', '-q', '-m', 'init']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  const l = dc('link', 'add', 'ledger-app', CODE, '--url', 'example/ledger-app');
  if (l.status !== 0) throw new Error(`link add failed: ${l.stderr || l.stdout}`);
  for (const t of ['Ship the ledger export', 'Fix the totals row', 'Write the release note']) if (dc('tasks', 'create', t, '-w', 'A task card.').status !== 0) throw new Error('task create failed');
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...env(), PATH, DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log'), DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}
async function api(base, method, path, body) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'X-Dreamcontext-Vault': VAULT, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const results = { pass: 0, fails: [], notes: [], shots: [], measures: {} };
const ok = (label, cond, detail) => {
  if (cond) { results.pass++; console.log(`  ✓ ${label}`); }
  else { results.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); }
  return !!cond;
};
const note = (m) => { results.notes.push(m); console.log(`  · ${m}`); };
const until = async (page, fn, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};
const shot = async (page, name) => { const p = join(OUT, name); await page.screenshot({ path: p }); results.shots.push(p); return p; };

const centre = (page) => page.locator('[data-super-slot="centre"]');
const composer = (page) => centre(page).locator('.chat-cmp-input').first();
async function sayToSuper(page, text) {
  const input = composer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
/** Runs `super <args>` through the stand-in super (the owner's message `GO-SUPER …`). */
async function superVerb(page, args) {
  const before = reports().filter((r) => r.kind === 'super').length;
  await sayToSuper(page, `GO-SUPER ${args}`);
  await until(page, async () => reports().filter((r) => r.kind === 'super').length > before, 40000);
  const step = reports().filter((r) => r.kind === 'super').at(-1)?.step;
  await until(page, async () => reports().filter((r) => r.role === 'super' && r.kind === 'turn-end').length > 0, 2000);
  await page.waitForTimeout(700);
  return { status: step?.status, json: step?.json?.result ?? step?.json ?? {}, out: step?.out };
}
let specN = 0;
function spec(questions, title = 'Header mockups') {
  const p = join(SCRATCH, `spec-${++specN}.json`);
  writeFileSync(p, JSON.stringify({ title, questions }));
  return `@${p}`;
}
const pictureQuestion = (srcs, question = 'Which header?') => [{
  question, header: 'Header', multiSelect: false,
  options: srcs.map((src, i) => ({ label: `Option ${String.fromCharCode(65 + i)}`, description: 'a mockup', preview: `<img src="${src}" alt="">` })),
}];
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(900));
const presenting = async (page) => (await page.locator('[data-testid="super-surface"][data-presenting]:visible').count()) > 0;
const layoutOf = (page) => page.locator('[data-testid="super-surface"]:visible').first().getAttribute('data-layout');
const openQuestionCard = (page) => centre(page).locator('[data-testid="super-question-card"][data-state="open"]');
const imgCards = () => record().containers.filter((c) => c.kind === 'image');
const byRef = (ref) => record().containers.find((c) => c.kind === 'image' && c.ref === ref);

/** The drawn geometry of presented picture cards, measured the way olcum/ did: the picture rect
 *  from naturalWidth/Height under object-fit contain inside the img box. */
function measure(page, ids) {
  return page.evaluate((ids) => ids.map((id) => {
    const el = document.querySelector(`[data-testid="super-container"][data-container-id="${id}"]`);
    if (!el) return { id, missing: true };
    const r = el.getBoundingClientRect();
    const clip = el.querySelector('.super-card-clip')?.getBoundingClientRect() ?? r;
    const head = el.querySelector('.super-card-head')?.getBoundingClientRect();
    const img = el.querySelector('img');
    const out = { id, where: el.getAttribute('data-where'), card: { x: r.x, y: r.y, w: r.width, h: r.height } };
    if (!img || !head) return out;
    const ir = img.getBoundingClientRect();
    const nw = img.naturalWidth; const nh = img.naturalHeight;
    const s = Math.min(ir.width / nw, ir.height / nh);
    const pic = { x: ir.x + (ir.width - nw * s) / 2, y: ir.y + (ir.height - nh * s) / 2, w: nw * s, h: nh * s };
    const content = { x: clip.x + 1, y: head.bottom, w: clip.width - 2, h: clip.bottom - 1 - head.bottom };
    const gaps = [pic.x - content.x, content.x + content.w - (pic.x + pic.w), pic.y - content.y, content.y + content.h - (pic.y + pic.h)];
    return { ...out, natural: [nw, nh], complete: img.complete, pic, area: pic.w * pic.h, fill: (pic.w * pic.h) / (r.width * r.height), band: Math.max(...gaps) };
  }), ids);
}
async function measured(page, ids) {
  await until(page, async () => (await page.evaluate((ids) => ids.every((id) => {
    const img = document.querySelector(`[data-testid="super-container"][data-container-id="${id}"] img`);
    return !!img && img.complete && img.naturalWidth > 0;
  }), ids)), 15000);
  return measure(page, ids);
}

async function openChat(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
}

/** Answer the open question card by clicking one option. */
async function clickAnswer(page, label) {
  const card = openQuestionCard(page).first();
  // A preview question is a board of tiles; a plain one a list of options.
  await card.locator('.chat-surveycard-tile, .chat-surveycard-opt').filter({ hasText: label }).first().click();
  await card.locator('.chat-btn.primary').first().click();
}

/** The pictures' group tile (or the cards) are drawn inside the Others pile, not on the stage. */
async function inOthersPile(page, groupId, ids) {
  const pile = await page.locator('[data-testid="super-others"]').first().boundingBox();
  if (!pile) return { ok: false, why: 'no Others pile' };
  const tiles = groupId ? [page.locator(`[data-testid="super-group"][data-group-id="${groupId}"]`).first()] : ids.map((id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`).first());
  for (const t of tiles) {
    if (!(await t.count())) continue;
    const where = await t.getAttribute('data-where');
    if (where !== 'others') return { ok: false, why: `drawn ${where}` };
    const b = await t.boundingBox();
    if (b && !(b.x + b.width / 2 >= pile.x - 4 && b.x + b.width / 2 <= pile.x + pile.width + 4 && b.y + b.height / 2 >= pile.y - 40 && b.y + b.height / 2 <= pile.y + pile.height + 40)) return { ok: false, why: `tile at ${JSON.stringify(b)} vs pile ${JSON.stringify(pile)}` };
  }
  const onStage = await page.locator('[data-testid="super-container"][data-where="present"]').count();
  return { ok: onStage === 0, why: `${onStage} cards still presented` };
}

// ─── the flow ───────────────────────────────────────────────────────────────────────────
async function flow(pw, base) {
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } } });
  await markAnnouncementsSeen(context, base).catch(() => {});
  const page = await context.newPage();
  const errors = [];
  const consoleLog = createWriteStream(join(OUT, 'console.log'));
  page.on('console', (m) => { consoleLog.write(`[${m.type()}] ${m.text()}\n`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) consoleLog.write(`[http ${r.status()}] ${r.request().method()} ${r.url()}\n`); });

  // An Exif-6 portrait JPEG: a 1600x900 landscape frame the browser turns upright (V7).
  const jpegB64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 900; const g = c.getContext('2d'); g.fillStyle = '#c86'; g.fillRect(0, 0, 1600, 900); g.fillStyle = '#222'; g.fillRect(0, 0, 200, 900); return c.toDataURL('image/jpeg', 0.8).split(',')[1]; });
  const raw = Buffer.from(jpegB64, 'base64');
  writeFileSync(join(PROJ, 'mockups', 'phone-shot.jpg'), Buffer.concat([raw.subarray(0, 2), exif6(), raw.subarray(2)]));

  console.log('\n── hand over');
  await openChat(page, base);
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  const first = page.locator('.chat-cmp-input:visible').first();
  await first.click();
  await first.fill('hello');
  await page.keyboard.press('Enter');
  await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
  await page.waitForTimeout(1500);
  ok('the hand-over button shows', await until(page, async () => (await page.locator('[data-testid="super-handover-btn"]:visible').count()) > 0, 20000));
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
  await until(page, async () => (await composer(page).count()) > 0, 20000);
  await settle(page);
  // The Exif-6 JPEG opened now and put in Others: V7 presents it later.
  await superVerb(page, 'open image mockups/phone-shot.jpg --no-group');
  const jpgCard = byRef('mockups/phone-shot.jpg');
  ok('the Exif-6 JPEG is recorded as a portrait (aspect < 1)', !!jpgCard && jpgCard.aspect < 1, JSON.stringify(jpgCard));
  if (jpgCard) await superVerb(page, `stack ${jpgCard.id}`);

  console.log('\n── V6 setup: a phone in Mac mode watching the Super chat');
  let phone = null;
  const phoneErrors = [];
  const setup = await api(base, 'POST', '/api/handsfree/mac/setup', {});
  const started = await api(base, 'POST', '/api/handsfree/mac/start', { vaults: [VAULT] });
  const qr = (await api(base, 'POST', '/api/handsfree/mac/qr')).json.url;
  if (ok('Mac mode is up with a sign-in link', setup.status === 200 && started.status === 200 && typeof qr === 'string', JSON.stringify({ setup: setup.status, started: started.status, qr }))) {
    const pctx = await browser.newContext({ ...pw.devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await markAnnouncementsSeen(pctx, base).catch(() => {});
    phone = await pctx.newPage();
    phone.on('console', (m) => { if (m.type() === 'error') phoneErrors.push(m.text()); });
    phone.on('pageerror', (e) => phoneErrors.push(String(e)));
    await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await until(phone, async () => phone.url().includes(`vault=${VAULT}`), 25000);
    for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
    const row = phone.locator('[data-testid="super-row"]:visible');
    ok('the phone lists the Super Agent', await until(phone, async () => (await row.count()) > 0, 20000));
    let opened = false;
    for (let i = 0; i < 3 && !opened; i++) {
      await row.first().click().catch(() => {});
      opened = await until(phone, async () => (await phone.locator('.chat-cmp-input:visible').count()) > 0, 8000);
    }
    ok('the phone opens the Super chat', opened);
    await phone.waitForTimeout(1500);
  }

  console.log('\n── V1: a picture question presents its pictures by itself');
  const v1Srcs = ['mockups/wide-a.png', './mockups/wide-b.png', 'mockups/wide-c.png'];
  const v1 = await superVerb(page, `ask --json ${spec(pictureQuestion(v1Srcs))}`);
  ok('super ask: 200, show presented via preview, 3 cards', v1.status === 0 && v1.json.show?.state === 'presented' && v1.json.show?.via === 'preview' && v1.json.show?.cards?.length === 3, JSON.stringify(v1.json).slice(0, 600));
  const v1Ids = v1.json.show?.cards ?? [];
  const v1Item = v1.json.item;
  ok('record: view present, view.ask = the item, the 3 cards, a grid', record().view.mode === 'present' && record().view.ask === v1Item && JSON.stringify([...record().view.cards].sort()) === JSON.stringify([...v1Ids].sort()) && record().view.layout === 'grid', JSON.stringify(record().view));
  ok('record: no `super present` was run', !reports().some((r) => r.kind === 'super' && /^present/.test(r.step?.args?.replace(/^super /, '') ?? '')));
  await settle(page);
  ok('DOM: presenting, the grid, 3 picture cards drawn present', await until(page, async () => (await presenting(page)) && (await layoutOf(page)) === 'grid'
    && (await page.locator('[data-testid="super-container"][data-kind="image"][data-where="present"]').count()) === 3, 15000));
  ok('DOM: the question card is open in the Super chat', await until(page, async () => (await openQuestionCard(page).count()) === 1, 15000));
  const v1m = await measured(page, v1Ids);
  ok('DOM: the 3 pictures are painted, inside the viewport', v1m.every((x) => x.complete && x.card && x.card.x >= 0 && x.card.x + x.card.w <= 1441 && x.card.y + x.card.h <= 901), JSON.stringify(v1m.map((x) => [x.where, x.card])));
  const visible = async (ids) => page.evaluate((ids) => ids.map((id) => {
    const el = document.querySelector(`[data-testid="super-container"][data-container-id="${id}"]`);
    if (!el) return { id, missing: true };
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return { id, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], opacity: o, hitsSelf: !!hit && el.contains(hit), vis: getComputedStyle(el).visibility };
  }), ids);
  let vis = [];
  ok('DOM: all 3 pictures are actually visible (opaque, on top at their centre)', await until(page, async () => { vis = await visible(v1Ids); return vis.every((v) => v.opacity > 0.95 && v.hitsSelf && v.vis === 'visible'); }, 8000), JSON.stringify(vis));
  await page.waitForTimeout(1500);
  await shot(page, 'v1-presented-1440x900.png');
  if (phone) {
    const strip = phone.locator('[data-testid="stage-media-strip"]:visible').last();
    ok('V6: the phone shows the stage strip with the 3 pictures', await until(phone, async () => (await strip.count()) > 0 && (await strip.locator('.super-stage-media-thumb, .super-stage-media-gone').count()) === 3, 20000),
      await phone.locator('[data-testid="stage-media-strip"]').count());
    await phone.screenshot({ path: join(OUT, 'v6-phone-390.png') });
    results.shots.push(join(OUT, 'v6-phone-390.png'));
    const glance = await (await fetch(`${base}/api/assistant/glance`)).json().catch(() => ({}));
    ok('V6: the notch glance is unchanged: one super row, the question', (glance.chats ?? []).filter((c) => c.super).length === 1, JSON.stringify(glance.chats ?? []).slice(0, 300));
  }

  console.log('\n── V2: answered by a click: the stage floats, the pictures go to Others');
  await clickAnswer(page, 'Option B');
  ok('his answer reached the Super', await until(page, async () => reports().some((r) => r.kind === 'answer'), 20000));
  ok('record: the view floats, the question is done, askShows empty', await until(page, async () => record().view.mode === 'float' && !(record().askShows ?? []).length, 15000), JSON.stringify({ view: record().view, askShows: record().askShows }));
  const v1Group = record().groups.find((g) => v1Ids.every((id) => g.cards.includes(id)));
  ok('record: the 3 pictures are one group, in Others', !!v1Group && v1Group.place === 'others', JSON.stringify(record().groups));
  await settle(page);
  let pile = await inOthersPile(page, v1Group?.id, v1Ids);
  ok('DOM: no presentation, the group tile is inside the Others pile', !(await presenting(page)) && pile.ok, pile.why);
  await shot(page, 'v2-answered-others-1440x900.png');

  console.log('\n── V2 (typed): a second picture question answered in words');
  const v2 = await superVerb(page, `ask --json ${spec(pictureQuestion(['mockups/wide-d.png', 'mockups/wide-e.png']), 'Footer')}`);
  ok('presented (compare)', v2.json.show?.state === 'presented' && record().view.layout === 'compare', JSON.stringify(v2.json.show));
  await settle(page);
  ok('DOM: presenting compare', await until(page, async () => (await presenting(page)) && (await layoutOf(page)) === 'compare', 10000));
  await sayToSuper(page, 'Neither, keep the old footer');
  ok('the typed answer reached the Super', await until(page, async () => reports().some((r) => r.kind === 'owner' && r.text === 'Neither, keep the old footer'), 20000));
  ok('record: floats, the pictures in Others', await until(page, async () => record().view.mode === 'float'
    && (v2.json.show?.cards ?? []).every((id) => { const s = record(); const g = s.groups.find((x) => x.cards.includes(id)); return g ? g.place === 'others' : s.containers.find((c) => c.id === id)?.place === 'others'; }), 15000), JSON.stringify(record().view));
  await settle(page);
  const v2Group = record().groups.find((g) => (v2.json.show?.cards ?? []).every((id) => g.cards.includes(id)));
  pile = await inOthersPile(page, v2Group?.id, v2.json.show?.cards ?? []);
  ok('DOM: nothing presented, the tile in the Others pile', !(await presenting(page)) && pile.ok, pile.why);

  console.log('\n── V3: the owner\'s own presentation is never replaced');
  const tasks = record().containers.filter((c) => c.kind === 'task').map((c) => c.id);
  if (tasks.length < 2) for (const slug of ['ship-the-ledger-export', 'fix-the-totals-row', 'write-the-release-note']) await superVerb(page, `open task ${slug}`);
  const t2 = record().containers.filter((c) => c.kind === 'task').map((c) => c.id).slice(0, 2);
  const own = await api(base, 'POST', '/api/super/layout', { view: { mode: 'present', cards: t2 } });
  ok('the owner presents two task cards himself (by: owner)', own.status === 200 && record().view.by === 'owner', JSON.stringify(record().view));
  const ownView = JSON.stringify(record().view);
  await settle(page);
  const v3 = await superVerb(page, `ask --json ${spec(pictureQuestion(['mockups/wide-f.png', 'mockups/wide-a.png']), 'Logo')}`);
  ok('show.state skipped, reason owner_layout', v3.json.show?.state === 'skipped' && v3.json.show?.reason === 'owner_layout', JSON.stringify(v3.json.show));
  ok('record: his view untouched', JSON.stringify(record().view) === ownView, `${ownView} → ${JSON.stringify(record().view)}`);
  await settle(page);
  ok('DOM: his two task cards are the presentation', await until(page, async () => (await page.locator('[data-testid="super-container"][data-kind="task"][data-where="present"]').count()) === 2
    && (await page.locator('[data-testid="super-container"][data-kind="image"][data-where="present"]').count()) === 0, 10000));
  await page.waitForTimeout(1500);
  await shot(page, 'v3-owner-presentation-untouched-1440x900.png');
  await clickAnswer(page, 'Option A');
  await until(page, async () => !(record().queue ?? []).some((q) => q.kind === 'ask' && q.state !== 'done'), 15000);
  ok('after that answer his view still stands', JSON.stringify(record().view) === ownView, JSON.stringify(record().view));
  await api(base, 'POST', '/api/super/layout', { exit: { cards: t2, closing: [] } });
  await settle(page);

  console.log('\n── V4: a child\'s picture question, escalated');
  const d1 = await superVerb(page, 'delegate --prompt ASKPIC:mockups/tall-a.png --brief Header-shot');
  const c1 = d1.json.sessionId ?? d1.json.child ?? Object.keys(record().children).find((k) => !record().children[k].adopted);
  ok('a child is delegated', d1.status === 0 && !!c1, d1.out?.slice(0, 300));
  const q1 = () => record().queue.find((q) => q.sessionId === c1 && q.kind === 'question');
  ok('its AskUserQuestion reaches the queue', await until(page, async () => !!q1(), 40000), JSON.stringify(record().queue));
  await until(page, async () => reports().some((r) => r.kind === 'event'), 20000);
  const v4 = await superVerb(page, `queue ask ${q1()?.id} Which-header-shot?`);
  ok('queue ask: show presented via preview, 1 card', v4.json.show?.state === 'presented' && v4.json.show?.via === 'preview' && v4.json.show?.cards?.length === 1, JSON.stringify(v4.json).slice(0, 500));
  ok('record: view.ask = the item; the picture is for the child', record().view.ask === q1()?.id && byRef('mockups/tall-a.png')?.forChild === c1, JSON.stringify(record().view));
  await settle(page);
  ok('DOM: the child\'s picture is presented', await until(page, async () => (await presenting(page)) && (await page.locator(`[data-testid="super-container"][data-container-id="${v4.json.show?.cards?.[0]}"][data-where="present"]`).count()) === 1, 10000));
  await shot(page, 'v4-child-question-1440x900.png');
  const escCard = centre(page).locator('[data-testid="super-question-card"][data-kind="question"]').first();
  if (await until(page, async () => (await escCard.count()) > 0, 10000)) {
    await escCard.locator('.chat-surveycard-tile, .chat-surveycard-opt').filter({ hasText: 'This one' }).first().click();
    await escCard.locator('.chat-btn.primary').first().click();
  }
  ok('the child got the answer through the card', await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'answered'), 20000));
  ok('record: floats, the child\'s picture in Others', await until(page, async () => record().view.mode === 'float' && byRef('mockups/tall-a.png')?.place === 'others', 20000), JSON.stringify({ view: record().view, card: byRef('mockups/tall-a.png') }));
  await settle(page);
  pile = await inOthersPile(page, null, [byRef('mockups/tall-a.png')?.id]);
  ok('DOM: back in the Others pile', !(await presenting(page)) && pile.ok, pile.why);

  console.log('\n── V4b: a worktree child\'s picture is outside the project');
  const d2 = await superVerb(page, 'delegate --prompt ASKPIC:shot.png --brief Worktree-shot --worktree ledger-app --slug shots');
  const c2 = d2.json.sessionId ?? d2.json.child ?? Object.keys(record().children).find((k) => k !== c1 && !record().children[k].adopted);
  ok('a worktree child is delegated', d2.status === 0 && !!c2 && !!record().children[c2]?.worktree, d2.out?.slice(0, 400));
  await superVerb(page, `open image mockups/wide-b.png mockups/wide-c.png --for ${c2}`);
  const q2 = () => record().queue.find((q) => q.sessionId === c2 && q.kind === 'question');
  ok('its question reaches the queue', await until(page, async () => !!q2(), 40000));
  const v4b = await superVerb(page, `queue ask ${q2()?.id} Which-shot?`);
  ok('show.skipped names its src, via recent (its --for pictures), presented', JSON.stringify(v4b.json.show?.skipped) === '["shot.png"]' && v4b.json.show?.via === 'recent' && v4b.json.show?.cards?.length === 2 && v4b.json.show?.state === 'presented', JSON.stringify(v4b.json.show));
  await settle(page);
  await superVerb(page, `queue done ${q2()?.id}`);
  ok('closed: floats again', await until(page, async () => record().view.mode === 'float', 15000));
  await settle(page);

  console.log('\n── V5: the Super forgets everything: recent');
  await superVerb(page, 'open image mockups/poster-a.png mockups/poster-b.png');
  const v5 = await superVerb(page, 'ask Which-poster? --options Red|Blue');
  ok('presented via recent, 2 cards', v5.json.show?.via === 'recent' && v5.json.show?.state === 'presented' && v5.json.show?.cards?.length === 2, JSON.stringify(v5.json.show));
  await settle(page);
  ok('DOM: presenting the two', await until(page, async () => (await presenting(page)) && (await page.locator('[data-testid="super-container"][data-kind="image"][data-where="present"]').count()) === 2, 10000));
  await clickAnswer(page, 'Red');
  ok('answered: floats', await until(page, async () => record().view.mode === 'float', 15000));
  await settle(page);

  console.log('\n── V7: shape at 1440x900 and 2000x1300');
  // Every picture V7 presents is a card (opened alone and put in Others: present brings it back).
  const ensure = async (ref) => {
    if (!byRef(ref)) { await superVerb(page, `open image ${ref} --no-group`); if (byRef(ref)) await superVerb(page, `stack ${byRef(ref).id}`); }
    return byRef(ref)?.id;
  };
  const wideIds = [await ensure('mockups/wide-a.png'), await ensure('mockups/wide-b.png')];
  const tallIds = [await ensure('mockups/tall-a.png'), await ensure('mockups/tall-b.png')];
  const threeIds = [await ensure('mockups/wide-c.png'), await ensure('mockups/wide-d.png'), await ensure('mockups/wide-e.png')].filter(Boolean);
  ok('V7: every picture is a card', [...wideIds, ...tallIds].every(Boolean) && threeIds.length === 3);
  const noShape = record().containers.filter((c) => c.kind === 'task').map((c) => c.id).slice(0, 3);
  const checkCards = (label, m, minFill) => {
    ok(`${label}: every card drawn present with its picture`, m.every((x) => x.where === 'present' && x.pic), JSON.stringify(m));
    ok(`${label}: fill >= ${Math.round(minFill * 100)} % (${m.map((x) => Math.round((x.fill ?? 0) * 1000) / 10).join(', ')})`, m.every((x) => (x.fill ?? 0) >= minFill));
    ok(`${label}: no empty band over 8 px (${m.map((x) => Math.round(x.band ?? 99)).join(', ')})`, m.every((x) => (x.band ?? 99) <= 8));
  };
  for (const [w, h] of [[1440, 900], [2000, 1300]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    // Two wide, auto-presented by a question.
    const a = await superVerb(page, `ask --json ${spec(pictureQuestion(['mockups/wide-a.png', 'mockups/wide-b.png']), `Wide ${w}`)}`);
    ok(`${w}: the wide pair is auto-presented`, a.json.show?.state === 'presented', JSON.stringify(a.json.show));
    await settle(page);
    let m = await measured(page, wideIds);
    results.measures[`${w}-wide-auto`] = m;
    ok(`${w}: two wide pictures stack as rows (auto)`, m.length === 2 && m[1].card && Math.abs(m[0].card.x - m[1].card.x) < 2 && Math.abs(m[0].card.y - m[1].card.y) > 100, JSON.stringify(m.map((x) => x.card)));
    ok(`${w}: each picture >= 1.4x 0.34.5 (${m.map((x) => Math.round(x.area ?? 0)).join(', ')} vs ${BASELINE[w]})`, m.every((x) => (x.area ?? 0) >= 1.4 * BASELINE[w]));
    checkCards(`${w} wide auto`, m, 0.85);
    const label = await page.locator('[data-testid="super-layout-switch"] button').allInnerTexts().catch(() => []);
    ok(`${w}: the switcher reads Compare, never "Side by side" (${label.join('|')})`, label.some((t) => /Compare/.test(t)) && !label.some((t) => /Side by side/.test(t)));
    await shot(page, `v7-wide-auto-${w}x${h}.png`);
    await clickAnswer(page, 'Option A');
    await until(page, async () => record().view.mode === 'float', 15000);
    await settle(page);
    // The same pair by plain `super present`.
    await superVerb(page, `present ${wideIds.join(' ')}`);
    await settle(page);
    m = await measured(page, wideIds);
    results.measures[`${w}-wide-present`] = m;
    ok(`${w}: plain present stacks them too`, m.length === 2 && Math.abs(m[0].card.x - m[1].card.x) < 2 && Math.abs(m[0].card.y - m[1].card.y) > 100 && m.every((x) => (x.area ?? 0) >= 1.4 * BASELINE[w]), JSON.stringify(m.map((x) => x.card)));
    checkCards(`${w} wide present`, m, 0.85);
    await shot(page, `v7-wide-present-${w}x${h}.png`);
    // Two portraits.
    await superVerb(page, `present ${tallIds.join(' ')}`);
    await settle(page);
    m = await measured(page, tallIds);
    results.measures[`${w}-tall`] = m;
    ok(`${w}: two portraits stand side by side`, m.length === 2 && Math.abs(m[0].card.y - m[1].card.y) < 2 && Math.abs(m[0].card.x - m[1].card.x) > 100, JSON.stringify(m.map((x) => x.card)));
    checkCards(`${w} portraits`, m, 0.9);
    await shot(page, `v7-portraits-${w}x${h}.png`);
    // Three wide: a 2x2, the last row centred.
    if (threeIds.length === 3) {
      await superVerb(page, `present ${threeIds.join(' ')}`);
      await settle(page);
      m = await measured(page, threeIds);
      results.measures[`${w}-three`] = m;
      const region = await page.evaluate(() => { const r = [...document.querySelectorAll('[data-testid="super-container"][data-where="present"]')].map((e) => e.getBoundingClientRect()); return { l: Math.min(...r.map((x) => x.left)), r: Math.max(...r.map((x) => x.right)) }; });
      const third = m[2]?.card;
      ok(`${w}: three wide take a 2x2, the last row centred`, !!third && third.y > m[0].card.y + 50 && Math.abs(third.x + third.w / 2 - (region.l + region.r) / 2) < 30 && Math.abs(m[0].card.y - m[1].card.y) < 2, JSON.stringify(m.map((x) => x.card)));
      // The plan's bar for three is the shape (2x2, last row centred); fill is recorded, 80 % floor.
      checkCards(`${w} three wide`, m, 0.8);
      await shot(page, `v7-three-${w}x${h}.png`);
    }
    // Three cards with no shape: today's grid, the last row left-aligned.
    if (noShape.length === 3) {
      await superVerb(page, `present ${noShape.join(' ')}`);
      await settle(page);
      const r = await measure(page, noShape);
      ok(`${w}: three cards with no shape keep today's grid (last row left-aligned, equal cells)`, Math.abs(r[2].card.x - r[0].card.x) < 2 && Math.abs(r[0].card.w - r[1].card.w) < 2 && Math.abs(r[0].card.h - r[2].card.h) < 2, JSON.stringify(r.map((x) => x.card)));
    }
    // An Exif-6 JPEG beside a portrait: side by side, laid out as a portrait.
    const jpg = byRef('mockups/phone-shot.jpg');
    if (ok(`${w}: the Exif-6 JPEG is on the record`, !!jpg)) {
      await superVerb(page, `present ${jpg.id} ${tallIds[0]}`);
      await settle(page);
      m = await measured(page, [jpg.id, tallIds[0]]);
      results.measures[`${w}-exif`] = m;
      ok(`${w}: the Exif-6 JPEG stands beside the portrait, not letterboxed`, Math.abs(m[0].card.y - m[1].card.y) < 2 && (m[0].band ?? 99) <= 8 && (m[0].natural?.[0] ?? 0) < (m[0].natural?.[1] ?? 0), JSON.stringify(m));
      await shot(page, `v7-exif-${w}x${h}.png`);
    }
    await superVerb(page, 'present --off');
    await settle(page);
  }

  console.log('\n── narrow 1000x800');
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(800);
  await superVerb(page, `present ${wideIds.join(' ')}`);
  await settle(page);
  ok('narrow: no horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await shot(page, 'narrow-1000x800.png');
  await superVerb(page, 'present --off');

  await context.close();
  await browser.close();
  return { errors: [...errors, ...phoneErrors.map((e) => `[phone] ${e}`)] };
}

// ─── main ───────────────────────────────────────────────────────────────────────────────
let server = null;
try {
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing: npm run build first');
  const pw = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const r = await flow(pw, `http://127.0.0.1:${port}`);
  // The worktree child's own question card draws its preview `shot.png` against the project,
  // where it does not exist (V4b's point): those 404s are that src, nothing else.
  const http = readFileSync(join(OUT, 'console.log'), 'utf-8').split('\n').filter((l) => l.startsWith('[http 4'));
  const shot404 = http.length > 0 && http.every((l) => l.includes('path=shot.png'));
  const errs = r.errors.filter((e) => !(shot404 && /Failed to load resource: the server responded with a status of 404/.test(e)));
  if (errs.length !== r.errors.length) note(`ignored ${r.errors.length - errs.length} 404 console line(s), all for the worktree child's preview shot.png: ${http.join(' | ')}`);
  ok('zero console and page errors', errs.length === 0, errs.slice(0, 8).join('\n'));
} catch (err) {
  results.fails.push(`crashed: ${err?.stack || err}`);
  console.error(err);
} finally {
  server?.kill();
  spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.fails.length ? 'FAIL' : 'PASS'}: ${results.pass} passed, ${results.fails.length} failed${results.fails.length ? `\n  - ${results.fails.join('\n  - ')}` : ''}`);
process.exit(results.fails.length ? 1 : 0);
