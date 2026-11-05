#!/usr/bin/env node
/**
 * Nothing goes unsaid, observed (task super-hicbir-konuyu-kacirmaz, wave 2). The real dashboard
 * server from this checkout's dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), a scripted stand-in
 * `claude` (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-owed.mjs
 *
 * 1. Tilki's shape: the Super answers his message without its mark. Its turn ends with the debt
 *    open: ONE `[super owed]` turn follows, drawn as an event line (never his bubble); the scripted
 *    Super answers under the ref there, the debt closes by the mark, no third turn comes.
 * 2. A Super that never answers (SESSIZ): two `[super owed]` turns, then the debt is his to see:
 *    a "Cevaplanmadı" row on the agenda, above Waiting on you, with "Gerek yok". 1440x900 and
 *    390x844 screenshots. "Gerek yok" closes it (by: owner) and the row goes.
 * 3. He presses Stop mid-turn (UZUN): no `[super owed]` turn; the debt is parked; ten minutes
 *    later (the page's clock moved on, the page left open) the parked row shows by itself.
 * Zero page errors. Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-owed-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-owed');
const LOGS = join(OUT, 'logs');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;

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
let stopped = false;
const childSid = () => { try { return Object.keys(JSON.parse(readFileSync(RECORD, 'utf-8')).children ?? {})[0]; } catch { return undefined; } };

async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const c = childSid();
    if (c) cli('super', 'brief', c, 'Sürüm notları');
    return 'Devraldım.';
  }
  if (text.startsWith('[super owed]')) {
    const lines = text.split('\\n');
    const debts = [];
    lines.forEach((l, i) => {
      const m = /^- owed=(\\S+) kind=(\\S+) ref=([0-9a-z]{6})/.exec(l);
      if (m) debts.push({ id: m[1], ref: m[3], silent: /SESSIZ/.test(lines[i + 1] ?? '') });
    });
    report({ kind: 'owed-turn', debts });
    const parts = debts.filter((d) => !d.silent).map((d) => '<!-- re:' + d.ref + ' -->\\nOn this: it is done.');
    return parts.length ? parts.join('\\n\\n') : 'Bakıyorum.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 400) }); return null; }
  const ref = (/<owner-msg ref="([0-9a-z]{6})"/.exec(text) || [])[1];
  report({ kind: 'owner', ref, text: text.slice(0, 200) });
  // A model takes seconds to answer; the stand-in too (the record's debt write lands first).
  await sleep(1500);
  if (/UZUN/.test(text)) {
    stopped = false;
    for (let i = 0; i < 300 && !stopped; i++) await sleep(100);
    report({ kind: 'long-ended', stopped });
    return stopped ? '__aborted__' : 'Bitti.';
  }
  // Tilki's shape: a reply with no mark (it answered the card, not his message).
  return 'Not aldım.';
}

let inited = false;
let busy = false;
const inbox = [];
async function turn(blocks) {
  busy = true;
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks.join('\\n')) : 'Hazırım.'; } catch (e) { said = 'error ' + e; }
  if (said === '__aborted__') {
    out({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming', result: '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  } else {
    if (said) say(said);
    out({ type: 'result', subtype: 'success', is_error: false, result: said ?? '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
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
    if (o.type === 'control_request') {
      if (o.request && o.request.subtype === 'interrupt') { stopped = true; report({ kind: 'interrupt' }); }
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
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
  // The drawer shell (0.40+): the project's Super row opens its stage.
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['orbit'], projectOrder: ['orbit'], lastVault: 'orbit' }));
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
  const input = page.locator('.super-centre textarea').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

const motionIdle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);
const owed = () => record().owed ?? [];
const openOwed = () => owed().filter((d) => !d.closed);
const agenda = (page) => page.locator('[data-testid="super-container"][data-kind="agenda"] [data-testid="super-agenda"][data-variant="full"]');
const unanswered = (page) => agenda(page).locator('[data-testid="super-agenda-section-unanswered"]');
const owedTurns = () => reports().filter((r) => r.kind === 'owed-turn');
const superIdle = () => { const r = reports().filter((x) => x.role === 'super' && x.kind === 'turn-end'); return r.length; };

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
  await markAnnouncementsSeen(context, base);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${base}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="ns-rail-chat"]').first().click({ timeout: 30_000 });
    await page.locator('[data-testid="drawer-super-row"]').first().click({ timeout: 20_000 });
    ok('the Super stage came up', await until(page, async () => page.getByTestId('super-centre').isVisible(), 30000));
    await until(page, async () => !!record().session, 20000);
    await clean(page);
    await page.waitForTimeout(2000);

    // ── 1. Answered without its mark: one [super owed] turn, answered there ─────────────
    await sayCentre(page, 'Sürüm notu yayında mı?');
    ok('his message is a debt in the record', await until(page, async () => openOwed().some((d) => d.kind === 'msg' && /Sürüm notu/.test(d.gist)), 15000), JSON.stringify(owed()));
    ok('its turn ended without a section, so ONE [super owed] turn follows', await until(page, async () => owedTurns().length === 1, 30000), JSON.stringify(owedTurns()));
    ok('the owed turn named that debt by its ref', owedTurns()[0]?.debts?.length === 1);
    ok('its section closed it, by the mark', await until(page, async () => owed().some((d) => /Sürüm notu/.test(d.gist) && d.closed?.by === 'mark'), 15000), JSON.stringify(owed()));
    await page.waitForTimeout(2500);
    ok('no third turn: nothing is still owed', owedTurns().length === 1 && openOwed().length === 0, JSON.stringify(owedTurns()));
    const eventLines = page.locator('.super-centre [data-testid="super-event-line"]');
    ok('the owed turn is drawn as an event line, never his bubble', await until(page, async () => (await eventLines.count()) >= 1, 10000)
      && !(await page.locator('.super-centre').innerText()).includes('[super owed]'));

    // ── 2. Never answered: twice, then his to see; "Gerek yok" clears it ───────────────
    await sayCentre(page, 'Logo hazır mı? SESSIZ');
    ok('two [super owed] turns name it, no more', await until(page, async () => owedTurns().filter((t) => t.debts.some((d) => d.silent)).length === 2, 45000), JSON.stringify(owedTurns()));
    await page.waitForTimeout(3000);
    ok('…and no third', owedTurns().filter((t) => t.debts.some((d) => d.silent)).length === 2);
    const silent = () => owed().find((d) => /Logo hazır/.test(d.gist));
    ok('the debt is open with two nudges', silent()?.nudges === 2 && !silent()?.closed, JSON.stringify(silent()));
    const card = page.locator('[data-testid="super-container"][data-kind="agenda"]');
    ok('a small agenda counts it as waiting on him (never "0 waiting")', await until(page, async () => (await card.locator('[data-testid="super-agenda-tile-waiting"]').count()) === 0
      || /^\s*1/.test(await card.locator('[data-testid="super-agenda-tile-waiting"]').innerText()), 15000));
    // The notepad itself: the card at its large size (the owner's own size menu).
    if ((await agenda(page).count()) === 0) {
      await card.hover();
      await card.locator('[data-testid="super-card-size-btn"], [data-testid="super-card-more"]').first().click();
      await page.getByTestId('super-size-large').click();
      await motionIdle(page);
      await page.waitForTimeout(800);
    }
    ok('the agenda shows "Cevaplanmadı" above Waiting on you', await until(page, async () => (await unanswered(page).count()) === 1, 15000));
    const sections = await agenda(page).locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
    ok('…first among the sections', sections[0] === 'unanswered', JSON.stringify(sections));
    const row = unanswered(page).locator('[data-testid="super-agenda-row"]').first();
    ok('its row says his words and carries "Gerek yok" and "write about this"', /Logo hazır/.test(await row.innerText()) && (await row.locator('[data-testid="super-agenda-owed-drop"]').count()) === 1 && (await row.locator('[data-testid="super-agenda-about"]').count()) === 1, await row.innerText().catch(() => ''));
    await page.mouse.move(5, 5);
    await shot(page, '01-unanswered-1440.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await shot(page, '02-unanswered-390.png');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow', overflow <= 1, `over by ${overflow}`);
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(1500);
    await unanswered(page).locator('[data-testid="super-agenda-owed-drop"]').first().click();
    ok('"Gerek yok" closes it (by: owner) and the row goes', await until(page, async () => silent()?.closed?.by === 'owner' && (await unanswered(page).count()) === 0, 10000), JSON.stringify(silent()));

    // ── 3. Stop mid-turn: nothing decided; ten minutes later the parked row shows ──────
    const before = owedTurns().length;
    // The page's clock from here on is one the run can move (it still flows): the agenda arms its
    // one timer for the parked line after this, so moving the clock ten minutes fires it.
    await page.clock.install();
    await sayCentre(page, 'Uzun bir iş yap UZUN');
    ok('the long turn started', await until(page, async () => reports().some((r) => r.kind === 'owner' && /UZUN/.test(r.text)), 15000));
    await page.waitForTimeout(800);
    await page.locator('.super-centre .chat-cmp-send.is-stop').first().click();
    ok('he pressed Stop and the turn ended stopped', await until(page, async () => reports().some((r) => r.kind === 'long-ended' && r.stopped), 15000));
    await page.waitForTimeout(4000);
    const long = () => owed().find((d) => /Uzun bir iş/.test(d.gist));
    ok('no [super owed] turn after a Stop', owedTurns().length === before, JSON.stringify(owedTurns().slice(before)));
    ok('the debt is parked by his Stop', long()?.parked === 'stop' && !long()?.closed, JSON.stringify(long()));
    ok('not on his agenda yet', (await unanswered(page).count()) === 0);
    await page.clock.fastForward('10:30');
    ok('ten minutes on, the page left open: the parked row shows by itself', await until(page, async () => (await unanswered(page).count()) === 1 && /Uzun bir iş/.test(await unanswered(page).innerText()), 10000));
    await page.mouse.move(5, 5);
    await shot(page, '03-parked-1440.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    await shot(page, '04-parked-390.png');
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow (parked)', overflow2 <= 1, `over by ${overflow2}`);

    const errs = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED/i.test(e));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    writeFileSync(join(LOGS, 'console-errors.json'), JSON.stringify(errors, null, 2));
    void superIdle;
  } catch (e) {
    ok('the run completed', false, String(e).slice(0, 1200));
    await page.screenshot({ path: join(OUT, 'zz-failure.png') }).catch(() => {});
    writeFileSync(join(LOGS, 'console-errors.json'), JSON.stringify(errors, null, 2));
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
