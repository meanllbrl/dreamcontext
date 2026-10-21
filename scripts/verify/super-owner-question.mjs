#!/usr/bin/env node
/**
 * A question the Super Agent puts to the owner reaches him, and the agent is told whether it
 * did (task super-agent-acikken-…-cocuklar-susar, run 2: Tilki 2026-10-21, three `super queue
 * ask`s nobody saw, AskUserQuestion locking the super turn for 82 minutes).
 *
 *   npm run build && node scripts/verify/super-owner-question.mjs
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard in
 * Chromium, the real chat sockets and the real CLI run from INSIDE the spawned chats with only
 * the env the server gave them. `claude` is a scripted stand-in (no tokens). It proves:
 *   1. hand over one chat; the owner is ON the Super stage (a presence report, what the desktop
 *      window sends): the Super Agent's own `super ask` answers reached:true via screen; the
 *      glance (the notch) lists it; its option on the job bar sends "Answer to your question: …"
 *      into the SUPER chat;
 *   2. the owner AWAY (no presence) and no notifier on this machine: a child's AskUserQuestion is
 *      escalated with `super queue ask`; the reply says reached:false with a note that forbids
 *      "I asked you"; that turn's end is NOT swallowed (a notch inbox row for the super session);
 *      the job bar's option answers the CHILD.
 * Run 3 (owner 2026-10-21 "soruyu hep chatta sorsun"): both questions are ALSO a card in the super
 * chat under the turn that asked (the stand-in asks through a real Bash tool call), answered from
 * the card (to the super / to the child), never locking the super's turn; a question asked with no
 * readable call is drawn at the chat's end; a phone has no super chat at all.
 * Banner and phone pushes need the desktop notifier and Mac mode: tests/unit/super-owner-question.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dc-verify-super-owner-q-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-owner-question');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const AWAY = join(SCRATCH, 'away');

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-oq-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let awaiting = null;
let seq = 0;
const ask = (request) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: request.tool_name, input: request.input }] } });
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', ...request, tool_use_id: id, requires_user_interaction: true } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } }); resolve(r); };
});
// A CLI call the way claude makes it: a Bash tool_use the transcript shows, then its result.
const shq = (a) => /^[A-Za-z0-9_.\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'";
const bashCall = (...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description: 'Ask the owner' } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim() }], is_error: r.status !== 0 }] } });
  return r;
};
async function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', children: Object.keys(cli('super', 'state').json?.children ?? {}) }); return 'arranged'; }
  if (text.startsWith('[super event')) {
    const q = cli('super', 'queue', 'list');
    const items = q.json?.queue ?? [];
    const question = items.find((i) => i.kind === 'question' && i.state !== 'done' && i.state !== 'escalated');
    // The harness says when the owner has gone: it removes the presence first.
    for (let i = 0; i < 50 && !existsSync(${JSON.stringify(AWAY)}); i += 1) await sleep(200);
    const esc = question ? bashCall('super', 'queue', 'ask', question.id, 'The login button: blue or green?') : null;
    report({ kind: 'escalated', esc });
    return 'Which colour for the login button: blue or green?';
  }
  if (text.includes('GO-ASKOWNER')) { const r = bashCall('super', 'ask', 'Ship the login fix now?', '--options', 'Ship it|Wait'); report({ kind: 'asked', r }); return 'Ship the login fix now?'; }
  // Asked with no tool row the chat can read (the tail must still draw it).
  if (text.includes('GO-ASKQUIET')) { const r = cli('super', 'ask', 'Rename the app to Acme Go?', '--options', 'Yes|No'); report({ kind: 'askedQuiet', r }); return 'One more question for you.'; }
  const go = text.match(/GO-CHILDASK (\\S+)/);
  if (go) { report({ kind: 'sent', r: cli('super', 'send', go[1], 'ASK-Q') }); return 'asked the child'; }
  if (text.startsWith('Answer to your question:')) { report({ kind: 'answer', text }); return 'noted'; }
  report({ kind: 'owner', text });
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('ASK-Q')) {
    const r = await ask({ tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour for the login button?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'brand' }, { label: 'Green', description: 'go' }] }] } });
    report({ kind: 'answered', response: r });
    return 'got answer';
  }
  return 'ok';
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') { if (awaiting) { const r = awaiting; awaiting = null; r(o.response && o.response.response); } continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(OUT, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const frames = () => readNd(FRAMES);
const fails = [];
const ok = (label, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`); if (!cond) fails.push(label); return !!cond; };
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };
async function say(page, text) {
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
const result = (r) => r?.json?.result ?? r?.json ?? {};

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const presence = (vault, sessionId = null) => fetch(`${base}/api/assistant/presence`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'main', vault, sessionId }) });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1600, height: 1000 } } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    console.log('\n── one chat, handed over');
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
    await say(page, 'hello');
    await until(page, async () => frames().some((f) => f.role === 'child'), 30000);
    await page.waitForTimeout(1500);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
    ok('the super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    const child = reports().find((r) => r.kind === 'handover')?.children?.[0];
    ok('one child adopted', !!child, JSON.stringify(reports()));
    await until(page, async () => (await page.locator('[data-super-slot="centre"] .chat-cmp-input').count()) > 0, 20000);
    await page.waitForTimeout(1500);

    console.log('\n── the super agent\'s own question, the owner on the Super stage');
    // On the Super stage: what the desktop window reports (its presence names the super session).
    const superSession = (await (await fetch(`${base}/api/super/state`, { headers: { 'x-dreamcontext-vault': 'acme-app' } })).json()).session;
    await presence('acme-app', superSession);
    await page.locator('[data-super-slot="centre"] .chat-cmp-input').first().click();
    await page.locator('[data-super-slot="centre"] .chat-cmp-input').first().fill('GO-ASKOWNER');
    await page.keyboard.press('Enter');
    ok('super ask ran', await until(page, async () => reports().some((r) => r.kind === 'asked'), 30000));
    const asked = reports().find((r) => r.kind === 'asked')?.r;
    console.log(`      reply: ${JSON.stringify(result(asked))}`);
    ok('super ask: exit 0, asked, shown, reached via screen', asked?.status === 0 && result(asked).asked === true && result(asked).shown === true && result(asked).reached === true && (result(asked).via ?? []).includes('screen'), asked?.out);
    ok('…its note tells it to end the turn, never to wait', /end your turn; never wait/.test(result(asked).note ?? ''), result(asked).note);
    const glance = await (await fetch(`${base}/api/assistant/glance`)).json();
    ok('the notch glance lists it (SuperAsk row with its options)', (glance.chats ?? []).some((c) => c.super && c.ask?.tool === 'SuperAsk' && /Ship the login fix/.test(c.ask.text) && (c.ask.options ?? []).join('|') === 'Ship it|Wait'), JSON.stringify(glance.chats));
    ok('the job bar draws it at its head with its options', await until(page, async () => /Ship the login fix/.test(await page.getByTestId('super-queue-head').innerText()) && (await page.getByTestId('super-ask-option').count()) === 2, 15000));

    console.log('\n── the question is IN the super chat, under the turn that asked it');
    const centre = page.locator('[data-super-slot="centre"]');
    const askCard = centre.locator('[data-testid="super-question-card"][data-item]').filter({ hasText: 'Ship the login fix now?' });
    ok('a question card in the super chat, open, with both options', await until(page, async () => (await askCard.count()) === 1
      && (await askCard.getAttribute('data-state')) === 'open'
      && (await askCard.getByTestId('super-question-option').allInnerTexts()).map((x) => x.trim().replace(/\s*\d$/, '')).join('|') === 'Ship it|Wait', 15000));
    ok('…drawn after the asking turn (its Bash row and its prose come before it)', await askCard.evaluate((card) => {
      const all = [...card.closest('[data-super-slot="centre"]').querySelectorAll('*')];
      const prose = all.filter((el) => el.children.length === 0 && /Ship the login fix now\?/.test(el.textContent ?? '') && !card.contains(el));
      return prose.length > 0 && prose.every((el) => el.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
    }));
    ok('the turn is NOT locked: the super\'s turn ended, the composer takes text, no AskUserQuestion card', await until(page, async () => reports().some((r) => r.role === 'super' && r.kind === 'turn-end' && r.said === 'Ship the login fix now?')
      && await centre.locator('.chat-cmp-input').first().isEditable()
      && (await centre.locator('.chat-surveycard:not(.super-question-card)').count()) === 0, 15000));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, '01-ask-card-1440.png') });
    await askCard.getByTestId('super-question-option').filter({ hasText: 'Ship it' }).click();
    ok('the card\'s option sends "Answer to your question: Ship it" into the SUPER chat', await until(page, async () => reports().some((r) => r.role === 'super' && r.kind === 'answer' && r.text.startsWith('Answer to your question: Ship it')), 20000), JSON.stringify(frames().slice(-4)));
    ok('…once: one answer frame only', reports().filter((r) => r.role === 'super' && r.kind === 'answer').length === 1, JSON.stringify(reports().filter((r) => r.kind === 'answer')));
    ok('…the card shows the answer and closes', await until(page, async () => (await askCard.getAttribute('data-state')) === 'answered' && /You answered: Ship it/.test(await askCard.innerText()) && (await askCard.getByTestId('super-question-option').count()) === 0, 15000));
    ok('…and the job bar head drops', await until(page, async () => (await page.getByTestId('super-queue-head').count()) === 0, 15000));
    await page.screenshot({ path: join(OUT, '02-ask-answered-1440.png') });

    console.log('\n── a question with no readable call still reaches the chat (the tail), answered in words');
    await centre.locator('.chat-cmp-input').first().click();
    await centre.locator('.chat-cmp-input').first().fill('GO-ASKQUIET');
    await page.keyboard.press('Enter');
    ok('super ask (no tool row) ran', await until(page, async () => reports().some((r) => r.kind === 'askedQuiet' && r.r?.status === 0), 30000), JSON.stringify(reports().slice(-3)));
    const quiet = centre.locator('[data-testid="super-question-card"]').filter({ hasText: 'Rename the app to Acme Go?' });
    ok('…its card is drawn at the chat\'s end, open, with its options', await until(page, async () => (await quiet.count()) === 1 && (await quiet.getAttribute('data-state')) === 'open' && (await quiet.getByTestId('super-question-option').count()) === 2, 15000));
    await until(page, async () => reports().some((r) => r.role === 'super' && r.kind === 'turn-end' && r.said === 'One more question for you.'), 15000);
    await centre.locator('.chat-cmp-input').first().click();
    await centre.locator('.chat-cmp-input').first().fill('Not now, keep the name');
    await page.keyboard.press('Enter');
    ok('…written words reach the super and close it: the tail card goes, the bar head drops', await until(page, async () => reports().some((r) => r.role === 'super' && r.kind === 'owner' && r.text === 'Not now, keep the name')
      && (await quiet.count()) === 0 && (await page.getByTestId('super-queue-head').count()) === 0, 20000));

    console.log('\n── a child\'s question escalated while the owner is away (no presence, no notifier)');
    await centre.locator('.chat-cmp-input').first().click();
    await centre.locator('.chat-cmp-input').first().fill(`GO-CHILDASK ${child}`);
    await page.keyboard.press('Enter');
    ok('the child asked (AskUserQuestion)', await until(page, async () => frames().some((f) => f.role === 'child' && f.blocks[0] === 'ASK-Q'), 30000));
    // He leaves: the window's report withdrawn (what a blur sends), then the event turn escalates.
    await until(page, async () => frames().some((f) => f.role === 'super' && /^\[super events?\]/.test(f.blocks[0] ?? '')), 60000);
    await presence(null);
    writeFileSync(AWAY, '1');
    ok('the super agent escalated it (queue ask)', await until(page, async () => reports().some((r) => r.kind === 'escalated'), 40000), JSON.stringify(reports().slice(-3)));
    const esc = reports().find((r) => r.kind === 'escalated')?.esc;
    console.log(`      reply: ${JSON.stringify(result(esc))}`);
    ok('queue ask: exit 0, escalated, shown, reached FALSE, via []', esc?.status === 0 && result(esc).escalated === true && result(esc).shown === true && result(esc).reached === false && (result(esc).via ?? []).length === 0, esc?.out);
    ok('…its note says he has NOT seen it and forbids "I asked you"', /NOT seen/.test(result(esc).note ?? '') && /do not tell him you asked/.test(result(esc).note ?? ''), result(esc).note);
    ok('the unseen turn kept its own notch row (inbox: the super session finished)', await until(page, async () => {
      const inbox = await (await fetch(`${base}/api/assistant/inbox`)).json();
      return (inbox.events ?? []).some((e) => e.kind === 'finished' && e.vault === 'acme-app' && /blue or green/.test(e.lastText ?? ''));
    }, 15000), JSON.stringify((await (await fetch(`${base}/api/assistant/inbox`)).json()).events));
    ok('the job bar draws the escalated question', await until(page, async () => /blue or green/.test(await page.getByTestId('super-queue-head').innerText()), 15000));
    const escCard = centre.locator('[data-testid="super-question-card"][data-kind="question"]');
    ok('the escalated question is a card in the super chat with the CHILD\'s options', await until(page, async () => (await escCard.count()) === 1
      && /blue or green/.test(await escCard.innerText())
      && (await escCard.getByTestId('super-question-option').allInnerTexts()).map((x) => x.trim().replace(/\s*\d$/, '')).join('|') === 'Blue|Green', 15000));
    await page.screenshot({ path: join(OUT, '03-escalated-card-1440.png') });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(800);
    ok('at 900 wide (a narrow desktop window) the card is still in the chat with its options', (await escCard.count()) === 1 && (await escCard.getByTestId('super-question-option').count()) === 2);
    await page.screenshot({ path: join(OUT, '04-escalated-card-900.png') });
    await escCard.getByTestId('super-question-option').filter({ hasText: 'Blue' }).click();
    ok('the card\'s option answers the CHILD', await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'answered' && JSON.stringify(r.response).includes('Blue')), 20000), JSON.stringify(reports().filter((r) => r.kind === 'answered')));
    ok('…never the super (no second answer frame)', reports().filter((r) => r.role === 'super' && r.kind === 'answer').length === 1);
    ok('…the card shows the answer, the bar head drops', await until(page, async () => (await escCard.getAttribute('data-state')) === 'answered' && /You answered: Blue/.test(await escCard.innerText()) && (await page.getByTestId('super-queue-head').count()) === 0, 15000));
    await page.screenshot({ path: join(OUT, '05-escalated-answered-900.png') });

    console.log('\n── a phone (390, touch) has no super chat by design: no card, no errors');
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const phone = await phoneCtx.newPage();
    phone.on('console', (m) => { if (m.type() === 'error') errors.push(`[phone] ${m.text()}`); });
    phone.on('pageerror', (e) => errors.push(`[phone] ${String(e)}`));
    await phone.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await phone.waitForTimeout(3500);
    ok('no Super stage and no question card on the phone', (await phone.locator('[data-testid="super-surface"]').count()) === 0 && (await phone.locator('[data-testid="super-question-card"]').count()) === 0);
    await phone.screenshot({ path: join(OUT, '06-phone-390.png') });
    await phoneCtx.close();
    const real = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(e));
    ok('no console errors', real.length === 0, real.join('\n'));
  } finally {
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} failed` : '✓ all passed'} — screenshots and video in ${OUT}`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
