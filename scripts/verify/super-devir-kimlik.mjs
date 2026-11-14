#!/usr/bin/env node
/**
 * The Super Agent after a `/clear` handoff: its stage verbs still reach the owner's window and its
 * `super send` still reaches its children (field 2026-11-14, Tilki and dreamcontext).
 *
 *   npm run build && node scripts/verify/super-devir-kimlik.mjs        (ENGINE=chromium|webkit)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard, the real
 * chat WebSockets and the real CLI run from INSIDE the Super's process. `claude` is a scripted
 * stand-in (no tokens spent) that acts out `/clear` as the CLI does (a new session id on a
 * `system/init`, the real SessionStart hook with source=clear).
 *
 *   D1  hand over; the super delegates one child: its card is on the stage.
 *   D2  the super runs `super handoff`: the pane rotates (`/clear` + the continue prompt).
 *   D3  in the fresh session: `super present <card>` shows the card presented ON SCREEN, `super stack`
 *       puts it in Others ON SCREEN, `super send <child>` is delivered; each reply says `window: sent`.
 *   D4  the owner types `/clear` himself, then the same three.
 *   D5  the window reloads (an app reopen): ONE super process after it, and the same three again.
 *   D6  a second window opens the project while the first holds the Super: it takes the live
 *       process (still ONE), and present/stack reach the second window (a send to a child whose
 *       tab is in the first window is not covered: that window holds the child).
 *   D7  the server restarts: the window takes the Super back, its process has a window token, and
 *       present still reaches the screen.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-devir-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-devir-kimlik');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const ENGINE = process.env.ENGINE || 'chromium';

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// A transcript per conversation, where the CLI keeps them: the server resumes only what exists.
const transcript = (id) => { const d = ${JSON.stringify(join(HOME, '.claude', 'projects', 'scratch'))}; mkdirSync(d, { recursive: true }); writeFileSync(d + '/' + id + '.jsonl', '{}\\n'); };
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let session = at('--resume') || at('--session-id') || ('v-' + process.pid);
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, session, pid: process.pid, t: Date.now(), ...o }) + '\\n');
transcript(session);
report({ kind: 'spawn', windowToken: !!process.env.DREAMCONTEXT_WINDOW_TOKEN, tab: process.env.DREAMCONTEXT_TAB_SESSION || '', args: argv.filter((a) => a === '--resume' || a === '--session-id' || /^[0-9a-f-]{36}$/.test(a)) });
process.on('exit', () => report({ kind: 'exit' }));
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 800) };
};
let inited = false;
let rotations = 0;
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [cli('super', 'delegate', '--prompt', 'CHILD one', '--brief', 'Child one')];
    report({ kind: 'handover', steps });
    return 'arranged';
  }
  if (text.startsWith('HANDOFF')) {
    const r = cli('super', 'handoff',
      '--done', 'One child delegated (Child one).', '--next', 'Child one keeps running its brief.',
      '--decisions', 'none', '--learned', 'none', '--style', 'Owner: Turkish, short, result first.', '--files', 'none');
    report({ kind: 'handoff', status: r.status, out: r.out });
    return 'handoff written';
  }
  const m = /^RUN (\\S+) (.*)$/s.exec(text);
  if (m) { const r = cli(...JSON.parse(m[2])); report({ kind: 'run', tag: m[1], ...r }); return 'ran ' + m[1]; }
  if (text.startsWith('Handoff:')) { report({ kind: 'continue' }); return 'back on a fresh session'; }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 200) }); return 'noted'; }
  return 'ok';
}
function clear() {
  rotations += 1;
  const from = session;
  session = 'c' + String(process.pid).padStart(7, '0') + '-0000-4000-8000-' + String(rotations).padStart(12, '0');
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  const hook = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, 'hook', 'session-start'], {
    env: process.env, encoding: 'utf-8', timeout: 60000, cwd: process.cwd(),
    input: JSON.stringify({ source: 'clear', session_id: session, hook_event_name: 'SessionStart', cwd: process.cwd() }),
  });
  transcript(session);
  report({ kind: 'clear', from, to: session, hookStatus: hook.status });
}
async function turn(blocks) {
  const text = blocks[0] ?? '';
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  if (text === '/clear') {
    clear();
    out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: session });
    return;
  }
  if (role === 'child') report({ kind: 'child-turn', text: text.slice(0, 200) });
  let said = 'ok';
  try { said = role === 'super' ? superTurn(text) : 'ok'; } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }], usage: { input_tokens: 10, cache_read_input_tokens: 40000, output_tokens: 5 } }, session_id: session });
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
process.stdin.on('end', () => chain.then(() => process.exit(0)));
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
const cardId = (sid) => `chat-${createHash('sha1').update(sid).digest('hex').slice(0, 12)}`;
const alivePids = (role) => {
  const born = reports().filter((r) => r.kind === 'spawn' && r.role === role).map((r) => r.pid);
  const dead = new Set(reports().filter((r) => r.kind === 'exit').map((r) => r.pid));
  return born.filter((p) => !dead.has(p) && spawnSync('kill', ['-0', String(p)]).status === 0);
};

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); }
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await sleep(1500); }
  }
}

/** Type into the Super's own composer (the centre). */
async function sayToSuper(page, text) {
  const input = page.locator('[data-super-slot="centre"] .chat-cmp-input, .super-dock .chat-cmp-input').filter({ visible: true }).first();
  await until(async () => (await input.count()) > 0, 30000);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
let runSeq = 0;
async function superRun(page, args) {
  runSeq += 1;
  const tag = `r${runSeq}`;
  await sayToSuper(page, `RUN ${tag} ${JSON.stringify(args)}`);
  let r = null;
  await until(async () => { r = reports().find((x) => x.kind === 'run' && x.tag === tag); return !!r; }, 45000);
  return r;
}
const whereOn = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`).first().getAttribute('data-where').catch(() => null);

async function threeVerbs(page, label, kid, opts = {}) {
  const card = cardId(kid);
  const p = await superRun(page, ['super', 'present', card]);
  ok(`${label}: super present exits 0`, p?.status === 0, JSON.stringify(p));
  ok(`${label}: …and the card is presented ON SCREEN`, await until(async () => (await whereOn(page, card)) === 'present', 15000), `where=${await whereOn(page, card)} view=${JSON.stringify(record().view)}`);
  ok(`${label}: …its reply says the window got it`, p?.json?.window === 'sent', p?.out);
  const off = await superRun(page, ['super', 'present', '--off']);
  ok(`${label}: super present --off exits 0`, off?.status === 0, off?.out);
  if (opts.presentOnly) return;
  const s = await superRun(page, ['super', 'stack', card]);
  ok(`${label}: super stack exits 0`, s?.status === 0, s?.out);
  // Others is a closed pile: the card leaves the stage (drawn in Others, or not drawn at all).
  ok(`${label}: …and the card leaves the stage ON SCREEN`, await until(async () => ['others', null].includes(await whereOn(page, card)), 15000), `where=${await whereOn(page, card)}`);
  ok(`${label}: …its reply says the window got it`, s?.json?.window === 'sent', s?.out);
  await superRun(page, ['super', 'float', card]);
  if (opts.noSend) return;
  const before = reports().filter((x) => x.kind === 'child-turn').length;
  const word = `hello-${label.replace(/\W+/g, '')}`;
  const sd = await superRun(page, ['super', 'send', kid, word]);
  ok(`${label}: super send is accepted`, sd?.status === 0 && sd?.json?.ok !== false, sd?.out);
  ok(`${label}: …and the child reads it`, await until(async () => reports().filter((x) => x.kind === 'child-turn').length > before
    && reports().some((x) => x.kind === 'child-turn' && x.text.includes(word)), 20000));
}

let restarting = false;
async function run(base, restart) {
  const { chromium, webkit } = await import('playwright');
  const browser = await (ENGINE === 'webkit' ? webkit : chromium).launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !(restarting && /ERR_CONNECTION_REFUSED/.test(m.text()))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n── D1 hand over, one child');
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(async () => reports().some((r) => r.role === 'child' && r.kind === 'spawn'), 20000);
  await sleep(1200);
  await page.locator('[data-testid="drawer-super-row"]:visible, [data-testid="super-handover-btn"]:visible').first().click();
  await sleep(1500);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click().catch(() => {});
  ok('D1 the handover delegated', await until(async () => reports().some((r) => r.kind === 'handover'), 90000));
  const kid = reports().find((r) => r.kind === 'handover')?.steps?.[0]?.json?.sessionId;
  ok('D1 the child card is on the stage', !!kid && await until(async () => (await whereOn(page, cardId(kid))) !== null, 20000), JSON.stringify(reports().find((r) => r.kind === 'handover')));
  await threeVerbs(page, 'D1 before any handoff', kid);

  console.log('── D2 super handoff rotates the pane');
  await sayToSuper(page, 'HANDOFF');
  ok('D2 the pane rotated (/clear + continue)', await until(async () => reports().some((r) => r.kind === 'continue'), 45000), JSON.stringify(reports().filter((r) => r.role === 'super').slice(-6)));
  await sleep(1500);
  ok('D2 one super process', alivePids('super').length === 1, JSON.stringify(alivePids('super')));
  await threeVerbs(page, 'D3 after the handoff', kid);

  console.log('── D4 the owner types /clear');
  await sayToSuper(page, '/clear');
  await until(async () => reports().filter((r) => r.kind === 'clear').length >= 2, 20000);
  await sleep(1000);
  await threeVerbs(page, 'D4 after the owner /clear', kid);

  console.log('── D5 the window reloads');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  ok('D5 one super process after the reload', await until(async () => alivePids('super').length === 1, 20000), JSON.stringify({ alive: alivePids('super'), spawns: reports().filter((r) => r.role === 'super' && (r.kind === 'spawn' || r.kind === 'exit')) }));
  await page.screenshot({ path: join(OUT, `${ENGINE}-reloaded-1440.png`) });
  await threeVerbs(page, 'D5 after the reload', kid);
  ok('D5 still one super process', alivePids('super').length === 1, JSON.stringify(alivePids('super')));

  console.log('── D6 a second window opens the project while the first still holds the Super');
  const page2 = await context.newPage();
  page2.on('console', (m) => { if (m.type() === 'error') errors.push(`[page2] ${m.text()}`); });
  await openChat(page2, base);
  await page2.locator('[data-testid="drawer-super-row"]:visible').first().click().catch(() => {});
  await sleep(4000);
  ok('D6 the second window takes the live Super: still one super process', alivePids('super').length === 1,
    JSON.stringify({ alive: alivePids('super'), spawns: reports().filter((r) => r.role === 'super' && (r.kind === 'spawn' || r.kind === 'exit')) }));
  await page2.screenshot({ path: join(OUT, `${ENGINE}-second-window-1440.png`) });
  // The child's own tab stays in the FIRST window (it holds that process): a send from here is
  // answered "not running" by this window. Open question, not this fix: whether a Super's
  // children follow it to the window that takes it.
  await threeVerbs(page2, 'D6 in the second window', kid, { noSend: true });
  ok('D6 one super process at the end', alivePids('super').length === 1, JSON.stringify(alivePids('super')));

  console.log('── D7 the server restarts (an app update): the window takes the Super back');
  await page2.close();
  restarting = true;
  const base2 = await restart();
  restarting = false;
  await page.goto(`${base2}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await page.locator('[data-testid="drawer-super-row"]:visible').first().click().catch(() => {});
  await sleep(3000);
  ok('D7 one super process after the restart', await until(async () => alivePids('super').length === 1, 20000), JSON.stringify(alivePids('super')));
  const tokenOk = reports().filter((r) => r.kind === 'spawn' && r.role === 'super').pop()?.windowToken === true;
  ok('D7 the respawned Super has its window token', tokenOk, JSON.stringify(reports().filter((r) => r.kind === 'spawn' && r.role === 'super').pop()));
  // The child came back running after the restart: a live job's card is never stacked (by design).
  await threeVerbs(page, 'D7 after the restart', kid, { presentOnly: true });

  ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await browser.close();
}

async function main() {
  setupScratch();
  let port = await freePort();
  let srv = await startServer(port);
  const restart = async () => {
    srv.kill();
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
    await sleep(1500);
    port = await freePort();
    srv = await startServer(port);
    return `http://127.0.0.1:${port}`;
  };
  try { await run(`http://127.0.0.1:${port}`, restart); }
  catch (e) { ok('ran to the end', false, e?.stack ?? e); }
  finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  console.log(`scratch: ${SCRATCH}${process.env.KEEP_SCRATCH ? '' : ' (removed)'}`);
  if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
