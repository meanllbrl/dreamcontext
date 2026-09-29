#!/usr/bin/env node
/**
 * Train Me mode end-to-end verification.
 *
 *   npm run build && npm run verify:train-me
 *
 * Proves one full Train Me round the way the owner meets it (task train-me-mode-…, AC9):
 *
 *   1. the composer's mode menu carries a 4th row, "Train Me" (ALPHA), that is selectable,
 *      and picking it respawns the chat with `mode=train` on the WS upgrade;
 *   2. the process that serves the next turn was spawned with the Train Me briefing — the
 *      stand-in reads back its own `--append-system-prompt-file`;
 *   3. one swipe round (4 cards: text, picture, clip, plain text) round-trips — every verdict
 *      and the note on one card reach the `control_response` the CLI would read;
 *   4. an automation's Train button opens a NEW `Train · <title>` tab in mode train whose first
 *      prompt binds it to the slug and `automations learn <slug> --playbook-file`, and an
 *      automation with `learning: false` refuses with the reason instead.
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/ws/agent-chat` route, the real
 * `/api/automations*` routes and the real React surface in Chromium, in both themes. `claude`
 * is a scripted stand-in in an isolated fake HOME (see chat-questions.mjs): per turn it
 * appends how it was spawned (argv flags, the briefing file's contents, the first prompt) to
 * `spawns.jsonl`, and per `TRAINSWIPE` prompt it sends a swipe AskUserQuestion and writes the
 * answer it gets back to `answers.jsonl`. Automations are created by the REAL CLI.
 *
 * Screenshots of the mode menu, a swipe card and the Train tab in both themes land in
 * `$SCRATCH/shots/`.
 *
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check in every theme passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-train-me');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const ANSWERS = join(PROJ, 'answers.jsonl');
const SPAWNS = join(PROJ, 'spawns.jsonl');

const LEARN_SLUG = 'hero-picker';
const LEARN_TITLE = 'Hero Image Picker';
const NOLEARN_SLUG = 'uptime-ping';
const NOLEARN_TITLE = 'Uptime Ping';

// ─── the swipe round (the extended shape, as CLI 2.1.281 sends it) ────────────────────

const SWIPE = {
  title: 'Teaching me your taste → onboarding illustrations',
  metadata: { source: 'swipe' },
  questions: [
    {
      question: 'Card 1 — flat, rounded, two colours. Keep it?',
      header: 'Style 1',
      description: 'Swipe right to keep it in the style guide, left to drop it.',
      options: [{ label: 'Keep', preview: '<div class="dc-doc dc-doc--hug"><div class="dc-callout dc-callout--good">Flat, rounded, two colours</div></div>' }, { label: 'Drop' }],
      multiSelect: false, kind: 'choice',
    },
    {
      question: 'Card 2 — the gradient hero. Keep it?',
      header: 'Style 2',
      options: [{ label: 'Keep', preview: '<img src="docs/hero.png">' }, { label: 'Drop' }],
      multiSelect: false, kind: 'choice',
    },
    {
      question: 'Card 3 — a looping motion intro. Keep it?',
      header: 'Style 3',
      options: [{ label: 'Keep', preview: '<video src="tmp/clip.mp4"></video>' }, { label: 'Drop' }],
      multiSelect: false, kind: 'choice',
    },
    {
      question: 'Card 4 — "Your first project, in one click." as the headline. Keep it?',
      header: 'Copy 1',
      options: [{ label: 'Keep', description: 'Short, second person' }, { label: 'Drop' }],
      multiSelect: false, kind: 'choice',
    },
  ],
};
const NOTE = 'too busy — motion only on hover';

// ─── the scripted `claude` ────────────────────────────────────────────────────────────

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/train-me.mjs. */
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SWIPE = ${JSON.stringify(SWIPE)};
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
const briefPath = flag('--append-system-prompt-file');
let briefing = null;
if (briefPath) { try { briefing = fs.readFileSync(briefPath, 'utf-8'); } catch (e) { briefing = 'READ-FAILED: ' + e.message; } }
const pid = process.pid;
// Lifecycle trail, for diagnosing a respawn that dies: who started, how it ended.
const life = (m) => { try { fs.appendFileSync(${JSON.stringify(join(SCRATCH, 'standin-life.log'))}, new Date().toISOString() + ' ' + pid + ' ' + m + '\\n'); } catch {} };
life('start ' + JSON.stringify(argv));
process.on('exit', (c) => life('exit ' + c));
process.on('SIGTERM', () => { life('SIGTERM'); process.exit(143); });
// Like the real CLI: the conversation id is the one it was pinned or resumed to, and its
// transcript lands at ~/.claude/projects/<cwd-slug>/<id>.jsonl only once a turn is served.
// The server keys its resume hand-off wait on that file existing, so a stand-in that never
// writes one would test a server path real sessions with history never take.
const sid = flag('--session-id') || flag('--resume') || ('verify-train-' + pid);
const tdir = require('node:path').join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const transcript = (entry) => { try { fs.mkdirSync(tdir, { recursive: true }); fs.appendFileSync(require('node:path').join(tdir, sid + '.jsonl'), JSON.stringify({ ...entry, sessionId: sid, cwd: process.cwd(), uuid: sid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2), timestamp: new Date().toISOString(), isSidechain: false }) + '\\n'); } catch {} };
let seq = 0, awaiting = null, busy = false, first = true;
const inbox = [];
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') {
      if (awaiting) { const r = awaiting; awaiting = null; r(o.response && o.response.response); }
      continue;
    }
    if (o.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type === 'user') {
      const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) { inbox.push(text); pump(); }
    }
  }
});
async function turn(prompt) {
  busy = true;
  // Recorded by the process that SERVES A TURN, never at startup: the server also runs
  // \`claude\` for probes, and those carry no briefing.
  if (first) {
    first = false;
    fs.appendFileSync(${JSON.stringify(SPAWNS)}, JSON.stringify({ pid, briefPath, briefing, permissionMode: flag('--permission-mode'), firstPrompt: prompt }) + '\\n');
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: flag('--permission-mode') || 'default', slash_commands: [] });
  transcript({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
  if (prompt.includes('TRAINSWIPE')) {
    const id = 'toolu_' + (++seq);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: SWIPE }] } });
    out({ type: 'control_request', request_id: 'req-swipe-' + seq, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: SWIPE, tool_use_id: id, requires_user_interaction: true } });
    const response = await new Promise((r) => { awaiting = r; });
    fs.appendFileSync(${JSON.stringify(ANSWERS)}, JSON.stringify({ key: 'SWIPE', response }) + '\\n');
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GOT-SWIPE' }] } });
  } else {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'What should I learn first?' }] } });
  }
  transcript({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  busy = false;
  pump();
}
let pumping = false;
async function pump() {
  if (pumping || busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  pumping = true;
  try { await turn(next); } finally { pumping = false; }
}
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup ────────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function cli(args) {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args],
    { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

async function setupScratch(chromium) {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'docs'), join(PROJ, 'tmp'), SHOTS])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  await p.setContent('<body style="margin:0;height:270px;display:grid;place-items:center;background:linear-gradient(135deg,#6d5dfc,#f472b6);font:700 42px system-ui;color:#fff">HERO</body>');
  await p.screenshot({ path: join(PROJ, 'docs', 'hero.png') });
  await b.close();
  const ff = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', join(PROJ, 'tmp', 'clip.mp4')]);
  if (ff.status !== 0) console.log('  (ffmpeg unavailable — the clip card will show a missing clip)');

  cli(['vaults', 'add', 'proj', PROJ]);
  // Real manifests from the real CLI — one that learns (the default), one created with
  // --no-learning, which `automations learn` refuses and so the Train button must too.
  cli(['automations', 'create', LEARN_SLUG, '--title', LEARN_TITLE, '--days', 'daily', '--at', '09:00']);
  cli(['automations', 'create', NOLEARN_SLUG, '--title', NOLEARN_TITLE, '--days', 'daily', '--at', '10:00', '--no-learning']);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const env = { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' };
  delete env.CLAUDE_CODE_QUESTION_EXTENDED;
  delete env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT;
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drained to a file: an unread pipe fills up and stalls the server mid-run.
  const log = createWriteStream(join(SCRATCH, 'server.log'));
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

const readJsonl = (f) => (existsSync(f)
  ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function runTheme(chromium, base, theme, report) {
  rmSync(ANSWERS, { force: true });
  rmSync(SPAWNS, { force: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const sockets = [];
  const wsTrail = [];
  page.on('websocket', (ws) => {
    if (!/agent[-/]chat/.test(ws.url())) return;
    sockets.push(ws.url());
    const n = sockets.length;
    wsTrail.push(`#${n} open ${ws.url().slice(-200)}`);
    ws.on('framereceived', (f) => { const s = String(f.payload); if (/"type":"(meta|dc-meta|system)"|subtype/.test(s) && s.length < 600) wsTrail.push(`#${n} ← ${s.slice(0, 300)}`); });
    ws.on('framesent', (f) => wsTrail.push(`#${n} → ${String(f.payload).slice(0, 200)}`));
    ws.on('close', () => wsTrail.push(`#${n} closed`));
  });
  const vis = (sel) => page.locator(`${sel}:visible`);
  const composer = () => vis('.chat-cmp-input').first();
  const card = () => vis('.chat-surveycard').first();
  const modeTrigger = () => vis('.chat-cmp-modeltrigger').first();
  const modeWord = async () => (await modeTrigger().locator('.chat-cmp-modeltrigger-model').innerText().catch(() => '')).trim();
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const idle = () => until(async () => (await vis('.chat-cmp-stop').count()) === 0, 15000);
  const wsParams = (u) => new URL(u.replace(/^ws/, 'http')).searchParams;
  const shotPage = (name) => page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`) }).catch(() => {});

  console.log(`\n═══ ${theme} ═══`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(800);

  // ── 1: the mode menu's 4th cell ──
  console.log('── 1: Train Me is the 4th cell of the mode grid, and picking it respawns in train');
  ok('a fresh chat starts in Basic', (await modeWord()) === 'Basic', await modeWord());
  // One Basic turn first, so the switch is the realistic one: a chat with a transcript,
  // resumed into the new mode. (Switching a chat that never had a turn races the old
  // process's shutdown in the server — a general mode-switch edge, not Train Me's.)
  await composer().click();
  await composer().fill('hello');
  await page.keyboard.press('Enter');
  await until(async () => (await page.getByText('What should I learn first?').count()) > 0, 15000);
  await idle();
  await modeTrigger().click();
  await page.waitForTimeout(400);
  const rows = vis('.chat-cmp-modemenu .chat-cmp-scroll.is-grid .chat-cmp-modelrow');
  ok('the mode menu opens as a 2×2 grid of four rows', (await rows.count()) === 4, `rows=${await rows.count()}`);
  const fourth = rows.nth(3);
  const fourthName = (await fourth.locator('.chat-cmp-modelrow-name').innerText().catch(() => '')).trim();
  ok('the 4th cell is "Train Me"', fourthName === 'Train Me', fourthName);
  const chip = (await fourth.locator('.chat-cmp-badge').innerText().catch(() => '')).trim();
  ok('…wearing the ALPHA chip', /^alpha$/i.test(chip), chip || '<no chip>');
  ok('…and it is selectable (not disabled)', (await fourth.getAttribute('disabled')) === null);
  const gridBoxes = [];
  for (let i = 0; i < 4; i++) gridBoxes.push(await rows.nth(i).boundingBox());
  ok('…laid out in the grid\'s bottom-right cell',
    gridBoxes.every(Boolean) && Math.abs(gridBoxes[3].y - gridBoxes[2].y) < 2 && gridBoxes[3].x > gridBoxes[2].x
      && gridBoxes[3].y > gridBoxes[1].y,
    JSON.stringify(gridBoxes.map((b) => b && [Math.round(b.x), Math.round(b.y)])));
  await vis('.chat-cmp-modemenu').first().screenshot({ path: join(SHOTS, `${theme}-mode-menu.png`) }).catch(() => {});
  const socketsBefore = sockets.length;
  await fourth.click();
  const picked = await until(async () => (await modeWord()) === 'Train Me', 20000);
  if (!picked) { await shotPage('after-pick-train'); wsTrail.forEach((l) => report.note(`  ws ${l}`)); }
  ok('picking it puts "Train Me" on the trigger', picked,
    `trigger=${JSON.stringify(await modeWord())} · pane=${JSON.stringify((await vis('.chat-pane').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240))}`);
  ok('…and the respawn\'s WS upgrade carries mode=train',
    await until(async () => sockets.slice(socketsBefore).some((u) => wsParams(u).get('mode') === 'train'), 20000),
    JSON.stringify(sockets.slice(socketsBefore).map((u) => u.slice(-160))));
  await page.waitForTimeout(800);

  // ── 2 + 3: one swipe round, served by a process spawned with the Train Me briefing ──
  console.log('── 2-3: the train briefing reaches the spawn; one swipe round round-trips');
  await composer().click();
  await composer().fill('TRAINSWIPE onboarding illustrations');
  await page.keyboard.press('Enter');
  const opened = await until(async () => (await vis('.chat-surveycard').count()) > 0 && !(await card().getAttribute('data-state')), 20000);
  ok('the swipe card opens', opened);
  const spawnRec = readJsonl(SPAWNS).find((s) => (s.firstPrompt ?? '').includes('TRAINSWIPE'));
  const brief = spawnRec?.briefing ?? '';
  ok('the turn was served by a process given --append-system-prompt-file', !!spawnRec?.briefPath, JSON.stringify(spawnRec)?.slice(0, 200));
  ok('the briefing carries the Train Me heading', brief.includes('# Mode: Train Me'), brief.slice(0, 120));
  ok('…the "what are we training" opener (patterns match)', brief.includes('dreamcontext patterns match'));
  ok('…swipe decks via metadata.source', brief.includes('"metadata":{"source":"swipe"}'));
  ok('…the silent-prediction rule, and no per-round rule print', /predict/i.test(brief) && brief.includes('Do not print the rule between rounds'));
  ok('…the confirm gate before any write', brief.includes('explicit yes'));
  ok('…and the automation route (automations learn --playbook-file)', brief.includes('dreamcontext automations learn <slug> --playbook-file'));
  ok('…with the surface briefing still in front of it', brief.indexOf('# Surface: dreamcontext Chat') !== -1
    && brief.indexOf('# Surface: dreamcontext Chat') < brief.indexOf('# Mode: Train Me'));

  if (opened) {
    ok('it is drawn as a swipe deck of four cards',
      (await vis('.chat-surveycard.swipe').count()) === 1 && (await vis('.chat-surveycard-dot').count()) === 4,
      `dots=${await vis('.chat-surveycard-dot').count()}`);
    const current = () => vis('.chat-surveycard-page:not([inert])').first();
    const title = async () => (await current().locator('.chat-surveycard-title').innerText().catch(() => '')).trim();
    await page.waitForTimeout(1500);
    await card().screenshot({ path: join(SHOTS, `${theme}-swipe-card.png`) }).catch(() => {});

    // card 1: a right drag
    const face = current().locator('.chat-swipe-face');
    const fb = await face.boundingBox();
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(fb.x + fb.width / 2 + i * 18, fb.y + fb.height / 2); await page.waitForTimeout(16); }
    await page.mouse.up();
    ok('card 1: a right drag decides it and deals card 2',
      await until(async () => (await title()) === SWIPE.questions[1].question, 4000), await title());
    // card 2: the picture — ← key
    ok('card 2: the project picture draws natively and loads',
      await until(async () => (await current().locator('img').first().evaluate((el) => el.naturalWidth).catch(() => 0)) > 0, 8000));
    await current().focus();
    await page.keyboard.press('ArrowLeft');
    ok('card 2: ← decides it and deals card 3',
      await until(async () => (await title()) === SWIPE.questions[2].question, 4000), await title());
    // card 3: the clip — a note, then the Drop button
    ok('card 3: the clip is a real <video>',
      await until(async () => (await current().locator('video').count()) > 0, 8000));
    await page.waitForTimeout(400);
    await card().screenshot({ path: join(SHOTS, `${theme}-swipe-card-video.png`) }).catch(() => {});
    await current().locator('.chat-surveycard-fieldinput').fill(NOTE);
    await current().locator('.chat-swipe-btn.no').click();
    ok('card 3: a note + the Drop button decide it and deal card 4',
      await until(async () => (await title()) === SWIPE.questions[3].question, 4000), await title());
    // card 4: plain text — the Keep button
    await current().locator('.chat-swipe-btn.yes').click();
    ok('every card is decided', await until(async () => (await vis('.chat-surveycard-dot.done').count()) === 4, 4000),
      `done=${await vis('.chat-surveycard-dot.done').count()}`);
    await page.waitForTimeout(500);
    await vis('.chat-surveycard .chat-btn.primary').first().click();
    await until(async () => readJsonl(ANSWERS).length > 0, 10000);
    const r = readJsonl(ANSWERS).find((a) => a.key === 'SWIPE')?.response;
    const a = r?.updatedInput?.answers ?? {};
    const q = SWIPE.questions.map((x) => x.question);
    ok('allow went back to the CLI', r?.behavior === 'allow', JSON.stringify(r)?.slice(0, 200));
    ok('every verdict is in the control_response (Keep, Drop, Drop, Keep)',
      a[q[0]] === 'Keep' && a[q[1]] === 'Drop' && a[q[2]] === 'Drop' && a[q[3]] === 'Keep', JSON.stringify(a));
    ok('the note rides on card 3 as annotations.notes',
      r?.updatedInput?.annotations?.[q[2]]?.notes === NOTE, JSON.stringify(r?.updatedInput?.annotations));
    ok('…and only on card 3', Object.keys(r?.updatedInput?.annotations ?? {}).length === 1);
    await idle();
  }

  // ── 4: the automation's Train button ──
  console.log('── 4: an automation\'s Train button opens a train tab bound to it');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  const openPanel = async (t) => {
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    // The page opens on the Messages feed; the cards are on its Agents switch.
    await until(async () => (await page.locator('.agents-switch-opt', { hasText: 'Automations' }).count()) > 0, 10000);
    await page.locator('.agents-switch-opt', { hasText: 'Automations' }).first().click().catch(() => {});
    if (!(await until(async () => (await page.locator('.agent-card').count()) >= 2, 15000))) {
      await shotPage(`board-missing-${t.replace(/\W+/g, '-')}`);
      report.note(`board shows ${await page.locator('.agent-card').count()} cards: ${JSON.stringify(await page.locator('.agent-card-name').allInnerTexts())}`);
      return false;
    }
    const c = page.locator('.agent-card', { has: page.locator('.agent-card-name', { hasText: t }) }).first();
    if (!(await c.count())) {
      await shotPage(`board-missing-${t.replace(/\W+/g, '-')}`);
      report.note(`no card titled ${t}: ${JSON.stringify(await page.locator('.agent-card-name').allInnerTexts())}`);
      return false;
    }
    // "Runs" opens the automation's detail panel — where the Train button lives.
    await c.locator('.agent-card-btn', { hasText: 'Runs' }).click();
    return until(async () => (await page.locator('.adp-panel').count()) === 1
      && (await page.locator('.adp-panel .adp-title').innerText().catch(() => '')).trim() === t, 10000);
  };
  const trainBtn = () => page.locator('.adp-panel .adp-edit', { hasText: /^Train$/ });

  ok(`the ${NOLEARN_TITLE} panel opens`, await openPanel(NOLEARN_TITLE));
  ok('learning: false → the Train button is aria-disabled',
    await until(async () => (await trainBtn().getAttribute('aria-disabled').catch(() => null)) === 'true', 8000),
    await trainBtn().getAttribute('aria-disabled').catch(() => '<no button>'));
  const why = (await trainBtn().getAttribute('title').catch(() => '')) ?? '';
  ok('…and says why (the same refusal `automations learn` gives)',
    /Learning is off/.test(why) && why.includes(`automations/${NOLEARN_SLUG}.md`), why);
  // The chat surface is collapsed behind this page, so tabs are counted in the DOM, not on screen.
  const trainTabs = () => page.locator('.agent-tab', { hasText: 'Train ·' }).count();
  // `force`: Playwright refuses aria-disabled targets, but the button is deliberately NOT
  // `disabled` — a user's click reaches it and must explain itself.
  await trainBtn().click({ timeout: 5000, force: true }).catch(() => {});
  ok('…a click says why out loud (a toast)',
    await until(async () => (await page.getByText(/Learning is off for this agent/).count()) > 0, 4000));
  await page.waitForTimeout(1000);
  ok('…and opens nothing', (await trainTabs()) === 0 && (await page.locator('.adp-panel').count()) === 1,
    `train tabs=${await trainTabs()} panel=${await page.locator('.adp-panel').count()}`);
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }

  ok(`the ${LEARN_TITLE} panel opens`, await openPanel(LEARN_TITLE));
  ok('learning on → the Train button is enabled',
    await until(async () => (await trainBtn().getAttribute('aria-disabled').catch(() => null)) === 'false', 8000),
    await trainBtn().getAttribute('aria-disabled').catch(() => '<no button>'));
  const tabNames = async () => (await page.locator('.agent-tab').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  const tabsBefore = await tabNames();
  const spawnsBefore = readJsonl(SPAWNS).length;
  const socketsBeforeTrain = sockets.length;
  await trainBtn().click({ timeout: 5000 }).catch(() => {});
  ok('the panel gets out of the way', await until(async () => (await page.locator('.adp-panel').count()) === 0, 10000));
  const wantTab = `Train · ${LEARN_TITLE}`;
  ok(`a NEW tab "${wantTab}" opens beside the existing chat`,
    await until(async () => {
      const now = await tabNames();
      return now.length === tabsBefore.length + 1 && now.some((t) => t.includes(wantTab))
        && tabsBefore.every((t) => now.includes(t));
    }, 20000),
    `${JSON.stringify(tabsBefore)} → ${JSON.stringify(await tabNames())}`);
  ok('…and it is the active tab', (await vis('.agent-tab.active, .agent-tab[aria-selected="true"]').allInnerTexts()).some((t) => t.includes(wantTab)),
    JSON.stringify(await vis('.agent-tab.active, .agent-tab[aria-selected="true"]').allInnerTexts()));
  ok('…in mode train (trigger)', await until(async () => (await modeWord()) === 'Train Me', 10000), await modeWord());
  ok('…and its WS upgrade carries mode=train',
    await until(async () => sockets.slice(socketsBeforeTrain).some((u) => wsParams(u).get('mode') === 'train'), 15000),
    JSON.stringify(sockets.slice(socketsBeforeTrain).map((u) => u.slice(-160))));
  ok('the kickoff reaches a process', await until(async () => readJsonl(SPAWNS).length > spawnsBefore, 20000));
  const kick = readJsonl(SPAWNS).slice(spawnsBefore).find((s) => (s.firstPrompt ?? '').includes(LEARN_SLUG));
  const fp = kick?.firstPrompt ?? '';
  ok('its first prompt names the automation slug', fp.includes(`\`${LEARN_SLUG}\``), fp.slice(0, 200));
  ok(`…and the write route: automations learn ${LEARN_SLUG} --playbook-file`,
    fp.includes(`dreamcontext automations learn ${LEARN_SLUG} --playbook-file`), fp.slice(0, 400));
  ok('…served by a process carrying the Train Me briefing', (kick?.briefing ?? '').includes('# Mode: Train Me'));
  ok('…spawned under auto, not an escalated permission mode', kick?.permissionMode === 'auto', kick?.permissionMode);
  const permWord = (await modeTrigger().locator('.chat-cmp-modeltrigger-effort').innerText().catch(() => '')).trim();
  ok('…and the composer says the same', permWord === 'auto', permWord);
  await until(async () => (await page.getByText('What should I learn first?').count()) > 0, 10000);
  await page.waitForTimeout(600);
  await shotPage('train-tab');

  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0, fails: [], notes: [],
  check(theme, label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(`[${theme}] ${label}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
try {
  const { chromium } = await import('@playwright/test');
  console.log('· setting up scratch vault + two automations + scripted claude…');
  await setupScratch(chromium);
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of ['light', 'dark']) {
    // The surface mirrors its tab roster to disk; a tab from the last theme would restore here.
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runTheme(chromium, `http://127.0.0.1:${port}`, theme, report);
  }
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
console.log(`   screenshots: ${SHOTS}`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
