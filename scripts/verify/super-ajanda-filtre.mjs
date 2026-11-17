#!/usr/bin/env node
/**
 * verify:super-ajanda-filtre — an agenda line's press shows only its thread in the Super chat
 * (task ajanda-gunluk, plan ajanda-filtre, criteria 1, 3, 4, 5, 8, 11, 12). A real dashboard server
 * (this worktree's dist/), a stand-in claude and a scratch HOME: the super notes two lines in his
 * turns, a long unlinked reply sits between them; pressing a line filters the chat ("Only: … ·
 * N messages · ×"), the row stays highlighted, the About chip is staged; a send stays in the
 * thread; ×, Esc and the same row give the full chat back at its place; a line with nothing linked
 * shows the empty state; an out-of-thread question's "Go to question" ends the filter and lands on
 * the card; medium size moves the detail to the hover; wide opens the inline detail with the
 * filter; both themes; a 390 px phone.
 *
 * Run: npm run build && node scripts/verify/super-ajanda-filtre.mjs. Output: tmp/super-ajanda-filtre/.
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
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-super-ajanda-filtre-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CODE = join(SCRATCH, 'ledger-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-ajanda-filtre');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const VAULT = 'pocket-ledger';
/** 0.34.5's measured picture areas for two wide 1600x960 mockups in compare (olcum/results.json). */
const KEY = 'verifyOwnerKey_0123456789abcdefghijklmnopqrstuv';
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
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: ['compact', 'review'] });
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
    env: { ...env(), PATH, DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log'), DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1', DREAMCONTEXT_OWNER_KEY_STDIN: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  srv.stdin.write(`${KEY}\n`);
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
const agendaCard = (page) => page.locator('[data-testid="super-container"][data-kind="agenda"]');
// The pad line itself (data-kind note), never the "Your message" row of the turn that noted it.
const rowWith = (page, text) => agendaCard(page).locator('[data-testid="super-agenda-row"][data-kind="note"]').filter({ hasText: text }).first();
const chip = (page) => centre(page).locator('[data-testid="super-thread-chip"]');
const transcriptText = (page) => centre(page).locator('.chat-scroll').first().innerText();
const draft = (page) => composer(page).inputValue();
const scrollTopOf = (page) => page.evaluate(() => document.querySelector('[data-super-slot="centre"] .chat-scroll')?.scrollTop ?? -1);
const atBottomOf = (page) => page.evaluate(() => { const el = document.querySelector('[data-super-slot="centre"] .chat-scroll'); return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 4; });
const qline = (page) => centre(page).locator('[data-testid="super-question-line"]');
async function owner(page, body) {
  return page.evaluate(async ([b, v]) => (await fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': v }, body: JSON.stringify(b) })).status, [body, VAULT]);
}
async function setSize(page, size) {
  await agendaCard(page).hover();
  await agendaCard(page).locator('[data-testid="super-card-size-btn"], [data-testid="super-card-more"]').first().click();
  const opt = page.getByTestId(`super-size-${size}`);
  if (await opt.isDisabled()) { await page.keyboard.press('Escape'); return false; }
  await opt.click();
  const done = await until(page, async () => (await agendaCard(page).getAttribute('data-size')) === size, 8000);
  await settle(page);
  await page.mouse.move(5, 5);
  return done;
}
async function pressRow(page, text) {
  // Pressed with the focus elsewhere (a real press from the stage); the hover strip sits over the
  // row's right end, so the press lands on the words.
  await page.evaluate(() => document.activeElement?.blur?.());
  await rowWith(page, text).locator('.super-agenda-name').click({ position: { x: 8, y: 6 } });
  await page.waitForTimeout(700);
}
const LINE_A = 'Telegram bots move to rich cards';
const LINE_B = 'Board export splits for the phone';
const LINE_C = 'Write the beta price idea';

async function flow(pw, base) {
  const browser = await pw.chromium.launch();
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', recordVideo: { dir: join(SCRATCH, 'video'), size: { width: 1440, height: 900 } } });
  const videoT0 = Date.now();
  await markAnnouncementsSeen(context, base).catch(() => {});
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[desk] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[desk] ${e}`));
  await openChat(page, base);
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  const first = page.locator('.chat-cmp-input:visible').first();
  await first.click(); await first.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
  await page.waitForTimeout(1500);
  await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
  ok('the super took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
  await until(page, async () => (await composer(page).count()) > 0, 20000);
  await settle(page);

  console.log('\n── lines linked in his turns');
  const a = await superVerb(page, `note add now ${LINE_A}`);
  ok('line A noted in his turn', a.status === 0, a.out);
  await sayToSuper(page, 'LONG');
  await until(page, async () => reports().some((r) => r.kind === 'owner' && r.text === 'LONG'), 30000);
  await page.waitForTimeout(1500);
  const b = await superVerb(page, `note add now ${LINE_B}`);
  ok('line B noted in his turn', b.status === 0, b.out);
  if (!(record().containers ?? []).some((k) => k.kind === 'agenda')) await owner(page, { agenda: 'open' });
  ok('the agenda is a card on the stage', await until(page, async () => (await agendaCard(page).count()) === 1, 15000));
  await settle(page);
  if ((await agendaCard(page).getAttribute('data-size')) !== 'large') await setSize(page, 'large');
  ok('line A is on the agenda', await until(page, async () => (await rowWith(page, LINE_A).count()) === 1, 15000));
  // The owner's own line, added with the agenda's +: no turn noted it (the empty state's line).
  // The + box is the Mac shell's (this page is a browser), so the line goes in through the same
  // owner route with the shell's key; the page's own fetch carries the same-origin headers.
  const added = await page.evaluate(async ([text, v, key]) => (await fetch('/api/super/pad/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': v, 'X-Dreamcontext-Owner-Key': key }, body: JSON.stringify({ text }) })).status, [LINE_C, VAULT, KEY]);
  ok('line C (his own) is on the agenda', added === 200 && await until(page, async () => (await rowWith(page, LINE_C).count()) === 1, 10000), `status ${added}`);

  for (const scheme of ['dark', 'light']) {
    console.log(`\n── ${scheme}`);
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(500);
    const fullBefore = await transcriptText(page);
    // Light: he reads higher up (not at the bottom), so × must find his place, not the bottom.
    if (scheme === 'light') {
      // A real wheel over the chat (his own scroll releases the follow; a script's write does not).
      const box = await centre(page).locator('.chat-scroll').first().boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(80); }
      await page.waitForTimeout(900);
    }
    const topBefore = await scrollTopOf(page);
    const bottomBefore = await atBottomOf(page);
    ok(`${scheme}: the full chat holds the long unlinked reply`, fullBefore.includes('Line 1 of a long report'));
    await pressRow(page, LINE_A);
    ok(`${scheme}: press shows the Only strip`, await until(page, async () => (await chip(page).count()) === 1, 5000));
    const chipText = await chip(page).innerText();
    ok(`${scheme}: the strip names the line and a count`, chipText.includes(LINE_A) && /\d+\s+(messages|mesaj)/.test(chipText), chipText);
    const filtered = await transcriptText(page);
    ok(`${scheme}: only the thread is drawn (no long reply, no line B turn)`, !filtered.includes('Line 1 of a long report') && !filtered.includes('note add now Board'), filtered.slice(0, 400));
    ok(`${scheme}: the thread holds the message that noted it`, filtered.includes(`note add now ${LINE_A}`), filtered.slice(0, 400));
    ok(`${scheme}: the row stays highlighted`, (await rowWith(page, LINE_A).getAttribute('data-thread')) === 'on');
    // Owner 2026-11-17: the strip alone says it; the composer gets no chip of its own.
    ok(`${scheme}: the composer stays empty (no About chip)`, !(await draft(page)).includes('Telegram') && (await centre(page).locator('.chat-cmp-hl-ref').count()) === 0, await draft(page));
    ok(`${scheme}: the composer was not focused by the press`, !(await composer(page).evaluate((el) => el === document.activeElement)));
    await shot(page, `${scheme}-1-filtered.png`);
    await chip(page).getByTestId('super-thread-clear').click();
    ok(`${scheme}: × gives the full chat back`, await until(page, async () => (await chip(page).count()) === 0 && (await transcriptText(page)).includes('Line 1 of a long report'), 5000));
    await page.waitForTimeout(500);
    const topAfter = await scrollTopOf(page);
    // At the bottom he comes back to the bottom, even when the chat grew meanwhile.
    const bottomAfter = await atBottomOf(page);
    ok(`${scheme}: …at the place he left it`, bottomBefore ? bottomAfter : Math.abs(topAfter - topBefore) <= 4, `${topBefore} -> ${topAfter}, bottom ${bottomBefore} -> ${bottomAfter}`);
    ok(`${scheme}: …and the row is no longer highlighted`, (await rowWith(page, LINE_A).getAttribute('data-thread')) === null);
    await shot(page, `${scheme}-2-after-x.png`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });

  console.log('\n── the owner clip (light): press, filtered chat, send, ×');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(800);
  const clipFrom = Date.now() - videoT0;
  await page.mouse.move(400, 520, { steps: 12 });
  await pressRow(page, LINE_A);
  await page.waitForTimeout(1500);
  await composer(page).click();
  await page.keyboard.type('add a preview to the card', { delay: 45 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  ok('clip: the super got it with the row block, no chip used', await until(page, async () => reports().some((r) => r.kind === 'owner' && r.text.includes('add a preview to the card') && /\[About agenda line note=/.test(r.text)), 30000));
  await page.waitForTimeout(2200);
  ok('clip: the sent message is in the filtered chat', (await transcriptText(page)).includes('add a preview to the card'));
  ok('clip: no "About" label repeats the strip inside the filtered chat', (await centre(page).locator('[data-testid="chat-msg-about"]').count()) === 0);
  await shot(page, 'light-3-sent.png');
  await chip(page).getByTestId('super-thread-clear').hover();
  await page.waitForTimeout(500);
  await chip(page).getByTestId('super-thread-clear').click();
  await page.waitForTimeout(2000);
  ok('clip: in the full chat the message names its line again', (await centre(page).locator('[data-testid="chat-msg-about"]').filter({ hasText: 'Telegram' }).count()) >= 1);
  await shot(page, 'light-4-after-x.png');
  results.clip = { from: clipFrom, to: Date.now() - videoT0 };
  await page.emulateMedia({ colorScheme: 'dark' });

  console.log('\n── a send from the filter stays in the thread');
  await pressRow(page, LINE_A);
  await composer(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('make the title bold');
  await page.keyboard.press('Enter');
  ok('the super got it, About block and all', await until(page, async () => reports().some((r) => r.kind === 'owner' && r.text.includes('make the title bold') && /\[About agenda line note=/.test(r.text)), 30000));
  await page.waitForTimeout(1500);
  ok('it shows in the filtered chat', (await transcriptText(page)).includes('make the title bold'));
  ok('the box is empty after the send (no chip comes back)', (await draft(page)).trim() === '', await draft(page));
  ok('no message moved the view by itself', (await chip(page).count()) === 1);
  await shot(page, 'dark-3-sent-in-thread.png');
  // Esc in the chat clears.
  await composer(page).click();
  await page.keyboard.press('Escape');
  ok('Esc in the chat ends the filter', await until(page, async () => (await chip(page).count()) === 0, 4000));
  ok('…and the surface stays open', (await composer(page).count()) > 0 && (await page.locator('.agent-surface.expanded').count()) > 0);
  await pressRow(page, LINE_A);
  ok('pressed again, the sent message is still in the thread', (await transcriptText(page)).includes('make the title bold'));
  await rowWith(page, LINE_A).locator('.super-agenda-row-btn').focus();
  await page.keyboard.press('Escape');
  ok('Esc with the focus on the pressed row ends the filter', await until(page, async () => (await chip(page).count()) === 0, 4000));
  ok('…and folds nothing', (await composer(page).count()) > 0);
  await pressRow(page, LINE_A);
  await composer(page).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('/');
  const slash = centre(page).locator('.chat-cmp-slash');
  if (await until(page, async () => (await slash.count()) > 0, 2000)) {
    await page.keyboard.press('Escape');
    ok('Esc on the / menu closes the menu and keeps the filter', (await slash.count()) === 0 && (await chip(page).count()) === 1);
  } else note('the / menu did not open here: menu-first Esc not observed');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await pressRow(page, LINE_A);
  ok('the same row again ends the filter', await until(page, async () => (await chip(page).count()) === 0, 4000));

  console.log('\n── a line with nothing linked');
  if (await rowWith(page, LINE_C).count()) {
    await pressRow(page, LINE_C);
    ok('the empty state shows', await until(page, async () => (await centre(page).getByTestId('super-thread-empty').count()) === 1, 4000));
    await shot(page, 'dark-4-empty.png');
    await centre(page).getByTestId('super-thread-back').click();
    ok('"Back to the whole chat" ends it', await until(page, async () => (await chip(page).count()) === 0, 4000));
  } else note('line C not on the agenda: empty state not observed here');

  console.log('\n── switching rows, and an out-of-thread question');
  await pressRow(page, LINE_A);
  await pressRow(page, LINE_B);
  ok('another row switches the filter', (await chip(page).innerText()).includes(LINE_B));
  ok('…and the composer stays empty', (await draft(page)).trim() === '', await draft(page));
  await pressRow(page, LINE_B);
  await superVerb(page, `ask --json ${spec([{ question: 'Ship the cancel flow to staging now?', header: 'Staging', multiSelect: false, options: [{ label: 'Ship it' }, { label: 'Wait' }] }], 'Cancel flow to staging')}`);
  ok('the question card is open', await until(page, async () => (await openQuestionCard(page).count()) > 0, 20000));
  await pressRow(page, LINE_A);
  ok('filtered, the question card is hidden', (await openQuestionCard(page).count()) === 0);
  ok('…and "Go to question" shows over the composer', await until(page, async () => (await qline(page).count()) === 1, 5000));
  await shot(page, 'dark-5-question-line.png');
  await qline(page).getByTestId('super-question-line-go').click();
  ok('its press ends the filter', await until(page, async () => (await chip(page).count()) === 0, 5000));
  ok('…and lands on the card', await until(page, async () => (await openQuestionCard(page).count()) > 0 && (await openQuestionCard(page).first().isVisible()), 5000));
  await shot(page, 'dark-6-after-go.png');

  console.log('\n── a line: the press filters, Ask asks without filtering (owner 2026-11-17), 1440 light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  await rowWith(page, LINE_B).hover();
  await page.waitForTimeout(400);
  const hoverOnly = (await rowWith(page, LINE_B).locator('.agenda-hover-btn').evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => e.dataset.action)));
  ok('hover: the row shows Ask alone', hoverOnly.join(',') === 'ask', hoverOnly.join(','));
  await shot(page, 'final-0-hover.png');
  // Ask: an About chip in the box, the chat stays whole.
  await rowWith(page, LINE_B).getByTestId('super-agenda-about').click();
  await page.waitForTimeout(600);
  ok('Ask does not filter the chat', (await chip(page).count()) === 0 && (await transcriptText(page)).includes('Line 1 of a long report'));
  ok('…it puts the line in the box to write about', (await draft(page)).includes('Board') || (await centre(page).locator('.chat-cmp-hl-ref').count()) > 0, await draft(page));
  await composer(page).fill('');
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  // The press filters at once; the strip's line name opens the detail, Done is there.
  await pressRow(page, LINE_A);
  ok('the press filters at once', (await chip(page).count()) === 1);
  await chip(page).getByTestId('super-thread-label').hover();
  await chip(page).getByTestId('super-thread-label').click();
  ok('the strip\'s line name opens the line\'s detail', await until(page, async () => (await page.getByTestId('super-agenda-detail-float').count()) === 1, 3000));
  const det = page.getByTestId('super-agenda-detail-float');
  ok('Done is in the detail', (await det.getByTestId('super-agenda-detail-done').count()) === 1);
  await page.waitForTimeout(500);
  await shot(page, 'final-1-detail.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await chip(page).count()) await chip(page).getByTestId('super-thread-clear').click();
  await page.emulateMedia({ colorScheme: 'dark' });

  console.log('\n── the row that filters stays selected (owner 2026-11-17), 1440 light, clip');
  const caption = (text) => page.evaluate((t) => {
    let el = document.getElementById('verify-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'verify-caption';
      el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:10px 22px;border-radius:12px;background:rgba(20,16,40,.88);color:#fff;font:600 22px/1.3 -apple-system,system-ui,sans-serif;pointer-events:none;white-space:nowrap';
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.display = t ? 'block' : 'none';
  }, text);
  const selOf = (text) => rowWith(page, text).evaluate((el) => {
    const bar = getComputedStyle(el, '::after');
    const tint = getComputedStyle(el, '::before');
    return { on: el.dataset.thread === 'on', bar: `${bar.width} ${bar.opacity}`, tint: tint.opacity, askShown: [...el.querySelectorAll('.agenda-hover-btn')].some((b) => b.getClientRects().length > 0) };
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(600);
  const selFrom = Date.now() - videoT0;
  await caption('Satıra bas: sohbet süzülür, satır seçili kalır');
  await page.waitForTimeout(900);
  const rbox = await rowWith(page, LINE_A).locator('.super-agenda-name').boundingBox();
  await page.mouse.move(rbox.x + 30, rbox.y + 8, { steps: 14 });
  await page.mouse.click(rbox.x + 30, rbox.y + 8);
  await page.waitForTimeout(500);
  await page.mouse.move(900, 820, { steps: 10 });
  await page.waitForTimeout(1800);
  let sel = await selOf(LINE_A);
  ok('selected: the pressed row stays selected while the chat is filtered', sel.on && (await chip(page).count()) === 1);
  ok('selected: it carries the accent bar on its left edge and the tint', sel.bar === '3px 1' && sel.tint === '1', `${sel.bar} / ${sel.tint}`);
  ok('selected: no Ask strip is left over it after a mouse press', !sel.askShown);
  await shot(page, 'secili-1-light.png');
  await caption('Başka satıra bas: seçim oraya geçer');
  await page.waitForTimeout(900);
  const bbox = await rowWith(page, LINE_B).locator('.super-agenda-name').boundingBox();
  await page.mouse.move(bbox.x + 30, bbox.y + 8, { steps: 10 });
  await page.mouse.click(bbox.x + 30, bbox.y + 8);
  await page.waitForTimeout(500);
  await page.mouse.move(900, 820, { steps: 10 });
  await page.waitForTimeout(1500);
  ok('selected: another row takes the selection', (await selOf(LINE_B)).on && !(await selOf(LINE_A)).on && (await chip(page).innerText()).includes(LINE_B));
  await caption('Aynı satıra tekrar bas: süzme kapanır');
  await page.waitForTimeout(900);
  await page.mouse.move(bbox.x + 30, bbox.y + 8, { steps: 10 });
  await page.mouse.click(bbox.x + 30, bbox.y + 8);
  await page.waitForTimeout(500);
  await page.mouse.move(900, 820, { steps: 10 });
  await page.waitForTimeout(1500);
  ok('selected: the same row again ends the filter and the selection', (await chip(page).count()) === 0 && !(await selOf(LINE_B)).on && !(await selOf(LINE_A)).on);
  await caption('Üzerine gelince yalnız Ask çıkar');
  await page.waitForTimeout(700);
  await page.mouse.move(rbox.x + 60, rbox.y + 8, { steps: 12 });
  await page.waitForTimeout(2200);
  const hov = await rowWith(page, LINE_A).locator('.agenda-hover-btn').evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => e.dataset.action));
  ok('selected: the hover shows Ask alone', hov.join(',') === 'ask', hov.join(','));
  await caption('');
  results.selClip = { from: selFrom, to: Date.now() - videoT0 };
  await page.mouse.move(5, 5);
  // Dark: the same selection reads on the dark card.
  await page.emulateMedia({ colorScheme: 'dark' });
  await pressRow(page, LINE_A);
  await page.mouse.move(900, 820);
  await page.waitForTimeout(600);
  sel = await selOf(LINE_A);
  ok('selected (dark): the row stays selected, accent bar and all', sel.on && sel.bar === '3px 1' && sel.tint === '1', `${sel.bar} / ${sel.tint}`);
  await shot(page, 'secili-2-dark.png');
  await pressRow(page, LINE_A);

  console.log('\n── motion (owner 2026-11-17: "küt diye değil"), 1440 light, before/after clip');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.mouse.move(5, 5);
  const inner = centre(page).locator('.chat-scroll-inner').first();
  const motionAt = async (text, waitMs) => {
    const b = await rowWith(page, text).locator('.super-agenda-name').boundingBox();
    await page.mouse.move(b.x + 30, b.y + 8, { steps: 8 });
    await page.waitForTimeout(250);
    await page.mouse.click(b.x + 30, b.y + 8);
    await page.waitForTimeout(waitMs);
    return rowWith(page, text).evaluate((el) => {
      const inn = document.querySelector('[data-super-slot="centre"] .chat-scroll-inner');
      const kid = inn ? [...inn.children].find((c) => c.getClientRects().length && !c.classList.contains('chat-reply-lines')) : null;
      return { tint: Number(getComputedStyle(el, '::before').opacity), anim: inn?.dataset.threadAnim ?? null, kidAnim: kid ? getComputedStyle(kid).animationName : '', kidOpacity: kid ? Number(getComputedStyle(kid).opacity) : 1 };
    });
  };
  // Before: reduced motion is today's instant change.
  const mFrom = Date.now() - videoT0;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await caption('ÖNCE: satıra bas, her şey bir anda değişir');
  await page.waitForTimeout(1200);
  let m = await motionAt(LINE_A, 40);
  ok('reduced motion: the selection is there at once, nothing animates', m.tint === 1 && m.kidAnim === 'none', JSON.stringify(m));
  await page.mouse.move(900, 820, { steps: 6 });
  await page.waitForTimeout(1200);
  await caption('ÖNCE: tekrar bas, yine bir anda');
  await page.waitForTimeout(900);
  await motionAt(LINE_A, 1200);
  await page.mouse.move(900, 820, { steps: 6 });
  // After: the motion.
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await caption('SONRA: satıra bas, seçim belirir, sohbet süzülüp yerine oturur');
  await page.waitForTimeout(1300);
  m = await motionAt(LINE_A, 40);
  ok('motion: right after the press the selection is still fading in', m.tint > 0 && m.tint < 1, JSON.stringify(m));
  ok('motion: the shown entries settle in (opacity and transform)', m.anim !== null && /chat-thread-settle/.test(m.kidAnim), JSON.stringify(m));
  await page.waitForTimeout(700);
  m = await rowWith(page, LINE_A).evaluate((el) => ({ tint: Number(getComputedStyle(el, '::before').opacity), anim: document.querySelector('[data-super-slot="centre"] .chat-scroll-inner')?.dataset.threadAnim ?? null }));
  ok('motion: it ends settled and the trigger is gone (a later message does not animate in)', m.tint === 1 && m.anim === null, JSON.stringify(m));
  await page.mouse.move(900, 820, { steps: 6 });
  await page.waitForTimeout(900);
  await caption('SONRA: tekrar bas, aynı yumuşaklıkla geri döner');
  await page.waitForTimeout(1000);
  m = await motionAt(LINE_A, 40);
  ok('motion: the way back fades out the selection and settles the full chat', m.tint > 0 && m.tint < 1 && /chat-thread-settle/.test(m.kidAnim), JSON.stringify(m));
  await page.mouse.move(900, 820, { steps: 6 });
  await page.waitForTimeout(1400);
  await caption('');
  results.motionClip = { from: mFrom, to: Date.now() - videoT0 };
  ok('motion: the inner wrapper is never left transformed', await inner.evaluate((el) => getComputedStyle(el).transform === 'none'));
  await page.emulateMedia({ colorScheme: 'dark' });

  console.log('\n── sizes');
  if (await setSize(page, 'medium')) {
    // Medium shows one group at a time: line A is the Super's, under "On it".
    await agendaCard(page).getByTestId('super-agenda-filter-onit').click();
    await pressRow(page, LINE_A);
    ok('medium: the press filters', (await chip(page).count()) === 1);
    ok('medium: no floating detail on the press', (await page.getByTestId('super-agenda-detail-float').count()) === 0);
    await rowWith(page, LINE_A).hover();
    await page.waitForTimeout(300);
    ok('medium: the hover holds Ask alone (no Done, no Details)', (await rowWith(page, LINE_A).getByTestId('super-agenda-about').isVisible()) && (await rowWith(page, LINE_A).locator('[data-testid="super-agenda-done"], [data-testid="super-agenda-detail-open"]').count()) === 0);
    await chip(page).getByTestId('super-thread-label').click();
    ok('medium: the strip\'s line name opens the detail', await until(page, async () => (await page.getByTestId('super-agenda-detail-float').count()) === 1, 3000));
    await page.waitForTimeout(400); // the detail's fade-in
    await shot(page, 'dark-7-medium.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await chip(page).count()) await chip(page).getByTestId('super-thread-clear').click();
  } else note('medium size not reachable');
  // Wide needs a wider window than 1440 (its menu says so).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(1200);
  if (await setSize(page, 'wide')) {
    await pressRow(page, LINE_A);
    ok('wide: the press filters and opens the inline detail', (await chip(page).count()) === 1 && (await agendaCard(page).getByTestId('super-agenda-detail').count()) === 1);
    await shot(page, 'dark-8-wide.png');
    await pressRow(page, LINE_A);
    ok('wide: a second press clears filter and detail', (await chip(page).count()) === 0 && (await agendaCard(page).getByTestId('super-agenda-detail').count()) === 0);
  } else note('wide size not reachable');

  console.log('\n── phone 390');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  const pchip = page.locator('[data-testid="phone-agenda-chip"]').filter({ visible: true });
  if (await pchip.count()) {
    await pchip.first().click();
    await page.waitForTimeout(800);
    const prow = page.locator('[data-testid="phone-agenda-sheet"] [data-testid="super-agenda-row"]').filter({ hasText: LINE_A }).first();
    await prow.locator('.super-agenda-row-btn').click();
    ok('phone: the sheet closes', await until(page, async () => (await page.getByTestId('phone-agenda-sheet').count()) === 0, 4000));
    ok('phone: the chat is filtered', await until(page, async () => (await page.locator('[data-testid="super-thread-chip"]').filter({ visible: true }).count()) === 1, 4000));
    ok('phone: the keyboard did not open (composer not focused)', await page.evaluate(() => !document.activeElement?.classList.contains('chat-cmp-input')));
    ok('phone: no horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await shot(page, 'phone-390-filtered.png');
  } else {
    note('phone: the phone agenda sheet is drawn only on the Mac phone surface; at 390 px in this harness the desktop shell narrows instead');
    ok('phone 390: no horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await shot(page, 'phone-390.png');
  }
  const video = page.video();
  await context.close();
  if (video) { const vp = join(OUT, 'flow.webm'); await video.saveAs(vp); results.video = vp; }
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
