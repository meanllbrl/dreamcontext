#!/usr/bin/env node
/**
 * Chat question card end-to-end verification.
 *
 *   npm run build && npm run verify:chat-questions
 *
 * Proves the AskUserQuestion card the owner asked for on 2026-09-26 — a card that can be
 * answered COLD from a notification, takes a note on a pick, shows visual options as an
 * A/B/C board, runs quick verdicts as a swipe deck, and does not jump when you click it.
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/ws/agent-chat` route and the real
 * React surface in Chromium. `claude` is a scripted stand-in in an isolated fake HOME (the
 * same airtight substitution `chat-steer.mjs` documents): per prompt keyword it sends the
 * EXTENDED AskUserQuestion request the real CLI 2.1.281 sends once `CHAT_QUESTION_ENV` is
 * set (shape captured from a live run), then writes the `control_response` it gets back to
 * `answers.jsonl` — so every assertion about "what the model reads" is made on the bytes the
 * CLI would actually receive, not on UI state.
 *
 * It also proves the env contract itself: the stand-in records the two env vars it was
 * spawned with, which is the only way to know the spawn really sets them.
 *
 * Screenshots of every card in both themes land in `$SCRATCH/shots/`.
 *
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check in every theme passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-questions');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const ANSWERS = join(PROJ, 'answers.jsonl');
const ENVFILE = join(PROJ, 'spawn-env.json');

// ─── the question payloads (the extended shape, as CLI 2.1.281 sends it) ──────────────

const Q = {
  ROWS: {
    title: 'Invoice export → how dates are written',
    questions: [
      {
        question: 'Which date format should the exported invoices use?',
        header: 'Date format',
        description: 'The accountant imports these into Excel; the wrong format breaks their sort.',
        options: [
          { label: 'ISO 2026-09-26 (Recommended)', description: 'Sorts correctly everywhere' },
          { label: 'Local 26.09.2026', description: 'Reads naturally, sorts as text' },
        ],
        multiSelect: false, kind: 'choice',
      },
      { question: 'Anything the accountant asked for that I should know?', header: 'Context', kind: 'text', placeholder: 'Optional', options: [] },
      { question: 'How many invoices per file?', header: 'Batch size', kind: 'number', min: 10, max: 500, step: 10, defaultValue: 100, unit: 'invoices', options: [] },
    ],
  },
  BOARD: {
    title: 'Settings page redesign → header style',
    questions: [{
      question: 'Which header should the settings page use?',
      header: 'Header',
      description: 'This sets the look for every settings tab, so it is hard to change later.',
      options: [
        { label: 'Compact bar', description: 'One line, more room for content', preview: '<div class="dc-doc dc-doc--hug"><div class="dc-card"><div class="dc-card-title">Settings</div><div class="dc-card-sub">General · Agents · Voice</div></div></div>' },
        { label: 'Hero with picture', description: 'Friendlier, takes a third of the screen', preview: '<div class="dc-doc dc-doc--hug"><img class="dc-img" src="docs/hero.png" alt="hero"><p class="dc-caption">Hero</p></div>' },
        { label: 'Screenshot only', description: 'The real screen, drawn natively', preview: '<img src="docs/hero.png">' },
        { label: 'Motion intro', description: 'A short clip plays once', preview: '<video src="tmp/clip.mp4"></video>' },
      ],
      multiSelect: false, kind: 'choice',
    }],
  },
  SWIPE: {
    title: 'Teaching me your taste → onboarding illustrations',
    metadata: { source: 'swipe' },
    questions: [
      {
        question: 'Do you like this illustration style?',
        header: 'Style 1',
        description: 'Swipe right to keep it in the style guide, left to drop it.',
        options: [{ label: 'Keep', preview: '<div class="dc-doc dc-doc--hug"><div class="dc-callout dc-callout--good">Flat, rounded, two colors</div></div>' }, { label: 'Drop' }],
        multiSelect: false, kind: 'choice',
      },
      {
        question: 'And this one?',
        header: 'Style 2',
        options: [{ label: 'Keep', preview: '<img src="docs/hero.png">' }, { label: 'Drop' }],
        multiSelect: false, kind: 'choice',
      },
    ],
  },
  OTHER: {
    title: 'Release notes → where they are posted',
    questions: [{
      question: 'Where should the release notes go?',
      header: 'Channel',
      options: [{ label: 'GitHub release', description: 'Next to the tag' }, { label: 'The docs site', description: 'A changelog page' }],
      multiSelect: false, kind: 'choice',
    }],
  },
  UNCLEAR: {
    title: 'Refactor → the thing',
    questions: [{
      question: 'Should I do the thing with the other thing?',
      header: 'Thing',
      options: [{ label: 'Yes' }, { label: 'No' }],
      multiSelect: false, kind: 'choice',
    }],
  },
};

// ─── the scripted `claude` ────────────────────────────────────────────────────────────

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-questions.mjs. */
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const Q = ${JSON.stringify(Q)};
let seq = 0, awaiting = null, busy = false;
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
  // \`claude\` for probes (the slash-command cache), and a probe spawned without the chat env
  // would otherwise overwrite this with nulls.
  fs.writeFileSync(${JSON.stringify(ENVFILE)}, JSON.stringify({
    extended: process.env.CLAUDE_CODE_QUESTION_EXTENDED ?? null,
    preview: process.env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT ?? null,
  }));
  out({ type: 'system', subtype: 'init', session_id: 'verify-questions', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
  const key = Object.keys(Q).find((k) => prompt.includes(k));
  if (key) {
    const id = 'toolu_' + (++seq);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: Q[key] }] } });
    out({ type: 'control_request', request_id: 'req-' + key + '-' + seq, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: Q[key], tool_use_id: id, requires_user_interaction: true } });
    const response = await new Promise((r) => { awaiting = r; });
    fs.appendFileSync(${JSON.stringify(ANSWERS)}, JSON.stringify({ key, response }) + '\\n');
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'GOT-' + key }] } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-questions' });
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

  // A real project picture — rendered, so the board shows something recognisable.
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 480, height: 270 } });
  await p.setContent('<body style="margin:0;height:270px;display:grid;place-items:center;background:linear-gradient(135deg,#6d5dfc,#f472b6);font:700 42px system-ui;color:#fff">HERO</body>');
  await p.screenshot({ path: join(PROJ, 'docs', 'hero.png') });
  await b.close();
  // A real clip for the lone-<video> tile, when ffmpeg is around to make one.
  const ff = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', join(PROJ, 'tmp', 'clip.mp4')]);
  if (ff.status !== 0) console.log('  (ffmpeg unavailable — the video tile will show a missing clip)');

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  // The owner's own env must not leak in: the spawn has to set these ITSELF.
  const env = { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' };
  delete env.CLAUDE_CODE_QUESTION_EXTENDED;
  delete env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT;
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

function readAnswers() {
  if (!existsSync(ANSWERS)) return [];
  return readFileSync(ANSWERS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function runTheme(chromium, base, theme, report) {
  rmSync(ANSWERS, { force: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const vis = (sel) => page.locator(`${sel}:visible`);
  const composer = () => vis('.chat-cmp-input').first();
  const card = () => vis('.chat-surveycard').first();
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const answerFor = async (key) => {
    await until(async () => readAnswers().some((a) => a.key === key), 10000);
    return readAnswers().find((a) => a.key === key)?.response;
  };
  const ask = async (key) => {
    await composer().click();
    await composer().fill(`show ${key}`);
    await page.keyboard.press('Enter');
    return until(async () => (await vis('.chat-surveycard').count()) > 0 && !(await card().getAttribute('data-state')), 15000);
  };
  const shot = (name) => card().screenshot({ path: join(SHOTS, `${theme}-${name}.png`) }).catch(() => {});
  const idle = () => until(async () => (await vis('.chat-cmp-stop').count()) === 0, 15000);

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

  // ── S1: rows — context, description, note on a pick, text + number, no jump ──
  console.log('── S1: a cold-readable card with a note, a text and a number question');
  ok('the card opens', await ask('ROWS'));
  const env = existsSync(ENVFILE) ? JSON.parse(readFileSync(ENVFILE, 'utf-8')) : {};
  ok('the spawn set CLAUDE_CODE_QUESTION_EXTENDED=1 itself', env.extended === '1', JSON.stringify(env));
  ok('the spawn set CLAUDE_CODE_QUESTION_PREVIEW_FORMAT=html itself', env.preview === 'html', JSON.stringify(env));
  const ctx = (await vis('.chat-surveycard-context').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('the context strip leads the card with the title', ctx.includes('Invoice export → how dates are written'), ctx);
  ok('the question\'s description is shown under it',
    (await vis('.chat-surveycard-desc').first().innerText().catch(() => '')).includes('wrong format breaks their sort'));
  await page.waitForTimeout(400);
  await shot('rows');
  const before = await card().boundingBox();
  await vis('.chat-surveycard-opt').first().click();
  await page.waitForTimeout(500);
  const after = await card().boundingBox();
  ok('clicking an option does not move or resize the card (no jump)',
    before && after && Math.abs(before.y - after.y) < 1 && Math.abs(before.height - after.height) < 1,
    `before y=${before?.y} h=${before?.height} · after y=${after?.y} h=${after?.height}`);
  const tag = (await vis('.chat-surveycard-field-tag').first().innerText()).trim();
  ok('after a pick the free field is a NOTE on it', /note/i.test(tag), tag);
  await vis('.chat-surveycard-fieldinput').first().fill('the accountant uses a Mac');
  await shot('rows-note');
  await page.getByRole('button', { name: /^Next/ }).first().click().catch(() => page.keyboard.press('ArrowRight'));
  await page.waitForTimeout(500);
  const textField = vis('.chat-surveycard-page:not([inert]) .chat-surveycard-fieldinput').first();
  await textField.fill('They want one file per month');
  await page.getByRole('button', { name: /^Next/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  const range = vis('.chat-surveycard-page:not([inert]) .chat-surveycard-range').first();
  ok('the number question draws a slider', (await range.count()) === 1);
  // `fill` refuses range inputs; set the value through the native setter so React's
  // onChange sees a real input event, the way a drag would deliver it.
  await range.evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '200');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await shot('rows-number');
  await vis('.chat-surveycard .chat-btn.primary').first().click();
  const r1 = await answerFor('ROWS');
  const q1 = Q.ROWS.questions;
  ok('allow went back to the CLI', r1?.behavior === 'allow', JSON.stringify(r1)?.slice(0, 200));
  ok('the pick is the answer — the note did not leak into it',
    r1?.updatedInput?.answers?.[q1[0].question] === 'ISO 2026-09-26 (Recommended)', JSON.stringify(r1?.updatedInput?.answers));
  ok('the note travels as annotations.notes (the model reads it as "notes: …")',
    r1?.updatedInput?.annotations?.[q1[0].question]?.notes === 'the accountant uses a Mac', JSON.stringify(r1?.updatedInput?.annotations));
  ok('the text question answers with what was typed',
    r1?.updatedInput?.answers?.[q1[1].question] === 'They want one file per month');
  ok('the number question answers with the slider value',
    r1?.updatedInput?.answers?.[q1[2].question] === '200', r1?.updatedInput?.answers?.[q1[2].question]);
  ok('the request is echoed verbatim — title and every question field go back',
    r1?.updatedInput?.title === Q.ROWS.title && r1?.updatedInput?.questions?.[2]?.unit === 'invoices');
  await idle();

  // ── S1b: "Other" after a pick ──
  console.log('── S1b: "Other" — an own answer after picking something');
  ok('the Other card opens', await ask('OTHER'));
  ok('an "Other" row is on the card before anything is clicked', (await vis('.chat-surveycard-opt.other').count()) === 1);
  await vis('.chat-surveycard-opt').first().click();
  await vis('.chat-surveycard-fieldinput').first().fill('the team Slack');
  await page.waitForTimeout(200);
  const ob = await card().boundingBox();
  await vis('.chat-surveycard-opt.other').first().click();
  await page.waitForTimeout(400);
  const oa = await card().boundingBox();
  ok('picking Other does not move or resize the card',
    ob && oa && Math.abs(ob.y - oa.y) < 1 && Math.abs(ob.height - oa.height) < 1, `before h=${ob?.height} · after h=${oa?.height}`);
  ok('Other replaces the pick (one radio group)', (await vis('.chat-surveycard-opt.on').count()) === 1
    && (await vis('.chat-surveycard-opt.other.on').count()) === 1);
  ok('the field turns into the ANSWER and takes the caret',
    /answer/i.test(await vis('.chat-surveycard-field-tag').first().innerText())
    && await vis('.chat-surveycard-fieldinput').first().evaluate((el) => el === document.activeElement));
  await shot('other');
  await vis('.chat-surveycard .chat-btn.primary').first().click();
  const ro = await answerFor('OTHER');
  ok('the typed text IS the answer, with no note riding on it',
    ro?.updatedInput?.answers?.[Q.OTHER.questions[0].question] === 'the team Slack' && !ro?.updatedInput?.annotations,
    JSON.stringify({ a: ro?.updatedInput?.answers, n: ro?.updatedInput?.annotations }));
  await idle();

  // ── S2: the A/B/C board ──
  console.log('── S2: visual options as an A/B/C board');
  ok('the board card opens', await ask('BOARD'));
  ok('four tiles, lettered A–D',
    (await vis('.chat-surveycard-tile').count()) === 4
    && (await vis('.chat-surveycard-tile-letter').allInnerTexts()).join('') === 'ABCD');
  await page.waitForTimeout(2500);   // frames measure, pictures inline
  const nativeImg = vis('.chat-surveycard-tile img.chat-surveycard-media').first();
  ok('a lone project picture is drawn natively and actually loads',
    await until(async () => (await nativeImg.evaluate((el) => el.naturalWidth).catch(() => 0)) > 0, 8000));
  const video = vis('.chat-surveycard-tile video.chat-surveycard-media').first();
  ok('a lone clip becomes a real, playable <video>',
    await until(async () => (await video.evaluate((el) => el.readyState).catch(() => 0)) >= 1, 8000));
  let inlined = false;
  for (const f of page.frames()) {
    const w = await f.evaluate(() => { const i = document.querySelector('img.dc-img'); return i ? { w: i.naturalWidth, s: i.getAttribute('src').slice(0, 11) } : null; }).catch(() => null);
    if (w && w.w > 0 && w.s === 'data:image/') { inlined = true; break; }
  }
  ok('a project picture INSIDE an HTML preview is inlined into the sandbox and renders', inlined);
  await shot('board');
  await vis('.chat-surveycard-tile').nth(1).click();
  await page.waitForTimeout(300);
  ok('clicking a tile selects it', (await vis('.chat-surveycard-tile.on').count()) === 1);
  await vis('.chat-surveycard-tile').nth(1).locator('.chat-htmlview-full-btn').click();
  await page.waitForTimeout(600);
  ok('the tile\'s fullscreen door opens without changing the vote',
    (await vis('.chat-surveycard-tile.on').count()) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await vis('.chat-surveycard-tile').nth(2).locator('.chat-htmlview-full-btn').click();
  ok('a lone picture has a fullscreen door, and it opens the zoomable viewer',
    await until(async () => (await page.locator('.image-viewer .image-viewer-img').count()) === 1, 5000));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${theme}-board-image-full.png`) }).catch(() => {});
  await page.locator('.image-viewer-close').click();
  await page.waitForTimeout(400);
  ok('closing the viewer with its own button is not a vote for that tile',
    (await page.locator('.image-viewer').count()) === 0
    && (await vis('.chat-surveycard-tile.on').count()) === 1
    && (await vis('.chat-surveycard-tile').nth(1).getAttribute('aria-checked')) === 'true');
  await vis('.chat-surveycard-tile').nth(3).locator('.chat-htmlview-full-btn').click();
  ok('a clip has a fullscreen door, and it plays in a full-window player',
    await until(async () => (await page.locator('.fullscreen-overlay video').count()) === 1, 5000));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${theme}-board-video-full.png`) }).catch(() => {});
  await page.locator('.fullscreen-overlay video').click().catch(() => {});
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok('clicks and keys inside the full-window player change nothing on the card',
    (await page.locator('.fullscreen-overlay').count()) === 0
    && (await vis('.chat-surveycard-tile').nth(1).getAttribute('aria-checked')) === 'true'
    && (await vis('.chat-surveycard-tile.on').count()) === 1);
  await vis('.chat-surveycard .chat-btn.primary').first().click();
  const r2 = await answerFor('BOARD');
  ok('the board answer is tile B\'s label',
    r2?.updatedInput?.answers?.[Q.BOARD.questions[0].question] === 'Hero with picture', JSON.stringify(r2?.updatedInput?.answers));
  await idle();

  // ── S3: the swipe deck ──
  console.log('── S3: quick verdicts as a swipe deck');
  ok('the swipe card opens', await ask('SWIPE'));
  ok('it is drawn as a deck', (await vis('.chat-surveycard.swipe').count()) === 1);
  await page.waitForTimeout(1500);
  await shot('swipe');
  const face = vis('.chat-surveycard-page:not([inert]) .chat-swipe-face').first();
  const fb = await face.boundingBox();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(fb.x + fb.width / 2 + i * 18, fb.y + fb.height / 2); await page.waitForTimeout(16); }
  await shot('swipe-drag');
  await page.mouse.up();
  await page.waitForTimeout(700);
  ok('a right drag decides question 1 and moves to question 2',
    (await vis('.chat-surveycard-dot.done').count()) === 1
    && (await vis('.chat-surveycard-page:not([inert]) .chat-surveycard-title').first().innerText()) === 'And this one?');
  await vis('.chat-surveycard-page:not([inert])').first().focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);
  await shot('swipe-done');
  await vis('.chat-surveycard .chat-btn.primary').first().click();
  const r3 = await answerFor('SWIPE');
  const a3 = r3?.updatedInput?.answers ?? {};
  ok('right = the FIRST option, ← = the second',
    a3[Q.SWIPE.questions[0].question] === 'Keep' && a3[Q.SWIPE.questions[1].question] === 'Drop', JSON.stringify(a3));
  await idle();

  // ── S4: "Unclear? Ask again" ──
  console.log('── S4: a card nobody can parse costs one click');
  ok('the unclear card opens', await ask('UNCLEAR'));
  await vis('.chat-surveycard-fieldinput').first().fill('which thing?');
  await vis('.chat-surveycard-unclear').first().click();
  const r4 = await answerFor('UNCLEAR');
  ok('it answers with a DENY (the input schema has no free-response field)', r4?.behavior === 'deny', JSON.stringify(r4));
  ok('the message tells the agent how to re-ask, and carries what was typed',
    /did not understand/.test(r4?.message ?? '') && /`title`/.test(r4?.message ?? '') && (r4?.message ?? '').includes('which thing?'));
  await idle();

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
  console.log('· setting up scratch vault + scripted claude…');
  await setupScratch(chromium);
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of ['light', 'dark']) {
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
