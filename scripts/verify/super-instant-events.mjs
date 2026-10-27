#!/usr/bin/env node
/**
 * A child's question and a child's "done" reach the owner and the Super at once, observed (owner
 * 2026-10-27, super-anlik-olay). The real dashboard server from this checkout's dist (scratch
 * HOME, DREAMCONTEXT_DESKTOP=1), a scripted stand-in `claude` (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-instant-events.mjs
 *
 * 1. The owner hands one chat over. The Super's handover turn sends the child a job that asks a
 *    question, then stays busy 8 s. The question's card is on the owner's job bar within ~1 s,
 *    WHILE the Super is still mid-turn, named by its job, with "Open its chat".
 * 2. "Open its chat" brings the child beside the centre with its own question card; the owner
 *    picks there. The child gets that pick, the bar empties, and the Super never hears that
 *    question (he answered first). The child's turn ends while the Super is still busy: its done
 *    reaches the Super the moment that turn ends.
 * 3. The owner asks the Super to start a second job; its question is on his bar at once AND goes
 *    to the (idle) Super, which answers it itself: the child gets the Super's pick once, his card
 *    closes. The child's turn ends: the idle Super hears done within ~2-3 s.
 * Hop times are printed. Screenshots at 1440x900 and 390x844, zero page errors.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-instant-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-instant-events');
const LOGS = join(OUT, 'logs');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;
/** How long the Super's handover turn stays busy after it sent the first job. */
const BUSY_MS = 8_000;

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
const sid = 'cap-' + process.pid;
const RECORD = ${JSON.stringify(RECORD)};
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const fence = (o) => '\\n\\n\`\`\`dream-view\\n' + JSON.stringify(o) + '\\n\`\`\`';
let awaiting = null;
let seq = 0;

async function ask(tag, question) {
  const id = 'toolu_' + (++seq);
  const input = { questions: [{ question: tag + ' ' + question, header: 'DB', options: [{ label: 'postgres', description: 'server' }, { label: 'sqlite', description: 'file' }] }] };
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } });
  report({ kind: 'asked', tag });
  out({ type: 'control_request', request_id: 'req-' + tag + '-' + seq, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: id, requires_user_interaction: true } });
  const response = await new Promise((r) => { awaiting = r; });
  report({ kind: 'answered', tag, response: JSON.stringify(response ?? null).slice(0, 400) });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } });
  return 'Seçimi aldım, kuruyorum. Bitti.';
}

async function childTurn(text) {
  if (/ASK1/.test(text)) return ask('Q1-OWNER', 'Hangi veritabanı?');
  if (/ASK2/.test(text)) return ask('Q2-SUPER', 'Hangi veritabanı?');
  return 'Hazırım.' + fence({ type: 'title', text: 'Veritabanı kurulumu' });
}

const childSid = () => { try { return Object.keys(JSON.parse(readFileSync(RECORD, 'utf-8')).children ?? {})[0]; } catch { return undefined; } };
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const c = childSid();
    if (c) { cli('super', 'brief', c, 'Veritabanı kurulumu'); cli('super', 'send', c, 'ASK1: veritabanını sor.'); }
    report({ kind: 'handover-busy', child: c });
    await sleep(${BUSY_MS});
    return 'Veritabanı işini devraldım.';
  }
  if (text.startsWith('[super')) {
    const q = /event=question/.test(text);
    const done = /event=done/.test(text);
    report({ kind: 'event', question: q, done, shownOwner: /shown=owner/.test(text), text: text.slice(0, 900) });
    if (q && /Q2-SUPER/.test(text)) {
      const qid = (/question=(\\S+)/.exec(text) || [])[1];
      const child = (/child=(\\S+) event=question/.exec(text) || [])[1];
      const r = cli('super', 'answer', child, qid, 'sqlite');
      report({ kind: 'super-answered', status: r.status, out: r.out.slice(0, 300) });
    }
    return null;
  }
  if (/Q2-BASLAT/.test(text)) { const c = childSid(); if (c) cli('super', 'send', c, 'ASK2: veritabanını yine sor.'); report({ kind: 'steer-ask2' }); return 'Tamam.'; }
  report({ kind: 'owner', text });
  return 'Not aldım.';
}

let inited = false;
let busy = false;
const inbox = [];
async function turn(blocks) {
  busy = true;
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  if (said) say(said);
  out({ type: 'result', subtype: 'success', is_error: false, result: said ?? '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said, first: (blocks[0] ?? '').slice(0, 40) });
  busy = false;
  pump();
}
let pumping = false;
async function pump() {
  if (pumping || busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  pumping = true;
  try { await turn(next); } finally { pumping = false; }
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
    inbox.push(blocks);
    pump();
  }
});
process.stdin.on('end', () => process.exit(0));
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
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, SHELL: '/bin/sh' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {}, queue: [] }; } };
const log = (...a) => console.log(...a);
const until = async (page, fn, ms = 20000, step = 100) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(step); } return false; };
const find = (pred) => reports().find(pred);
const secs = (ms) => `${(ms / 1000).toFixed(2)} s`;

let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };
const hops = [];
const hop = (name, ms) => { hops.push({ name, ms }); log(`  ⏱ ${name}: ${secs(ms)}`); };
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
async function sayCentre(page, text) {
  const input = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
const motionIdle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
const openChat = (page) => page.locator('[data-testid="super-queue-open-chat"]');
const questions = () => (record().queue ?? []).filter((q) => q.kind === 'question');

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'tr-TR' });
  await context.addInitScript(() => {
    try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'light'); } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
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
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill('Veritabanını kur.');
    await page.keyboard.press('Enter');
    await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'turn-end'), 60000);
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await motionIdle(page);

    // ── 1. The child asks while the Super is mid-turn: the owner has it at once ───────────
    ok('the Super took the chat over and sent the job that asks', await until(page, async () => !!find((r) => r.kind === 'asked' && r.tag === 'Q1-OWNER'), 60000));
    const asked1 = find((r) => r.kind === 'asked' && r.tag === 'Q1-OWNER').t;
    ok('the question\'s card is on the owner\'s job bar, "Open its chat"', await until(page, async () => (await openChat(page).count()) === 1, 10000, 50));
    const cardAt = Date.now();
    hop('child asks → card on owner\'s bar (Super mid-turn)', cardAt - asked1);
    ok('…within 2 s of the ask', cardAt - asked1 <= 2000, secs(cardAt - asked1));
    ok('…while the Super is still busy in its own turn (it had no turn to relay it)', !find((r) => r.role === 'super' && r.kind === 'turn-end' && r.first.startsWith('[super handover]')));
    const headText = await page.getByTestId('super-queue-head').innerText().catch(() => '');
    ok('the bar names the job and shows the child\'s own words', /Veritabanı kurulumu/.test(headText) && /Q1-OWNER/.test(headText), headText.replace(/\s+/g, ' '));
    const item1 = questions().find((q) => (q.ownerText ?? '').includes('Q1-OWNER'));
    ok('the record item is direct, not yet delivered to the Super', item1?.direct === true && item1?.state === 'pending', JSON.stringify(item1));
    const agendaRow = page.locator('[data-testid="super-agenda-section-waiting"] [data-testid="super-agenda-row"]').filter({ hasText: 'Veritabanı' });
    ok('Waiting on you lists it', await until(page, async () => (await agendaRow.count()) === 1, 5000));
    await page.mouse.move(5, 5);
    await shot(page, '01-child-question-on-bar-1440.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    await shot(page, '02-child-question-on-bar-390.png');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow', overflow <= 1, `over by ${overflow}`);
    const btn = await openChat(page).boundingBox().catch(() => null);
    ok('390 px: "Open its chat" is whole on screen', !!btn && btn.x >= 0 && btn.x + btn.width <= 390.5 && btn.width > 20, JSON.stringify(btn));
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(1200);

    // ── 2. One click opens the child; he answers in its own card ──────────────────────────
    await openChat(page).click();
    const card = page.locator('[data-super-slot="shown"] .chat-surveycard').last();
    ok('"Open its chat" brings the child beside the centre with its own question card', await until(page, async () => (await card.count()) === 1 && (await card.isVisible()), 10000));
    await motionIdle(page);
    await page.waitForTimeout(800);
    await page.mouse.move(5, 5);
    await shot(page, '03-open-its-chat-1440.png');
    await card.locator('.chat-surveycard-opt').filter({ hasText: 'postgres' }).first().click();
    await card.locator('.chat-btn.primary').first().click();
    ok('the child got HIS pick (postgres)', await until(page, async () => /postgres/.test(find((r) => r.kind === 'answered' && r.tag === 'Q1-OWNER')?.response ?? ''), 15000),
      JSON.stringify(find((r) => r.kind === 'answered')));
    ok('the item closed and the bar is empty', await until(page, async () => questions().every((q) => q.state === 'done') && (await openChat(page).count()) === 0, 10000),
      JSON.stringify(questions()));
    const childEnd1 = await until(page, async () => !!find((r) => r.role === 'child' && r.kind === 'turn-end' && /ASK1/.test(r.first)), 15000);
    ok('the child finished its turn while the Super is still mid-turn', childEnd1 && !find((r) => r.role === 'super' && r.kind === 'turn-end' && r.first.startsWith('[super handover]')));
    ok('the Super\'s busy turn ends', await until(page, async () => !!find((r) => r.role === 'super' && r.kind === 'turn-end' && r.first.startsWith('[super handover]')), 20000));
    const superEnd = find((r) => r.role === 'super' && r.kind === 'turn-end' && r.first.startsWith('[super handover]')).t;
    ok('the done reaches it right after that turn ends', await until(page, async () => !!find((r) => r.kind === 'event' && r.done), 10000, 50));
    const ev1 = find((r) => r.kind === 'event' && r.done);
    hop('Super turn ends → child\'s done delivered (Super was busy)', ev1.t - superEnd);
    ok('…within 1.5 s of its turn end', ev1.t - superEnd <= 1500, secs(ev1.t - superEnd));
    ok('the Super never heard the question he answered first', !reports().some((r) => r.kind === 'event' && /Q1-OWNER/.test(r.text)));

    // ── 3. A second question: on his bar AND to the idle Super, which answers it first ────
    await page.waitForTimeout(1500);
    await sayCentre(page, 'Q2-BASLAT');
    ok('the child asks the second question', await until(page, async () => !!find((r) => r.kind === 'asked' && r.tag === 'Q2-SUPER'), 30000));
    const asked2 = find((r) => r.kind === 'asked' && r.tag === 'Q2-SUPER').t;
    const sawCard2 = await until(page, async () => (await openChat(page).count()) === 1 || !!find((r) => r.kind === 'super-answered'), 10000, 50);
    const card2At = Date.now();
    ok('it is on his bar (or already answered by the Super)', sawCard2);
    hop('child asks → card on bar (Super idle)', card2At - asked2);
    ok('the idle Super heard it, marked shown=owner', await until(page, async () => reports().some((r) => r.kind === 'event' && r.question && /Q2-SUPER/.test(r.text) && r.shownOwner), 15000));
    const ev2 = reports().find((r) => r.kind === 'event' && r.question && /Q2-SUPER/.test(r.text));
    hop('child asks → question delivered to the idle Super', ev2.t - asked2);
    ok('the Super answered it (accepted)', await until(page, async () => find((r) => r.kind === 'super-answered')?.status === 0, 15000), JSON.stringify(find((r) => r.kind === 'super-answered')));
    ok('the child got the Super\'s pick (sqlite), exactly once', await until(page, async () => /sqlite/.test(find((r) => r.kind === 'answered' && r.tag === 'Q2-SUPER')?.response ?? ''), 15000)
      && reports().filter((r) => r.kind === 'answered' && r.tag === 'Q2-SUPER').length === 1);
    ok('his card closed: the bar is empty, the item done', await until(page, async () => (await openChat(page).count()) === 0 && questions().every((q) => q.state === 'done'), 10000), JSON.stringify(questions()));
    ok('the child finished', await until(page, async () => !!find((r) => r.role === 'child' && r.kind === 'turn-end' && /ASK2/.test(r.first)), 15000));
    const childEnd2 = find((r) => r.role === 'child' && r.kind === 'turn-end' && /ASK2/.test(r.first)).t;
    ok('its done reaches the idle Super', await until(page, async () => reports().filter((r) => r.kind === 'event' && r.done).length >= 2, 15000, 50));
    const ev3 = reports().filter((r) => r.kind === 'event' && r.done)[1];
    hop('child turn ends → done delivered (Super idle)', ev3.t - childEnd2);
    ok('…within 3 s (2 s settle)', ev3.t - childEnd2 <= 3000, secs(ev3.t - childEnd2));
    await page.mouse.move(5, 5);
    await shot(page, '04-after-both-1440.png');

    const errs = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED/i.test(e));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    writeFileSync(join(LOGS, 'console-errors.json'), JSON.stringify(errors, null, 2));
    writeFileSync(join(LOGS, 'hops.json'), JSON.stringify(hops, null, 2));
  } catch (e) {
    ok('the run completed', false, String(e).slice(0, 1200));
  } finally {
    try { writeFileSync(join(LOGS, 'reports.ndjson'), readFileSync(REPORTS, 'utf-8')); } catch {}
    try { writeFileSync(join(LOGS, 'record.json'), readFileSync(RECORD, 'utf-8')); } catch {}
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
    await new Promise((r) => setTimeout(r, 800));
    if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
