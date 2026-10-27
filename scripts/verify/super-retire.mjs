#!/usr/bin/env node
/**
 * The Super ends finished jobs on its own (task super-agent-ends-finished-told-child-sessions-…,
 * owner 2026-10-27: "buradaki eski sessionlar da kapanmıyor").
 *
 *   npm run build && node scripts/verify/super-retire.mjs            (ENGINES=chromium)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard in a real
 * browser, real chat processes run by a scripted stand-in `claude` (no tokens). The retire bar is
 * shortened to 20 s and the tidy tick to 2 s (verify-only env); the real bar is 60 minutes.
 *
 *   R1  the super delegates a QUICK child (its turn ends at once) and a LONG one (works for minutes);
 *       both cards are on the stage.
 *   R2  the quick child's done event reaches the super (told); its card is still on the stage.
 *   R3  ~20 s later, with nobody touching it, the system ends it: its process exits, its card
 *       leaves the stage, the record says ended with a done `ended` item; no `super end` was run.
 *   R4  the LONG child (working) and the owner's own adopted chat are never ended.
 *   Screenshots before/after at 1440 px, no console errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-retire-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-retire');
const REPORTS = join(SCRATCH, 'reports.ndjson');
/** A conversation the project had before (on disk only), for Past chats → `super adopt`. */
const PAST_ID = '7a1c0de5-0000-4000-8000-00000000a11d';
const PAST_TITLE = 'Pricing page copy review';
/** Claude's own folder for this project's transcripts (Past chats reads it). */
const SLUG_DIR = () => join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
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
// Lean children (orchestration plan r5 D14): strict MCP, and the servers its --mcp-config files grant.
const mcpFiles = []; { const i = argv.indexOf('--mcp-config'); if (i >= 0) for (const f of argv.slice(i + 1)) { if (f.startsWith('--')) break; mcpFiles.push(f); } }
const mcp = []; for (const f of mcpFiles) { try { mcp.push(...Object.keys(JSON.parse(readFileSync(f, 'utf-8')).mcpServers ?? {})); } catch {} }
report({ kind: 'spawn', resume: at('--resume'), model: at('--model'), modeHead: (brief.match(/^# Mode: ([^\\n]+)/m) || [])[1] || '', strict: argv.includes('--strict-mcp-config'), mcp });
process.on('exit', () => report({ kind: 'exit' }));
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
function persist(text) {
  if (!/^[0-9a-f-]{36}$/.test(convo)) return;
  const dir = ${JSON.stringify(join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-')))};
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type: 'user', sessionId: convo, message: { role: 'user', content: text } }) + '\\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inited = false;
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const steps = [cli('super', 'state')];
    const adopted = Object.keys(steps[0].json?.children ?? {});
    steps.push(cli('super', 'delegate', '--prompt', 'CHILD quick job', '--brief', 'Quick job'));
    steps.push(cli('super', 'delegate', '--prompt', 'CHILD LONG job', '--brief', 'Long job'));
    report({ kind: 'handover', adopted, steps });
    return 'arranged';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 400) }); return 'noted'; }
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('LONG')) {
    const id = 'toolu_long_' + process.pid;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm run build', description: 'Build' } }] } });
    await sleep(240000);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'built' }] }] } });
    return 'built';
  }
  return 'quick job finished';
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
    if (o.type === 'control_request') {
      if (o.request && o.request.subtype === 'set_model') report({ kind: 'set_model', model: o.request.model });
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    if (/^\\/effort /.test(blocks[0])) report({ kind: 'effort', text: blocks[0] });
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
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_SUPER_RETIRE_MS: String(RETIRE_MS), DREAMCONTEXT_SUPER_TIDY_TICK_MS: '2000' });
const RETIRE_MS = 20_000;
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  // The owner's MCP servers (user scope): a lean child gets only the ones its job names.
  writeFileSync(join(HOME, '.claude.json'), `${JSON.stringify({ mcpServers: { whatsapp: { command: 'true' }, fathom: { command: 'true' } } }, null, 2)}\n`);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  mkdirSync(join(PROJ, 'docs'), { recursive: true });
  writeFileSync(join(PROJ, 'docs', 'shot.png'), Buffer.from(PNG_1PX, 'base64'));
  // A conversation the project had before this run, on disk only (Past chats lists it).
  const past = SLUG_DIR();
  mkdirSync(past, { recursive: true });
  const ts = new Date(Date.now() - 3600_000).toISOString();
  writeFileSync(join(past, `${PAST_ID}.jsonl`), [
    { type: 'user', cwd: PROJ, sessionId: PAST_ID, timestamp: ts, uuid: 'u-1', message: { role: 'user', content: PAST_TITLE } },
    { type: 'assistant', cwd: PROJ, sessionId: PAST_ID, timestamp: ts, uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
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
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const tag = (s) => `[${engineName}] ${s}`;

  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'spawn'), 20000);
  await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('the handover ran'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
  const ho = reports().find((r) => r.kind === 'handover');
  const own = ho?.adopted?.[0];
  const [quick, long] = (ho?.steps ?? []).filter((s) => s.args.startsWith('super delegate')).map((s) => s.json?.sessionId);
  ok(tag('R1 two children delegated'), !!quick && !!long, JSON.stringify(ho?.steps?.map((s) => s.out.slice(0, 200))));
  ok(tag('R1 both cards are on the stage'), await until(page, async () => (await card(page, quick).count()) === 1 && (await card(page, long).count()) === 1, 20000));

  const told = () => record().queue.some((q) => q.sessionId === quick && q.kind === 'done' && q.state === 'done');
  ok(tag('R2 the quick child is done and its done event reached the super'), await until(page, async () => told() && record().children?.[quick]?.row === 'done', 90000),
    JSON.stringify({ ch: record().children?.[quick], q: record().queue.filter((q) => q.sessionId === quick) }));
  const toldAt = Date.now();
  ok(tag('R2 …its card is still on the stage, not ended yet'), (await card(page, quick).count()) === 1 && record().children?.[quick]?.endedAt === undefined);
  await page.screenshot({ path: join(OUT, `${engineName}-before-1440.png`) });

  ok(tag('R3 the system ended it: the record says ended'), await until(page, async () => typeof record().children?.[quick]?.endedAt === 'number', RETIRE_MS + 30000),
    JSON.stringify(record().children?.[quick]));
  const after = (Date.now() - toldAt) / 1000;
  console.log(`      ended ${after.toFixed(1)} s after it was told (bar ${RETIRE_MS / 1000} s, tick 2 s)`);
  ok(tag('R3 …not before the bar'), record().children[quick].endedAt - toldAt >= 0 && record().children[quick].endedAt >= record().children[quick].finishedAt + RETIRE_MS);
  ok(tag('R3 …with a done ended item'), record().queue.some((q) => q.kind === 'ended' && q.sessionId === quick && q.state === 'done'));
  ok(tag('R3 its card left the stage'), await until(page, async () => (await card(page, quick).count()) === 0, 10000));
  ok(tag('R3 its process exited'), await until(page, async () => exited(quick), 15000));
  ok(tag('R3 no super end was run by the agent'), !reports().some((r) => (r.steps ?? []).some((s) => /super end/.test(s.args))));
  ok(tag('R3 the ended child is not in the roster'), await until(page, async () => !((await roster(page)).sessions ?? []).some((m) => m.sessionId === quick), 10000));
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(OUT, `${engineName}-after-1440.png`) });
  ok(tag('R4 the working child is never ended: card on stage, process alive'), (await card(page, long).count()) === 1 && record().children?.[long]?.endedAt === undefined && alive(long),
    JSON.stringify(record().children?.[long]));
  if (own) ok(tag("R4 the owner's own adopted chat is never ended"), record().children?.[own]?.endedAt === undefined && alive(own));
  ok(tag('no console errors'), errors.length === 0, errors.join('\n'));
  await browser.close();
}

async function main() {
  try {
    for (const engine of (process.env.ENGINES || 'chromium').split(',')) {
      setupScratch();
      const port = await freePort();
      const srv = await startServer(port);
      try { await run(engine, `http://127.0.0.1:${port}`); }
      catch (e) { result.fails.push(String(e)); console.log('  ✗', e); }
      finally { srv.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
    }
  } finally { /* keep the scratch for a look */ }
  console.log(`\n${result.pass} passed, ${result.fails.length} failed`);
  process.exit(result.fails.length ? 1 : 0);
}
main();
