#!/usr/bin/env node
/**
 * The Super Agent asks EXACTLY the way any agent asks (owner 2026-10-22: "atomik olarak normal
 * agent nasıl soru soruyorsa Super Agent de öyle sormalı"), its question rings like any agent's,
 * and nothing that came in while it was open is lost
 * (task super-agent-soruyu-normal-ajan-gibi-sorar-…).
 *
 *   npm run build && node scripts/verify/super-ask-atomic.mjs [outDirName]
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard in
 * Chromium, the real chat sockets and the real CLI run from INSIDE the spawned chats. `claude` is
 * a scripted stand-in (no tokens). Run against an older build it records the "before".
 *   1. ALARM. The owner is in the project on another page (the chat surface down) and the window
 *      is not focused: a normal agent's AskUserQuestion raises the alarm (chime + banner); then,
 *      handed over, the Super Agent's `super ask` must raise the same.
 *   2. SAME CARD. `super ask --json` (AskUserQuestion's shape: title, description, option
 *      descriptions, a preview, a multi-select second question) is drawn in the super chat by the
 *      chat's own card: the class signature of its subtree equals the normal agent's card's.
 *      The job bar has no option buttons, only Answer.
 *   3. ANSWER. Picks + a note + a multi-pick go back as ONE `[super answer]` message, and what
 *      came in while it was open (a job the owner waited on, finished) rides in the same message
 *      as `<super-while-you-asked>`. The transcript shows the card's receipt, not a bubble.
 *   4. UNCLEAR and SWIPE on the same card.
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
const SCRATCH = join(tmpdir(), `dc-verify-super-ask-atomic-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-soru-atomik', process.argv[2] ?? 'after');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');

// AskUserQuestion's own input: what a normal agent asks, and what the super asks with --json.
const SPEC = {
  title: 'Login fix · ship or wait',
  questions: [
    {
      question: 'Ship the login fix now?', header: 'Ship', description: 'The release train leaves at five; the fix is tested.', multiSelect: false,
      options: [
        { label: 'Ship it', description: 'Goes out with today\'s train' },
        { label: 'Wait', description: 'Holds it for next week', preview: '<div class="dc-card"><div class="dc-card-title">Next train</div><p class="dc-p">Monday 09:00</p></div>' },
      ],
    },
    {
      question: 'Who tells the team?', header: 'Tell', multiSelect: true,
      options: [{ label: 'Me', description: 'You post it' }, { label: 'Claude', description: 'The agent posts it' }, { label: 'Nobody', description: 'No post' }],
    },
  ],
};
const SWIPE = {
  title: 'Release notes · keep or cut',
  questions: [
    { question: 'Keep the dark-mode line?', header: 'Dark', options: [{ label: 'Keep' }, { label: 'Cut' }] },
    { question: 'Keep the speed line?', header: 'Speed', options: [{ label: 'Keep' }, { label: 'Cut' }] },
  ],
  metadata: { source: 'swipe' },
};

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-aa-' + process.pid;
const SPEC = ${JSON.stringify(SPEC)};
const SWIPE = ${JSON.stringify(SWIPE)};
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
const shq = (a) => /^[A-Za-z0-9_.\\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\\\''") + "'";
const bashCall = (...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description: 'Ask the owner' } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim() }], is_error: r.status !== 0 }] } });
  return r;
};
async function superTurn(blocks) {
  const text = blocks[0] ?? '';
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', children: Object.keys(cli('super', 'state').json?.children ?? {}) }); return 'arranged'; }
  if (text.startsWith('[super event')) {
    report({ kind: 'events', text });
    // A child's question: escalate it to the owner (the super cannot settle it).
    // The record marks it delivered just after the turn is written: pending or delivered here.
    const q = (cli('super', 'queue', 'list').json?.queue ?? []).find((i) => i.kind === 'question' && (i.state === 'delivered' || i.state === 'pending'));
    if (q) { const r = bashCall('super', 'queue', 'ask', q.id, 'The login button: blue or green?'); report({ kind: 'escalated', r }); return 'The login button: blue or green?'; }
    return '';
  }
  const ca = text.match(/GO-CHILDASK (\\S+)/);
  if (ca) { report({ kind: 'sentAsk', r: cli('super', 'send', ca[1], 'ASK-COLOUR') }); return 'Asked the child.'; }
  if (text.startsWith('[super answer]')) { report({ kind: 'answer', text, blocks }); return 'noted'; }
  const fin = text.match(/GO-CHILDFINISH (\\S+)/);
  if (fin) { report({ kind: 'sent', r: cli('super', 'send', fin[1], 'FINISH') }); return 'The report job is running.'; }
  // Asked a moment after the owner's message, so the owner has left the stage by then.
  if (text.includes('GO-ASKLEGACY')) { await sleep(2500); const r = bashCall('super', 'ask', 'Rename the app to Acme Go?', '--options', 'Yes|No'); report({ kind: 'askedLegacy', r }); return 'Rename the app to Acme Go?'; }
  if (text.includes('GO-ASKJSON')) { const r = bashCall('super', 'ask', '--json', JSON.stringify(SPEC)); report({ kind: 'askedJson', r }); return 'Ship the login fix now?'; }
  if (text.includes('GO-ASKSWIPE')) { const r = bashCall('super', 'ask', '--json', JSON.stringify(SWIPE)); report({ kind: 'askedSwipe', r }); return 'Two release-note lines to keep or cut.'; }
  report({ kind: 'owner', text, blocks });
  return 'ok';
}
async function childTurn(text) {
  if (text.includes('ASK-NORMAL')) {
    await sleep(2500);
    const r = await ask({ tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: SPEC });
    report({ kind: 'answeredNormal', response: r });
    return 'got it';
  }
  if (text.includes('ASK-COLOUR')) {
    const r = await ask({ tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: { title: 'Login page · button colour', questions: [{ question: 'Which colour for the login button?', header: 'Colour', description: 'The brand guide allows both.', multiSelect: false, options: [{ label: 'Blue', description: 'Brand blue' }, { label: 'Green', description: 'Reads as go' }] }] } });
    report({ kind: 'answeredColour', response: r });
    return 'Blue it is.';
  }
  if (text.includes('FINISH')) return 'The weekly report is ready: 12 new sign-ups.';
  return 'ok';
}
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks) : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  if (said) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
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

// The window's alarm, observable headless: every banner (the browser Notification arm of
// `postBanner`) and every chime (two oscillators per `playAskChime`). `__dcFocus = false` makes
// the window report no focus, as when the owner is in another app.
const INSTRUMENT = `
  window.__notes = []; window.__osc = 0; window.__dcFocus = true;
  const realHasFocus = Document.prototype.hasFocus;
  Document.prototype.hasFocus = function () { return window.__dcFocus === false ? false : realHasFocus.call(this); };
  class N { constructor(title, o) { window.__notes.push({ title, body: o && o.body }); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } }
  window.Notification = N;
  const AC = window.AudioContext;
  if (AC) { const co = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc += 1; return co.call(this); }; }
`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
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
const fails = [];
const results = [];
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? `\n      ${String(detail).slice(0, 900)}` : ''}`);
  results.push({ label, pass: !!cond });
  if (!cond) fails.push(label);
  return !!cond;
};
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };
const result = (r) => r?.json?.result ?? r?.json ?? {};

/** Answer an AskUserQuestion card the way the owner does: per page, click each label (an option
 *  row or a preview tile), type the note, then Next, and Submit on the last page. */
async function answerCard(page, card, pages) {
  for (let i = 0; i < pages.length; i += 1) {
    const { labels, note } = pages[i];
    const cur = card.locator('.chat-surveycard-page').nth(i);
    for (const label of labels) {
      const title = cur.locator('.chat-surveycard-opt-title, .chat-surveycard-tile-label, .chat-surveycard-tile-foot').filter({ hasText: new RegExp(`^\\s*${label}\\b`) }).first();
      await title.click();
      await page.waitForTimeout(150);
    }
    if (note) await cur.locator('.chat-surveycard-fieldinput').fill(note);
    await card.locator('.chat-btn.primary').click();
    await page.waitForTimeout(450);
  }
}

/** The class signature of a card's subtree: every distinct class name, sorted. */
const signature = (loc) => loc.evaluate((root) => [...new Set([root, ...root.querySelectorAll('*')].flatMap((el) => [...el.classList]))].sort());

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const presence = (vault, sessionId = null) => fetch(`${base}/api/assistant/presence`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'main', vault, sessionId }) });
  const superState = async () => (await fetch(`${base}/api/super/state`, { headers: { 'x-dreamcontext-vault': 'acme-app' } })).json();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 1000 } } });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const alarms = () => page.evaluate(() => ({ notes: window.__notes.length, chimes: Math.floor(window.__osc / 2), last: window.__notes[window.__notes.length - 1] ?? null }));
  const away = async () => {
    // Another page of the same project (the chat surface down), the window not focused.
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Tasks$/ }) }).first().click();
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__dcFocus = false; });
  };
  const back = async () => {
    await page.evaluate(() => { window.__dcFocus = true; });
    const nav = page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Chat$/ }) }).first();
    if (await nav.count()) await nav.click();
    await page.waitForTimeout(800);
  };
  const say = async (loc, text) => { await loc.click(); await loc.fill(text); await page.keyboard.press('Enter'); };
  try {
    console.log('\n── a normal agent\'s question, the owner on another page and away from the window');
    await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
    await say(page.locator('.chat-cmp-input:visible').first(), 'ASK-NORMAL');
    await away();
    const a0 = await alarms();
    ok('the normal question rings: a chime and a banner while he is on another page', await until(page, async () => { const a = await alarms(); return a.notes > a0.notes && a.chimes > a0.chimes; }, 15000), JSON.stringify(await alarms()));
    const normalAlarm = await alarms();
    console.log(`      normal alarm: ${JSON.stringify(normalAlarm)}`);
    await page.screenshot({ path: join(OUT, '01-normal-alarm-away-1440.png') });
    await back();
    const normalCard = page.locator('.chat-surveycard').first();
    ok('the normal card is in its chat', await until(page, async () => (await normalCard.count()) > 0, 15000));
    const normalSig = await signature(normalCard).catch(() => []);
    await page.screenshot({ path: join(OUT, '02-normal-card-1440.png') });
    // Answer it (pick on each page, submit) so the chat is free for the hand-over.
    await answerCard(page, normalCard, [{ labels: ['Ship it'] }, { labels: ['Me'] }]).catch((e) => console.log(`      (answer: ${String(e).slice(0, 160)})`));
    ok('the normal question answered', await until(page, async () => reports().some((r) => r.kind === 'answeredNormal'), 20000));
    await page.waitForTimeout(1500);

    console.log('\n── hand over');
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    ok('the Super stage shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
    ok('the super agent took the hand-over', await until(page, async () => reports().some((r) => r.kind === 'handover'), 60000));
    const child = reports().find((r) => r.kind === 'handover')?.children?.[0];
    const centreInput = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
    await until(page, async () => (await centreInput.count()) > 0, 20000);
    await page.waitForTimeout(1500);
    const superSession = (await superState()).session;
    await presence('acme-app', superSession);

    console.log('\n── a child asks; the super escalates it (the owner\'s first open question)');
    const centre = page.locator('[data-super-slot="centre"]');
    await say(centreInput, `GO-CHILDASK ${child}`);
    ok('the child\'s question was escalated', await until(page, async () => reports().some((r) => r.kind === 'escalated' && r.r?.status === 0), 60000), JSON.stringify(reports().slice(-3)));
    const escCard = centre.locator('[data-testid="super-question-card"][data-kind="question"]');
    ok('…the child\'s own AskUserQuestion is the card in the super chat (context, why line, option descriptions)', await until(page, async () => (await escCard.locator('.chat-surveycard').count()) === 1
      && /Login page · button colour/.test(await escCard.innerText()) && /Brand blue/.test(await escCard.innerText()), 15000));
    await page.screenshot({ path: join(OUT, '03-escalated-child-card-1440.png') });

    console.log('\n── the Super Agent asks while that one is open, the owner on another page and away');
    await say(centreInput, 'GO-ASKLEGACY');
    await presence('acme-app', null);
    await away();
    const b0 = await alarms();
    ok('super ask ran', await until(page, async () => reports().some((r) => r.kind === 'askedLegacy' && r.r?.status === 0), 30000), JSON.stringify(reports().slice(-2)));
    const superRang = await until(page, async () => { const a = await alarms(); return a.notes > b0.notes && a.chimes > b0.chimes; }, 10000);
    const superAlarm = await alarms();
    console.log(`      super alarm: ${JSON.stringify({ notes: superAlarm.notes - b0.notes, chimes: superAlarm.chimes - b0.chimes, last: superAlarm.last })}`);
    ok('the super question rings like a normal one, even with another question open: a chime and a banner', superRang, JSON.stringify({ before: b0, after: superAlarm }));
    const glance = await (await fetch(`${base}/api/assistant/glance`)).json();
    ok('the notch glance lists the project as asking', (glance.chats ?? []).some((c) => c.super && c.activity === 'asking'), JSON.stringify(glance.chats));
    await page.screenshot({ path: join(OUT, '04-super-alarm-away-1440.png') });
    await back();

    console.log('\n── the owner answers the child\'s question in the super chat, with a note');
    await answerCard(page, escCard.locator('.chat-surveycard'), [{ labels: ['Blue'], note: 'the darker blue' }]).catch((e) => console.log(`      (answer: ${String(e).slice(0, 160)})`));
    ok('…the CHILD gets it, pick and note, like its own card', await until(page, async () => reports().some((r) => r.kind === 'answeredColour' && JSON.stringify(r.response).includes('Blue') && JSON.stringify(r.response).includes('the darker blue')), 20000), JSON.stringify(reports().filter((r) => r.kind === 'answeredColour')));

    const legacyCard = centre.locator('[data-testid="super-question-card"]').filter({ hasText: 'Rename the app to Acme Go?' });
    ok('the old --options question is a card in the super chat', await until(page, async () => (await legacyCard.count()) === 1, 15000));
    await page.screenshot({ path: join(OUT, '05-super-legacy-card-1440.png') });
    ok('…drawn by the chat\'s own card (.chat-surveycard with its lettered options)', (await legacyCard.locator('.chat-surveycard .chat-surveycard-opt').count()) >= 2);
    // "Unclear — ask again" on it.
    const unclear = legacyCard.locator('.chat-surveycard-unclear');
    ok('…it offers "Unclear — ask again"', (await unclear.count()) === 1);
    await unclear.click().catch(() => {});
    ok('Unclear sends ONE `[super answer] … unclear` message to the super', await until(page, async () => reports().some((r) => r.kind === 'answer' && /^\[super answer\] item=\S+ unclear/.test(r.text)), 20000), JSON.stringify(reports().filter((r) => r.role === 'super').slice(-3)));
    ok('…the card goes, the transcript shows its receipt', await until(page, async () => (await legacyCard.count()) === 0 && (await centre.locator('[data-testid="super-answer-receipt"]').filter({ hasText: /ask again/ }).count()) === 1, 15000));

    console.log('\n── super ask --json: AskUserQuestion\'s shape, the same card');
    await page.waitForTimeout(1500);
    await say(centreInput, `GO-CHILDFINISH ${child}`);
    ok('the super sent the child a job the owner waits on', await until(page, async () => reports().some((r) => r.kind === 'sent' && r.r?.status === 0), 30000), JSON.stringify(reports().slice(-2)));
    await until(page, async () => reports().some((r) => r.role === 'child' && r.kind === 'turn-end' && /weekly report/.test(r.said)), 30000);
    await page.waitForTimeout(800);
    await say(centreInput, 'GO-ASKJSON');
    ok('super ask --json ran', await until(page, async () => reports().some((r) => r.kind === 'askedJson' && r.r?.status === 0), 30000), JSON.stringify(reports().filter((r) => r.kind === 'askedJson')));
    const card = centre.locator('[data-testid="super-question-card"]').filter({ hasText: 'Ship the login fix now?' });
    ok('its card is in the super chat', await until(page, async () => (await card.count()) === 1, 15000));
    const surveyCard = card.locator('.chat-surveycard');
    ok('…context strip (title), why line (description), option descriptions, the preview board', await until(page, async () => /Login fix · ship or wait/.test(await surveyCard.locator('.chat-surveycard-context').innerText().catch(() => ''))
      && /release train leaves at five/.test(await surveyCard.innerText())
      && /Goes out with today's train/.test(await surveyCard.innerText())
      && (await surveyCard.locator('iframe').count()) > 0, 15000));
    const superSig = await signature(surveyCard).catch(() => []);
    const missing = normalSig.filter((c) => !superSig.includes(c));
    const extra = superSig.filter((c) => !normalSig.includes(c));
    ok('…the SAME component: its class signature equals the normal agent\'s card\'s', normalSig.length > 0 && missing.length === 0 && extra.length === 0, JSON.stringify({ missing, extra }));
    const head = page.getByTestId('super-queue-head');
    ok('the job bar shows the question with ONE Answer button and no option buttons of its own', await until(page, async () => /Ship the login fix/.test(await head.innerText().catch(() => ''))
      && (await head.getByTestId('super-queue-answer').count()) === 1 && (await page.getByTestId('super-ask-option').count()) === 0, 10000));
    await page.screenshot({ path: join(OUT, '06-super-json-card-1440.png') });

    console.log('\n── while it is open the awaited job finishes (held, not dropped)');
    const tJson = reports().find((r) => r.kind === 'askedJson')?.t ?? 0;
    ok('the finished job is held', await until(page, async () => ((await superState()).held ?? []).some((h) => h.kind === 'done' && h.child === child && h.at >= tJson - 2000), 60000), JSON.stringify((await superState()).held));
    ok('…and no event turn went out meanwhile', !reports().some((r) => r.kind === 'events' && r.t > (reports().find((x) => x.kind === 'askedJson')?.t ?? 0)));

    console.log('\n── the owner answers: picks, a note, a multi-pick');
    await answerCard(page, surveyCard, [{ labels: ['Wait'], note: 'after the demo' }, { labels: ['Me', 'Claude'] }]).catch((e) => console.log(`      (answer: ${String(e).slice(0, 160)})`));
    await page.screenshot({ path: join(OUT, '07-super-json-answered-1440.png') });
    ok('ONE `[super answer]` message in AskUserQuestion\'s answer words, the note after its pick', await until(page, async () => reports().some((r) => r.kind === 'answer' && r.text.includes('"Ship the login fix now?"="Wait" notes: "after the demo"') && r.text.includes('"Who tells the team?"="Me, Claude"')), 20000), JSON.stringify(reports().filter((r) => r.kind === 'answer').slice(-1)));
    const ans = reports().filter((r) => r.kind === 'answer').slice(-1)[0];
    ok('…what came in meanwhile rides in the SAME message (<super-while-you-asked>: the finished job, its last reply, one at a time)', !!ans && ans.blocks.some((b) => b.startsWith('<super-while-you-asked') && new RegExp(`child=${child} event=done`).test(b) && /weekly report is ready/.test(b) && /ONE AT A TIME/.test(b)), JSON.stringify(ans?.blocks?.slice(1)));
    ok('…once: one answer frame for it', reports().filter((r) => r.kind === 'answer' && /"Wait"/.test(r.text)).length === 1);
    ok('…the card goes; the receipt stands where the answer is ("You chose: Wait, Me, Claude"); no bubble', await until(page, async () => (await card.count()) === 0
      && (await centre.locator('[data-testid="super-answer-receipt"]').filter({ hasText: 'You chose: Wait, Me, Claude' }).count()) === 1
      && (await centre.locator('.chat-user').filter({ hasText: '[super answer]' }).count()) === 0, 15000));
    ok('…the held ledger is empty and the bar head dropped', await until(page, async () => !(await superState()).held && (await page.getByTestId('super-queue-head').count()) === 0, 15000));
    await page.screenshot({ path: join(OUT, '08-super-answered-receipt-1440.png') });

    console.log('\n── a swipe deck, same as a normal agent\'s');
    await page.waitForTimeout(1500);
    await say(centreInput, 'GO-ASKSWIPE');
    const swipe = centre.locator('[data-testid="super-question-card"] .chat-surveycard.swipe');
    ok('metadata.source "swipe" draws the swipe deck', await until(page, async () => (await swipe.count()) === 1, 20000));
    await page.screenshot({ path: join(OUT, '09-super-swipe-1440.png') });
    // The deck's own two buttons, exactly the throw a drag makes (→ the first option, ← the second).
    await swipe.locator('.chat-surveycard-page').nth(0).locator('.chat-swipe-btn.yes').click().catch(() => {});
    await page.waitForTimeout(900);
    await swipe.locator('.chat-surveycard-page').nth(1).locator('.chat-swipe-btn.no').click().catch(() => {});
    await page.waitForTimeout(900);
    await swipe.locator('.chat-btn.primary').click().catch(() => {});
    ok('keep, then cut: one message back', await until(page, async () => reports().some((r) => r.kind === 'answer' && r.text.includes('"Keep the dark-mode line?"="Keep"') && r.text.includes('"Keep the speed line?"="Cut"')), 20000), JSON.stringify(reports().filter((r) => r.kind === 'answer').slice(-1)));

    console.log('\n── a phone (390) has no super chat by design: no errors');
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const phone = await phoneCtx.newPage();
    phone.on('console', (m) => { if (m.type() === 'error') errors.push(`[phone] ${m.text()}`); });
    phone.on('pageerror', (e) => errors.push(`[phone] ${String(e)}`));
    await phone.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await phone.waitForTimeout(3500);
    await phone.screenshot({ path: join(OUT, '10-phone-390.png') });
    await phoneCtx.close();
    const real = errors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket|Failed to load resource/i.test(e));
    ok('no console errors', real.length === 0, real.join('\n'));
  } catch (e) {
    ok(`the run reached its end (${String(e).slice(0, 200)})`, false);
  } finally {
    writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, reports: reports() }, null, 2));
    await context.close();
    await browser.close();
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} failed` : '✓ all passed'} — screenshots and video in ${OUT}`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
