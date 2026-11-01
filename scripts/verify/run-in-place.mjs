#!/usr/bin/env node
/**
 * A member's or routine's run opens in place as a chat (AI Team W2).
 *
 *   npm run build && dreamcontext builder heavy -- node scripts/verify/run-in-place.mjs [--super]
 *
 * The real server from dist/ (scratch HOME, a stand-in `claude`), a fake tunnel, the phone listener,
 * a fictional member with five kinds of run. On the Mac surface at 1440 and 390, and on a real phone
 * session: steps open under the bubble, live steps land, a fixture token in a Bash command never
 * reaches the phone (read in every response body), Continue resumes the same session, a routine
 * firing while typing does not move the target, a refusal shows the server's sentence, a question
 * is answered from the flow, a full report opens with no session, and nothing says Activity.
 * `--super`: the same run on a Super team card, and the remote stage's allowlist.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import { chromium, devices } from '@playwright/test';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dc-verify-run-in-place-')));
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-run-in-place', String(process.pid));
const CLI = join(REPO, 'dist', 'index.js');
const TOKEN = 'FIXTURE-TOKEN-5f3a';
const BOUND = '11111111-1111-4111-8111-111111111111';

/** `claude`: a chat echoes, a headless resume writes its turn into the same transcript. */
const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const dir = () => path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
const row = (sid, o) => { fs.mkdirSync(dir(), { recursive: true }); fs.appendFileSync(path.join(dir(), sid + '.jsonl'), JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n'); };
if (!argv.includes('stream-json')) {
  const sid = at('--resume') || crypto.randomUUID();
  if (argv.includes('-p')) {
    const text = at('-p');
    row(sid, { type: 'user', message: { role: 'user', content: text } });
    row(sid, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'RESUMED ' + text.slice(0, 40) }] } });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'RESUMED', num_turns: 1, total_cost_usd: 0, session_id: sid }) + '\\n');
  } else process.stdout.write('{}\\n');
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text)[0] || '';
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row(sid, { type: 'user', message: { role: 'user', content: text } });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text }] };
    row(sid, { type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ECHO', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const onlySuper = process.argv.includes('--super');
const passed = []; const failed = [];
const check = (label, ok, detail = '') => {
  (ok ? passed : failed).push(label);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n      ${String(detail).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const freePort = () => new Promise((ok, no) => { const s = createServer(); s.once('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

// npm's cache stays the real one: under the fake HOME, `npx tsx` would download tsx every run.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME, npm_config_cache: join(process.env.HOME ?? HOME, '.npm') };
const seed = (verb, arg = '') => execFileSync('npx', ['--yes', 'tsx', join(REPO, 'scripts', 'verify', 'run-in-place-seed.ts'), PROJ, verb, arg], { env, cwd: REPO, encoding: 'utf-8' });
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf-8' });

mkdirSync(SHOTS, { recursive: true });
mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN); chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
spawnSync('git', ['init', '-q'], { cwd: PROJ });
cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project']);
const reg = cli(['vaults', 'add', 'proj', PROJ]);
if (reg.status !== 0) throw new Error(`vaults add: ${reg.stderr}`);

const runs = JSON.parse(seed('seed').trim().split('\n').pop());

const port = await freePort();
const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
const server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
  cwd: PROJ, stdio: 'ignore',
  env: { ...env, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_AUTO_DASHBOARD: '0', DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log') },
});
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'X-Dreamcontext-Vault': 'proj', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const up = await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 30000, 300);
if (!up) throw new Error('the server did not come up');

const browser = await chromium.launch();
const findings = [];

async function open(name, opts, url) {
  const ctx = await browser.newContext(opts);
  await markAnnouncementsSeen(ctx, `http://127.0.0.1:${port}`);
  const p = await ctx.newPage();
  const bodies = [];
  // The 409 is the refusal this check provokes on purpose.
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|WebSocket|ERR_ABORTED|status of 409/.test(m.text())) findings.push(`${name} console: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => findings.push(`${name} crash: ${String(e).slice(0, 200)}`));
  p.on('response', async (r) => {
    if (r.url().includes('/api/')) {
      if (r.status() >= 500) findings.push(`${name} ${r.status()} ${r.url().slice(-80)}`);
      try { bodies.push({ url: r.url(), text: await r.text() }); } catch { /* streaming or gone */ }
    }
  });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await until(() => p.locator('[data-testid="ns-titlebar"], .sidebar-item').count(), 25000);
  await sleep(2500);
  for (let i = 0; i < 3; i++) { const x = p.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await sleep(200); }
  return { ctx, p, bodies, shot: (n, full = false) => p.screenshot({ path: join(SHOTS, `${name}-${n}.png`), fullPage: full }) };
}

const toTeam = async (p) => {
  const rail = p.getByTestId('ns-rail-automations');
  if (await rail.count()) await rail.first().click();
  else await p.locator('.sidebar-item').filter({ has: p.locator('.sidebar-label', { hasText: /^AI Team$/ }) }).first().click();
  await p.locator('.aiteam').waitFor({ timeout: 15000 });
};
const toLookout = async (p) => {
  await toTeam(p);
  const row = p.locator('[data-team-row="lookout"]');
  if (await row.count()) await row.first().click();
  await p.locator('.aiteam-stage').first().waitFor({ timeout: 15000 });
  await until(() => p.locator('[data-feed-boundary]').count(), 15000);
  await sleep(800);
};
const key = (run) => `lookout::${run}`;
const scrollTo = async (p, sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 8000 }); };

async function macPass(name, viewport) {
  console.log(`\n── Mac surface ${name}`);
  const v = await open(`mac-${name}`, { viewport }, `http://127.0.0.1:${port}/?vault=proj`);
  const { p } = v;
  await toLookout(p);
  const text = () => p.locator('.aiteam-stage').first().innerText();
  check(`${name}: the sentence of a silent run reads with no tap`, (await text()).includes('Acme is healthy: 3 messages sent.'));
  check(`${name}: no Activity way in`, (await p.locator('[data-team-activity]').count()) === 0);
  await v.shot('1-stage');

  await scrollTo(p, `[data-run-steps="${key(runs.bound)}"]`);
  await p.locator(`[data-run-steps="${key(runs.bound)}"]`).click();
  const steps = p.locator(`[data-run-foot="${key(runs.bound)}"] [data-testid="run-view"]`);
  check(`${name}: Steps open under the bubble`, await until(async () => (await steps.innerText()).includes('RUN-WORDS three messages sent.')));
  const stepsText = await steps.innerText();
  check(`${name}: the composed prompt is hidden`, !stepsText.includes('COMPOSED-PROMPT-MARK'), stepsText);
  check(`${name}: the Mac keeps the full step (Bash is there)`, /Bash|curl|Ran/.test(stepsText), stepsText.slice(0, 200));
  await steps.scrollIntoViewIfNeeded();
  await v.shot('2-steps');
  await p.locator(`[data-run-steps="${key(runs.bound)}"]`).click();

  const live = p.locator(`[data-run-foot="${key(runs.live)}"] [data-testid="run-view"]`);
  await scrollTo(p, `[data-run-foot="${key(runs.live)}"]`);
  check(`${name}: a running run opens its steps by itself`, await until(() => live.count(), 12000));
  const mark = `${name}-${Date.now()}`;
  seed('step', mark);
  check(`${name}: live steps land while it runs`, await until(async () => (await live.innerText()).includes(`live step ${mark}`), 14000));
  await v.shot('3-live');

  const lightReport = p.locator(`[data-feed-report="${key(runs.light)}"]`);
  await lightReport.scrollIntoViewIfNeeded();
  await lightReport.click();
  check(`${name}: Full report opens in place on a run with no session`, await until(async () => (await text()).includes('LIGHT-REPORT-BODY')));
  check(`${name}: that run offers no Steps and says it ran with no session`, (await p.locator(`[data-run-steps="${key(runs.light)}"]`).count()) === 0 && (await p.locator(`[data-run-foot="${key(runs.light)}"] [data-run-line="noSession"]`).count()) === 1);
  await p.locator(`[data-run-foot="${key(runs.light)}"] [data-testid="run-report"]`).scrollIntoViewIfNeeded();
  await v.shot('4-report');
  await lightReport.click();
  return v;
}

const transcript = () => join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-'), `${BOUND}.jsonl`);
const turnsResumed = () => (readFileSync(transcript(), 'utf-8').match(/"RESUMED /g) ?? []).length;

/** The send button: Enter only makes a new line on a phone. */
const send = async (p) => { await p.locator('.aiteam-stage .chat-cmp-send.is-enabled:visible').first().click(); };

/** Continue on the bound run: the pin, a firing routine, the send, the same session, the sentence. */
async function continuePass(name, v) {
  const { p } = v;
  const box = p.locator('.aiteam-stage .chat-cmp-input').first();
  const replies = [];
  const hear = (r) => { if (r.method() === 'POST' && r.url().includes('/thread/reply')) replies.push(r.postDataJSON()); };
  p.on('request', hear);
  await scrollTo(p, `[data-run-continue="${key(runs.bound)}"]`);
  await p.locator(`[data-run-continue="${key(runs.bound)}"]`).click();
  check(`${name}: the pin stands above the box`, await until(() => p.locator(`[data-run-pin="${key(runs.bound)}"]`).count()));
  await box.fill(`please look again ${name}`);
  seed('fire');
  await sleep(6500);
  check(`${name}: a routine firing does not move the pin`, (await p.locator(`[data-run-pin="${key(runs.bound)}"]`).count()) === 1 && (await box.inputValue()) === `please look again ${name}`);
  await v.shot('5-pin');
  const before = turnsResumed();
  await send(p);
  check(`${name}: the send carries the captured run`, await until(() => replies.length > 0) && replies[0].runId === runs.bound, JSON.stringify(replies));
  check(`${name}: Continue resumes the SAME session`, await until(() => turnsResumed() > before, 20000));
  check(`${name}: the box is empty after the send`, (await box.inputValue()) === '');
  const says = async () => (await p.locator('.aiteam-stage').first().evaluate((e) => e.textContent));
  check(`${name}: the run keeps its sentence above the reply`, await until(async () => (await says()).includes('RESUMED')) && (await says()).includes('Acme is healthy: 3 messages sent.'));
  await v.shot('5b-continued');
  // A refusal: the same pin, the same box.
  seed('approval');
  await box.fill(`refused ${name}`);
  await send(p);
  check(`${name}: a refusal shows the server's sentence`, await until(async () => (await p.locator('[data-run-pin-refused]').innerText()).includes('waiting for you to approve'), 10000));
  check(`${name}: the words go back in the box`, await until(async () => (await box.inputValue()).includes(`refused ${name}`)));
  await v.shot('6-refused');
  await box.fill('');
  await p.locator('[data-run-pin-close]').click();
  check(`${name}: X returns the box to a new conversation`, (await p.locator('[data-run-pin]').count()) === 0);
  seed('approved');
  p.off('request', hear);
}

let exit = 0;
try {
  if (!onlySuper) {
  await api('POST', '/api/handsfree/mac/setup', {});
  await api('POST', '/api/handsfree/mac/start', { vaults: ['proj'] });

  const desk = await macPass('1440', { width: 1440, height: 900 });
  const small = await macPass('390', { width: 390, height: 844 });

  console.log('\n── Continue, on the Mac');
  const { p } = desk;
  const text = () => p.locator('.aiteam-stage').first().innerText();
  console.log('\n── A question from the flow, on the Mac');
  const answer = async (page, name, words, pick) => {
    const shelf = page.locator('[data-stage-questions]');
    check(`${name}: the question stands above the box, one line, the flow keeps its room`, await until(async () => (await shelf.innerText()).includes(words)) && (await shelf.boundingBox()).height < 60);
    await page.locator('[data-stage-questions-toggle]').click();
    await shelf.getByText(pick, { exact: false }).first().click();
    await shelf.locator('.chat-surveycard').last().evaluate((e) => e.scrollIntoView({ block: 'end' }));
    await page.screenshot({ path: join(SHOTS, `${name}-7-question.png`) });
    const send = shelf.locator('button').filter({ hasText: /Submit|Send|Answer/ }).last();
    if (await send.count()) await send.click();
    check(`${name}: answered from the flow`, await until(async () => (await shelf.count()) === 0, 12000));
  };
  await answer(p, 'mac-1440', 'Which line should I watch?', 'Line A');
  // After the question: the route refuses on the oldest question open, and that one takes a reply.
  await continuePass('1440', desk);
  await continuePass('390', small);
  await small.ctx.close();

  console.log('\n── Phone listener');
  const qr = (await api('POST', '/api/handsfree/mac/qr')).json.url;
  seed('question', runs.asked);
  const ph = await open('phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }, qr);
  const q = ph.p;
  const close = q.locator('[data-testid="ns-drawer-toggle"]');
  if (await q.locator('[data-testid="chat-drawer"]').isVisible().catch(() => false)) await close.click().catch(() => {});
  await toLookout(q);
  const body = () => q.locator('.aiteam-stage').first().innerText();
  check('phone: the sentence reads with no tap', (await q.locator('.aiteam-stage').first().evaluate((e) => e.textContent)).includes('Acme is healthy: 3 messages sent.'));
  await scrollTo(q, `[data-run-steps="${key(runs.bound)}"]`);
  await q.locator(`[data-run-steps="${key(runs.bound)}"]`).click();
  const stepsP = q.locator(`[data-run-foot="${key(runs.bound)}"] [data-testid="run-view"]`);
  check('phone: the steps show the agent\'s words', await until(async () => (await stepsP.innerText()).includes('RUN-WORDS three messages sent.')));
  await stepsP.scrollIntoViewIfNeeded();
  await ph.shot('2-steps');
  await scrollTo(q, `[data-run-foot="${key(runs.live)}"]`);
  const liveP = q.locator(`[data-run-foot="${key(runs.live)}"] [data-testid="run-view"]`);
  const mark = `phone-${Date.now()}`;
  seed('step', mark);
  check('phone: a live run\'s words land', await until(async () => (await liveP.innerText()).includes(`live step ${mark}`), 14000));
  const report = q.locator(`[data-feed-report="${key(runs.light)}"]`);
  await report.scrollIntoViewIfNeeded(); await report.click();
  check('phone: Full report opens in place with no session', await until(async () => (await body()).includes('LIGHT-REPORT-BODY')));
  await q.locator(`[data-run-foot="${key(runs.light)}"] [data-testid="run-report"]`).scrollIntoViewIfNeeded();
  await ph.shot('3-report');
  await answer(q, 'phone', 'Which line next?', 'Line C');
  await continuePass('phone', ph);
  const subRead = await q.evaluate((id) => fetch(`/api/agent/chat-history?claudeId=${id}&subagent=abc123`, { headers: { 'x-dreamcontext-vault': 'proj' } }).then((r) => r.text()), '22222222-2222-4222-8222-222222222222');
  check('phone: a live run\'s sub-agent reads as words only', subRead.includes('RUN-WORDS sub-agent') && !subRead.includes(TOKEN), subRead.slice(0, 200));

  const reads = ph.bodies.filter((b) => /chat-history|\/session/.test(b.url));
  check('phone: transcript reads happened', reads.length > 0, ph.bodies.length);
  const leak = ph.bodies.filter((b) => b.text.includes(TOKEN) || b.text.includes('acme.example') || b.text.includes('COMPOSED-PROMPT-MARK'));
  check('phone: the fixture token is in no response body', leak.length === 0, leak.map((b) => b.url).join(' '));

  console.log('\n── A banner link');
  const link = await open('link', { viewport: { width: 1440, height: 900 } }, `http://127.0.0.1:${port}/?vault=proj&open=${encodeURIComponent('dreamcontext://project/proj/automation/lookout')}`);
  check('a banner link lands on the stage', await until(() => link.p.locator('[data-stage="lookout"]').count(), 15000));
  await until(() => link.p.locator('[data-feed-boundary]').count(), 10000);
  check('…at the newest run, not a list of runs', (await link.p.locator('[data-team-event], .aiteam-replying').count()) === 0);
  await link.shot('8-banner');
  await link.ctx.close();
  await desk.ctx.close();
  await ph.ctx.close();
  } else {
  // Apart from the rest: a Mac on hands-free has handed its chats over, so nothing starts one here.
  console.log('\n── A Super card');
  const sup = await open('super', { viewport: { width: 1440, height: 900 } }, `http://127.0.0.1:${port}/?vault=proj`);
  const s = sup.p;
  const toChat = async () => {
    const rail = s.getByTestId('ns-rail-chat');
    if (await rail.count()) await rail.first().click().catch(() => {});
    await sleep(1200);
    const start = s.getByTestId('chat-empty-new').first();
    if (!(await s.locator('.chat-cmp-input:visible').count()) && await start.count()) await start.click().catch(() => {});
  };
  await toChat();
  await until(async () => (await s.locator('.chat-cmp-input:visible').count()) > 0, 20000);
  const input = s.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await s.keyboard.press('Enter');
  check('the Super hand-over is offered', await until(() => s.getByTestId('super-handover-btn').count(), 20000));
  await sleep(1500);
  await s.locator('[data-testid="super-handover-btn"]:visible').first().click();
  check('the stage is up', await until(() => s.locator('[data-testid="super-surface"]:visible').count(), 20000));
  await sleep(1500);
  seed('team', runs.bound);
  await s.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3500);
  await toChat();
  const tile = s.getByTestId('super-team-tile').first();
  check('the team card stands on the stage', await until(() => tile.count(), 20000));
  await tile.click();
  const job = s.getByTestId('team-job-conversation').first();
  check('Steps open on a Super card, without the composed prompt', await until(async () => (await job.innerText()).includes('RUN-WORDS three messages sent.'), 15000) && !(await job.innerText()).includes('COMPOSED-PROMPT-MARK'));
  check('no read-only line under a run\'s steps', (await job.locator('[data-testid="super-readonly"]').count()) === 0);
  await s.getByTestId('team-job-report').click();
  check('Full report opens on a Super card', await until(async () => (await job.innerText()).includes('ACME-REPORT-BODY')));
  await sup.shot('9-super-card');
  await sup.ctx.close();

  await api('POST', '/api/handsfree/mac/setup', {});
  await api('POST', '/api/handsfree/mac/start', { vaults: ['proj'] });
  const ph2 = await open('phone-super', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } }, await (async () => (await api('POST', '/api/handsfree/mac/qr')).json.url)());
  const stage = await ph2.p.evaluate(() => fetch('/api/agent/super-stage', { headers: { 'x-dreamcontext-vault': 'proj' } }).then((r) => r.text()));
  check('phone: the remote stage carries the job, never its brief', stage.includes('team-verify-000001') && !stage.includes('Check the line'), stage.slice(0, 160));
  await ph2.ctx.close();
  }
} catch (err) {
  failed.push(`stopped: ${err instanceof Error ? err.message : err}`);
  console.log(`  ✗ stopped: ${err instanceof Error ? err.stack : err}`);
  exit = 1;
}

await browser.close().catch(() => {});
await fetch(`http://127.0.0.1:${port}/api/handsfree/mac/stop`, { method: 'POST' }).catch(() => {});
server.kill();
try { const pid = runs.sleep; if (pid) process.kill(pid); } catch { /* gone */ }
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
for (const f of findings) console.log(`FINDING: ${f}`);
console.log(`\n${passed.length} passed, ${failed.length} failed, ${findings.length} finding(s); shots ${SHOTS}`);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(exit || failed.length || findings.length ? 1 : 0);
