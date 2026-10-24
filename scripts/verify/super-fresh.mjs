#!/usr/bin/env node
/**
 * The Super Agent's "Yeni oturum / New session", end to end (task super-agent-devrini-…).
 *
 *   npm run build && node scripts/verify/super-fresh.mjs            (ENGINES=chromium,webkit)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard, the real
 * chat WebSockets and the real CLI run from INSIDE each chat's process. `claude` is a scripted
 * stand-in (no tokens spent). It acts out `/clear` the way the CLI does: a NEW session id on a
 * `system/init`, and the real SessionStart hook run with `source=clear` and the pane's env, so the
 * handoff banner prints and the record's `consumedAt` is stamped.
 *
 *   F1  hand over; the super delegates two children and pools one job: two cards, one Havuz row.
 *   F2  the centre's head shows "New session"; a press queues a `[super fresh]` turn; the stand-in
 *       runs `dreamcontext super handoff …`: the file `state/.super/handoff.md` holds the entry,
 *       no task file was created, and the record is `kind: super`.
 *   F3  the pane rotates: `/clear`, then the continue prompt naming `.super/handoff.md`; the
 *       SessionStart hook printed the super banner and stamped `consumedAt`; the fresh session's
 *       first answer appears; the button is pressable again.
 *   F4  children, pool and cards are what they were before the press.
 *   F5  a second press where the stand-in writes NO handoff: the server's fallback still rotates
 *       (`rotated` with a fallback continue prompt).
 *   Screenshots at 1440 and 390 px wide (the button, the handoff card, after); no console errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-fresh-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-fresh');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const SKIP_FLAG = join(SCRATCH, 'skip-handoff');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const HANDOFF_FILE = join(PROJ, '_dream_context', 'state', '.super', 'handoff.md');
const HANDOFF_DIR = join(PROJ, '_dream_context', 'state', '.handoff-requests');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);

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
    const steps = [];
    for (const n of ['one', 'two']) steps.push(cli('super', 'delegate', '--prompt', 'CHILD ' + n, '--brief', 'Child ' + n));
    steps.push(cli('super', 'pool', 'add', '--prompt', 'LATER: tidy the changelog', '--brief', 'Tidy the changelog'));
    report({ kind: 'handover', steps });
    return 'arranged';
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
const freshBtn = (page) => page.locator('[data-testid="super-fresh-btn"]');
/** Pressable: aria-disabled, not `disabled` (a keyboard press keeps its focus). */
const pressable = async (page) => (await freshBtn(page).getAttribute('aria-disabled')) === null;
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

  console.log(`\n── ${engineName}: hand over, two children, one pooled job`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'spawn'), 20000);
  await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('F1 the handover arranged the stage'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
  const kids = (reports().find((r) => r.kind === 'handover')?.steps ?? []).filter((s) => s.args.startsWith('super delegate')).map((s) => s.json?.sessionId).filter(Boolean);
  ok(tag('F1 two children delegated, their cards on the stage, one pooled job'), kids.length === 2
    && await until(page, async () => (await card(page, kids[1]).count()) === 1, 20000) && (record().pool ?? []).length === 1,
    JSON.stringify(reports().find((r) => r.kind === 'handover')?.steps?.map((s) => s.out.slice(0, 160))));
  const superSession = record().session;
  const before = stage(record());
  const tasksBefore = taskFiles();

  console.log(`── ${engineName}: New session`);
  ok(tag('F2 the centre head shows the New session button'), await until(page, async () => (await freshBtn(page).count()) === 1 && await pressable(page), 15000));
  await shots(page, engineName, 'button');
  await freshBtn(page).click();
  ok(tag('F2 the press greys the button'), await until(page, async () => (await freshBtn(page).getAttribute('data-busy')) === 'true', 5000));
  ok(tag('F2 the super got a [super fresh] turn and ran super handoff'), await until(page, async () => reports().some((r) => r.kind === 'fresh-handoff'), 30000));
  const fh = reports().find((r) => r.kind === 'fresh-handoff');
  ok(tag('F2 super handoff exited 0'), fh?.status === 0, fh?.out);
  ok(tag('F2 the fresh turn listed the live children'), kids.every((k) => fh?.text.includes(k)), fh?.text);
  const file = existsSync(HANDOFF_FILE) ? readFileSync(HANDOFF_FILE, 'utf-8') : '';
  ok(tag('F2 the handoff file holds the entry'), file.includes('# Super Agent devri') && file.includes('Two children delegated'), file.slice(0, 300));
  ok(tag('F2 no task file was created'), JSON.stringify(taskFiles()) === JSON.stringify(tasksBefore), JSON.stringify(taskFiles()));

  ok(tag('F3 the pane rotated: /clear then the continue prompt naming the file'), await until(page, async () => reports().some((r) => r.kind === 'continue'), 30000));
  const cl = reports().find((r) => r.kind === 'clear');
  const cont = reports().find((r) => r.kind === 'continue');
  ok(tag('F3 the continue prompt sends the fresh session to .super/handoff.md and super state'), /state\/\.super\/handoff\.md/.test(cont?.text ?? '') && /super state/.test(cont?.text ?? ''), cont?.text);
  ok(tag('F3 the SessionStart hook printed the super banner'), cl?.hookStatus === 0 && (cl?.banner ?? []).some((l) => l.includes(".super/handoff.md")), JSON.stringify(cl));
  const rec1 = handoffRecord(superSession);
  ok(tag('F3 the record is kind super, acted and consumed'), rec1?.kind === 'super' && !!rec1?.actedAt && !!rec1?.consumedAt, JSON.stringify(rec1));
  ok(tag('F3 the same pane: no new process for the super'), reports().filter((r) => r.kind === 'spawn' && r.role === 'super').length === 1);
  await shots(page, engineName, 'rotated');
  ok(tag('F3 the fresh session answered and the button is pressable again'), await until(page, async () => (await pressable(page)) && (await freshBtn(page).getAttribute('data-busy')) === null, 30000));
  ok(tag('F4 children, pool and cards are what they were'), stage(record()) === before, `${before}\n${stage(record())}`);

  console.log(`── ${engineName}: New session with no handoff written (fallback)`);
  writeFileSync(SKIP_FLAG, '1');
  await freshBtn(page).click();
  ok(tag('F5 a second press queues a fresh turn'), await until(page, async () => reports().some((r) => r.kind === 'fresh-skipped'), 30000));
  ok(tag('F5 the server rotated anyway with the fallback prompt'), await until(page, async () => reports().filter((r) => r.kind === 'continue').length === 2, 30000)
    && /wrote none this time/.test(reports().filter((r) => r.kind === 'continue')[1]?.text ?? ''), JSON.stringify(reports().filter((r) => r.kind === 'continue')));
  ok(tag('F5 the button frees again'), await until(page, async () => (await pressable(page)), 30000));
  ok(tag('F5 the stage is still the same'), stage(record()) === before);
  await shots(page, engineName, 'after');

  ok(tag('no console errors'), errors.length === 0, errors.slice(0, 5).join('\n'));
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
