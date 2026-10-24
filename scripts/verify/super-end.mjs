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
 *   L1-L3 lean children (orchestration plan r5 D14): a child delegated with `--mcp whatsapp`
 *       spawns with `--strict-mcp-config` and only that server, one without `--mcp` with none;
 *       the super and the owner's own chat are not strict; the resumed (E3) and the restarted (U1)
 *       child keep the same set.
 *   E4  the owner's x on a child card asks: "Move to Others" keeps the process and stacks the
 *       card; "End session" ends it (process exits, card gone); a BUSY child offers "End when
 *       done", shows the pending chip, and closes when its turn ends.
 *   E5  a non-chat card (a task) closes at once, with no question.
 *   U1  `super update <child> --model --effort --mode` → the child's process gets the live
 *       `set_model` request and the `/effort` frame, then restarts `--resume`ing the same
 *       conversation in the new mode with the new model; its card stays; the record has all three.
 *   U2  the owner's own (adopted) chat is refused without --force; the super's raw `window model`
 *       into a child is refused (`super update` is the one path).
 *   A1  the owner reopens a past conversation from Past chats (⌘⇧O) mid-hand-over: it runs as a
 *       hidden tab, no child. `super adopt <it>` is refused without --force (his own chat); with
 *       --force its card comes and the record names it an adopted child.
 *   R1  (end review round 1) "Move to Others" after "End when done" drops the pending end: the
 *       busy child finishes its turn and keeps running. A failed record (the end route answers
 *       500) leaves the chat running and the card says so. The owner ends his own adopted chat
 *       from its card. An image card closes at once. No `gone` turn reaches the super for an
 *       ended child. An ended child he reopens from Past chats is his adopted child again: its
 *       card comes back.
 *   Screenshots of the choice at 1280 and 1920 px, of the update, the failed end, the adopted card
 *   and the reopened child; no console errors.
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
    for (const n of ['one', 'two', 'three']) steps.push(cli('super', 'delegate', '--prompt', 'CHILD ' + n, '--brief', 'Child ' + n, ...(n === 'one' ? ['--mcp', 'whatsapp'] : [])));
    steps.push(cli('super', 'open', 'task', 'fix-the-login-form'));
    steps.push(cli('super', 'open', 'image', 'docs/shot.png'));
    report({ kind: 'handover', adopted, steps });
    return 'arranged';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 300) }); return 'noted'; }
  const m = text.match(/GO-(END|RESUME|BUSY|OWNEND|UPDATE|ADOPT)\\s*(\\S*)\\s*(\\S*)/);
  if (m) {
    const [, verb, a, b] = m;
    const steps = [];
    if (verb === 'UPDATE') {
      steps.push(cli('super', 'update', a, '--model', 'haiku', '--effort', 'low', '--mode', 'plan'));
      if (b) steps.push(cli('super', 'update', b, '--model', 'haiku'));
      steps.push(cli('window', 'model', 'haiku', '--tab', a));
    }
    if (verb === 'ADOPT') {
      steps.push(cli('super', 'adopt', a));
      steps.push(cli('super', 'adopt', a, '--force', '--brief', 'Pricing copy'));
    }
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
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
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
  const browserType = engineName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  // The R1 failed-end step answers the end route 500 on purpose: the browser's own log of that
  // one response is expected while the fake route stands, and nothing else is.
  let faking500 = false;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (faking500 && /status of 500/.test(m.text())) return;
    errors.push(m.text());
  });
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
  const firstSpawn = (id) => reports().find((r) => r.kind === 'spawn' && r.convo === id);
  ok(tag('L1 a delegated child with --mcp whatsapp runs lean with exactly that server'), firstSpawn(c1)?.strict === true
    && JSON.stringify(firstSpawn(c1)?.mcp) === '["whatsapp"]', JSON.stringify(firstSpawn(c1)));
  ok(tag('L1 a delegated child without --mcp runs lean with no user server'), firstSpawn(c2)?.strict === true && firstSpawn(c2)?.mcp.length === 0, JSON.stringify(firstSpawn(c2)));
  const superSpawn = reports().find((r) => r.kind === 'spawn' && r.role === 'super');
  ok(tag('L1 the Super Agent and the owner\'s own chat spawn as before (not strict)'), superSpawn?.strict === false
    && (!own || firstSpawn(own)?.strict === false), JSON.stringify([superSpawn, own && firstSpawn(own)]));

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
  const resumed = reports().filter((r) => r.kind === 'spawn' && r.resume === c1).pop();
  ok(tag('L2 the resumed child keeps its lean set (strict, whatsapp only)'), resumed?.strict === true && JSON.stringify(resumed?.mcp) === '["whatsapp"]', JSON.stringify(resumed));
  ok(tag('E3 its card is back'), await until(page, async () => (await card(page, c1).count()) === 1, 10000));

  console.log(`── ${engineName}: super update`);
  await until(page, async () => (await card(page, c1).getAttribute('data-status')) === 'idle', 15000);
  const before = reports().filter((r) => r.kind === 'spawn' && r.convo === c1).map((r) => r.pid);
  await sayToSuper(page, `GO-UPDATE ${c1} ${own ?? ''}`);
  ok(tag('U1 super update answered ok'), await until(page, async () => reports().some((r) => r.kind === 'owner-update'), 45000)
    && reports().find((r) => r.kind === 'owner-update').steps[0].status === 0, JSON.stringify(reports().find((r) => r.kind === 'owner-update')?.steps?.map((x) => x.out.slice(0, 300))));
  const live1 = before[before.length - 1];
  ok(tag('U1 the running child got the live set_model haiku'), reports().some((r) => r.kind === 'set_model' && r.pid === live1 && r.model === 'haiku'));
  ok(tag('U1 …and the /effort low frame'), reports().some((r) => r.kind === 'effort' && r.pid === live1 && r.text === '/effort low'));
  ok(tag('U1 it restarted on the same conversation in Plan mode with the new model'), await until(page, async () => reports().some((r) => r.kind === 'spawn'
    && r.convo === c1 && !before.includes(r.pid) && r.resume === c1 && r.modeHead === 'Plan' && r.model === 'haiku'), 20000),
  JSON.stringify(reports().filter((r) => r.kind === 'spawn' && r.convo === c1)));
  const restarted = reports().filter((r) => r.kind === 'spawn' && r.convo === c1 && !before.includes(r.pid)).pop();
  ok(tag('L3 the restarted child is still lean with its set'), restarted?.strict === true && JSON.stringify(restarted?.mcp) === '["whatsapp"]', JSON.stringify(restarted));
  ok(tag('U1 …the old process exited, its card stayed'), exited(c1) === false && before.every((p) => reports().some((r) => r.kind === 'exit' && r.pid === p))
    && (await card(page, c1).count()) === 1);
  ok(tag('U1 the record has mode, model and effort'), await until(page, async () => {
    const ch = record().children?.[c1];
    return ch?.mode === 'plan' && ch?.model === 'haiku' && ch?.effort === 'low';
  }, 5000), JSON.stringify(record().children?.[c1]));
  await page.screenshot({ path: join(OUT, `${engineName}-update.png`) });
  const upd = reports().find((r) => r.kind === 'owner-update');
  if (own) ok(tag('U2 the owner\'s own chat is refused without --force'), upd.steps[1].status !== 0 && /adopted/.test(upd.steps[1].out), upd.steps[1].out);
  const raw = upd.steps[upd.steps.length - 1];
  ok(tag('U2 the super\'s raw `window model` into a child is refused'), raw.status !== 0 && /super update/.test(raw.out), raw.out);

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
  // The x toggles the choice shut (Escape would also fold the chat surface).
  if (await page.getByTestId('super-close-choice').count()) await clickClose(page, c2);
  await until(page, async () => (await page.getByTestId('super-close-choice').count()) === 0, 3000);
  // R1: "End when done", then "Move to Others" before the turn ends: the owner's last word wins.
  const busyBefore = reports().filter((r) => r.kind === 'busy-done').length;
  await sayToSuper(page, `GO-BUSY ${c2}`);
  await until(page, async () => (await card(page, c2).getAttribute('data-status')) === 'working', 15000);
  await clickClose(page, c2);
  await page.getByTestId('super-close-end').click();
  ok(tag('R1 "End when done" shows the pending chip'), await until(page, async () => (await card(page, c2).getByTestId('super-close-pending').count()) === 1, 5000));
  await clickClose(page, c2);
  await page.getByTestId('super-close-others').click();
  ok(tag('E4 "Move to Others" stacks the card'), await until(page, async () => record().containers.some((k) => k.ref === c2 && k.place === 'others'), 8000));
  ok(tag('R1 …and drops the pending end'), (await page.getByTestId('super-close-pending').count()) === 0);
  ok(tag('R1 the busy child finishes its turn'), await until(page, async () => reports().filter((r) => r.kind === 'busy-done').length > busyBefore, 20000));
  await page.waitForTimeout(3000);
  ok(tag('…and the child keeps running, not ended'), alive(c2) && !exited(c2) && record().children?.[c2]?.endedAt === undefined);

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
  const image = page.locator('[data-testid="super-container"][data-kind="image"]');
  ok(tag('R1 the image card is on the stage'), await until(page, async () => (await image.count()) === 1, 5000));
  await image.hover();
  await image.locator('[data-testid="super-card-close"]').click();
  ok(tag('R1 an image card closes at once, no question'), await until(page, async () => (await image.count()) === 0, 5000)
    && (await page.getByTestId('super-close-choice').count()) === 0);

  if (own) {
    console.log(`── ${engineName}: the owner ends his own chat from its card`);
    await until(page, async () => (await card(page, own).count()) === 1, 10000);
    // A record that does not land: the chat keeps running and the card says so.
    faking500 = true;
    await page.route('**/api/super/end', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    await clickClose(page, own);
    await page.getByTestId('super-close-end').click();
    ok(tag('R1 a failed end shows on the card'), await until(page, async () => (await card(page, own).getByTestId('super-close-failed').count()) === 1, 8000));
    ok(tag('R1 …and the chat keeps running, not ended'), alive(own) && record().children?.[own]?.endedAt === undefined);
    await page.screenshot({ path: join(OUT, `${engineName}-end-failed.png`) });
    await page.unroute('**/api/super/end');
    faking500 = false;
    await clickClose(page, own);
    await page.getByTestId('super-close-end').click();
    ok(tag('R1 the owner ends his own adopted chat: process exits, card gone, recorded'), await until(page, async () => exited(own)
      && (await card(page, own).count()) === 0 && typeof record().children?.[own]?.endedAt === 'number', 15000));
  }

  console.log(`── ${engineName}: Past chats → super adopt`);
  await superComposer(page).click();
  await page.keyboard.press('Meta+Shift+O');
  const row = page.locator('.chp-modal .chp-row-title', { hasText: PAST_TITLE });
  ok(tag('A1 Past chats lists the earlier conversation mid-hand-over'), await until(page, async () => (await row.count()) === 1, 10000));
  await row.click();
  ok(tag('A1 it runs again (a --resume of it), as no child'), await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.resume === PAST_ID), 20000)
    && !record().children?.[PAST_ID] && (await card(page, PAST_ID).count()) === 0);
  await page.waitForTimeout(1500);
  await sayToSuper(page, `GO-ADOPT ${PAST_ID}`);
  ok(tag('A1 super adopt answered'), await until(page, async () => reports().some((r) => r.kind === 'owner-adopt'), 30000));
  const ad = reports().find((r) => r.kind === 'owner-adopt');
  ok(tag('A1 without --force it is refused: the owner\'s own chat'), ad?.steps[0]?.status !== 0 && /owners_chat/.test(ad?.steps[0]?.out ?? ''), ad?.steps[0]?.out);
  ok(tag('A1 with --force it is adopted'), ad?.steps[1]?.status === 0, ad?.steps[1]?.out);
  ok(tag('A1 its card comes'), await until(page, async () => (await card(page, PAST_ID).count()) === 1, 10000));
  ok(tag('A1 the record names it an adopted child with the hand-over note'), record().children?.[PAST_ID]?.adopted === true
    && record().children?.[PAST_ID]?.brief === 'Pricing copy' && record().notes?.[PAST_ID] === 'handover', JSON.stringify(record().children?.[PAST_ID]));
  for (const w of [1280, 1920]) {
    await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 1080 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${engineName}-adopted-${w}.png`) });
  }
  ok(tag('A1 it still runs'), alive(PAST_ID));

  const endedNow = Object.entries(record().children ?? {}).filter(([, ch]) => typeof ch.endedAt === 'number');
  const goneTurns = reports().filter((r) => r.kind === 'event' && /status=gone/.test(r.text)
    && endedNow.some(([sid, ch]) => r.text.includes(sid) && r.t >= ch.endedAt));
  ok(tag('R1 no gone turn reached the super for an ended child'), endedNow.length >= 2 && goneTurns.length === 0,
    JSON.stringify({ ended: endedNow.map(([k]) => k), goneTurns }));

  console.log(`── ${engineName}: the owner reopens an ended child from Past chats`);
  ok(tag('R1 c3 is ended before the reopen'), typeof record().children?.[c3]?.endedAt === 'number');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await superComposer(page).click();
  await page.keyboard.press('Meta+Shift+O');
  const row3 = page.locator('.chp-modal .chp-row-title', { hasText: 'CHILD three' });
  ok(tag('R1 Past chats lists the ended child'), await until(page, async () => (await row3.count()) >= 1, 10000));
  await row3.first().click();
  ok(tag('R1 it runs again'), await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.resume === c3 && r.t > (record().children?.[c3]?.startedAt ?? 0)), 20000));
  ok(tag('R1 it is his adopted child again: not ended, its card back'), await until(page, async () => {
    const ch = record().children?.[c3];
    return ch?.endedAt === undefined && ch?.adopted === true && (await card(page, c3).count()) === 1;
  }, 15000), JSON.stringify(record().children?.[c3]));
  await page.screenshot({ path: join(OUT, `${engineName}-reopened.png`) });

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
