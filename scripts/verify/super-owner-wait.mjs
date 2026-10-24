#!/usr/bin/env node
/**
 * A Super child waiting on the OWNER is never "done", observed (task a-super-child-waiting-on-
 * the-owner-or-still-running-is-never-shown-done; Tilki field 2026-10-22). The real dashboard
 * server from this checkout's dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), a scripted stand-in
 * `claude` (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-owner-wait.mjs
 *
 * The owner hands one chat over. The Super steers it to start a long exploration script in the
 * background (the CLI's roster lists it, its turn ends saying it goes on): past the 30 s settle
 * window the row is still in Now and its card says working, never done. Then the Super steers it
 * to deploy: the child ends its turn with a `run` card only the owner can run (a sign-in). At once
 * (well inside the settle window): a Waiting on you row "Needs you", the job bar's head with
 * "Open its card", the card's "Needs you" badge, the child NOT in Done, and the Super's next turn
 * is `event=owner` (not done). "Open its card" brings the child beside the centre with the run card
 * in view. The owner presses ▶ Run (a real PTY; the desktop marker is stubbed): the card posts its
 * report, the item clears by itself, the child goes on and only then finishes. Screenshots at
 * 1440x900 and 390x844, zero page errors.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-owner-wait-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-owner-wait');
const LOGS = join(OUT, 'logs');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;
const RUN_CMD = 'echo signed-in-for-verify';
/** The background quiet bar, shortened so a job is SEEN outlasting it (production: 10 min). */
const QUIET_MS = 15_000;

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
const roster = (tasks) => out({ type: 'system', subtype: 'background_tasks_changed', tasks });

async function childTurn(text) {
  if (/^\\[ran in chat\\]/.test(text)) { report({ kind: 'ran', text: text.slice(0, 200) }); await sleep(300); return 'Giriş tamam. Rollout %100, iş bitti.'; }
  if (/EXPLORE/.test(text)) {
    roster([{ task_id: 'bg1', task_type: 'local_bash', description: 'Run live exploration script' }]);
    report({ kind: 'explore' });
    return 'Keşif betiği arka planda sürüyor; çıktısına bakacağım.';
  }
  if (/WAIT:/.test(text)) { report({ kind: 'steered-wait' }); return 'Tamam, sahibini bekliyorum.'; }
  if (/DEPLOY/.test(text)) {
    roster([]);
    await sleep(300);
    report({ kind: 'deploy' });
    return 'PR birleşti. Rollout durumunu okumak için gcloud oturumu gerekiyor; tarayıcıda giriş istediği için senin.'
      + fence({ type: 'run', id: 'gcloud-login', command: ${JSON.stringify(RUN_CMD)}, why: 'tarayıcı açıp Google girişi bekliyor; rollout durumunu okumak için gerekli' });
  }
  return 'Hazırım.' + fence({ type: 'title', text: 'Koçluk 3 canlıya' });
}

const childSid = () => { try { return Object.keys(JSON.parse(readFileSync(RECORD, 'utf-8')).children ?? {})[0]; } catch { return undefined; } };
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    await sleep(500);
    const c = childSid();
    if (c) { cli('super', 'brief', c, 'Koçluk 3 canlıya'); cli('super', 'send', c, 'EXPLORE: keşif betiğini arka planda başlat.'); }
    report({ kind: 'handover', child: c });
    return 'Koçluk 3 işini devraldım; keşif çalışıyor.';
  }
  if (text.startsWith('[super')) {
    const owner = /event=owner/.test(text);
    report({ kind: 'event', owner, done: /event=done/.test(text), text: text.slice(0, 600) });
    return owner ? 'Koçluk 3 seni bekliyor: Google Cloud girişi gerekiyor, kartı ajandada.' : null;
  }
  if (/BEKLE-DE/.test(text)) { const c = childSid(); if (c) cli('super', 'send', c, 'WAIT: sahibi giriş yapana kadar bekle.'); report({ kind: 'steer-wait', child: c }); return 'Tamam.'; }
  if (/DEPLOY-ET/.test(text)) { const c = childSid(); if (c) cli('super', 'send', c, 'DEPLOY: PR birleştir ve rollout durumunu oku.'); report({ kind: 'steer-deploy', child: c }); return 'Tamam.'; }
  report({ kind: 'owner', text });
  return 'Not aldım.';
}
let inited = false;
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  if (said) say(said);
  out({ type: 'result', subtype: 'success', is_error: false, result: said ?? '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
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
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length || running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
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
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, SHELL: '/bin/sh', DREAMCONTEXT_SUPER_BACKGROUND_QUIET_MS: String(QUIET_MS) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };

let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };
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
const rowsOf = (page, sec) => page.locator(`[data-testid="super-agenda-section-${sec}"] [data-testid="super-agenda-row"]`);
const ownerItems = () => (record().queue ?? []).filter((q) => q.kind === 'owner');

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
    // The run card's ▶ is desktop-only (isDesktop: the Tauri marker); its PTY is the server's.
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
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
    await input.fill('Koçluk 3 işlerini canlıya al.');
    await page.keyboard.press('Enter');
    await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'turn-end'), 60000);
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await motionIdle(page);
    ok('the Super took the chat over and steered it to explore', await until(page, async () => reports().some((r) => r.kind === 'explore'), 90000));
    const sid = Object.keys(record().children ?? {})[0];

    // ── 1. A background job still running is working, never done ─────────────────────────
    // Past the quiet bar (shortened to 15 s here) AND a stale sweep (60 s) AND the settle window:
    // the old rule had this row done by now.
    const exploreAt = reports().find((r) => r.kind === 'explore')?.t ?? Date.now();
    await page.waitForTimeout(Math.max(0, exploreAt + QUIET_MS + 60_000 + 15_000 - Date.now()));
    const rec1 = record();
    ok(`${Math.round((Date.now() - exploreAt) / 1000)} s after its turn ended (quiet bar ${QUIET_MS / 1000} s), the script still running: the row is working, no done item`, rec1.children?.[sid]?.row === 'working'
      && !(rec1.queue ?? []).some((q) => q.kind === 'done' && q.sessionId === sid), JSON.stringify({ row: rec1.children?.[sid]?.row, q: rec1.queue?.map((q) => q.kind) }));
    ok('…it sits in Now, not in Done', (await rowsOf(page, 'now').filter({ hasText: 'Koçluk 3' }).count()) === 1
      && (await rowsOf(page, 'done').filter({ hasText: 'Koçluk 3' }).count()) === 0);
    const tile = page.locator('[data-testid="super-container"] .super-tile[data-tile="chat"]').first();
    ok('…and its card says working (its background shell counts), not done', (await tile.getAttribute('data-kind').catch(() => null)) === 'working', String(await tile.getAttribute('data-kind').catch(() => null)));
    ok('the Super heard nothing (no done event for a job still running)', !reports().some((r) => r.kind === 'event' && r.done));
    await page.mouse.move(5, 5);
    await shot(page, '01-background-script-still-working-1440.png');

    // ── 2. A run card only the owner can run: Needs you at once ───────────────────────────
    await sayCentre(page, 'DEPLOY-ET');
    ok('the child deployed and left a run card', await until(page, async () => reports().some((r) => r.kind === 'deploy'), 60000));
    const deployAt = reports().find((r) => r.kind === 'deploy').t;
    ok('an owner item is on the queue at once (well inside the 30 s settle window)', await until(page, async () => ownerItems().some((q) => q.state !== 'done'), 10000)
      && Date.now() - deployAt < 15_000, JSON.stringify(ownerItems()));
    const waitingRow = rowsOf(page, 'waiting').filter({ hasText: 'Koçluk 3' });
    ok('Waiting on you: one row, chip "Needs you"/"Seni bekliyor", the card\'s plain line', await until(page, async () => (await waitingRow.count()) === 1
      && /Google girişi/.test(await waitingRow.innerText()) && (await waitingRow.getAttribute('data-chip')) === 'needsYou', 10000), await waitingRow.innerText().catch(() => ''));
    ok('…the Waiting count is 1', (await page.getByTestId('super-agenda-count-waiting').innerText()) === '1');
    ok('…and the job is in neither Now nor Done', (await rowsOf(page, 'now').filter({ hasText: 'Koçluk 3' }).count()) === 0
      && (await rowsOf(page, 'done').filter({ hasText: 'Koçluk 3' }).count()) === 0);
    const head = page.locator('[data-testid="super-queue-head"][data-kind="owner"]');
    ok('the job bar leads with it and offers "Open its card"', await until(page, async () => (await head.count()) === 1 && (await page.getByTestId('super-queue-open-owner').count()) === 1, 5000));
    ok('the child\'s card wears "Needs you" in place of its state', await until(page, async () => (await page.locator('[data-testid="super-tile-asks"][data-asks="owner"]').count()) === 1, 5000));
    ok('the Super\'s event says event=owner (it waits on him), not done', await until(page, async () => reports().some((r) => r.kind === 'event' && r.owner), 30000)
      && !reports().some((r) => r.kind === 'event' && r.done), JSON.stringify(reports().filter((r) => r.kind === 'event').map((r) => r.text.slice(0, 160))));
    ok('the Super\'s word to him shows in full in the centre, not folded into an event line', await until(page, async () => (await page.locator('[data-super-slot="centre"]').innerText()).includes('Koçluk 3 seni bekliyor'), 15000));
    // The Super steers the child to wait: its words are not his answer, the item stays.
    await sayCentre(page, 'BEKLE-DE');
    ok('the Super\'s steer reached the child', await until(page, async () => reports().some((r) => r.kind === 'steered-wait'), 30000));
    await page.waitForTimeout(35_000);
    const rec2 = record();
    ok('a Super steer and 35 s later (past the settle window): row "waiting", no done item, still on his queue', rec2.children?.[sid]?.row === 'waiting'
      && !(rec2.queue ?? []).some((q) => q.kind === 'done' && q.sessionId === sid) && ownerItems().some((q) => q.state !== 'done'),
    JSON.stringify({ row: rec2.children?.[sid]?.row, q: rec2.queue?.map((q) => `${q.kind}:${q.state}`) }));
    await page.mouse.move(5, 5);
    await shot(page, '02-needs-you-1440.png');

    // ── 3. "Open its card" brings the child beside the centre with the run card in view ───
    await page.getByTestId('super-queue-open-owner').click();
    ok('the child is shown beside the centre with its run card in view', await until(page, async () => page.evaluate(() => {
      const card = [...document.querySelectorAll('[data-super-slot="shown"] .chat-runcard[data-view-id="gcloud-login"]')].pop();
      if (!card) return false;
      const r = card.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    }), 10000));
    await page.waitForTimeout(800);
    await page.mouse.move(5, 5);
    await shot(page, '03-open-its-card-1440.png');

    // Phone width, while it waits.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await shot(page, '04-needs-you-390.png');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('390 px: no horizontal overflow', overflow <= 1, `scrollWidth over by ${overflow}`);
    const btn = await page.getByTestId('super-queue-open-owner').boundingBox().catch(() => null);
    ok('390 px: the bar\'s "Open its card" is whole on screen', !!btn && btn.x >= 0 && btn.x + btn.width <= 390 + 0.5 && btn.width > 20, JSON.stringify(btn));
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(1500);

    // ── 4. He runs it: the item clears by itself and the child goes on ────────────────────
    const play = page.locator('[data-super-slot="shown"] .chat-runcard[data-view-id="gcloud-login"] .chat-runcard-play').last();
    if (!(await play.count())) { await page.getByTestId('super-queue-open-owner').click().catch(() => {}); await page.waitForTimeout(1500); }
    await play.click();
    ok('the run report reached the child', await until(page, async () => reports().some((r) => r.kind === 'ran' && r.text.includes(RUN_CMD)), 30000),
      JSON.stringify(reports().slice(-4)));
    ok('the owner item cleared by itself', await until(page, async () => ownerItems().every((q) => q.state === 'done'), 10000), JSON.stringify(ownerItems()));
    ok('Waiting on you is empty and the bar draws no owner head', await until(page, async () => (await page.getByTestId('super-agenda-count-waiting').innerText()) === '0'
      && (await head.count()) === 0, 10000));
    ok('the "Needs you" badge is gone', await until(page, async () => (await page.locator('[data-testid="super-tile-asks"][data-asks="owner"]').count()) === 0, 10000));
    ok('the child went on and finished: done after its own next turn', await until(page, async () => record().children?.[sid]?.row === 'done', 60000), String(record().children?.[sid]?.row));
    await page.mouse.move(5, 5);
    await shot(page, '05-ran-cleared-1440.png');
    const errs = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED/i.test(e));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    writeFileSync(join(LOGS, 'console-errors.json'), JSON.stringify(errors, null, 2));
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
main().catch((e) => { console.error(e); process.exit(1); });
