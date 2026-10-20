#!/usr/bin/env node
/**
 * `super end`, `super resume` and the owner's card close, end to end (task super-agent-bir-alt-
 * sohbeti-gercekten-sonlandirabilir-…).
 *
 *   npm run build && node scripts/verify/super-end.mjs            (ENGINES=chromium,webkit)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard, the real
 * chat WebSockets and the real CLI run from INSIDE each chat's process. `claude` is a scripted
 * stand-in (no tokens spent) that reports every spawn (with its `--resume` id) and every exit.
 *
 *   E1  the super delegates three children; `super end <child>` → its process exits, its card
 *       goes, the record says ended, a done `ended` queue item; the owner's own chat is refused
 *       (409 adopted) without --force.
 *   E2  the ended child is gone from the persisted roster and does not come back on a reload.
 *   E3  `super resume <child>` → a new process `--resume`s the same conversation; its card is back.
 *   E4  the owner's x on a child card asks: "Move to Others" keeps the process and stacks the
 *       card; "End session" ends it (process exits, card gone); a BUSY child offers "End when
 *       done", shows the pending chip, and closes when its turn ends.
 *   E5  a non-chat card (a task) closes at once, with no question.
 *   Screenshots of the choice at 1280 and 1920 px; no console errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-end-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-end');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const convo = at('--resume') || at('--session-id') || '';
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, convo, pid: process.pid, t: Date.now(), ...o }) + '\\n');
report({ kind: 'spawn', resume: at('--resume') });
process.on('exit', () => report({ kind: 'exit' }));
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
function persist(text) {
  if (!/^[0-9a-f-]{36}$/.test(convo)) return;
  const dir = join(process.env.HOME, '.claude', 'projects', 'verify-super-end');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type: 'user', sessionId: convo, message: { role: 'user', content: text } }) + '\\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inited = false;
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [cli('super', 'state')];
    const adopted = Object.keys(steps[0].json?.children ?? {});
    for (const n of ['one', 'two', 'three']) steps.push(cli('super', 'delegate', '--prompt', 'CHILD ' + n, '--brief', 'Child ' + n));
    steps.push(cli('super', 'open', 'task', 'fix-the-login-form'));
    report({ kind: 'handover', adopted, steps });
    return 'arranged';
  }
  if (text.startsWith('[super')) return 'noted';
  const m = text.match(/GO-(END|RESUME|BUSY|OWNEND)\\s*(\\S*)/);
  if (m) {
    const [, verb, a] = m;
    const steps = [];
    if (verb === 'END') steps.push(cli('super', 'end', a));
    if (verb === 'OWNEND') steps.push(cli('super', 'end', a));
    if (verb === 'RESUME') steps.push(cli('super', 'resume', a));
    if (verb === 'BUSY') steps.push(cli('super', 'send', a, 'BUSY'));
    report({ kind: 'owner-' + verb.toLowerCase(), steps });
    return 'did ' + verb;
  }
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('BUSY')) {
    const id = 'toolu_busy_' + process.pid;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm run build', description: 'Build' } }] } });
    await sleep(9000);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'built' }] }] } });
    report({ kind: 'busy-done' });
    return 'built';
  }
  return 'ok';
}
async function turn(blocks) {
  const text = blocks.join('');
  persist(blocks[0] ?? '');
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(text); } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'v-' + process.pid });
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
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });

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
  for (const [what, r] of [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' })],
    ['task', dc('tasks', 'create', 'Fix the login form', '-w', 'The login form loses its input on a slow network.')],
  ]) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
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
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {}, queue: [] }; } };
const cardId = (sid) => `chat-${createHash('sha1').update(sid).digest('hex').slice(0, 12)}`;
const card = (page, sid) => page.locator(`[data-container-id="${cardId(sid)}"]`);
const exited = (sid) => {
  const pids = reports().filter((r) => r.kind === 'spawn' && r.convo === sid).map((r) => r.pid);
  return pids.length > 0 && pids.every((p) => reports().some((r) => r.kind === 'exit' && r.pid === p));
};
const alive = (sid) => {
  const pids = reports().filter((r) => r.kind === 'spawn' && r.convo === sid).map((r) => r.pid);
  return pids.some((p) => !reports().some((r) => r.kind === 'exit' && r.pid === p));
};

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
const superComposer = (page) => page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
async function sayToSuper(page, text) {
  const input = superComposer(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
async function clickClose(page, sid) {
  const c = card(page, sid);
  await c.hover();
  await c.locator('[data-testid="super-card-close"]').click();
}
const roster = (page) => page.evaluate(() => fetch('/api/agent/sessions', { headers: { 'X-Dreamcontext-Vault': 'acme-app' } }).then((r) => r.json()));

async function run(engineName, base) {
  const { chromium, webkit } = await import('playwright');
  const browserType = engineName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const tag = (s) => `[${engineName}] ${s}`;

  console.log(`\n── ${engineName}: hand over, three delegated children`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'spawn'), 20000);
  await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('the handover arranged the screen'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
  const ho = reports().find((r) => r.kind === 'handover');
  const own = ho?.adopted?.[0];
  const kids = (ho?.steps ?? []).filter((s) => s.args.startsWith('super delegate')).map((s) => s.json?.sessionId).filter(Boolean);
  ok(tag('three children delegated'), kids.length === 3, JSON.stringify(ho?.steps?.map((s) => s.out.slice(0, 200))));
  const [c1, c2, c3] = kids;
  ok(tag('their cards and the task card are on the stage'), await until(page, async () => (await card(page, c3).count()) === 1
    && (await page.locator('[data-testid="super-container"][data-kind="task"]').count()) === 1, 20000));
  await until(page, async () => kids.every((k) => reports().some((r) => r.kind === 'spawn' && r.convo === k)), 20000);

  console.log(`── ${engineName}: super end`);
  await sayToSuper(page, `GO-END ${c1}`);
  ok(tag('super end <child> answered ok'), await until(page, async () => reports().some((r) => r.kind === 'owner-end' && r.steps[0]?.status === 0), 30000),
    JSON.stringify(reports().find((r) => r.kind === 'owner-end')));
  ok(tag('E1 its process exited'), await until(page, async () => exited(c1), 15000));
  ok(tag('E1 its card is gone'), await until(page, async () => (await card(page, c1).count()) === 0, 10000));
  ok(tag('E1 the record says ended, with a done ended item'), typeof record().children?.[c1]?.endedAt === 'number'
    && record().queue.some((q) => q.kind === 'ended' && q.sessionId === c1 && q.state === 'done'));
  if (own) {
    await sayToSuper(page, `GO-OWNEND ${own}`);
    await until(page, async () => reports().some((r) => r.kind === 'owner-ownend'), 30000);
    const r = reports().find((x) => x.kind === 'owner-ownend');
    ok(tag('E1 the owner\'s own chat is refused without --force (adopted)'), r?.steps[0]?.status !== 0 && /adopted/.test(r?.steps[0]?.out ?? ''), r?.steps[0]?.out);
    ok(tag('…and keeps running'), alive(own));
  }
  ok(tag('E2 the ended child is not in the persisted roster'), await until(page, async () => !((await roster(page)).sessions ?? []).some((m) => m.sessionId === c1), 10000),
    JSON.stringify((await roster(page)).sessions?.map((m) => m.sessionId)));
  const spawnsBefore = reports().filter((r) => r.kind === 'spawn' && r.convo === c1).length;
  await openChat(page, base);
  await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000);
  await page.waitForTimeout(3000);
  ok(tag('E2 after a reload it has no card and no new process'), (await card(page, c1).count()) === 0
    && reports().filter((r) => r.kind === 'spawn' && r.convo === c1).length === spawnsBefore);

  console.log(`── ${engineName}: super resume`);
  ok(tag('the super composer is back after the reload'), await until(page, async () => superComposer(page).isVisible(), 20000));
  await sayToSuper(page, `GO-RESUME ${c1}`);
  ok(tag('super resume answered ok'), await until(page, async () => reports().some((r) => r.kind === 'owner-resume' && r.steps[0]?.status === 0), 30000),
    JSON.stringify(reports().find((r) => r.kind === 'owner-resume')?.steps));
  ok(tag('E3 a new process --resumes the same conversation'), await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.resume === c1), 15000));
  ok(tag('E3 its card is back'), await until(page, async () => (await card(page, c1).count()) === 1, 10000));

  console.log(`── ${engineName}: the owner's close`);
  await until(page, async () => (await card(page, c2).count()) === 1, 10000);
  await clickClose(page, c2);
  ok(tag('E4 the x on a child card asks'), await until(page, async () => (await page.getByTestId('super-close-choice').count()) === 1, 5000));
  for (const w of [1280, 1920]) {
    await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 1080 });
    await page.waitForTimeout(800);
    if (!(await page.getByTestId('super-close-choice').count())) await clickClose(page, c2);
    await page.screenshot({ path: join(OUT, `${engineName}-close-choice-${w}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(800);
  if (!(await page.getByTestId('super-close-choice').count())) await clickClose(page, c2);
  await page.getByTestId('super-close-others').click();
  ok(tag('E4 "Move to Others" stacks the card'), await until(page, async () => record().containers.some((k) => k.ref === c2 && k.place === 'others'), 8000));
  ok(tag('…and the child keeps running'), alive(c2) && !exited(c2));

  await sayToSuper(page, `GO-BUSY ${c3}`);
  await until(page, async () => (await card(page, c3).getAttribute('data-status')) === 'working', 15000);
  await clickClose(page, c3);
  const endBtn = page.getByTestId('super-close-end');
  ok(tag('E4 a busy child offers "End when done"'), await until(page, async () => /when done/i.test(await endBtn.innerText()), 5000), await endBtn.innerText().catch(() => ''));
  await page.screenshot({ path: join(OUT, `${engineName}-close-busy.png`) });
  await endBtn.click();
  ok(tag('E4 the pending chip shows'), await until(page, async () => (await card(page, c3).getByTestId('super-close-pending').count()) === 1, 5000));
  ok(tag('…the child keeps working until its turn ends'), alive(c3));
  ok(tag('E4 after its turn it is ended (process exits, card gone)'), await until(page, async () => exited(c3) && (await card(page, c3).count()) === 0, 30000));

  await clickClose(page, c1);
  await page.getByTestId('super-close-end').click();
  ok(tag('E4 "End session" on an idle child ends it'), await until(page, async () => exited(c1) && (await card(page, c1).count()) === 0, 15000));
  ok(tag('…and records it ended'), await until(page, async () => typeof record().children?.[c1]?.endedAt === 'number', 5000));

  const task = page.locator('[data-testid="super-container"][data-kind="task"]');
  await task.hover();
  await task.locator('[data-testid="super-card-close"]').click();
  ok(tag('E5 a task card closes at once, no question'), await until(page, async () => (await task.count()) === 0, 5000)
    && (await page.getByTestId('super-close-choice').count()) === 0);

  ok(tag('no console errors'), errors.length === 0, errors.slice(0, 5).join('\n'));
  await browser.close();
}

async function main() {
  const results = [];
  for (const engine of ENGINES) {
    setupScratch();
    const port = await freePort();
    const srv = await startServer(port);
    try { await run(engine, `http://127.0.0.1:${port}`); }
    catch (e) { ok(`[${engine}] ran to the end`, false, e?.stack ?? e); }
    finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
    results.push(engine);
  }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  console.log(`screenshots: ${OUT}`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
