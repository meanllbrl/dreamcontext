#!/usr/bin/env node
/**
 * A finished AI Team job reaches the Super Agent as ONE event (task
 * super-agent-bir-ai-team-ajanina-is-verdiginde-ajanin-isi-bitince-super-e-olay-gelir).
 *
 *   npm run build && node scripts/verify/super-team-event.mjs            (ENGINES=chromium)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real chat WebSockets, a
 * real AI Team member (`dreamcontext agents create`) and the real CLI run from INSIDE the Super
 * Agent's own process. `claude` is a scripted stand-in (no tokens spent): it plays the super, logs
 * every `[super events]` turn it is given, and answers the member's `claude -p` run (a failure when
 * the job says FAILME).
 *
 *   E1  the owner asks the super for a team job (his turn): the member runs and ends; the super gets
 *       ONE `[super events]` item for that job, event=done, awaited=owner, with the member's last
 *       line fenced. Nothing more for it after that.
 *   E2  the same for a job whose run fails: ONE item, event=stuck, awaited=owner.
 *   E3  every team item on the record is settled (done), none left pending.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-team-event-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const MEMBER = 'scout';
const MEMBER_ANSWER = 'Signups fell 4% on Tuesday; the drop is all on the pricing step.';
const ENGINES = (process.env.ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
if (!argv.includes('stream-json')) {
  // The member's run: \`claude -p <prompt> --output-format json\`.
  if (argv.includes('-p')) {
    const prompt = argv[argv.indexOf('-p') + 1] || '';
    const fail = prompt.includes('FAILME');
    report({ kind: 'member-run', fail });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: fail ? 'error_during_execution' : 'success', is_error: fail, result: fail ? 'Could not reach the funnel data.' : ${JSON.stringify(MEMBER_ANSWER)}, session_id: 'member-' + process.pid, num_turns: 1, total_cost_usd: 0, duration_ms: 5 }) + '\\n');
    process.exit(fail ? 1 : 0);
  }
  process.stdout.write('{}\\n');
  process.exit(0);
}
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = (await import('node:fs')).readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
report({ kind: 'spawn', role });
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
  if (text.startsWith('[super events]')) { report({ kind: 'events', text }); return 'noted'; }
  if (text.startsWith('[super')) return 'noted';
  if (text.includes('GO-TEAM')) {
    const job = text.includes('GO-TEAM-FAIL') ? 'FAILME: look at the funnel.' : 'Look at this week\\'s signup funnel and name the step that dropped.';
    const step = cli('super', 'team', 'ask', ${JSON.stringify(MEMBER)}, job, '--brief', 'Funnel check');
    report({ kind: 'team', step });
    return 'asked the team';
  }
  return 'ok';
}
let inited = false;
async function turn(blocks) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
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
/** A clean environment: none of the calling session's Claude or dreamcontext variables. */
const env = () => {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_')));
  return { ...e, HOME, DREAMCONTEXT_DESKTOP: '1' };
};
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
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
    ['agent', dc('agents', 'create', MEMBER, '--title', 'Scout', '--prompt', 'Reads the product funnel and names what moved.')],
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
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { queue: [], team: [] }; } };

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 1200)}` : ''}`); }
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
async function sayToSuper(page, text) {
  const input = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
const countOf = (kind) => reports().filter((r) => r.kind === kind).length;
/** Every `- item=… team=<job>` line the super was given for one team job, across all its event turns. */
const teamLines = (job) => reports().filter((r) => r.kind === 'events')
  .flatMap((r) => r.text.split('\n').filter((l) => l.startsWith('- item=') && l.includes(` team=${job} `)).map((line) => ({ line, text: r.text })));

async function teamJob(page, word, tag) {
  const before = countOf('team');
  const runs = countOf('member-run');
  await sayToSuper(page, word);
  await until(page, async () => countOf('team') > before, 30000);
  const step = reports().filter((r) => r.kind === 'team')[before]?.step;
  ok(tag(`${word}: super team ask goes through`), step?.status === 0 && typeof step?.json?.job === 'string', step?.out);
  ok(tag(`${word}: the member ran`), await until(page, async () => countOf('member-run') > runs, 30000));
  return step?.json?.job ?? '';
}

async function run(engineName, base) {
  const { chromium, webkit } = await import('playwright');
  const browserType = engineName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const tag = (s) => `[${engineName}] ${s}`;

  console.log(`\n── ${engineName}: hand over`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await until(page, async () => (await page.getByTestId('super-handover-btn').count()) > 0);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('handed over'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
  await page.waitForTimeout(1500);

  console.log(`── ${engineName}: E1 a team job the owner asked for ends`);
  const j1 = await teamJob(page, 'GO-TEAM', tag);
  ok(tag('E1 the super gets an event for the finished job'), await until(page, async () => teamLines(j1).length > 0, 60000),
    JSON.stringify(record().queue));
  await page.waitForTimeout(8000);
  const l1 = teamLines(j1);
  ok(tag('E1 exactly ONE event for it, never a second'), l1.length === 1, l1.map((x) => x.line).join('\n'));
  ok(tag('E1 it is event=done, awaited=owner, naming the member'), /event=done/.test(l1[0]?.line ?? '') && /awaited=owner/.test(l1[0]?.line ?? '') && / member=scout /.test(l1[0]?.line ?? ''), l1[0]?.line);
  ok(tag('E1 its turn carries the member\'s last line, fenced, and the awaited=owner rule'),
    /<untrusted-project-output[^>]*>\s*Last line: Signups fell 4%/.test(l1[0]?.text ?? '') && /awaited=owner is a job the owner started through you/.test(l1[0]?.text ?? ''), l1[0]?.text);

  console.log(`── ${engineName}: E2 a team job whose run fails`);
  const j2 = await teamJob(page, 'GO-TEAM-FAIL', tag);
  ok(tag('E2 the super gets an event for the failed job'), await until(page, async () => teamLines(j2).length > 0, 60000),
    JSON.stringify(record().queue));
  await page.waitForTimeout(8000);
  const l2 = teamLines(j2);
  ok(tag('E2 exactly ONE event, event=stuck, awaited=owner'), l2.length === 1 && /event=stuck/.test(l2[0].line) && /awaited=owner/.test(l2[0].line), l2.map((x) => x.line).join('\n'));

  console.log(`── ${engineName}: E3 the record`);
  const items = (record().queue ?? []).filter((q) => q.team);
  ok(tag('E3 two team items on the record, both settled'), items.length === 2 && items.every((q) => q.state === 'done'), JSON.stringify(items));
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
  if (process.env.KEEP_SCRATCH) console.log(`scratch kept: ${SCRATCH}`); else rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
