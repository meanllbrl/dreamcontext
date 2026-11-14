#!/usr/bin/env node
/**
 * The agenda card follows every pad change the Super makes from the CLI (owner 2026-11-14:
 * "Ben hala görüyorum agenda'da", the card kept lines `super note drop` had removed).
 *
 *   npm run build && node scripts/verify/super-ajanda-bayat.mjs      (ENGINES=chromium)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard and the
 * real CLI run from INSIDE the super's process; `claude` is a scripted stand-in (no tokens) that
 * acts out `/clear` the way the CLI does (a NEW session id on `system/init`).
 *
 *   A1  hand over; the super writes three Waiting lines: the card shows three.
 *   A2  the super drops one (`super note drop`): the card shows two at once.
 *   A3  New session (`/clear` rotation in the same pane), then the fresh session drops another
 *       and adds one: the card follows.
 *   A4  a reload after the rotation starts a SECOND Super process of the same pin while the
 *       first lingers (the owner's case); the super then clears its Waiting lines: the card
 *       follows. Before the fix the push went to the first, dead channel and the card froze.
 * Before/after screenshots of the agenda card; zero page errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-ajanda-bayat-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-ajanda-bayat');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SKIP_FLAG = join(SCRATCH, 'skip-handoff');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const HANDOFF_FILE = join(PROJ, '_dream_context', 'state', '.super', 'handoff.md');
const HANDOFF_DIR = join(PROJ, '_dream_context', 'state', '.handoff-requests');
const ENGINES = (process.env.ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let convo = at('--resume') || at('--session-id') || '';
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), ...o }) + '\\n');
report({ kind: 'spawn', tab: process.env.DREAMCONTEXT_TAB_SESSION || '' });
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
let session = 'v-' + process.pid;
let inited = false;
let rotations = 0;
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = ['PostHog girişi bekliyor', 'Codex ve Gemini dene', 'Telegram Yeni oturum dene'].map((t) => cli('super', 'note', 'add', 'waiting', t));
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  const m = /NOTE ([^\\n<]+)/.exec(text);
  if (m) {
    const steps = m[1].split(' ; ').map((c) => cli('super', 'note', ...c.split(' ')));
    report({ kind: 'note', cmd: m[1], steps: steps.map((s) => ({ st: s.status, o: s.out.slice(0, 200) })) });
    return 'agenda updated';
  }
  if (text.startsWith('[super fresh]')) {
    if (existsSync(${JSON.stringify(SKIP_FLAG)})) { report({ kind: 'fresh-skipped', text: text.slice(0, 600) }); return 'not writing one this time'; }
    const r = cli('super', 'handoff',
      '--done', 'Two children delegated (Child one, Child two) and one job pooled; nothing merged yet.',
      '--next', 'Child one and Child two keep running their briefs; start the pooled changelog job when one ends.',
      '--decisions', 'none', '--learned', 'none', '--style', 'Owner: Turkish, short, result first.', '--files', 'none');
    report({ kind: 'fresh-handoff', status: r.status, out: r.out.slice(0, 600), text: text.slice(0, 600) });
    return 'handoff written';
  }
  if (text.startsWith('Handoff:')) { report({ kind: 'continue', text }); return 'back on a fresh session'; }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 300) }); return 'noted'; }
  return 'ok';
}
function clear() {
  // What the CLI does with /clear: a new conversation, SessionStart(source=clear) in the pane's env.
  rotations += 1;
  const from = session;
  session = 'v-' + process.pid + '-r' + rotations;
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  const hook = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, 'hook', 'session-start'], {
    env: process.env, encoding: 'utf-8', timeout: 60000, cwd: process.cwd(),
    input: JSON.stringify({ source: 'clear', session_id: session, hook_event_name: 'SessionStart', cwd: process.cwd() }),
  });
  report({ kind: 'clear', from, to: session, hookStatus: hook.status, banner: (hook.stdout || '').split('\\n').filter((l) => l.startsWith('>> HANDOFF') || l.includes('.super/handoff.md')).slice(0, 4) });
}
async function turn(blocks) {
  const text = blocks[0] ?? '';
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  if (text === '/clear') {
    clear();
    out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
    return;
  }
  let said = 'ok';
  try { said = role === 'super' ? superTurn(text) : 'ok'; } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }], usage: { input_tokens: 10, cache_read_input_tokens: 40000, output_tokens: 5 } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
}
let buf = '';
let chain = Promise.resolve();
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
    if (!blocks.length) continue;
    chain = chain.then(() => turn(blocks));
  }
});
// LINGER (the owner's case, 2026-11-14): the Super process the server stops talking to stays
// alive (a real one did for 50 minutes, idle, its stdin still open), so its channel stays too.
process.stdin.on('end', () => chain.then(() => { if (role === 'super' && existsSync(${JSON.stringify(join(SCRATCH, 'linger'))})) { report({ kind: 'linger' }); setInterval(() => {}, 1 << 30); return; } process.exit(0); }));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
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
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {}, queue: [], pool: [] }; } };
const handoffRecord = (pane) => { try { return JSON.parse(readFileSync(join(HANDOFF_DIR, `${pane}.json`), 'utf-8')); } catch { return null; } };
const taskFiles = () => readdirSync(join(PROJ, '_dream_context', 'state')).filter((f) => f.endsWith('.md'));
const cardId = (sid) => `chat-${createHash('sha1').update(sid).digest('hex').slice(0, 12)}`;
const card = (page, sid) => page.locator(`[data-container-id="${cardId(sid)}"]`);

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
}
// New session is a row of the head's ⋯ menu (owner 2026-11-05); the busy state sits on the ⋯'s wrapper.
const moreWrap = (page) => page.locator('[data-testid="super-centre"] .super-head-more');
const busyOf = (page) => moreWrap(page).getAttribute('data-busy');
const pressable = async (page) => (await moreWrap(page).count()) === 1 && (await busyOf(page)) === null;
const pressFresh = async (page) => {
  if (!(await page.getByTestId('super-head-menu').count())) await page.locator('[data-testid="super-centre"] [data-testid="super-head-more"]').click();
  await page.getByTestId('super-head-fresh').click();
};
const stage = (r) => JSON.stringify({ children: Object.keys(r.children ?? {}).sort(), pool: (r.pool ?? []).map((p) => p.id).sort(), cards: (r.containers ?? []).map((c) => c.id).sort() });

async function shots(page, engineName, name) {
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `${engineName}-${name}-${w}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}

const agendaCard = (page) => page.locator('[data-testid="super-container"][data-kind="agenda"]');
const waitingRows = (page) => agendaCard(page).locator('[data-testid="super-agenda-section-waiting"] [data-testid="super-agenda-row"]');
const padWaiting = () => (record().pad ?? []).filter((p) => p.section === 'waiting').map((p) => p.text);
const cardWaiting = async (page) => (await waitingRows(page).allInnerTexts()).map((t) => t.split('\n')[0].trim());
const sameAsPad = async (page) => {
  const want = padWaiting(); const have = await cardWaiting(page);
  return want.length === have.length && want.every((t) => have.some((h) => h.startsWith(t)));
};
async function cardShot(page, engineName, name) {
  const el = agendaCard(page).first();
  if (await el.count()) await el.screenshot({ path: join(OUT, `${engineName}-${name}.png`) }).catch(() => {});
  await page.screenshot({ path: join(OUT, `${engineName}-${name}-stage.png`) });
}
const sayCentre = async (page, text) => {
  const input = page.locator('[data-super-slot="centre"] .chat-cmp-input, [data-testid="super-centre"] .chat-cmp-input').first();
  await input.click(); await input.fill(text); await page.keyboard.press('Enter');
};
const noteTurn = async (page, cmd) => {
  const n = reports().filter((r) => r.kind === 'note').length;
  await sayCentre(page, `NOTE ${cmd}`);
  return until(page, async () => reports().filter((r) => r.kind === 'note').length > n, 30000);
};
const idOf = (re) => (record().pad ?? []).find((p) => re.test(p.text))?.id;

async function run(engineName, base) {
  const { chromium, webkit } = await import('playwright');
  const browserType = engineName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const tag = (s) => `[${engineName}] ${s}`;
  const follows = async (label, ms = 8000) => ok(tag(label), await until(page, () => sameAsPad(page), ms), `pad=${JSON.stringify(padWaiting())} card=${JSON.stringify(await cardWaiting(page))}`);

  console.log(`\n── ${engineName}: hand over, three Waiting lines`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'spawn'), 20000);
  await page.waitForTimeout(1500);
  // The new shell turns the Super on from its drawer row; the classic hand-over button otherwise.
  await until(page, async () => (await page.getByTestId('drawer-super-row').first().isVisible().catch(() => false)) || (await page.locator('[data-testid="super-handover-btn"]:visible').count()) > 0, 20000);
  if (await page.getByTestId('drawer-super-row').first().isVisible().catch(() => false)) await page.getByTestId('drawer-super-row').first().click();
  else await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('A1 the handover wrote three Waiting lines'), await until(page, async () => padWaiting().length === 3, 90000), JSON.stringify(reports().find((r) => r.kind === 'handover')));
  await until(page, async () => (await agendaCard(page).count()) > 0, 20000);
  await follows('A1 the card shows the three lines');

  console.log(`── ${engineName}: the super drops a line`);
  ok(tag('A2 note drop ran'), await noteTurn(page, `drop ${idOf(/PostHog/)}`));
  await follows('A2 the card dropped it at once');

  console.log(`── ${engineName}: New session, then the fresh session edits the agenda`);
  await until(page, async () => await pressable(page), 15000);
  await pressFresh(page);
  ok(tag('A3 the pane rotated (/clear, continue prompt)'), await until(page, async () => reports().some((r) => r.kind === 'continue'), 60000));
  await until(page, async () => (await pressable(page)) && (await busyOf(page)) === null, 30000);
  await page.waitForTimeout(1000);
  await cardShot(page, engineName, 'before-drop');
  ok(tag('A3 note drop + add ran on the fresh session'), await noteTurn(page, `drop ${idOf(/Codex/)} ; add waiting GitHub token yenile`));
  await follows('A3 the card follows the fresh session\'s changes');
  await cardShot(page, engineName, 'after-drop');

  console.log(`── ${engineName}: reload, then clear`);
  writeFileSync(join(SCRATCH, 'linger'), '1');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openChat(page, base);
  await until(page, async () => (await agendaCard(page).count()) > 0, 30000);
  await follows('A4 after the reload the card reads the record', 15000);
  // The live condition (2026-11-14): after the rotation the reload's reattach finds no live chat
  // under the pin, so a SECOND Super process starts while the first one lingers.
  const superSpawns = () => reports().filter((r) => r.kind === 'spawn' && r.role === 'super');
  ok(tag('A4 the reload started a second Super process of the same pin (the live condition)'), await until(page, async () => superSpawns().length >= 2, 20000), JSON.stringify(superSpawns().map((r) => r.pid)));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  console.log(`    super pids ${superSpawns().map((r) => `${r.pid}:${alive(r.pid) ? 'alive' : 'gone'}`).join(' ')}`);
  await page.waitForTimeout(1500);
  await cardShot(page, engineName, 'before-clear');
  ok(tag('A4 note clear waiting ran'), await noteTurn(page, 'clear waiting ; add waiting Son satır'));
  await follows('A4 the card follows the clear');
  await cardShot(page, engineName, 'after-clear');

  ok(tag('no console errors'), errors.filter((e) => !/WebSocket|favicon/i.test(e)).length === 0, errors.slice(0, 5).join('\n'));
  await browser.close();
}

async function main() {
  for (const engine of ENGINES) {
    setupScratch();
    const port = await freePort();
    const srv = await startServer(port);
    try { await run(engine, `http://127.0.0.1:${port}`); }
    catch (e) { ok(`[${engine}] ran to the end`, false, e?.stack ?? e); }
    finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
  }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  console.log(`screenshots: ${OUT}`);
  if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
