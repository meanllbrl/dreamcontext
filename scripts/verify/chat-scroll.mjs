#!/usr/bin/env node
/**
 * Chat transcript scroll-smoothness end-to-end verification.
 *
 * Proves the settle discipline added for the 08-01 owner report ("loading older entries —
 * or shedding them — breaks my scroll position with a flicker"): the pane must NEVER pay
 * for a window mutation with a `scrollTop` write while the scroller is still in motion,
 * because WKWebView's out-of-process animator overwrites (or is killed by) mid-flight
 * writes. Concretely:
 *
 *   A. a continuous wheel train toward the top does NOT trigger a reveal mid-train; the
 *      reveal fires once, after SCROLL_SETTLE_MS of quiet, and the reader's fold row is
 *      held to the pixel across the prepend;
 *   B. deliberate paced notches (gaps > SCROLL_SETTLE_MS) still auto-reveal between
 *      notches — scrolling back through history keeps its continuous feel;
 *   C. a pinned view over a streaming turn sheds old rows in TRIM_SLACK chunks (the
 *      hysteresis), never one-per-frame, and stays pinned to the bottom throughout;
 *   D. wheel activity DURING a streaming turn freezes the pinned snap (no chunk of rows is
 *      unmounted mid-motion); the snap lands after quiet, and the view is still pinned.
 *   E. a window folded into ONE collapsed run card still loads older entries from wheel-up
 *      alone (no scroll event can fire), the card survives the reveal, and the row being read
 *      INSIDE it is held — plus the automatic floor stops at WINDOW_MAX_ENTRIES.
 *   F. the window measures itself in CARDS (owner report 08-02): a transcript whose entry
 *      tail folds into two cards mounts further back until there is something to scroll, and
 *      each reveal adds CARDS rather than entries that vanish into the same fold.
 *
 *   npm run build && node scripts/verify/chat-scroll.mjs
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/agent/chat-history` resume
 * path (a synthesized 300-entry transcript in the fake HOME's ~/.claude/projects), the
 * real chat WS route, and the real React surface in Chromium with real wheel events.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is a scripted stand-in (see chat-steer.mjs for
 * the pattern); on a STREAM prompt it emits 80 short assistant frames at ~25ms so the
 * pinned-trim behaviour can be sampled live.
 *
 * HONEST LIMIT — Playwright cannot emit real trackpad momentum, so the WKWebView
 * animator-vs-write fight itself is not reproduced here (it never could be; that is why it
 * survived the 07-28 matrix). What IS proved is the invariant that makes the fight
 * unreachable: no reveal and no snap ever runs while input events are still arriving.
 *
 * FAILURE POLICY — collect, don't fail fast (same as chat-steer.mjs).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-scroll');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONV_ID = randomUUID();
/** Scenario E's conversation: one long contiguous tool run, so the whole window folds into
 *  a single collapsed ToolRunCard and the transcript is SHORTER than its scroller. */
const RUN_CONV_ID = randomUUID();
const RUN2_CONV_ID = randomUUID();
const CARDS_CONV_ID = randomUUID();

// Mirrors chatEntities — asserted against, so drift fails loudly rather than silently.
const WINDOW_TAIL = 40;
const WINDOW_STEP = 40;
const TRIM_SLACK = 20;
const WINDOW_TAIL_CARDS = 20;
const WINDOW_STEP_CARDS = 20;
const WINDOW_MAX_ENTRIES = 400;

/** Mirrors transcript-history.ts — a resumed conversation replays at most this many items, so
 *  it is the real `total` every replayed scenario's window is a slice of. */
const HISTORY_MAX_ITEMS = 500;

/** Scenario E's fixture: one unbroken run LONGER than the automatic floor may reach, so the
 *  fold still hides history above it (a shorter one is now mounted whole, which is correct
 *  and would leave E with nothing to reveal). */
const RUN_CALLS = 900;
/** Scenario F's fixture: turns of a message, an answer and a foldable stretch — 3 cards per
 *  14 entries, so an entry tail is two cards and the card floor has to reach much further. */
const CARD_TURNS = 40;
const CARD_TURN_CALLS = 12;

// ─── the scripted `claude` ────────────────────────────────────────────────────────────

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-scroll.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;
const inbox = [];

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
    if (o.type === 'user') {
      const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) { inbox.push(text); pump(); }
    }
  }
});

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: '${CONV_ID}', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
  if (prompt.includes('STREAM')) {
    for (let i = 1; i <= 80; i += 1) {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'stream item ' + i + ' — a short line of live output.' }] } });
      await sleep(25);
    }
  }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE: ' + prompt }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE: ' + prompt, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: '${CONV_ID}' });
  busy = false;
  pump();
}

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

// ─── the seeded 300-entry transcript ─────────────────────────────────────────────────
//
// The 07-28 lesson, applied: scroll bugs must be reproduced against SHORT rows (mostly
// collapsed tool cards), because tall synthetic rows keep a gesture from ever reaching the
// window's ceiling. 100 turns of user + text + tool_use/tool_result ≈ 300 replayed items.

function transcriptEntry(convId, i, type, message, extra = {}) {
  const stamp = new Date(Date.parse('2026-07-30T10:00:00Z') + i * 60_000).toISOString();
  return JSON.stringify({
    type, uuid: `${type}-${i}-${randomUUID().slice(0, 8)}`, timestamp: stamp,
    cwd: PROJ, sessionId: convId, version: '2.1.220', gitBranch: 'main', message, ...extra,
  });
}

function seedTranscript() {
  const lines = [];
  const entry = (i, type, message, extra) => transcriptEntry(CONV_ID, i, type, message, extra);
  lines.push(entry(0, 'user', { role: 'user', content: [{ type: 'text', text: 'Merhaba, uzun bir sohbet başlatalım — scroll doğrulaması için.' }] }));
  lines.push(entry(0, 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'Başlıyorum. Bu sohbet 100 tur sürecek.' }] }));
  for (let t = 1; t < 100; t += 1) {
    const toolId = `toolu_seed_${t}`;
    lines.push(entry(t, 'user', { role: 'user', content: [{ type: 'text', text: `Tur ${t}: sıradaki adımı yap.` }] }));
    lines.push(entry(t, 'assistant', {
      role: 'assistant',
      content: [
        { type: 'text', text: `Tur ${t}: kısa bir cevap satırı.` },
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo step-${t}`, description: `Step ${t}` } },
      ],
    }));
    lines.push(entry(t, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text: `step-${t}` }] }] }, { isMeta: false }));
  }
  const dir = join(HOME, '.claude', 'projects', 'scratch-proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CONV_ID}.jsonl`), lines.join('\n') + '\n');

  // Scenarios E1/E2 share a fixture SHAPE: 1 prompt, then RUN_CALLS CONTIGUOUS tool calls
  // (tool_result entries carry no text, so they only backfill — nothing breaks the run), then
  // one closing text. Whatever the window mounts is ONE collapsed ToolRunCard plus a
  // paragraph — deliberately SHORTER than the scroller. The run is longer than both the
  // replay cap and WINDOW_MAX_ENTRIES, so the card floor hits its ceiling with history still
  // above it: walking further finds no other card, and that is where the automatic floor must
  // stop and leave it to the reader.
  //
  // TWO conversations of it, because a replayed transcript is capped at HISTORY_MAX_ITEMS and
  // one reveal out of a fold this long reaches the rest of it — so E1 spends its reveal
  // COLLAPSED (proving the reveal is reachable with no scroll event in existence) and E2
  // spends its own with the card OPEN (proving the in-card prepend holds the reader's row).
  const runFixture = (convId, title, prefix) => {
    const out = [];
    const e = (i, type, message, extra) => transcriptEntry(convId, i, type, message, extra);
    out.push(e(0, 'user', { role: 'user', content: [{ type: 'text', text: title }] }));
    for (let t = 1; t <= RUN_CALLS; t += 1) {
      const toolId = `toolu_${prefix}_${t}`;
      out.push(e(t, 'assistant', {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo ${prefix}-step-${t}`, description: `Run step ${t}` } }],
      }));
      out.push(e(t, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text: `${prefix}-step-${t}` }] }] }, { isMeta: false }));
    }
    out.push(e(RUN_CALLS + 1, 'assistant', { role: 'assistant', content: [{ type: 'text', text: `RUN SONU: ${RUN_CALLS} adım tamamlandı.` }] }));
    const path = join(dir, `${convId}.jsonl`);
    writeFileSync(path, out.join('\n') + '\n');
    return path;
  };
  const runPath = runFixture(RUN_CONV_ID, `uzun tool kosusu senaryo E1 — tek karta katlanan ${RUN_CALLS} adim.`, 'run');
  const run2Path = runFixture(RUN2_CONV_ID, `uzun tool maraton senaryo E2 — acik kart icinde okuma.`, 'mar');

  // Scenario F's fixture (owner report 08-02): ordinary turns, each one a message, an answer
  // and a foldable stretch of calls. Three cards per 14 entries — so the ENTRY tail (40) is
  // about two cards and change, which is shorter than the scroller and therefore unscrollable,
  // while the conversation is full of cards a little further back.
  const cardLines = [];
  const centry = (i, type, message, extra) => transcriptEntry(CARDS_CONV_ID, i, type, message, extra);
  for (let t = 0; t < CARD_TURNS; t += 1) {
    cardLines.push(centry(t, 'user', { role: 'user', content: [{ type: 'text', text: `kartlar turu ${t}: bu adımı da hallet.` }] }));
    const calls = [];
    for (let c = 0; c < CARD_TURN_CALLS; c += 1) {
      calls.push({ type: 'tool_use', id: `toolu_card_${t}_${c}`, name: 'Read', input: { file_path: `src/mod-${t}-${c}.ts`, description: `Read ${t}/${c}` } });
    }
    cardLines.push(centry(t, 'assistant', {
      role: 'assistant',
      content: [
        { type: 'text', text: `Tur ${t}: önce dosyaları okuyorum, sonra özetliyorum.\n\nBu cevap iki satır sürüyor ki kartın yüksekliği gerçekçi olsun.` },
        ...calls,
      ],
    }));
    for (const call of calls) {
      cardLines.push(centry(t, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: 'ok' }] }] }, { isMeta: false }));
    }
  }
  const cardPath = join(dir, `${CARDS_CONV_ID}.jsonl`);
  writeFileSync(cardPath, cardLines.join('\n') + '\n');

  // All older than the main conversation, so the picker's newest-first list keeps it as row
  // #1 (the open flow clicks `.first()`); E and F find their own by search.
  const older = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(runPath, older, older);
  utimesSync(run2Path, older - 300, older - 300);
  utimesSync(cardPath, older - 600, older - 600);
}

// ─── setup ────────────────────────────────────────────────────────────────────────────

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
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/some-code-repo.git'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  seedTranscript();

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
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

async function runScenarios(chromium, base, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 200)}`));

  const ok = (label, cond, detail) => report.check('chromium', label, cond, detail);
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(120); }
    return false;
  };

  /** Mounted transcript rows + scroller metrics, in one evaluate so they are one frame. */
  const probe = () => page.evaluate(() => {
    const scroller = Array.from(document.querySelectorAll('.chat-scroll'))
      .find((el) => el.clientHeight > 0);
    if (!scroller) return null;
    const inner = scroller.querySelector('.chat-scroll-inner');
    return {
      rows: inner ? inner.children.length : 0,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      fromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  });

  /** Viewport-Y of the first row whose bottom is below the scroller's top edge — "the fold
   *  row", i.e. what the reader is looking at. Sees THROUGH an open run card to its rows,
   *  exactly as ChatPane's own captureAnchor does — the reader inside an open card is
   *  looking at a ToolCard row, not at the card's top edge. Keyed by a stable per-row
   *  identity so the SAME row can be re-measured after a commit. */
  const foldRow = () => page.evaluate(() => {
    const scroller = Array.from(document.querySelectorAll('.chat-scroll'))
      .find((el) => el.clientHeight > 0);
    if (!scroller) return null;
    const fold = scroller.getBoundingClientRect().top;
    const inner = scroller.querySelector('.chat-scroll-inner');
    const rows = [];
    for (const child of inner ? Array.from(inner.children) : []) {
      if (child.classList.contains('chat-window-more')) continue;
      const runRows = child.classList.contains('chat-toolrun')
        ? child.querySelectorAll(':scope > .chat-toolrun-rows > *')
        : null;
      if (runRows && runRows.length) rows.push(...Array.from(runRows));
      else rows.push(child);
    }
    let n = 0;
    for (const node of rows) {
      n += 1;
      const r = node.getBoundingClientRect();
      if (r.bottom > fold) {
        if (!node.dataset.verifyMark) node.dataset.verifyMark = `m${Math.floor(r.top)}-${n}-${rows.length}`;
        return { mark: node.dataset.verifyMark, top: r.top };
      }
    }
    return null;
  });
  const markTop = (mark) => page.evaluate((m) => {
    const node = document.querySelector(`[data-verify-mark="${m}"]`);
    return node ? node.getBoundingClientRect().top : null;
  }, mark);

  const composer = () => vis('.chat-cmp-input').first();
  const busy = async () => (await vis('.chat-cmp-stop').count()) > 0;
  const send = async (t) => {
    await composer().click();
    await composer().fill(t);
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
  };
  /** Center the mouse over the transcript so wheel events land on the scroller. */
  const aimAtTranscript = async () => {
    const box = await vis('.chat-scroll').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };

  // ── Open the seeded conversation through the real resume path ──────────────────────
  console.log('\n── open: resume the 300-entry conversation from Past chats');
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
  const pastBtn = page.getByRole('button', { name: /Past chats/ }).first();
  ok('the empty surface offers Past chats', await until(async () => (await pastBtn.count()) > 0, 15000));
  await pastBtn.click();
  ok('the picker lists the seeded conversation', await until(async () => (await vis('.chp-row').count()) > 0, 15000));
  await vis('.chp-row').first().click();
  ok('resume opens a chat pane', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  ok('history replays through /api/agent/chat-history', await until(async () => {
    const p = await probe();
    return !!p && p.rows > 10;
  }, 20000));
  await page.waitForTimeout(1500);

  const start = await probe();
  ok(`the window mounts a tail, not the whole conversation (rows=${start?.rows})`,
    !!start && start.rows <= WINDOW_TAIL + TRIM_SLACK + 6, JSON.stringify(start));
  ok('the view opens pinned to the bottom', !!start && start.fromBottom <= 4, JSON.stringify(start));

  // ── A: a continuous wheel train defers the reveal; the settled reveal holds ─────────
  console.log('── A: continuous wheel train → no mid-train reveal; settled reveal holds the fold row');
  await aimAtTranscript();
  const rowsBefore = (await probe()).rows;
  let midTrainRevealed = false;
  let reachedCeiling = false;
  for (let i = 0; i < 120; i += 1) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(25);
    const p = await probe();
    if (p.rows > rowsBefore + 2) { midTrainRevealed = true; break; }
    if (p.scrollTop <= 2) { reachedCeiling = true; if (i > 6) break; }
  }
  ok('the train reaches the window ceiling (fixture rows are short enough)', reachedCeiling);
  ok('NO reveal fires while wheel events are still arriving', !midTrainRevealed);
  const heldFold = await foldRow();
  const atWall = await probe();
  await page.waitForTimeout(600); // > SCROLL_SETTLE_MS — the quiet the reveal was waiting for
  const afterReveal = await probe();
  ok(`the reveal fires once the train settles (rows ${atWall.rows} → ${afterReveal.rows})`,
    afterReveal.rows >= atWall.rows + WINDOW_STEP - 2 && afterReveal.rows <= atWall.rows + WINDOW_STEP + 4,
    JSON.stringify({ atWall: atWall.rows, after: afterReveal.rows }));
  ok('the prepend was paid for — scrollTop moved down by the revealed height',
    afterReveal.scrollTop > 200, `scrollTop=${afterReveal.scrollTop}`);
  const foldAfter = heldFold ? await markTop(heldFold.mark) : null;
  ok('the fold row is held to the pixel across the settled reveal',
    heldFold !== null && foldAfter !== null && Math.abs(foldAfter - heldFold.top) <= 2,
    JSON.stringify({ before: heldFold?.top, after: foldAfter }));
  await page.waitForTimeout(400);
  const settled2 = await probe();
  ok('exactly ONE step revealed — no cascade after the correction',
    settled2.rows === afterReveal.rows, JSON.stringify({ afterReveal: afterReveal.rows, later: settled2.rows }));

  // ── B: paced notches (gaps > settle) still reveal between notches ───────────────────
  console.log('── B: paced notches keep the continuous feel');
  const rowsBeforeB = (await probe()).rows;
  for (let i = 0; i < 14; i += 1) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(260); // deliberate reading pace — each gap exceeds SCROLL_SETTLE_MS
  }
  await page.waitForTimeout(500);
  const afterB = await probe();
  ok(`paced scrolling auto-reveals without a button press (rows ${rowsBeforeB} → ${afterB.rows})`,
    afterB.rows >= rowsBeforeB + WINDOW_STEP - 2, JSON.stringify({ before: rowsBeforeB, after: afterB.rows }));

  // ── C: pinned stream sheds rows in TRIM_SLACK chunks, never per-frame ───────────────
  console.log('── C: pinned stream trims in chunks and stays pinned');
  const latest = vis('.chat-jump');
  if (await latest.count()) await latest.first().click();
  await page.waitForTimeout(600);
  const repinned = await probe();
  ok('Latest re-pins to the bottom', repinned.fromBottom <= 4, JSON.stringify(repinned));
  await page.waitForTimeout(700); // let the settled re-pin snap the window back before sampling
  await send('STREAM please');
  ok('the streaming turn starts', await until(busy, 10000));
  const samples = [];
  const streamEnd = Date.now() + 6000;
  while (Date.now() < streamEnd) {
    const p = await probe();
    if (p) samples.push(p);
    if (!(await busy()) && samples.length > 10) break;
    await page.waitForTimeout(60);
  }
  const maxRows = Math.max(...samples.map((s) => s.rows));
  const unpinnedSamples = samples.filter((s) => s.fromBottom > 6).length;
  ok(`mounted rows stay bounded by WINDOW_TAIL + TRIM_SLACK (max seen ${maxRows})`,
    maxRows <= WINDOW_TAIL + TRIM_SLACK + 6, JSON.stringify(samples.map((s) => s.rows)));
  ok(`the hysteresis lets the window grow before a chunk snap (max seen ${maxRows})`,
    maxRows >= WINDOW_TAIL + Math.floor(TRIM_SLACK / 2), JSON.stringify(samples.map((s) => s.rows)));
  ok('the view stays pinned to the bottom through the whole stream',
    unpinnedSamples === 0, `${unpinnedSamples} unpinned samples of ${samples.length}`);
  await until(async () => !(await busy()), 20000);

  // ── D: wheel activity mid-stream freezes the snap; quiet lands it ───────────────────
  console.log('── D: input mid-stream freezes the snap; quiet lands it, still pinned');
  await send('STREAM again');
  ok('a second streaming turn starts', await until(busy, 10000));
  await page.waitForTimeout(400);
  await aimAtTranscript();
  // Wander up, then ride the bottom — all while frames keep landing. Every wheel is
  // activity, so no chunk of rows may be unmounted under the pointer.
  let snapDuringMotion = false;
  let prevRows = (await probe()).rows;
  let prevWheelAt = 0;
  const dTrace = [];
  for (let i = 0; i < 30; i += 1) {
    const wheeledAt = Date.now();
    await page.mouse.wheel(0, i < 8 ? -300 : 600);
    await page.waitForTimeout(40);
    const p = await probe();
    dTrace.push({ i, rows: p.rows, top: Math.round(p.scrollTop), fb: Math.round(p.fromBottom), iw: prevWheelAt ? wheeledAt - prevWheelAt : 0, pw: Date.now() - wheeledAt });
    // A stall anywhere in this loop (this harness shares a laptop with real builds) can
    // legitimately cross SCROLL_SETTLE_MS — the app then genuinely IS quiet, and a snap
    // there is correct behaviour, not a violation. A drop only counts against the app if
    // input was demonstrably fresher than the settle window for the WHOLE bracket the drop
    // could have landed in: the gap between this wheel and the previous one (a snap between
    // iterations) and the gap between this wheel and this sample (a snap after it).
    const interWheelMs = prevWheelAt ? wheeledAt - prevWheelAt : 0;
    const postWheelMs = Date.now() - wheeledAt;
    // …and never the FIRST iteration: its bracket reaches back into the pre-loop pause,
    // where no wheel had fired yet and a settled snap is exactly what should happen.
    if (prevWheelAt > 0 && p.rows < prevRows - (TRIM_SLACK - 4) && interWheelMs < 140 && postWheelMs < 140) {
      snapDuringMotion = true;
    }
    prevRows = p.rows;
    prevWheelAt = wheeledAt;
  }
  ok('no snap unmounts a chunk while wheel events are still arriving', !snapDuringMotion,
    JSON.stringify(dTrace));
  await until(async () => !(await busy()), 20000);
  await page.waitForTimeout(800); // quiet + turn end — the deferred snap's moment
  await send('one more');
  await until(async () => !(await busy()), 15000);
  await page.waitForTimeout(500);
  const afterD = await probe();
  ok(`after quiet the snap lands (rows=${afterD.rows} ≤ ${WINDOW_TAIL + TRIM_SLACK + 6})`,
    afterD.rows <= WINDOW_TAIL + TRIM_SLACK + 6, JSON.stringify(afterD));
  ok('and the view is pinned to the bottom again', afterD.fromBottom <= 4, JSON.stringify(afterD));

  // ── E1/E2: a window folded into ONE collapsed run card (owner report 08-01, second pass) ─
  //
  // RUN_CALLS contiguous tool calls fold whatever is mounted into a single collapsed
  // ToolRunCard, so the transcript is SHORTER than its scroller: no overflow, no scroll
  // events, ever. The three defects these pin: (1) wheel-up loaded nothing (the reveal was
  // armed only from the scroll handler); (2) "Show earlier" REMOUNTED the card (key = first
  // item id, which the merge changes) — open state reset to the collapsed first frame; (3) the
  // anchor hold measured the card's top edge, not the row being read inside it, so an in-card
  // prepend shoved the reader by its full height. Since 08-02 they also pin the ceiling: a run
  // this long is the one shape where walking back finds no further card, so the automatic
  // floor must stop at WINDOW_MAX_ENTRIES instead of mounting the conversation.
  //
  // TWO conversations because one reveal out of a fold this long reaches the rest of the
  // replay (see the fixture note): E1 spends its reveal collapsed, E2 spends its own open.
  const moreBtn = () => vis('.chat-window-more').first();
  /** Entries above the window, as the button reports them — 0 once it is gone (the honest
   *  reading: nothing left to reveal), not -1. */
  const hiddenN = async () => {
    if ((await moreBtn().count()) === 0) return 0;
    const t = await moreBtn().innerText().catch(() => '');
    const m = /\((\d+)\)/.exec(t);
    return m ? Number(m[1]) : 0;
  };
  const openPastChat = async (needle, label) => {
    await vis('.chat-scroll').first().click();
    await page.keyboard.press('Meta+Shift+O');
    ok(`⌘⇧O opens Past chats (${label})`, await until(async () => (await vis('.chp-input').count()) > 0, 8000));
    await vis('.chp-input').first().fill(needle);
    await page.waitForTimeout(700);
    const title = (await vis('.chp-row').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    ok(`search finds the ${label} conversation`, new RegExp(needle, 'i').test(title), title);
    await vis('.chp-row').first().click();
  };

  console.log('── E1: folded run card — the reveal is reachable with nothing to scroll');
  await openPastChat('kosusu', 'run-heavy');
  ok('it resumes as a chat tab with a run card', await until(async () => (await vis('.chat-toolrun').count()) > 0, 20000));
  await page.waitForTimeout(1200);

  const e0 = await probe();
  const n0 = await hiddenN();
  ok(`the window folds into one collapsed card (${e0.rows} top-level rows, ${n0} hidden above)`,
    e0.rows <= 6 && n0 > 0, JSON.stringify({ rows: e0.rows, n0 }));
  ok('the folded transcript is SHORTER than its scroller — nothing to scroll',
    e0.scrollHeight <= e0.clientHeight + 4, JSON.stringify(e0));
  ok(`the card floor stops at its ceiling instead of mounting everything (${HISTORY_MAX_ITEMS - n0} entries up, cap ${WINDOW_MAX_ENTRIES})`,
    HISTORY_MAX_ITEMS - n0 <= WINDOW_MAX_ENTRIES + 4,
    JSON.stringify({ replayed: HISTORY_MAX_ITEMS, n0, mounted: HISTORY_MAX_ITEMS - n0 }));

  await aimAtTranscript();
  for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, -300); await page.waitForTimeout(30); }
  await page.waitForTimeout(700);
  const n1 = await hiddenN();
  ok(`wheel-up loads older messages even though no scroll event can fire (${n0} → ${n1})`,
    n1 <= n0 - Math.min(n0, WINDOW_STEP), JSON.stringify({ n0, n1 }));
  ok(`the step is bounded — one ask reaches at most WINDOW_MAX_ENTRIES further (${n0 - n1})`,
    n0 - n1 <= WINDOW_MAX_ENTRIES + 4, JSON.stringify({ n0, n1 }));
  ok('and the card did not open by itself', (await vis('.chat-toolrun[data-open]').count()) === 0);

  // E2: the owner's read-back flow — open the card, then keep reading upward through it, on a
  // conversation whose reveal is still unspent.
  console.log('── E2: reading back INSIDE an open run card — the prepend holds the row');
  await openPastChat('maraton', 'in-card');
  ok('it resumes as a chat tab with a run card too', await until(async () => (await vis('.chat-toolrun').count()) > 0, 20000));
  await page.waitForTimeout(1200);
  const e2Hidden = await hiddenN();
  ok(`it too has history above the fold (${e2Hidden} hidden)`, e2Hidden > 0);
  await vis('.chat-toolrun .chat-m-cardhead-hit').first().click();
  ok('opening the card mounts its rows', await until(async () => (await page.locator('.chat-toolrun-rows > *').count()) > 0, 8000));
  const r1 = await page.locator('.chat-toolrun-rows > *').count();
  await aimAtTranscript();
  for (let i = 0; i < 200; i += 1) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(25);
    const p = await probe();
    if (p.scrollTop <= 200) break;
  }
  const foldE = await foldRow();
  await page.waitForTimeout(900);
  const r2 = await page.locator('.chat-toolrun-rows > *').count();
  ok('the card SURVIVES the reveal open — no remount back to the collapsed first frame',
    (await vis('.chat-toolrun[data-open]').count()) === 1);
  ok(`the revealed entries land INSIDE the open card (${r1} → ${r2} rows)`,
    r2 >= r1 + Math.min(e2Hidden, WINDOW_STEP) - 2, JSON.stringify({ r1, r2, e2Hidden }));
  const foldEAfter = foldE ? await markTop(foldE.mark) : null;
  ok('the row being read inside the card is held across the in-card prepend',
    foldE !== null && foldEAfter !== null && Math.abs(foldEAfter - foldE.top) <= 2,
    JSON.stringify({ before: foldE?.top, after: foldEAfter }));

  // ── F: the window measured in CARDS (owner report 08-02) ─────────────────────────────
  //
  // "1 mesaj 50 mesajlı bir grup kayamıyor ama daha fazla yüklemek için kaydır diyor."
  // An ordinary conversation, but grouped: 14 entries render as 3 cards, so the ENTRY tail
  // (40) is two cards and change — shorter than the scroller, nothing to scroll, while the
  // pane's whole way back through history is "scroll up and I'll load more". The floor makes
  // the window reach for WINDOW_TAIL_CARDS things to look at instead, and each reveal step
  // has to be worth WINDOW_STEP_CARDS of them rather than 40 entries that merge into the
  // fold the reader is already staring at.
  console.log('── F: card floor — the window reaches for cards, not entries');
  const cardTotal = Math.min(CARD_TURNS * (CARD_TURN_CALLS + 2), HISTORY_MAX_ITEMS);
  await openPastChat('kartlar', 'grouped');
  ok('the grouped conversation resumes', await until(async () => (await vis('.chat-toolrun').count()) > 0, 20000));
  await page.waitForTimeout(1500);

  const f0 = await probe();
  const fHidden = await hiddenN();
  const fMounted = cardTotal - fHidden;
  ok(`the floor reaches past the entry tail (${fMounted} entries up, an entry window is ${WINDOW_TAIL})`,
    fHidden >= 0 && fMounted > WINDOW_TAIL + TRIM_SLACK,
    JSON.stringify({ cardTotal, fHidden, fMounted }));
  ok(`…and stops there, not at the ceiling (${fMounted} ≤ ${WINDOW_MAX_ENTRIES})`,
    fMounted <= WINDOW_MAX_ENTRIES + 4, JSON.stringify({ fMounted }));
  ok(`it mounted the cards it promised (${f0.rows} top-level rows ≥ ${WINDOW_TAIL_CARDS})`,
    f0.rows >= WINDOW_TAIL_CARDS, JSON.stringify(f0));
  ok('THE REPORT: the transcript now overflows its scroller — there is something to scroll',
    f0.scrollHeight > f0.clientHeight + 40, JSON.stringify(f0));
  ok('and it opens pinned to the bottom all the same', f0.fromBottom <= 4, JSON.stringify(f0));

  await moreBtn().click();
  await page.waitForTimeout(700);
  const f1 = await probe();
  ok(`a reveal is worth CARDS, not entries that vanish into the same fold (${f0.rows} → ${f1.rows} rows)`,
    f1.rows - f0.rows >= WINDOW_STEP_CARDS - 4, JSON.stringify({ before: f0.rows, after: f1.rows }));

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
  console.log('· setting up scratch vault + scripted claude + 300-entry transcript…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  await runScenarios(chromium, `http://127.0.0.1:${port}`, report);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
