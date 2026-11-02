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
 *   T4  the job's card is on the stage: the member's face and "Scout took the job", done (pushed
 *       when the run ended) with its last line, in the shared tone map's colour on tile and frame
 *       (screenshots at 1280 and 1920 px); a click shows it side by side ON THE STAGE with the
 *       member's conversation (the AI Team pane), written to there, never leaving the Super screen.
 *   T5  (plan-r10 1b, Wave 1) three `super team ask` to ONE member (Gantt): one conversation and ONE
 *       card on the stage reading "3 iş" ("3 jobs" in English), never three cards; the record holds
 *       one root and two follow-ups `by: super` (or, when the stand-in's run left no session to
 *       resume, new roots on the same card). Screenshots at 1440 and 390 in tmp/verify/super-team/.
 *   T6  (plan-r10 1e, Wave 1) an agent-made prompt edit (`agents edit` from inside the member's own
 *       run, DREAMCONTEXT_AGENT_SELF) stamps itself: the member is approved, the edit is traced, and
 *       its AI Team page shows no approve button anywhere. Screenshots at 1440 and 390.
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
/** Wave 1's shots (plan-r10 1b and 1e), read by the lead. */
const OUT_W1 = join(REPO, 'tmp', 'verify', 'super-team');
/** A second member, approved by the owner, for one conversation and one card (T5) and the agent's edit (T6). */
const MEMBER2 = 'gantt';
const THREE = ['Fix the ClickUp assignments', 'Rename Ozan in the plan', 'Close the sprint'];
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const MEMBER = 'scout';
const MEMBER_ANSWER = 'Signups fell 4% on Tuesday; the drop is all on the pricing step.';
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const at0 = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : ''; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\\n');
if (!argv.includes('stream-json')) {
  // The member's run: \`claude -p <prompt> --output-format json\`.
  if (argv.includes('-p')) {
    const prompt = argv[argv.indexOf('-p') + 1] || '';
    report({ kind: 'member-run', prompt: prompt.slice(0, 4000) });
    const memberSession = at0('--resume') || randomUUID();
    if (prompt.includes('which step?')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
    const projDir = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(projDir, { recursive: true });
    appendFileSync(join(projDir, memberSession + '.jsonl'), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: memberSession, timestamp: new Date().toISOString(), message: { role: 'user', content: 'COMPOSED PROMPT LINE' } }) + '\\n');
    appendFileSync(join(projDir, memberSession + '.jsonl'), JSON.stringify({ type: 'assistant', uuid: randomUUID(), sessionId: memberSession, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'MEMBER SESSION LINE' }] } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(MEMBER_ANSWER)}, session_id: memberSession, num_turns: 1, total_cost_usd: 0, duration_ms: 5 }) + '\\n');
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
  if (text.startsWith('[super')) { report({ kind: 'super-turn', text: text.slice(0, 2000) }); return 'noted'; }
  if (text.includes('GO-TEAM')) {
    const steps = [cli('super', 'team', 'ask', ${JSON.stringify(MEMBER)}, 'Look at this week\\'s signup funnel and name the step that dropped.', '--brief', 'Funnel check')];
    report({ kind: 'team', steps });
    return 'asked the team';
  }
  if (text.includes('GO-THREE')) {
    const steps = ${JSON.stringify(THREE)}.map((job) => cli('super', 'team', 'ask', ${JSON.stringify(MEMBER2)}, job, '--brief', job));
    report({ kind: 'three', steps });
    return 'asked the same member three times';
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
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT, OUT_W1]) mkdirSync(d, { recursive: true });
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
    ['agent 2', dc('agents', 'create', MEMBER2, '--title', 'Gantt', '--prompt', 'Keeps the project plan and the ClickUp assignments right.')],
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
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
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
    return /Scout needs your approval\./.test(headText) && /AI Team/.test(headText) && !cut;
  }, 10000), headText);
  ok(tag('T1 with Open in AI Team and Reply'), (await head.getByTestId('super-queue-open-team').count()) === 1
    && (await head.locator('.super-queue-btn--reply').count()) === 1);
  // Under about 1600 px the stage folds its cards into Others: wide enough to keep this one out.
  for (const w of [1920]) {
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
    (await page.locator('.aiteam-stage:visible, .aiteam-convo:visible').filter({ hasText: 'Scout' }).count()) >= 1
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

  console.log(`── ${engineName}: T4 the job's card on the stage`);
  const card = page.locator('[data-testid="super-team-tile"]:visible');
  ok(tag('T4 the job has its card on the stage'), await until(page, async () => (await card.count()) === 1, 15000));
  // New cards wait while the owner types (G1) and then play their entrance: the card must end up
  // really drawn (its frame no longer pending, fully opaque), not just present in the DOM.
  const shown = async () => card.evaluate((el) => {
    const frame = el.closest('[data-container-id]');
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return !!frame && !frame.classList.contains('super-card-frame--pending') && o > 0.99;
  }).catch(() => false);
  ok(tag('T4 it is revealed: drawn fully opaque once the owner stops typing'), await until(page, shown, 30000));
  ok(tag('T4 with the member\'s face and "Scout took the job"'), await until(page, async () =>
    /Scout took the job/.test(await card.getByTestId('super-team-took').innerText().catch(() => ''))
    && (await card.locator('.super-team-who .agent-av, .super-team-who img').count()) === 1, 15000));
  ok(tag('T4 it reads done (pushed when the run ended), with the member\'s last line'), await until(page, async () =>
    (await card.getAttribute('data-team-status')) === 'done'
    && /Signups fell 4%/.test(await card.getByTestId('super-team-line').innerText().catch(() => '')), 30000),
    `${await card.getAttribute('data-team-status')} | ${await card.getByTestId('super-team-line').innerText().catch(() => '')}`);
  // The same tone language as a chat card: the state word is drawn in the tone superTone.css maps
  // its status to (done -> idle -> the accent token), and the frame carries that tone too.
  const tones = await card.evaluate((el) => {
    const frame = el.closest('[data-container-id]');
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { tile: el.getAttribute('data-super-tone'), frame: frame?.getAttribute('data-super-tone'), word: getComputedStyle(el.querySelector('.super-tile-state')).color, accent };
  });
  ok(tag('T4 its tone is the shared map\'s (idle for done), on the tile and the frame'), tones.tile === 'idle' && tones.frame === 'idle' && tones.word === tones.accent, JSON.stringify(tones));
  // Under about 1600 px the stage folds its cards into Others: wide enough to keep this one out.
  for (const w of [1920]) {
    await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 1080 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${engineName}-team-card-${w}.png`) });
    const box = await card.boundingBox();
    ok(tag(`T4 the card is on screen and drawn at ${w} px`), !!box && box.width > 100 && box.x >= 0 && box.x + box.width <= w && await shown(), JSON.stringify(box));
  }
  // A real mouse click on the card (the card frame takes it: a floating card is one grab handle)
  // shows it side by side ON THE STAGE with the member's conversation in it, never AI Team.
  const frame = page.locator('[data-container-id][data-kind="team"]');
  const convo = frame.getByTestId('team-job-conversation');
  // What the card asked the server, so a red here names its cause.
  const wire = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (!/chat-history|thread\/reply|reply-job/.test(u)) return;
    const body = await r.text().catch(() => '');
    wire.push({ at: Date.now(), status: r.status(), url: u.replace(/^.*\/api/, '').slice(0, 90), items: (body.match(/"role"|"kind"/g) ?? []).length, body: r.status() >= 400 ? body.slice(0, 200) : undefined });
  });
  const cb = await card.boundingBox();
  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
  ok(tag('T4 a click on the card opens the job on the stage'), await until(page, async () =>
    (await frame.getAttribute('data-where').catch(() => null)) !== 'float' && await convo.isVisible().catch(() => false), 15000),
    await frame.getAttribute('data-where').catch(() => ''));
  // (The AI Team page stays mounted behind the surface since T2, so what is ON TOP decides.)
  const onSuper = () => frame.evaluate((f) => { const b = f.getBoundingClientRect(); return !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.agent-surface'); });
  ok(tag('T4 …without leaving the Super screen'), await onSuper());
  ok(tag('T4 …it shows the run\'s real session, its transcript'), await until(page, async () => /MEMBER SESSION LINE/.test(await convo.innerText().catch(() => '')), 20000),
    (await convo.innerText().catch(() => '')).slice(0, 400));
  ok(tag('T4 …without the prompt the runner composed'), !/COMPOSED PROMPT LINE/.test(await convo.innerText().catch(() => '')));
  ok(tag('T4 …and no read-only line under a run\'s steps'), (await convo.getByTestId('super-readonly').count()) === 0);
  ok(tag('T4 …never the composer of a new conversation'), !/Start a new conversation/.test(await frame.innerHTML()));
  const memberInput = convo.getByTestId('team-job-reply');
  ok(tag('T4 …and it can be continued'), await until(page, async () => (await memberInput.count()) === 1 && await memberInput.isEnabled(), 20000));
  await memberInput.fill('which step?'); await convo.getByRole('button', { name: 'Send' }).click();
  const sentAt = Date.now();
  const trace = [];
  let closedShot = false;
  for (let i = 0; i < 60; i++) {
    const job = (record().team ?? []).find((j) => j.followUpOf);
    const closed = await convo.getByTestId('team-job-closed').isVisible().catch(() => false);
    trace.push({ ms: Date.now() - sentAt, card: await convo.getAttribute('data-team-status').catch(() => null), closed, followUp: job ? { open: job.open, told: job.told, outcome: job.outcome } : null });
    if (closed && !closedShot) { closedShot = true; await page.screenshot({ path: join(OUT, `${engineName}-team-card-closed.png`) }); }
    await page.waitForTimeout(250);
  }
  ok(tag('T4 …while the member answers the composer is honestly closed'), closedShot, (await convo.innerText().catch(() => '')).slice(-300));
  ok(tag('T4 …the Super hears what the owner wrote and the answer, once'), await until(page, async () => reports().filter((r) => r.kind === 'super-turn' && /followup=owner/.test(r.text) && /which step\?/.test(r.text)).length === 1, 150000),
    JSON.stringify(reports().filter((r) => r.kind === 'super-turn').slice(-3)).slice(0, 900));
  ok(tag('T4 …and the composer opens again'), await until(page, async () => (await memberInput.count()) === 1, 15000));
  writeFileSync(join(OUT, `${engineName}-card-trace.json`), JSON.stringify({ trace: trace.filter((x, i) => i === 0 || JSON.stringify({ ...x, ms: 0 }) !== JSON.stringify({ ...trace[i - 1], ms: 0 })), wire, heard: reports().filter((r) => r.kind === 'super-turn').map((r) => ({ t: r.t - sentAt, head: r.text.slice(0, 260) })), team: record().team, queue: (record().queue ?? []).slice(-4), members: reports().filter((r) => r.kind === 'member-run').map((r) => ({ t: r.t - sentAt, p: r.prompt.slice(0, 80) })) }, null, 1));
  // Its opening flight has landed (the frame's fade-in done) before the picture.
  await until(page, async () => frame.evaluate((f) => !f.getAnimations().length && getComputedStyle(f).opacity === '1'), 5000);
  await page.screenshot({ path: join(OUT, `${engineName}-team-card-opened.png`) });
  // The keyboard does what the click does: back to its tile, Enter on the focused card opens it too.
  await frame.getByTestId('super-card-minimize').click();
  ok(tag('T4 minimized, it is a floating tile again'), await until(page, async () =>
    (await frame.getAttribute('data-where').catch(() => null)) === 'float' && (await card.count()) === 1 && await shown(), 15000));
  await page.waitForTimeout(600);
  await frame.evaluate((el) => el.focus());
  await page.keyboard.press('Enter');
  ok(tag('T4 Enter on the focused card opens it on the stage too'), await until(page, async () =>
    (await frame.getAttribute('data-where').catch(() => null)) !== 'float' && await convo.isVisible().catch(() => false)
    && await onSuper(), 15000));
  // The new card at the owner's two widths, open.
  for (const w of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w[0], height: w[1] });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, `${engineName}-team-card-${w[0]}-open.png`) });
    console.log(`  card at ${w[0]}: conversation visible ${await convo.isVisible().catch(() => false)}, overflow ${await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)}`);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await frame.getByTestId('super-card-minimize').click().catch(() => {});

  console.log(`── ${engineName}: T5 three asks to one member, one card`);
  // Under about 1600 px the stage folds its cards into Others (T4): wide enough to keep them out.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(800);
  const t5 = await superDoes(page, 'GO-THREE', 'three', 90000);
  ok(tag('T5 three team asks to one member all go through'), (t5?.steps ?? []).length === 3 && t5.steps.every((x) => x.status === 0), JSON.stringify(t5?.steps?.map((x) => x.out.slice(0, 200))));
  const gJobs = (record().team ?? []).filter((j) => j.member === MEMBER2);
  const gRoots = gJobs.filter((j) => !j.followUpOf);
  ok(tag('T5 the record holds three jobs for the member, Super\'s follow-ups marked by super'), gJobs.length === 3 && gJobs.filter((j) => j.followUpOf).every((j) => j.by === 'super'), JSON.stringify(gJobs));
  const gCards = (record().containers ?? []).filter((c) => c.kind === 'team' && gJobs.some((j) => j.id === c.ref));
  ok(tag('T5 ONE card for the member on the record, pointing at its current root'), gCards.length === 1 && gCards[0].ref === gRoots[0]?.id, JSON.stringify(gCards));
  const gTile = page.locator('[data-testid="super-team-tile"]:visible').filter({ hasText: 'Gantt' });
  ok(tag('T5 ONE Gantt tile on the stage'), await until(page, async () => (await gTile.count()) === 1, 20000), String(await gTile.count()));
  // No \b after "iş": in JS a word boundary never follows a non-ASCII letter.
  const threeJobs = /(^|[^0-9])3 (iş|jobs)(?![A-Za-z])/;
  ok(tag('T5 it reads "3 iş"'), await until(page, async () => threeJobs.test(await gTile.getByTestId('super-team-jobs').innerText().catch(() => '')), 20000),
    await gTile.getByTestId('super-team-jobs').innerText().catch(() => ''));
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);
    // The card is drawn at this width (on the stage, or in Others when the stage folds it there).
    const seen = page.locator('[data-testid="super-team-tile"]').filter({ hasText: 'Gantt' });
    if (!(await seen.first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="super-others-open"]:visible').first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    const shown = await seen.first().isVisible().catch(() => false);
    const reads = shown ? await seen.first().getByTestId('super-team-jobs').innerText().catch(() => '') : '';
    ok(tag(`T5 at ${w} px the one Gantt card is drawn and reads "3 iş"`), shown && threeJobs.test(reads), `${shown} | ${reads}`);
    await page.screenshot({ path: join(OUT_W1, `${engineName}-one-card-${w}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });

  console.log(`── ${engineName}: T6 an agent's prompt edit asks nothing`);
  const edit = spawnSync(process.execPath, [CLI, 'agents', 'edit', MEMBER2, '--prompt', 'Keeps the project plan and the ClickUp assignments right.\nNames the owner of each item.'],
    { cwd: PROJ, env: { ...env(), DREAMCONTEXT_AGENT_SELF: MEMBER2 }, encoding: 'utf-8' });
  ok(tag('T6 the member\'s own run edits its prompt'), edit.status === 0, edit.stderr || edit.stdout);
  const listed = dc('agents', 'list', '--json');
  let gRow = null; try { gRow = JSON.parse(listed.stdout).agents.find((a) => a.slug === MEMBER2); } catch { /* reported below */ }
  ok(tag('T6 it stays approved to run, with no card'), gRow?.approvedToRun === true, listed.stdout.slice(0, 400));
  const traced = dc('agents', 'amendments', MEMBER2, '--json');
  ok(tag('T6 the edit is traced, by agent, waiting for nothing'), /"by": "agent"/.test(traced.stdout) && !/"waits": true/.test(traced.stdout), traced.stdout.slice(0, 400));
  await page.evaluate((slug) => window.dispatchEvent(new CustomEvent('dreamcontext-open-agents', { detail: { slug } })), MEMBER2);
  ok(tag('T6 the AI Team page opens on the member'), await until(page, async () =>
    (await page.locator('.aiteam:visible').count()) === 1
    && (await page.locator('.aiteam-stage:visible, .aiteam-convo:visible').filter({ hasText: 'Gantt' }).count()) >= 1, 15000));
  const team = page.locator('.aiteam:visible');
  const approveCount = async () => (await team.locator('[data-team-approval], [data-approval-review], .adp-approve-btn, [data-review-approval]').count())
    + (await team.getByRole('button', { name: /^(Approve|Onayla)/ }).count());
  await page.waitForTimeout(1500);
  ok(tag('T6 no approve button anywhere on its page'), (await approveCount()) === 0, String(await approveCount()));
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);
    ok(tag(`T6 at ${w} px the member's page shows no approve button`), (await approveCount()) === 0, String(await approveCount()));
    await page.screenshot({ path: join(OUT_W1, `${engineName}-agent-edit-no-approve-${w}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
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
  console.log(`screenshots: ${OUT} and ${OUT_W1}`);
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
