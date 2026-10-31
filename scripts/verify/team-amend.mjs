#!/usr/bin/env node
/**
 * The Super Agent corrects a member without a card, and the owner takes it back, in the real app.
 *
 *   npm run build && node scripts/verify/team-amend.mjs
 *
 * Built server, isolated scratch vault (fake HOME, DREAMCONTEXT_DESKTOP=1), real Chromium and a
 * stand-in `claude` that runs the real CLI verb with the window token the server gave it, so the
 * Super door is the live one. No tokens are spent. Fixtures are fictional ("Lumen Notes").
 *
 *   §1 a real Super chat amends: approved, no question, trace on disk. A plain chat is refused.
 *   §2 the hook refuses the real accident, and lets a read through.
 *   §3 browser, light and dark × 1440 and 390: the member's page shows why and the diff.
 *   §4 browser: Take back, one click: the old text returns, the member stays approved.
 *   §5 a hand edit still asks.
 *
 * Screenshots: tmp/verify-team-amend/<name>.png. Exit 1 on any FAIL, console error or failed request.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen, setTheme } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = join(REPO, 'tmp', 'verify-team-amend');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-team-amend');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const HOME = join(realpathSync(SCRATCH), 'home');
const PROJ = join(realpathSync(SCRATCH), 'lumen');
const DC = join(PROJ, '_dream_context');
const OLD = 'Watches the Lumen Notes sync and reports what broke.';
const NEW = `${OLD}\nName the failing lesson in the first line.`;
const ECHO = '<<<AMEND>>>';
const WHY = 'Its report buried the failing lesson on line 40.';

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
const sid = flag('--session-id') || flag('--resume') || 'verify';
let n = 0; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    n++;
    const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(distIndex(REPO))}, 'super', 'team', 'amend', 'scout', '--why', ${JSON.stringify(WHY)}, '--prompt-file', ${JSON.stringify(join(realpathSync(SCRATCH), 'new-prompt.md'))}], { env: process.env, encoding: 'utf-8' });
    const report = JSON.stringify({ status: r.status, crew: process.env.DREAMCONTEXT_SUPER_CREW || '', out: (r.stdout || '') + (r.stderr || '') });
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(ECHO)} + report }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: n, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const cleanEnv = { ...process.env, HOME };
for (const k of ['CLAUDECODE', 'DREAMCONTEXT_WINDOW_TOKEN', 'DREAMCONTEXT_WINDOW_URL', 'DREAMCONTEXT_TAB_SESSION']) delete cleanEnv[k];
const cli = (...args) => spawnSync(process.execPath, [distIndex(REPO), ...args], { cwd: PROJ, env: cleanEnv, encoding: 'utf-8' });
const must = (label, r) => { if (r.status !== 0) throw new Error(`${label} failed: ${r.stderr || r.stdout}`); return r; };

let fails = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 200)})` : ''}`);
  if (!cond) fails += 1;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(150); } return false; };

function setup() {
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(DC, 'state'), join(DC, 'knowledge')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(DC, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false } }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({ enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '' }, null, 2)}\n`);
  writeFileSync(join(realpathSync(SCRATCH), 'new-prompt.md'), NEW);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  must('vaults add', cli('vaults', 'add', 'lumen', PROJ));
  must('agents create', cli('agents', 'create', 'scout', '--title', 'Scout', '--prompt', OLD));
  must('routine', cli('automations', 'create', 'scout-daily', '--title', 'Morning sync check', '--agent', 'scout', '--job', 'Check last night\'s sync.', '--days', 'daily', '--at', '09:00'));
}

async function server(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...cleanEnv, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  if (!await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 30_000)) { srv.kill(); throw new Error(`no server: ${log.slice(-400)}`); }
  return srv;
}

async function chat(WebSocket, port, params) {
  const qs = new URLSearchParams({ vault: 'lumen', bypass: '0', ...params }).toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/chat?${qs}`, { headers: { origin: `http://127.0.0.1:${port}` } });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => done('timeout'), 25_000);
    function done(r) { clearTimeout(timer); try { ws.close(); } catch { /* closing */ } resolve(r); }
    ws.on('unexpected-response', (_q, res) => done(`refused ${res.statusCode}`));
    ws.on('error', (e) => done(`error ${e}`));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'user', text: 'GO' })));
    ws.on('message', (d) => { const t = d.toString('utf-8'); const i = t.indexOf(JSON.stringify(ECHO).slice(1, -1)); if (i !== -1) done(t.slice(i, i + 700)); });
  });
}

const hook = (input) => spawnSync(process.execPath, [distIndex(REPO), 'hook', 'pre-tool-use'], { cwd: PROJ, env: cleanEnv, encoding: 'utf-8', input: JSON.stringify(input) });

/** The rail's AI Team button; on a narrow window it waits behind More. */
async function openTeam(page) {
  const direct = page.locator('[data-testid="ns-rail-automations"]');
  if (await direct.isVisible().catch(() => false)) { await direct.click(); return; }
  await page.locator('[data-testid="ns-rail-more"]').click();
  await wait(300);
  await page.getByText(/^AI Team$/).first().click();
}

async function main() {
  setup();
  const { default: ws } = await import('ws');
  const WebSocket = ws.WebSocket ?? ws;
  const port = 45871;
  const base = `http://127.0.0.1:${port}`;
  const srv = await server(port);
  const api = async (p, init) => (await fetch(`${base}/api${p}`, { headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'lumen' }, ...init })).json();
  const summary = async () => (await api('/agents')).agents.find((a) => a.slug === 'scout');
  try {
    console.log('\n── §1 the door');
    const childSession = '11111111-1111-4111-8111-111111111111';
    const refused = await chat(WebSocket, port, { mode: 'basic', sessionId: childSession });
    check('a plain chat is refused the verb', refused.includes('not_the_super_agent') || refused.includes('\\"status\\":1'), refused.slice(0, 160));
    check('a plain chat is not the Super crew: what the owner\'s chat creates stays his', refused.includes('crew\\":\\"\\"'), refused.slice(0, 60));
    check('…and nothing changed', readFileSync(join(DC, 'agents', 'scout.md'), 'utf-8').includes(OLD) && !readFileSync(join(DC, 'agents', 'scout.md'), 'utf-8').includes('failing lesson'));

    const enabled = await (await fetch(`${base}/api/super/enable`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-dreamcontext-vault': 'lumen' }, body: '{}' })).json();
    check('hand-over gives a session', typeof enabled.session === 'string', JSON.stringify(enabled).slice(0, 120));
    const done = await chat(WebSocket, port, { mode: 'super', sessionId: enabled.session });
    console.log('super chat said:', done.slice(0, 300));
    check('the real Super chat amends through the CLI', done.includes('\\"status\\":0') || done.includes('status\\\\\\":0'), done.slice(0, 200));
    check('the Super session carries the crew mark', done.includes('crew\\":\\"1\\"'), done.slice(0, 60));
    check('the prompt on disk is the new one', readFileSync(join(DC, 'agents', 'scout.md'), 'utf-8').includes('failing lesson'));
    const s = await summary();
    check('the member stays approved, to chat and to run', s.approvedForChat && s.approvedToRun, JSON.stringify({ c: s.approvedForChat, r: s.approvedToRun, why: s.approvalReason }));
    const autos = await api('/automations');
    const routine = (autos.automations ?? autos).find((a) => a.slug === 'scout-daily');
    check('its routine stays approved', routine?.approved === true, routine?.approvalReason);
    check('no question was born', routine?.pendingQuestion === null);
    const list = (await api('/agents/scout/amendments')).amendments;
    check('the trace: reason, author, old and new text', list.length === 1 && list[0].why === WHY && list[0].by === 'super' && list[0].session === enabled.session && list[0].changes[0].before === OLD && list[0].changes[0].after === NEW, JSON.stringify(list[0] ?? null).slice(0, 200));
    await fetch(`${base}/api/super/disable`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-dreamcontext-vault': 'lumen' }, body: '{}' });

    console.log('\n── §2 the hook');
    const heredoc = hook({ tool_name: 'Bash', cwd: DC, tool_input: { command: `python3 - <<'EOF'\np='agents/scout.md'\ns=open(p).read()\nopen(p,'w').write(s+'x')\nEOF` } });
    check('the real accident is refused and names the command', heredoc.stdout.includes('"deny"') && heredoc.stdout.includes('super team amend'), heredoc.stdout.slice(0, 160));
    check('Edit is refused', hook({ tool_name: 'Edit', cwd: PROJ, tool_input: { file_path: join(DC, 'agents', 'scout.md') } }).stdout.includes('"deny"'));
    check('a read goes through', hook({ tool_name: 'Bash', cwd: DC, tool_input: { command: 'sed -n 1,5p agents/scout.md' } }).stdout === '');

    console.log('\n── §3-4 the owner');
    const browser = await chromium.launch();
    const errors = [];
    for (const [theme, width, height] of [['light', 1440, 900], ['dark', 390, 844], ['dark', 1440, 900], ['light', 390, 844]]) {
      const tag = `${theme}-${width}`;
      const ctx = await browser.newContext({ viewport: { width, height } });
      await markAnnouncementsSeen(ctx, base);
      await setTheme(ctx, theme);
      const page = await ctx.newPage();
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
      page.on('requestfailed', (r) => { if (!r.url().includes('/ws') && !r.url().includes('agent/')) errors.push(`${tag}: ${r.url()} ${r.failure()?.errorText}`); });
      await page.goto(`${base}/?vault=lumen`, { waitUntil: 'domcontentloaded' });
      await wait(2000);
      for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
      await openTeam(page);
      await page.locator('.aiteam').waitFor({ timeout: 15000 });
      await page.locator('[data-team-row="scout"]').click();
      const block = page.locator('[data-team-amendments]').first();
      check(`${tag}: the page says what changed`, await until(() => block.isVisible()), '');
      check(`${tag}: its reason is on the line`, (await block.innerText()).includes(WHY));
      await block.locator('[data-amend-toggle]').click();
      await page.locator('[data-amendment]').first().waitFor({ timeout: 5000 });
      const text = await block.innerText();
      check(`${tag}: the diff shows the added line`, text.includes('+ Name the failing lesson'), text.slice(0, 120));
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${tag}: nothing overflows`, over <= 0, String(over));
      await page.screenshot({ path: join(SHOTS, `${tag}.png`) });
      await ctx.close();
    }

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/?vault=lumen`, { waitUntil: 'domcontentloaded' });
    await wait(2000);
    for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await wait(300); }
    await openTeam(page);
    await page.locator('.aiteam').waitFor({ timeout: 15000 });
    await page.locator('[data-team-row="scout"]').click();
    const block = page.locator('[data-team-amendments]').first();
    await block.locator('[data-amend-toggle]').click();
    await block.locator('[data-amend-revert]').click();
    check('one click: the row reads as taken back', await until(() => block.locator('[data-amend-reverted]').isVisible()));
    check('the old text is on disk', !readFileSync(join(DC, 'agents', 'scout.md'), 'utf-8').includes('failing lesson'));
    const after = await summary();
    check('the member stays approved after taking it back', after.approvedForChat && after.approvedToRun);
    await page.screenshot({ path: join(SHOTS, 'taken-back.png') });
    await ctx.close();
    await browser.close();
    check('no console error or failed request', errors.length === 0, errors.slice(0, 4).join(' | '));

    console.log('\n── §5 a change from outside');
    const f = join(DC, 'agents', 'scout.md');
    writeFileSync(f, readFileSync(f, 'utf-8').replace(OLD, 'Text a teammate pushed.'));
    const hand = await summary();
    check('a hand edit still asks', hand.approvedToRun === false && hand.approvalReason === 'manifest-changed', hand.approvalReason);
  } finally {
    srv.kill();
  }
  console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}  screenshots: ${SHOTS}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
