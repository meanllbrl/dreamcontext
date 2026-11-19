#!/usr/bin/env node
/**
 * verify:super-question-line — the open question's line above the Super chat's composer (owner
 * 2026-11-17, option C). A real dashboard server (this worktree's dist/), a stand-in claude and a
 * scratch HOME: the super asks, a long reply pushes the card out of view, the line shows on the
 * composer's top edge, the chat never moves by itself, "Go to question" brings the card into view
 * and the line leaves; again in light; a 390 px phone; once answered, no line.
 *
 * Run: npm run build && node scripts/verify/super-question-line.mjs. Output: tmp/super-question-line/.
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
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-super-question-line-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CODE = join(SCRATCH, 'ledger-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-question-line');
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
  if (text.trim() === 'LONG') return Array.from({ length: 40 }, (_, i) => 'Line ' + (i + 1) + ' of a long report the super wrote after asking.').join('\\n\\n');
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
    const rail = page.locator('[data-testid="ns-rail-chat"]');
    if (await rail.count()) { await rail.first().click().catch(() => {}); await page.waitForTimeout(1500); }
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
const line = (page) => centre(page).locator('[data-testid="super-question-line"]');
const cardShown = (page) => page.evaluate(() => {
  const sc = document.querySelector('[data-super-slot="centre"] .chat-scroll');
  const card = document.querySelector('[data-super-slot="centre"] [data-testid="super-question-card"]');
  if (!sc || !card) return null;
  const a = sc.getBoundingClientRect(); const b = card.getBoundingClientRect();
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
});
async function wheel(page, dy) {
  const b = await page.locator('[data-super-slot="centre"] .chat-scroll').first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(60); }
  await page.waitForTimeout(700);
}
const scrollTopOf = (page) => page.evaluate(() => document.querySelector('[data-super-slot="centre"] .chat-scroll')?.scrollTop ?? -1);

async function flow(pw, base) {
  const browser = await pw.chromium.launch();
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await markAnnouncementsSeen(context, base).catch(() => {});
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[desk] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[desk] ${e}`));
  await openChat(page, base);
  for (const scheme of ['dark', 'light']) {
    console.log(`\n── ${scheme}`);
    if (scheme === 'dark') {
      ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
      const first = page.locator('.chat-cmp-input:visible').first();
      await first.click(); await first.fill('hello'); await page.keyboard.press('Enter');
      await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
      await page.waitForTimeout(1500);
      await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
      ok('the super took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
      await until(page, async () => (await composer(page).count()) > 0, 20000);
      await settle(page);
      await superVerb(page, `ask --json ${spec([{ question: 'Ship the cancel flow to staging now, before the review lands?', header: 'Staging', multiSelect: false, options: [{ label: 'Ship it' }, { label: 'Wait' }] }], 'Cancel flow → staging')}`);
      ok('the question card is open', await until(page, async () => (await openQuestionCard(page).count()) > 0, 20000));
      ok('no line while the card shows', await until(page, async () => (await line(page).count()) === 0, 3000));
      await shot(page, `${scheme}-0-card-in-view.png`);
      await sayToSuper(page, 'LONG');
      await until(page, async () => reports().filter((r) => r.kind === 'owner' && r.text === 'LONG').length > 0, 30000);
      await page.waitForTimeout(2000);
    } else {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForTimeout(600);
      await wheel(page, 600);
    }
    ok(`${scheme}: card scrolled out of view`, ((await cardShown(page)) ?? 999) < 40, String(await cardShown(page)));
    ok(`${scheme}: the line shows above the composer`, await until(page, async () => (await line(page).count()) === 1, 5000));
    const lb = await line(page).boundingBox(); const cb = await centre(page).locator('.chat-cmp').first().boundingBox();
    ok(`${scheme}: line sits on the composer's top edge`, !!lb && !!cb && Math.abs(lb.y + lb.height - cb.y) <= 2, `${JSON.stringify(lb)} ${JSON.stringify(cb)}`);
    ok(`${scheme}: line carries the title`, (await line(page).innerText()).includes('Cancel flow'), await line(page).innerText());
    const before = await scrollTopOf(page);
    await page.waitForTimeout(1500);
    ok(`${scheme}: the chat did not move by itself`, (await scrollTopOf(page)) === before);
    await shot(page, `${scheme}-1-line-shown.png`);
    await line(page).locator('[data-testid="super-question-line-go"]').click();
    ok(`${scheme}: the press brings the card into view`, await until(page, async () => ((await cardShown(page)) ?? 0) >= 40, 4000), String(await cardShown(page)));
    ok(`${scheme}: the line leaves once the card shows`, await until(page, async () => (await line(page).count()) === 0, 3000));
    await page.waitForTimeout(600);
    await shot(page, `${scheme}-2-after-go.png`);
  }
  console.log('\n── phone 390');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await page.locator('[data-testid="super-dock-pill"]').filter({ visible: true }).first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const pline = () => page.locator('[data-testid="super-question-line"]').filter({ visible: true });
  await page.mouse.move(195, 400);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(60); }
  await page.waitForTimeout(800);
  if (await until(page, async () => (await pline().count()) === 1, 4000)) {
    ok('phone: no horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    const b = await pline().first().boundingBox();
    ok('phone: line within the screen', !!b && b.x >= 0 && b.x + b.width <= 391, JSON.stringify(b));
    await shot(page, 'phone-390-line.png');
    await pline().locator('[data-testid="super-question-line-go"]').click();
    ok('phone: the line leaves after its press', await until(page, async () => (await pline().count()) === 0, 4000));
    await page.waitForTimeout(600);
    await shot(page, 'phone-390-after-go.png');
  } else { note('phone: no line drawn at 390 (see phone-390.png)'); await shot(page, 'phone-390.png'); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1500);
  console.log('\n── answered');
  await page.emulateMedia({ colorScheme: 'dark' });
  await clickAnswer(page, 'Wait');
  ok('the answer reached the super', await until(page, async () => reports().some((r) => r.kind === 'answer'), 30000));
  await until(page, async () => (await openQuestionCard(page).count()) === 0, 10000);
  await wheel(page, 600);
  ok('answered: no line at the bottom', (await line(page).count()) === 0);
  await wheel(page, -600);
  ok('answered: no line at the top', (await line(page).count()) === 0);
  await shot(page, 'dark-3-answered.png');
  await context.close();
  await browser.close();
  return { errors };
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
  ok('zero console and page errors', r.errors.length === 0, r.errors.slice(0, 8).join('\n'));
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
