#!/usr/bin/env node
/**
 * "Unclear? Ask again" and "Already answered" leave no orphan debt (super/unclear-borc, 2026-11-15).
 * Real dashboard server from dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), a stand-in `claude`, fictional
 * project "orbit". The Super asks a card; Unclear re-asks; Already answered closes it. No debt, no
 * [super owed] turn, the agenda waiting count stays 1 then 0, never a "…" row.
 *
 *   npm run build && node scripts/verify/super-unclear-borc.mjs
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
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-unclear-borc-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-unclear-borc');
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
  // His card buttons: "Unclear? Ask again" re-asks with a new card; "Already answered" acts.
  // Neither text carries a section mark: a debt for them could only stay open.
  const note = /^\\[super answer\\] item=\\S+ (unclear|already)/.exec(text);
  if (note) {
    report({ kind: 'card-note', note: note[1], text: text.slice(0, 200) });
    if (note[1] === 'unclear') {
      const r = cli('super', 'ask', 'Logonun rengi mor mu olsun, yeşil mi?', '--options', 'Mor|Yeşil');
      report({ kind: 'reasked', status: r.status, out: r.out.slice(0, 300) });
      return 'Soruyu daha açık sordum.';
    }
    return 'Tamam, cevabını buldum.';
  }
  if (/SOR/.test(text) && !text.startsWith('[super')) {
    const ref = (/<owner-msg ref="([0-9a-z]{6})"/.exec(text) || [])[1];
    const r = cli('super', 'ask', 'Logo rengi?', '--options', 'Mor|Yeşil');
    report({ kind: 'asked', ref, status: r.status, out: r.out.slice(0, 300) });
    return (ref ? '<!-- re:' + ref + ' -->\\n' : '') + 'Bir sorum var, kartta.';
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

    // ── 1. A Super card; "Unclear? Ask again" re-asks; no debt, the count stays 1 ────────
    const centre = page.locator('[data-super-slot="centre"]');
    const cardOf = (q) => centre.locator('[data-testid="super-question-card"][data-item]').filter({ hasText: q });
    const tile = page.locator('[data-testid="super-container"][data-kind="agenda"] [data-testid="super-agenda-tile-waiting"]');
    // What waits on him, whichever way the agenda is drawn: its counts tile, or its list's
    // "Cevaplanmadı" + "Waiting on you" section counts (an orphan "…" debt lands in the first).
    const agendaCard = page.locator('[data-testid="super-container"][data-kind="agenda"]');
    const waitingN = async () => {
      if (await tile.count()) { const m = /(\d+)/.exec(await tile.innerText().catch(() => '')); return m ? Number(m[1]) : 0; }
      let n = 0;
      for (const g of ['waiting', 'unanswered']) {
        const c = agendaCard.locator(`[data-testid="super-agenda-count-${g}"]`).first();
        if (await c.count()) n += Number((await c.innerText().catch(() => '0')).trim()) || 0;
      }
      return n;
    };
    await sayCentre(page, 'Logoyu SOR bana');
    ok('the Super asked a card', await until(page, async () => reports().some((r) => r.kind === 'asked' && r.status === 0), 30000), JSON.stringify(reports().slice(-3)));
    const first = cardOf('Logo rengi?');
    ok('its card is open in the super chat', await until(page, async () => (await first.count()) === 1 && (await first.getAttribute('data-state')) === 'open', 20000));
    await page.waitForTimeout(2500);
    ok('his "SOR" message is answered under its mark: nothing owed', openOwed().length === 0, JSON.stringify(owed()));
    ok('the agenda counts 1 waiting on him (the card)', await until(page, async () => (await waitingN()) === 1, 15000), String(await waitingN()));
    await page.mouse.move(5, 5);
    await shot(page, '01-card-open-1440.png');
    await first.locator('.chat-surveycard-more-btn').first().click();
    await first.locator('[role="menuitem"]').nth(0).click();
    ok('"Unclear? Ask again" sends the unclear note to the Super', await until(page, async () => reports().some((r) => r.kind === 'card-note' && r.note === 'unclear'), 20000));
    ok('…which re-asks with a new card', await until(page, async () => reports().some((r) => r.kind === 'reasked' && r.status === 0), 20000), JSON.stringify(reports().slice(-3)));
    const second = cardOf('Logonun rengi mor mu');
    ok('the new card is open', await until(page, async () => (await second.count()) === 1, 20000));
    // Long enough for two [super owed] nudges, which would put a "…" row on the agenda.
    await page.waitForTimeout(8000);
    ok('no debt opened for the unclear tap', openOwed().length === 0 && !owed().some((d) => d.gist === '…'), JSON.stringify(owed()));
    ok('no [super owed] turn followed', owedTurns().length === 0, JSON.stringify(owedTurns()));
    ok('the agenda still counts 1 waiting (the new card), never 2', (await waitingN()) === 1, String(await waitingN()));
    ok('no "…" row anywhere on the agenda', !/(^|\n)\s*…\s*($|\n)/.test(await page.locator('[data-testid="super-container"][data-kind="agenda"]').innerText().catch(() => '')));
    await page.mouse.move(5, 5);
    await shot(page, '02-after-reask-1440.png');

    // ── 2. "Already answered" on the new card: no debt, the count goes to 0 ──────────────
    await second.locator('.chat-surveycard-more-btn').first().click();
    await second.locator('[role="menuitem"]').nth(1).click();
    ok('"Already answered" reaches the Super', await until(page, async () => reports().some((r) => r.kind === 'card-note' && r.note === 'already'), 20000));
    await page.waitForTimeout(8000);
    ok('no debt opened for the already tap', openOwed().length === 0, JSON.stringify(owed()));
    ok('no [super owed] turn followed', owedTurns().length === 0, JSON.stringify(owedTurns()));
    ok('nothing waits on him any more', await until(page, async () => (await waitingN()) === 0, 15000), String(await waitingN()));
    await page.mouse.move(5, 5);
    await shot(page, '03-after-already-1440.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await shot(page, '04-after-already-390.png');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow', overflow <= 1, `over by ${overflow}`);

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
