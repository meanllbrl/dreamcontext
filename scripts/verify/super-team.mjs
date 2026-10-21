#!/usr/bin/env node
/**
 * `super team ask`, end to end (task super-agent-ai-team-uyelerine-is-verir-…).
 *
 *   npm run build && node scripts/verify/super-team.mjs            (ENGINES=chromium,webkit)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard, the real
 * chat WebSockets, the real AI Team member (`dreamcontext agents create`) and the real CLI run from
 * INSIDE the Super Agent's own process. `claude` is a scripted stand-in (no tokens spent): it plays
 * the super, and answers the member's `claude -p` run with a result envelope.
 *
 *   T1  the member is not approved on this Mac (a teammate's edit): `super team ask` is refused
 *       409 say_unapproved; the record holds ONE escalated `approval` item for it; the owner's
 *       queue strip leads with it, in his words, with "Open in AI Team" (screenshots at 1280 and
 *       1920 px). Asked again: still one item.
 *   T2  "Open in AI Team" lands on the AI Team page with that member open and its approval strip
 *       showing (screenshot).
 *   T3  the owner approves it (`agents approve --yes`), the super asks again: 200, the approval item
 *       is done and the strip is empty; the member's own thread holds the super's ask (via
 *       `super`); its run ends and `super state` shows the team job done, with its last line.
 *   No console errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-team-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-team');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const MEMBER = 'scout';
const MEMBER_ANSWER = 'Signups fell 4% on Tuesday; the drop is all on the pricing step.';
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
if (!argv.includes('stream-json')) {
  // The member's run: \`claude -p <prompt> --output-format json\`.
  if (argv.includes('-p')) {
    report({ kind: 'member-run', prompt: (argv[argv.indexOf('-p') + 1] || '').slice(0, 4000) });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(MEMBER_ANSWER)}, session_id: 'member-' + process.pid, num_turns: 1, total_cost_usd: 0, duration_ms: 5 }) + '\\n');
  } else process.stdout.write('{}\\n');
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
  if (text.startsWith('[super')) return 'noted';
  if (text.includes('GO-TEAM')) {
    const steps = [cli('super', 'team', 'ask', ${JSON.stringify(MEMBER)}, 'Look at this week\\'s signup funnel and name the step that dropped.', '--brief', 'Funnel check')];
    report({ kind: 'team', steps });
    return 'asked the team';
  }
  if (text.includes('GO-STATE')) {
    const s = cli('super', 'state');
    report({ kind: 'state', team: s.json?.team ?? null, out: s.out.slice(0, 2000) });
    return 'read state';
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
    ['agent', dc('agents', 'create', MEMBER, '--title', 'Scout', '--prompt', 'Reads the product funnel and names what moved.')],
  ]) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  // A teammate's edit: the member is no longer approved on this Mac.
  appendFileSync(join(PROJ, '_dream_context', 'agents', `${MEMBER}.md`), 'It also checks the pricing page.\n');
  if (!/needs approval/.test(dc('agents', 'list').stdout)) throw new Error('the member should need approval');
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
const approvals = () => (record().queue ?? []).filter((q) => q.kind === 'approval' && q.member === MEMBER);

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
const countOf = (kind) => reports().filter((r) => r.kind === kind).length;
async function superDoes(page, word, kind, ms = 30000) {
  const before = countOf(kind);
  await sayToSuper(page, word);
  await until(page, async () => countOf(kind) > before, ms);
  return reports().filter((r) => r.kind === kind)[before];
}

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

  console.log(`── ${engineName}: T1 a member not approved here`);
  const t1 = await superDoes(page, 'GO-TEAM', 'team');
  const s1 = t1?.steps?.[0];
  ok(tag('T1 super team ask is refused 409 say_unapproved'), s1 && s1.status !== 0 && /say_unapproved/.test(s1.out), s1?.out);
  ok(tag('T1 …and says the owner approves it, not the super'), /You cannot approve it: the owner does, in AI Team/.test(s1?.out ?? ''), s1?.out);
  ok(tag('T1 the record holds ONE escalated approval item for the member'), approvals().length === 1 && approvals()[0].state === 'escalated', JSON.stringify(record().queue));
  const head = page.locator('[data-testid="super-queue-head"][data-kind="approval"]');
  ok(tag('T1 the queue strip leads with it'), await until(page, async () => (await head.count()) === 1, 15000));
  let headText = '';
  ok(tag('T1 in the owner\'s words, naming the member by its name, on one uncut line'), await until(page, async () => {
    headText = await head.innerText();
    const cut = await head.locator('.super-queue-text').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    return /Scout needs your approval to take Claude.s job/.test(headText) && /AI Team/.test(headText) && !cut;
  }, 10000), headText);
  ok(tag('T1 with Open in AI Team and Reply'), (await head.getByTestId('super-queue-open-team').count()) === 1
    && (await head.locator('.super-queue-btn--reply').count()) === 1);
  for (const w of [1280, 1920]) {
    await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 1080 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${engineName}-approval-${w}.png`) });
    const cut = await head.locator('.super-queue-text').evaluate((el) => el.scrollWidth > el.clientWidth + 1).catch(() => true);
    ok(tag(`T1 the line is uncut at ${w} px`), !cut);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  const t1b = await superDoes(page, 'GO-TEAM', 'team');
  ok(tag('T1 asked again: refused again, still one item'), t1b?.steps?.[0]?.status !== 0 && approvals().length === 1, JSON.stringify(record().queue));

  console.log(`── ${engineName}: T2 Open in AI Team`);
  await head.getByTestId('super-queue-open-team').click();
  ok(tag('T2 the AI Team page opens'), await until(page, async () => (await page.locator('.aiteam:visible').count()) === 1, 15000));
  ok(tag('T2 with the member open and its approval waiting'), await until(page, async () =>
    (await page.locator('.aiteam-convo:visible').filter({ hasText: 'Scout' }).count()) >= 1
    && (await page.locator('[data-team-approval]:visible').count()) === 1, 15000));
  await page.screenshot({ path: join(OUT, `${engineName}-ai-team.png`) });

  console.log(`── ${engineName}: T3 approved, asked again`);
  const ap = dc('agents', 'approve', MEMBER, '--yes');
  ok(tag('T3 the owner approves it'), ap.status === 0, ap.stderr || ap.stdout);
  await openChat(page, base);
  ok(tag('T3 back on the super surface'), await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000));
  await page.waitForTimeout(1500);
  const runsBefore = countOf('member-run');
  const t3 = await superDoes(page, 'GO-TEAM', 'team');
  const s3 = t3?.steps?.[0];
  ok(tag('T3 super team ask goes through'), s3?.status === 0 && s3?.json?.member === MEMBER && ['running', 'queued'].includes(s3?.json?.status), s3?.out);
  ok(tag('T3 the approval item is done'), approvals().length === 1 && approvals()[0].state === 'done', JSON.stringify(approvals()));
  ok(tag('T3 the strip no longer asks'), await until(page, async () => (await head.count()) === 0, 10000));
  ok(tag('T3 the record has the team job'), record().team?.[0]?.member === MEMBER && record().team?.[0]?.brief === 'Funnel check', JSON.stringify(record().team));
  ok(tag('T3 the member ran'), await until(page, async () => countOf('member-run') > runsBefore, 30000));
  const thread = JSON.parse(dc('automations', 'thread', MEMBER, '--json').stdout || '[]');
  const entries = Array.isArray(thread) ? thread : (thread.entries ?? []);
  ok(tag('T3 its own thread holds the super\'s ask, via super'), entries.some((e) => e.kind === 'user' && e.via === 'super' && /signup funnel/.test(e.text)),
    JSON.stringify(entries).slice(0, 600));
  let row = null;
  await until(page, async () => {
    const st = await superDoes(page, 'GO-STATE', 'state', 20000);
    row = (st?.team ?? []).find((j) => j.member === MEMBER) ?? null;
    return row?.status === 'done';
  }, 60000);
  ok(tag('T3 super state shows the team job done'), row?.status === 'done', JSON.stringify(row));
  ok(tag('T3 …with the member\'s last line, fenced'), typeof row?.lastLine === 'string' && row.lastLine.includes('Signups fell 4%') && row.lastLine.startsWith('<untrusted-project-output'), JSON.stringify(row));
  await page.screenshot({ path: join(OUT, `${engineName}-after.png`) });

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
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
