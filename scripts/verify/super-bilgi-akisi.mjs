#!/usr/bin/env node
/**
 * verify:super-bilgi-akisi — information is READ on its own card, a question carries only the
 * decision (owner 2026-10-30, "okuyamıyorum"). Against the REAL dashboard server (dist/) in
 * Chromium with a stand-in `claude` and a scratch HOME (the harness of verify:super-ask-show).
 *
 *  A  a Super question with ONE option preview (a 7-item list): drawn once across the card, at
 *     card type, no "No preview" tile, an "Open whole" bar that opens it full screen;
 *  B  a report page opened with `super open web`, a one-line question `--show <its card>`: the
 *     card reads "To read: <name> → Show", the click brings the report side by side, and after
 *     the answer the report is still on the stage;
 *  Q  two question cards at once (two children's questions; a child's question beside the Super's
 *     own ask): answering one leaves the other open.
 *  R  (VERIFY_ONLY=R) the report card's page: margins, one left edge with the head strip, the
 *     sandbox note on its own strip, a bare page's rhythm, a page with CSS left alone.
 *  Shots at 1440x900 and a 390 px phone (Mac mode). VERIFY_MODE=before runs the same steps on a
 *  base build (VERIFY_REPO) for the before shots and the Q check, without this change's asserts.
 *
 * Run: npm run build && node scripts/verify/super-bilgi-akisi.mjs. Output: tmp/super-bilgi-akisi/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = process.env.VERIFY_REPO || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** `before`: the base build, shots only (its card has none of this change's parts). */
const BEFORE = process.env.VERIFY_MODE === 'before';
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-bilgi-akisi-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CODE = join(SCRATCH, 'ledger-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = process.env.VERIFY_OUT || join(REPO, 'tmp', 'super-bilgi-akisi');
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
const sid = 'verify-bilgi-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, cwd: process.cwd(), t: Date.now(), ...o }) + '\\n');
const waits = new Map();
let seq = 0;
const ask = (input) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  const reqId = 'req-' + process.pid + '-' + seq;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } });
  out({ type: 'control_request', request_id: reqId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: id, requires_user_interaction: true } });
  waits.set(reqId, (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } }); resolve(r); });
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
  const two = text.match(/ASKTWO:(\\S+)/);
  if (two) {
    const mk = (n) => ask({ questions: [{ question: 'Part ' + n + ' for ' + two[1] + '?', header: two[1], multiSelect: false, options: [{ label: 'Part ' + n + ' yes' }, { label: 'Part ' + n + ' no' }] }] }).then((r) => report({ kind: 'answered', word: two[1] + n, response: r }));
    await Promise.all([mk(1), mk(2)]);
    return 'got both';
  }
  const q = text.match(/ASKQ:(\\S+)/);
  if (q) {
    const r = await ask({ questions: [{ question: 'Which way for ' + q[1] + '?', header: q[1], multiSelect: false, options: [{ label: 'Way ' + q[1] + ' one', description: 'the first' }, { label: 'Way ' + q[1] + ' two', description: 'the second' }] }] });
    report({ kind: 'answered', word: q[1], response: r });
    return 'got answer ' + q[1];
  }
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
    if (o.type === 'control_response') { const k = o.response && o.response.request_id; const w = waits.get(k); if (w) { waits.delete(k); w(o.response.response); } continue; }
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
const SEVEN = ['Close the account and stop its notifications', 'Remove the empty timetable and 9 ghost lessons', 'New topics show up in search',
  'A "Move to another plan" menu for institution students', 'Revenue data flows again', 'Ask the teacher whether old lessons count when a plan is added',
  'An extra discount before the 8 November invoice'];
const LIST = `<div class="dc-doc"><h3 class="dc-h3">Today's 7 items</h3><ul class="dc-list">${SEVEN.map((x, i) => `<li>${[1, 2, 8, 9, 11, 12, 15][i]} ${x}</li>`).join('')}</ul></div>`;
const REPORT = `<!doctype html><html><body><div class="dc-doc">
<h1 class="dc-h1">Sprint 4 plan: 7 items today</h1>
<p class="dc-lede">Sprint 4 has 18 items not started. Proposal: the 7 most urgent start in parallel today, 6 move to sprint 5, 5 are dropped. Each item asks you again before it goes live.</p>
<div class="dc-grid dc-grid--3"><div class="dc-stat"><div class="dc-stat-label">Today</div><div class="dc-value">7</div></div><div class="dc-stat"><div class="dc-stat-label">To sprint 5</div><div class="dc-value">6</div></div><div class="dc-stat"><div class="dc-stat-label">Dropped</div><div class="dc-value">5</div></div></div>
<h2 class="dc-h2">Today's 7 items</h2><ol class="dc-list">${SEVEN.map((x) => `<li>${x}</li>`).join('')}</ol>
<h2 class="dc-h2">Your decisions</h2><ul class="dc-list"><li>What to ask the teacher (item 12)</li><li>The discount amount (item 15)</li></ul>
<h2 class="dc-h2">Money</h2><p class="dc-p">Item 15 lowers one invoice; item 11 fixes the revenue report.</p>
</div></body></html>`;

const BARE = `<!doctype html><html><body><h1>Plain report</h1><p>A page with no classes and no CSS.</p><h2>Items</h2><ul><li>One</li><li>Two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>`;
const OWN = `<!doctype html><html><head><style>body{padding:3px}h1{margin:1px}</style></head><body><h1>Own CSS</h1><p>Mine.</p></body></html>`;
const SCRIPTED = `<!doctype html><html><head><title>S</title><script>var s=document.createElement('style');s.textContent='body{padding:5px;max-width:none}';document.head.appendChild(s);</script></head><body><h1>Scripted</h1><p>Mine.</p></body></html>`;
const PREPENDED = `<!doctype html><html><body><h1>Prepended</h1><script>var s=document.createElement('style');s.textContent='h1{color:inherit}';document.head.prepend(s);</script></body></html>`;
const DEEP = `<!doctype html><html><body><div><div style="display:grid;padding:7px"><h1>Deep</h1><p>Mine.</p></div></div></body></html>`;
const DONE = new Error('done');

/** Where the page and its strips sit, from the card's left edge. */
async function reportGeo(page, id) {
  const card = page.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
  const frameEl = card.locator('iframe.doc-reader-html-frame');
  const handle = await frameEl.elementHandle();
  const frame = await handle.contentFrame();
  const inner = await frame.evaluate(() => {
    const b = getComputedStyle(document.body);
    const box = (q) => { const el = document.querySelector(q); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, top: r.top, bottom: r.bottom, mt: parseFloat(getComputedStyle(el).marginTop), mb: parseFloat(getComputedStyle(el).marginBottom) }; };
    return { pad: parseFloat(b.paddingLeft), maxWidth: b.maxWidth, width: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth, h1: box('h1'), p: box('p'), li: box('li'), th: box('th') };
  });
  const outer = await card.evaluate((el) => {
    const c = el.getBoundingClientRect();
    const rel = (q) => { const n = el.querySelector(q); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x - c.x, top: r.top - c.y, bottom: r.bottom - c.y }; };
    return { head: rel('.wb-widget-head .wb-widget-title, .wb-widget-head h3, .wb-widget-head > *'), frame: rel('iframe.doc-reader-html-frame'), foot: rel('.doc-reader-html-foot'), note: rel('.doc-reader-html-note') };
  });
  return { inner, outer, sandbox: await frameEl.getAttribute('sandbox'), csp: await frame.evaluate(() => document.querySelector('meta[http-equiv]')?.getAttribute('content')) };
}

async function reportCardStep(page) {
  const tag = BEFORE ? 'once' : 'sonra';
  const dir = join(PROJ, '_dream_context', 'tmp', 'super');
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of [['sprint-4-plan.html', REPORT], ['bare.html', BARE], ['own.html', OWN], ['scripted.html', SCRIPTED], ['prepended.html', PREPENDED], ['deep.html', DEEP]]) writeFileSync(join(dir, f), body);
  const open = async (f, title) => {
    await superVerb(page, `open web _dream_context/tmp/super/${f} --title ${title}`);
    await superVerb(page, 'half --off');
    await settle(page);
    return record().containers.filter((c) => c.kind === 'web').at(-1);
  };
  const web = await open('sprint-4-plan.html', 'Sprint-4-plan');
  await superVerb(page, `ask --json ${spec([{ question: 'Start the 7 items of the Sprint 4 plan today?', multiSelect: false, options: [{ label: 'Approve and start' }, { label: 'I will change the list' }] }], 'Sprint 4 → approve')} --show ${web?.id}`);
  await settle(page);
  const q = openQuestionCard(page).first();
  await until(page, async () => (await q.count()) > 0, 15000);
  await q.locator('.chat-surveycard-read').click();
  await until(page, async () => record().view.mode === 'half' && record().view.card === web?.id, 10000);
  await settle(page);
  await page.waitForTimeout(2000);
  await shot(page, `rapor-${tag}-1440.png`);
  const geo = await reportGeo(page, web?.id);
  console.log(JSON.stringify(geo));
  // The phone surface has no stage, so a 390 px report is the dashboard itself at that width.
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.waitForTimeout(2000);
  await shot(page, `rapor-${tag}-390.png`);
  if (!BEFORE) {
    const m = await reportGeo(page, web?.id).catch((e) => ({ error: String(e) }));
    ok('R: at 390 the page is inset and does not overflow', m.inner?.pad === 24 && m.inner.scrollW <= m.inner.width, JSON.stringify(m.inner ?? m));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  if (!BEFORE) {
    const { inner, outer, sandbox, csp } = geo;
    ok('R: the page keeps 24 px from the card', inner.pad === 24, String(inner.pad));
    ok('R: title, paragraph and list share the head strip\'s left edge', [inner.h1.x, inner.p.x].every((x) => Math.abs(x + outer.frame.x - outer.head.x) <= 1), JSON.stringify({ h1: inner.h1.x, p: inner.p.x, frame: outer.frame.x, head: outer.head.x }));
    ok('R: list markers stay inside the card', inner.li.x >= 24 + 12, String(inner.li.x));
    ok('R: nothing runs past the card', inner.scrollW <= inner.width, JSON.stringify([inner.scrollW, inner.width]));
    ok('R: the note sits on its own strip under the page, on the same edge', outer.foot.top >= outer.frame.bottom - 1 && Math.abs(outer.note.x - outer.head.x) <= 1, JSON.stringify(outer));
    ok('R: the sandbox did not move', sandbox === 'allow-scripts' && /default-src 'none'/.test(csp), JSON.stringify({ sandbox, csp }));
  }
  await clickAnswer(page, 'Approve and start');
  await until(page, async () => !openAskItem(), 15000);
  await superVerb(page, `close ${web?.id}`);
  const bare = await open('bare.html', 'Bare');
  await superVerb(page, `half ${bare?.id}`);
  await settle(page);
  await page.waitForTimeout(1500);
  await shot(page, `rapor-${tag}-bare-1440.png`);
  const g2 = await reportGeo(page, bare?.id).catch((e) => ({ error: String(e) }));
  console.log(JSON.stringify(g2));
  await superVerb(page, `close ${bare?.id}`);
  const own = await open('own.html', 'Own');
  await superVerb(page, `half ${own?.id}`);
  await settle(page);
  await page.waitForTimeout(1500);
  const g3 = await reportGeo(page, own?.id).catch((e) => ({ error: String(e) }));
  console.log(JSON.stringify(g3));
  await superVerb(page, `close ${own?.id}`);
  const geoOf = async (f, title) => {
    const c = await open(f, title);
    await superVerb(page, `half ${c?.id}`);
    await settle(page);
    await page.waitForTimeout(1500);
    const g = await reportGeo(page, c?.id).catch((e) => ({ error: String(e) }));
    await superVerb(page, `close ${c?.id}`);
    return g;
  };
  const g4 = await geoOf('scripted.html', 'Scripted');
  const g5 = await geoOf('deep.html', 'Deep');
  const g6 = await geoOf('prepended.html', 'Prepended');
  if (!BEFORE) {
    ok('R: a style a script puts in the head is left alone', g4.inner?.pad === 5 && g4.inner.maxWidth === 'none', JSON.stringify(g4.inner ?? g4));
    ok('R: a style a script puts first in the head turns the default off', g6.inner?.pad === 0 && g6.inner.maxWidth === 'none', JSON.stringify(g6.inner ?? g6));
    ok('R: a page styled by hand under a wrapper is left alone', g5.inner?.pad === 0 && g5.inner.maxWidth === 'none', JSON.stringify(g5.inner ?? g5));
    ok('R: a bare page gets the margin and a rhythm', g2.inner?.pad === 24 && g2.inner.h1.mb > 0 && g2.inner.p.mb > 0 && g2.inner.th.x > g2.inner.p.x - 1, JSON.stringify(g2.inner));
    ok('R: a page with its own CSS is left alone', g3.inner?.pad === 3 && g3.inner.maxWidth === 'none' && g3.inner.h1.mt === 1, JSON.stringify(g3.inner));
  }
}

/** The phone (390 px, Mac mode) watching the Super chat, or null. */
async function openPhone(browser, pw, base) {
  const setup = await api(base, 'POST', '/api/handsfree/mac/setup', {});
  const started = await api(base, 'POST', '/api/handsfree/mac/start', { vaults: [VAULT] });
  const qr = (await api(base, 'POST', '/api/handsfree/mac/qr')).json.url;
  if (!ok('Mac mode is up with a sign-in link', setup.status === 200 && started.status === 200 && typeof qr === 'string')) return null;
  const pctx = await browser.newContext({ ...pw.devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await markAnnouncementsSeen(pctx, base).catch(() => {});
  const phone = await pctx.newPage();
  phone.errors = [];
  phone.on('console', (m) => { if (m.type() === 'error') phone.errors.push(m.text()); });
  phone.on('pageerror', (e) => phone.errors.push(String(e)));
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await until(phone, async () => phone.url().includes(`vault=${VAULT}`), 25000);
  for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
  const row = phone.locator('[data-testid="super-row"]:visible');
  await until(phone, async () => (await row.count()) > 0, 20000);
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await row.first().click().catch(() => {});
    opened = await until(phone, async () => (await phone.locator('.chat-cmp-input:visible').count()) > 0, 8000);
  }
  ok('the phone opens the Super chat', opened);
  return phone;
}
async function phoneShot(phone, name) {
  if (!phone) return;
  const okBtn = phone.getByRole('button', { name: 'OK', exact: true });
  if (await okBtn.count()) await okBtn.first().click().catch(() => {});
  const card = phone.locator('[data-testid="super-question-card"]:visible').last();
  if (await until(phone, async () => (await card.count()) > 0, 15000)) await card.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  await phone.waitForTimeout(1500);
  const p = join(OUT, name);
  await phone.screenshot({ path: p });
  results.shots.push(p);
}
const openAskItem = () => (record().queue ?? []).find((q) => q.kind === 'ask' && q.state !== 'done');

async function flow(pw, base) {
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await markAnnouncementsSeen(context, base).catch(() => {});
  const page = await context.newPage();
  const errors = [];
  const consoleLog = createWriteStream(join(OUT, 'console.log'));
  page.on('console', (m) => { consoleLog.write(`[${m.type()}] ${m.text()}\n`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) consoleLog.write(`[http ${r.status()}] ${r.request().method()} ${r.url()}\n`); });

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
  ok('the super took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
  await until(page, async () => (await composer(page).count()) > 0, 20000);
  await settle(page);
  const phone = await openPhone(browser, pw, base);

  const ONLY_Q = process.env.VERIFY_ONLY === 'Q';
  if (process.env.VERIFY_ONLY === 'R') {
    console.log('\n── R: the report card\'s page');
    await reportCardStep(page);
    await browser.close();
    throw DONE;
  }
  if (!ONLY_Q) {
  console.log('\n── A: one option preview');
  const a = await superVerb(page, `ask --json ${spec([{
    question: 'Start these 7 items today?', description: 'If you approve, the 7 start in parallel; each asks you again before it goes live.',
    multiSelect: false,
    options: [{ label: 'Approve and start', description: '7 start, 6 move to sprint 5, 5 dropped', preview: LIST }, { label: 'I will change the list', description: 'Write by number: add, remove' }],
  }], 'Sprint 4 → plan')}`);
  ok('A: asked', a.status === 0 && !!a.json.item, a.out?.slice(0, 400));
  const card = openQuestionCard(page).first();
  ok('A: the question card is open', await until(page, async () => (await card.count()) > 0, 15000));
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(2000);
  await shot(page, `A-${BEFORE ? 'once' : 'sonra'}-1440.png`);
  await phoneShot(phone, `A-${BEFORE ? 'once' : 'sonra'}-390.png`);
  if (!BEFORE) {
    ok('A: no "No preview" tile, no board', (await card.locator('.chat-surveycard-tile-empty, .chat-surveycard-board').count()) === 0);
    const geo = await card.evaluate((el) => {
      const solo = el.querySelector('.chat-surveycard-solo')?.getBoundingClientRect();
      const block = el.querySelector('.chat-surveycard-page')?.getBoundingClientRect();
      const frame = el.querySelector('.chat-surveycard-solo iframe');
      const size = frame?.contentDocument ? getComputedStyle(frame.contentDocument.querySelector('li') ?? frame.contentDocument.body).fontSize : null;
      return { solo: solo && solo.width, block: block && block.width, size, rows: el.querySelectorAll('.chat-surveycard-opt').length, more: !!el.querySelector('.chat-surveycard-solo-more') };
    });
    ok('A: the preview spans the card (≥ 95 % of its width)', geo.solo && geo.block && geo.solo >= geo.block * 0.95, JSON.stringify(geo));
    ok('A: the list reads at card type (≤ 14 px)', geo.size === null || parseFloat(geo.size) <= 14, JSON.stringify(geo));
    ok('A: both options and Other are plain rows', geo.rows === 3, JSON.stringify(geo));
  }
  await clickAnswer(page, 'Approve and start');
  ok('A: answered', await until(page, async () => !openAskItem(), 15000));
  if (!BEFORE) {
    const many = `<div class="dc-doc"><ul class="dc-list">${Array.from({ length: 24 }, (_, i) => `<li>Item ${i + 1}: ${SEVEN[i % 7]}</li>`).join('')}</ul></div>`;
    await superVerb(page, `ask --json ${spec([{ question: 'Keep this long list?', multiSelect: false, options: [{ label: 'Keep it', preview: many }, { label: 'Drop it' }] }], 'Long list')}`);
    const longCard = openQuestionCard(page).first();
    const more = longCard.locator('.chat-surveycard-solo-more');
    if (ok('A: a long preview gets the "Open whole" bar', await until(page, async () => (await more.count()) === 1, 15000))) {
      await more.click();
      ok('A: "Open whole" opens it full screen', await until(page, async () => (await page.locator('[class*="fullscreen"] iframe').count()) > 0, 5000));
      await page.waitForTimeout(800);
      await shot(page, 'A-sonra-tamami-1440.png');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    await clickAnswer(page, 'Keep it');
    await until(page, async () => !openAskItem(), 15000);
  }

  console.log('\n── B: a report card and a one-line question');
  mkdirSync(join(PROJ, '_dream_context', 'tmp', 'super'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'tmp', 'super', 'sprint-4-plan.html'), REPORT);
  const o = await superVerb(page, 'open web _dream_context/tmp/super/sprint-4-plan.html --title Sprint-4-plan');
  const web = record().containers.find((c) => c.kind === 'web');
  ok('B: the report card is open', o.status === 0 && !!web, o.out?.slice(0, 300));
  await superVerb(page, 'half --off');
  await settle(page);
  const b = await superVerb(page, `ask --json ${spec([{ question: 'Start the 7 items of the Sprint 4 plan today?', multiSelect: false,
    options: [{ label: 'Approve and start', description: '7 start, 6 move, 5 dropped' }, { label: 'I will change the list', description: 'Write by number' }] }], 'Sprint 4 → approve')} --show ${web?.id}`);
  ok('B: asked with the report shown', b.status === 0 && !!b.json.item, b.out?.slice(0, 400));
  if (!BEFORE) ok('B: no warning (the report is the summary)', !b.json.warning, b.json.warning);
  if (!BEFORE) ok('B: record: the question points at the report', JSON.stringify(openAskItem()?.read) === JSON.stringify([web?.id]), JSON.stringify(openAskItem()));
  await settle(page);
  const bCard = openQuestionCard(page).first();
  await until(page, async () => (await bCard.count()) > 0, 15000);
  await bCard.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(2500);
  await shot(page, `B-${BEFORE ? 'once' : 'sonra'}-1440.png`);
  await phoneShot(phone, `B-${BEFORE ? 'once' : 'sonra'}-390.png`);
  if (!BEFORE) {
    const read = bCard.locator('.chat-surveycard-read');
    ok('B: the card reads "To read: Sprint-4-plan"', (await read.count()) === 1 && /To read:\s*Sprint-4-plan/.test(await read.innerText()), await read.innerText().catch(() => ''));
    await read.click();
    ok('B: the click brings the report side by side', await until(page, async () => record().view.mode === 'half' && record().view.card === web?.id, 10000), JSON.stringify(record().view));
    await settle(page);
    await page.waitForTimeout(2000);
    await shot(page, 'B-sonra-rapor-yaninda-1440.png');
  }
  await clickAnswer(page, 'Approve and start');
  ok('B: answered', await until(page, async () => !openAskItem(), 15000));
  await settle(page);
  ok('B: the report is still on the stage after the answer', (() => { const c = record().containers.find((x) => x.id === web?.id); return !!c && c.place === 'float'; })(), JSON.stringify(record().containers.find((x) => x.id === web?.id)));
  ok('B: DOM: the report card is drawn', (await page.locator(`[data-testid="super-container"][data-container-id="${web?.id}"]`).count()) > 0);
  await shot(page, `B-${BEFORE ? 'once' : 'sonra'}-cevaptan-sonra-1440.png`);
  await superVerb(page, `close ${web?.id}`);

  }

  console.log('\n── Q1: two children\'s questions at once');
  const kids = [];
  for (const w of ['alpha', 'beta']) {
    const d = await superVerb(page, `delegate --prompt ASKQ:${w} --brief Ask-${w}`);
    kids.push(d.json.sessionId ?? d.json.child);
  }
  const qOf = (kid) => record().queue.find((q) => q.sessionId === kid && q.kind === 'question' && q.state !== 'done');
  ok('Q1: both questions reach the queue', await until(page, async () => kids.every((k) => !!qOf(k)), 40000), JSON.stringify(record().queue.map((q) => [q.kind, q.state, q.direct])));
  for (const k of kids) if (qOf(k) && qOf(k).state !== 'escalated' && !qOf(k).direct) await superVerb(page, `queue ask ${qOf(k).id} Which-way?`);
  const qCards = centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="question"]');
  ok('Q1: two question cards are open', await until(page, async () => (await qCards.count()) === 2, 20000), String(await qCards.count()));
  await page.waitForTimeout(1000);
  await shot(page, `Q1-${BEFORE ? 'once' : 'sonra'}-iki-kart-1440.png`);
  const firstCard = qCards.first();
  const firstWord = (await firstCard.innerText()).includes('alpha') ? 'alpha' : 'beta';
  const otherWord = firstWord === 'alpha' ? 'beta' : 'alpha';
  await firstCard.locator('.chat-surveycard-opt').filter({ hasText: `Way ${firstWord} one` }).first().click();
  await firstCard.locator('.chat-btn.primary').first().click();
  ok(`Q1: the ${firstWord} child got its answer`, await until(page, async () => reports().some((r) => r.kind === 'answered' && r.word === firstWord), 20000));
  await page.waitForTimeout(4000);
  const otherOpen = await centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="question"]').filter({ hasText: `Way ${otherWord} one` }).count();
  const otherKid = kids.find((k) => (record().children[k]?.brief ?? '').includes(otherWord)) ?? kids[1];
  ok(`Q1: the ${otherWord} card is still open after the first answer`, otherOpen === 1, JSON.stringify({ otherOpen, queue: record().queue.map((q) => [q.sessionId.slice(0, 8), q.kind, q.state]) }));
  ok(`Q1: the ${otherWord} child has no answer yet`, !reports().some((r) => r.kind === 'answered' && r.word === otherWord));
  await shot(page, `Q1-${BEFORE ? 'once' : 'sonra'}-ilk-cevaptan-sonra-1440.png`);
  void otherKid;
  const left = centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="question"]').first();
  if (await left.count()) {
    await left.locator('.chat-surveycard-opt').filter({ hasText: `Way ${otherWord} two` }).first().click();
    await left.locator('.chat-btn.primary').first().click();
    ok(`Q1: the ${otherWord} child got its own answer`, await until(page, async () => reports().some((r) => r.kind === 'answered' && r.word === otherWord), 20000));
  }

  console.log('\n── Q2: a child\'s question beside the Super\'s own ask');
  const d3 = await superVerb(page, 'delegate --prompt ASKQ:gamma --brief Ask-gamma');
  const kid3 = d3.json.sessionId ?? d3.json.child;
  ok('Q2: the child question reaches the queue', await until(page, async () => !!qOf(kid3), 40000));
  if (qOf(kid3) && qOf(kid3).state !== 'escalated') await superVerb(page, `queue ask ${qOf(kid3).id} Which-way?`);
  const sa = await superVerb(page, `ask --json ${spec([{ question: 'Ship the release note now?', multiSelect: false, options: [{ label: 'Ship it' }, { label: 'Hold it' }] }], 'Release note')}`);
  ok('Q2: the Super asks its own question', sa.status === 0 && !!sa.json.item, sa.out?.slice(0, 300));
  const all = centre(page).locator('[data-testid="super-question-card"][data-state="open"]');
  ok('Q2: two cards open (the child\'s and the Super\'s)', await until(page, async () => (await all.count()) === 2, 20000), String(await all.count()));
  const gCard = centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="question"]').first();
  await gCard.locator('.chat-surveycard-opt').filter({ hasText: 'Way gamma one' }).first().click();
  await gCard.locator('.chat-btn.primary').first().click();
  ok('Q2: the gamma child got its answer', await until(page, async () => reports().some((r) => r.kind === 'answered' && r.word === 'gamma'), 20000));
  await page.waitForTimeout(4000);
  ok('Q2: the Super\'s own question is still open (record)', !!openAskItem(), JSON.stringify(record().queue.map((q) => [q.kind, q.state])));
  ok('Q2: the Super\'s own card is still open (DOM)', (await centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="ask"]').count()) === 1);
  await shot(page, `Q2-${BEFORE ? 'once' : 'sonra'}-cocuk-cevabindan-sonra-1440.png`);

  console.log('\n── Q3: the Super\'s own question answered, a child\'s still open');
  await clickAnswer(page, 'Ship it');
  ok('Q3: the Super heard the first answer', await until(page, async () => !openAskItem(), 15000));
  const d4 = await superVerb(page, 'delegate --prompt ASKQ:delta --brief Ask-delta');
  const kid4 = d4.json.sessionId ?? d4.json.child;
  ok('Q3: the child question reaches the queue', await until(page, async () => !!qOf(kid4), 40000));
  if (qOf(kid4) && qOf(kid4).state !== 'escalated') await superVerb(page, `queue ask ${qOf(kid4).id} Which-way?`);
  await superVerb(page, `ask --json ${spec([{ question: 'Publish the changelog?', multiSelect: false, options: [{ label: 'Publish' }, { label: 'Hold' }] }], 'Changelog')}`);
  const anyAsk = centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="ask"]');
  await until(page, async () => (await anyAsk.count()) === 1, 15000);
  await anyAsk.locator('.chat-surveycard-opt').filter({ hasText: 'Publish' }).first().click();
  await anyAsk.locator('.chat-btn.primary').first().click();
  ok('Q3: the ask closes', await until(page, async () => !openAskItem(), 15000));
  await page.waitForTimeout(5000);
  const delta = centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="question"]').filter({ hasText: 'Way delta one' });
  ok('Q3: the child\'s card is still open after the Super\'s answer', (await delta.count()) === 1, JSON.stringify(record().queue.map((q) => [q.kind, q.state])));
  ok('Q3: its queue item is still open', !!qOf(kid4) && qOf(kid4).state !== 'done', JSON.stringify(qOf(kid4)));
  if (await delta.count()) {
    await delta.locator('.chat-surveycard-opt').filter({ hasText: 'Way delta one' }).first().click();
    await delta.locator('.chat-btn.primary').first().click();
    await until(page, async () => reports().some((r) => r.kind === 'answered' && r.word === 'delta'), 15000);
  }

  console.log('\n── Q4: one child raises two questions at once');
  const d5 = await superVerb(page, 'delegate --prompt ASKTWO:eps --brief Ask-eps');
  const kid5 = d5.json.sessionId ?? d5.json.child;
  ok('Q4: a question reaches the queue', await until(page, async () => !!qOf(kid5), 40000));
  await page.waitForTimeout(3000);
  note(`Q4 queue: ${JSON.stringify(record().queue.filter((q) => q.sessionId === kid5).map((q) => [q.kind, q.state, q.requestId, q.direct]))}`);
  for (const q of record().queue.filter((x) => x.sessionId === kid5 && x.kind === 'question' && x.state !== 'done' && x.state !== 'escalated' && !x.direct)) await superVerb(page, `queue ask ${q.id} Which-part?`);
  await page.waitForTimeout(3000);
  const eps = centre(page).locator('[data-testid="super-question-card"][data-state="open"][data-kind="question"]');
  const nCards = await eps.count();
  note(`Q4: ${nCards} card(s) in the Super chat`);
  await shot(page, `Q4-${BEFORE ? 'once' : 'sonra'}-iki-soru-1440.png`);
  const childTab = await until(page, async () => (await eps.count()) > 0, 10000);
  if (childTab) {
    const c = eps.first();
    const part = (await c.innerText()).includes('Part 1') ? 1 : 2;
    await c.locator('.chat-surveycard-opt').filter({ hasText: `Part ${part} yes` }).first().click();
    await c.locator('.chat-btn.primary').first().click();
    ok(`Q4: part ${part} got its answer`, await until(page, async () => reports().some((r) => r.kind === 'answered' && r.word === `eps${part}`), 15000));
    await page.waitForTimeout(6000);
    const other = part === 1 ? 2 : 1;
    const answeredOther = reports().some((r) => r.kind === 'answered' && r.word === `eps${other}`);
    const cardsLeft = await centre(page).locator('[data-testid="super-question-card"][data-state="open"]').filter({ hasText: `Part ${other}` }).count();
    await shot(page, `Q4-${BEFORE ? 'once' : 'sonra'}-ilk-cevaptan-sonra-1440.png`);
    ok(`Q4: part ${other} is unanswered and its card still open`, !answeredOther && cardsLeft === 1, JSON.stringify({ answeredOther, cardsLeft, queue: record().queue.filter((q) => q.sessionId === kid5).map((q) => [q.kind, q.state, q.requestId]) }));
  }

  await context.close();
  await browser.close();
  return { errors: [...errors, ...(phone?.errors ?? []).map((e) => `[phone] ${e}`)] };
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
  if (err !== DONE) { results.fails.push(`crashed: ${err?.stack || err}`); console.error(err); }
} finally {
  server?.kill();
  spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.fails.length ? 'FAIL' : 'PASS'}: ${results.pass} passed, ${results.fails.length} failed${results.fails.length ? `\n  - ${results.fails.join('\n  - ')}` : ''}`);
process.exit(results.fails.length ? 1 : 0);
