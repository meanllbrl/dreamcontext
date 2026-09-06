#!/usr/bin/env node
/**
 * Clicking a file in the transcript SHOWS it — or says why it can't. Runtime proof.
 *
 *   npm run build && npm run verify:file-preview
 *
 * The owner's 09-06 report: a screenshot that was really on disk (`/tmp/arsiv/shots-tile.png`,
 * named by a Read row) opened the lightbox as the engine's broken-file glyph on a full-window
 * black screen. The file was outside the project root, so the endpoint answered 403
 * `needs_grant` — the one refusal the app knows how to fix — and an `<img>` reported it the
 * only way an `<img>` can: nothing at all.
 *
 * Nothing about that is provable from the server side (the route was answering correctly) or
 * from a unit test (an `<img>`'s error event is the browser's). So this drives the REAL app:
 *
 *   1. a picture INSIDE the project still just opens — drawn, zoomable, no card;
 *   2. a picture OUTSIDE it opens the card instead of a broken glyph: a real box, a sentence
 *      naming the reason, an "Allow access" button — and no `<img>` left on the stage;
 *   3. that button GRANTS the exact file the server resolved and the picture then draws,
 *      with the zoom bar back — one click from unreadable to readable;
 *   4. a file that is simply gone says so, rather than offering consent that would not help;
 *   5. the failure card never traps you: the backdrop and Esc still close the viewer;
 *   6. the same answer reaches the slide-over — an outside CLIP opened from a tool row offers
 *      the consent in the panel, where it used to point at an inline card that doesn't exist
 *      for a path the answer never rendered inline.
 *
 * Same harness contract as scripts/verify/dream-actions.mjs: the real server, the real
 * `/ws/agent-chat`, a real browser, a scripted stand-in for `claude` in an isolated fake HOME
 * so no tokens are spent, and COLLECT-DON'T-FAIL-FAST reporting.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-file-preview');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
/** Deliberately a sibling of the project, not a child: this is the whole point of the test. */
const OUTSIDE = join(SCRATCH, 'elsewhere');

const INSIDE_PNG = join(PROJ, 'tmp', 'inside-shot.png');
const OUTSIDE_PNG = join(OUTSIDE, 'outside-shot.png');
const MISSING_PNG = join(PROJ, 'tmp', 'never-written.png');
const OUTSIDE_WAV = join(OUTSIDE, 'outside-clip.wav');

/** A real 24×16 PNG — the assertions read `naturalWidth`, so the bytes have to decode. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR4nGO4o1FBFcQwatCoQaMGjRpEGQIANss6H3gMWPIAAAAASUVORK5CYII=',
  'base64',
);

/** A real (silent, 8-bit mono, 1000 samples) WAV, for the same reason: the panel's `<audio>`
 *  must be able to load it once it is allowed, or "it came back" would prove nothing. */
function wavBytes() {
  const data = Buffer.alloc(1000, 128);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(8000, 24); head.writeUInt32LE(8000, 28);
  head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// One turn of the shape the report came from: Read rows naming files. A Read's `file_path`
// becomes the row's path chip, which is the thing the owner clicked.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-file-preview.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let seq = 0, busy = false;

const FILES = ${JSON.stringify([INSIDE_PNG, OUTSIDE_PNG, MISSING_PNG, OUTSIDE_WAV])};

async function call(path) {
  const id = 'toolu_' + (++seq);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] } });
  await sleep(150);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'read ' + path }] }] } });
  await sleep(120);
}

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: ['compact'] });
  for (const f of FILES) await call(f);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ANSWER-ONE ' + prompt }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  busy = false;
  pump();
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request' && o.request && o.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) { inbox.push(text); pump(); }
  }
});

let pumping = false;
async function pump() {
  if (pumping || busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  pumping = true;
  try { await runTurn(next); } finally { pumping = false; }
}
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup (mirrors scripts/verify/dream-actions.mjs) ─────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(PROJ, 'tmp'), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(INSIDE_PNG, PNG);
  writeFileSync(OUTSIDE_PNG, PNG);
  writeFileSync(OUTSIDE_WAV, wavBytes());
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

/** The grants the user has actually given, as the server would read them back. */
function grants() {
  try {
    return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.file-grants.json'), 'utf-8')).paths ?? [];
  } catch { return []; }
}

function clearGrants() {
  rmSync(join(PROJ, '_dream_context', 'state', '.file-grants.json'), { force: true });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function runTheme(chromium, base, theme, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };
  const paneText = async () => (await vis('.chat-pane').first().innerText()).replace(/\s+/g, ' ');
  /** The four Read rows land as one contiguous run, which collapses to a headline the moment
   *  the turn does — so the chips the owner clicked are behind that toggle. Open it once. */
  const openRunCard = async () => {
    const head = page.locator('.chat-toolrun:visible .chat-m-cardhead-hit').first();
    if (await head.count()) { await head.click({ force: true }); await page.waitForTimeout(400); }
    else {
      report.note(`[debug] no visible run card — surfaces: expanded=${await page.locator('.agent-surface.expanded').count()}`
        + ` pane=${await page.locator('.chat-pane:visible').count()}`
        + ` toolrun=${await page.locator('.chat-toolrun').count()}`
        + ` viewer=${await page.locator('.image-viewer').count()}`);
    }
  };
  const openChip = async (path) => {
    // `:visible` matters twice over: the rows live behind the run card's toggle, and the app
    // keeps more than one transcript tree mounted — a hidden copy resolves the selector while
    // being unclickable.
    const chip = page.locator(`.chat-a-pathchip[title="${path}"]:visible`).first();
    if (!(await chip.count())) await openRunCard();
    await chip.click({ force: true, timeout: 10000 });
    await page.waitForTimeout(500);
  };
  /** Did the picture actually DRAW? `naturalWidth` is the only honest answer — an `<img>` is
   *  present, visible and the right size while it is failing. */
  const drawn = () => page.evaluate(() => {
    const img = document.querySelector('.image-viewer-img');
    return !!img && img.naturalWidth > 0;
  });
  const closeViewer = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  };

  console.log(`\n═══ ${theme} ═══`);
  clearGrants();
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

  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('GO');
  await page.keyboard.press('Enter');
  ok('the turn finishes', await until(async () => (await paneText()).includes('ANSWER-ONE'), 40000));
  await page.waitForTimeout(600);

  // ── 1 — a picture inside the project is unchanged ─────────────────────────────────
  console.log('── the happy path is untouched');
  await openChip(INSIDE_PNG);
  ok('a project screenshot opens the viewer', (await vis('.image-viewer').count()) === 1);
  ok('…and actually draws', await until(drawn, 6000));
  ok('…with no failure card in sight', (await page.locator('.image-viewer-fallback').count()) === 0);
  ok('…and the zoom bar it came for', (await vis('.image-viewer-bar').count()) === 1);
  await closeViewer();

  // ── 2 — the reported bug: outside the project ─────────────────────────────────────
  console.log('── the 09-06 report: a real file, outside the project');
  await openChip(OUTSIDE_PNG);
  ok('the viewer still opens for it', (await vis('.image-viewer').count()) === 1);
  const card = page.locator('.image-viewer-fallback');
  ok('the stage shows a failure CARD, not a broken image',
    await until(async () => (await card.count()) === 1, 8000));
  // Geometry, not presence: a card that resolves to a zero-height box is the same blank
  // screen the report was about (see the 08-26 decision in project memory).
  const box = await card.boundingBox().catch(() => null);
  ok('…as a real box on screen', !!box && box.height > 40 && box.width > 120, JSON.stringify(box));
  const cardText = ((await card.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  ok('…that names the reason', /outside the project/i.test(cardText), cardText);
  ok('…and offers the one click that fixes it',
    (await card.getByRole('button', { name: /Allow access/ }).count()) === 1, cardText);
  ok('the broken `<img>` is gone from the stage', (await page.locator('.image-viewer-img').count()) === 0);
  ok('…and so is the zoom bar for a picture that isn’t there',
    (await page.locator('.image-viewer-bar').count()) === 0);
  ok('the OS handoff is still offered beside it',
    (await vis('.image-viewer-actions .chat-fileactions').count()) === 1);
  if (process.env.VERIFY_SHOTS) {
    await page.screenshot({ path: `${process.env.VERIFY_SHOTS}/file-preview-blocked-${theme}.png` });
  }

  // ── 3 — one click from unreadable to readable ─────────────────────────────────────
  console.log('── Allow access: the picture appears');
  // Guarded, not assumed: with the card missing (the pre-fix behaviour, and what a regression
  // looks like) an unguarded click throws and takes the remaining sections down with it —
  // this harness collects, it does not fail fast.
  const allowBtn = card.getByRole('button', { name: /Allow access/ });
  if (await allowBtn.count()) {
    await allowBtn.click();
    ok('the picture draws after the grant', await until(drawn, 8000));
    ok('…the card is gone', (await page.locator('.image-viewer-fallback').count()) === 0);
    ok('…and it is a real viewer again (zoom bar back)', (await vis('.image-viewer-bar').count()) === 1);
    ok('the grant recorded the file the SERVER resolved, and only that file',
      grants().length === 1 && grants()[0] === OUTSIDE_PNG, JSON.stringify(grants()));
  } else {
    ok('the picture draws after the grant', false, 'no Allow access button to click');
  }
  await closeViewer();

  // ── 4 — a file that is simply gone ────────────────────────────────────────────────
  console.log('── a file that isn’t there says so');
  await openChip(MISSING_PNG);
  const gone = page.locator('.image-viewer-fallback');
  ok('the missing file also gets a card', await until(async () => (await gone.count()) === 1, 8000));
  const goneText = ((await gone.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  ok('…which says it is gone rather than offering consent that would not help',
    /isn’t there any more|isn't there any more/.test(goneText)
      && (await gone.getByRole('button', { name: /Allow access/ }).count()) === 0, goneText);

  // ── 5 — the card is not a trap ────────────────────────────────────────────────────
  console.log('── the way out is still there');
  await page.mouse.click(40, 40);
  await page.waitForTimeout(400);
  ok('a click on the backdrop beside the card still closes the viewer',
    (await page.locator('.image-viewer').count()) === 0);
  await openChip(MISSING_PNG);
  await until(async () => (await page.locator('.image-viewer-fallback').count()) === 1, 8000);
  await closeViewer();
  ok('…and so does Esc', (await page.locator('.image-viewer').count()) === 0);
  // Esc must close the PICTURE and stop there. The surface's own Esc handler is bound on
  // `window` when the overlay expands — before any viewer mounts — so it used to fire first
  // and take the whole chat down with the image the user was closing.
  ok('…without collapsing the chat behind it',
    (await page.locator('.agent-surface.expanded').count()) === 1);

  // ── 6 — the panel tells the same story ────────────────────────────────────────────
  console.log('── the slide-over: an outside clip asks in the panel');
  clearGrants();
  await openChip(OUTSIDE_WAV);
  ok('a clip opens the panel', await until(async () => (await vis('.chat-slideover-panel').count()) === 1, 8000));
  const panelCard = vis('.chat-slideover-panel .chat-unavailable');
  ok('the panel asks for consent itself, instead of pointing at a card that isn’t there',
    await until(async () => (await panelCard.count()) === 1, 8000),
    (await vis('.chat-slideover-panel').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200));
  if (await panelCard.count()) {
    await panelCard.getByRole('button', { name: /Allow access/ }).click();
    ok('…and the clip comes back once allowed',
      await until(async () => (await vis('.chat-slideover-media').count()) === 1, 8000));
    ok('…recording that one file', grants().length === 1 && grants()[0] === OUTSIDE_WAV, JSON.stringify(grants()));
  }

  const shot = process.env.VERIFY_SHOTS;
  if (shot) {
    await page.keyboard.press('Escape');
    await openChip(MISSING_PNG);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shot}/file-preview-${theme}.png` });
  }

  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  notes: [],
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
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
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
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
