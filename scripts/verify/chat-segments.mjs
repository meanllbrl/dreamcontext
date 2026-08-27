#!/usr/bin/env node
/**
 * Written order, and the slot a block holds while it is still being written — runtime proof,
 * in real Chromium.
 *
 *   npm run build && npm run verify:chat-segments
 *
 * The unit suite (tests/unit/chat-html.test.ts) pins the PARSE: that `segments` comes back
 * interleaved, that a pending segment lands last, that no slot marker leaks. None of that
 * proves the transcript DRAWS it that way. Three claims here are geometric, and geometry is
 * exactly what the owner was reporting on 2026-08-27 — "html önce, en altında stream devam
 * ediyor ve bu kopuk bir şeymiş gibi hissettiriyor":
 *
 *   1. THE CARD SITS BETWEEN THE PARAGRAPHS. An answer written prose → block → prose renders
 *      as two bubbles with the card measurably between them, and the trailing sentence is in
 *      the SECOND bubble. Before this change every prose run was merged into one bubble ABOVE
 *      the card, so the words framing a drawing rendered above it.
 *   2. THE PLACEHOLDER HOLDS THAT SLOT. Mid-stream, while the markup is hidden, the
 *      placeholder is already positioned where the card will land — below the prose written
 *      before it — instead of trailing the message as a pill.
 *   3. IT GROWS, AND NEVER LIES. Its outline gains a row as each title CLOSES, and every row
 *      it shows is a complete title from the fixture — never half of one.
 *   4. NO COLLAPSE ON ARRIVAL. Sampled every animation frame from before the turn starts, the
 *      frame's height never sits at the old 40px floor: the card grows out of the slot the
 *      placeholder was holding rather than snapping open from a sliver.
 *   5. NO STRANDED CARET. While the placeholder is up, no blinking caret is left in the
 *      paragraph above it — the caret belongs to the run being typed, and that run is done.
 *
 * Same harness contract as scripts/verify/chat-html.mjs: the real server, the real
 * `/ws/agent-chat`, and a scripted stand-in for `claude` in an isolated fake HOME — but this
 * one STREAMS in `text_delta` frames with real pauses, because every claim above is about a
 * moment mid-turn that an all-at-once answer never has. No tokens are spent. Screenshots land
 * in <scratch>/shots.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-segments');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const CLI = join(REPO, 'dist', 'index.js');

/** The old pre-measurement floor. A frame found at this height is the snap this fixes. */
const OLD_FLOOR = 40;

/** The three titles the fixture closes, in the order it closes them. The outline must only
 *  ever show these — a fourth string, or a prefix of one, means it is drawing half a
 *  heading, which is the thing the placeholder exists to avoid. */
const TITLES = ['Two ways to ship this', 'Behind a flag', 'Cut over at once'];

const PROSE_BEFORE = 'Here is the shape of it.';
const PROSE_AFTER = 'What do you think? Pick one and I will ship it.';

/**
 * The block, pre-split into the chunks the stand-in streams.
 *
 * Split at points that matter rather than at a fixed width: each title closes inside its own
 * chunk, so the outline is observed gaining exactly one row at a time. A uniform split would
 * still pass check 3 but would prove far less about it.
 */
const HTML_CHUNKS = [
  '<div class="dc-doc">',
  '<h2 class="dc-h2">Two ways to ship',
  ` this</h2>`,
  '<div class="dc-compare">',
  '<div class="dc-option dc-option--pick"><div class="dc-option-head">',
  '<span class="dc-option-title">Behind',
  ' a flag</span>',
  '<span class="dc-chip dc-chip--accent">recommended</span></div>',
  '<ul class="dc-pros"><li>Reversible in one commit</li></ul>',
  '<ul class="dc-cons"><li>Two code paths for a week</li></ul></div>',
  '<div class="dc-option"><div class="dc-option-head">',
  '<span class="dc-option-title">Cut over',
  ' at once</span></div>',
  '<ul class="dc-cons"><li>Rollback is a revert plus a redeploy</li></ul></div>',
  '</div></div>',
];

/** The whole answer, exactly as the stand-in will have streamed it. */
const ANSWER = [
  PROSE_BEFORE,
  '',
  '```dream-html',
  HTML_CHUNKS.join(''),
  '```',
  '',
  PROSE_AFTER,
].join('\n');

/**
 * The delta script: [text, pause-after-ms].
 *
 * The pauses are the instrument. The block has to take long enough to write that a poller can
 * catch the placeholder in several distinct states — which is also, not coincidentally, the
 * real condition being fixed: a 2KB block is ~600 tokens of dead air.
 */
const DELTAS = [
  [`${PROSE_BEFORE}\n\n`, 260],
  ['```dream-html\n', 200],
  ...HTML_CHUNKS.map((c) => [c, 150]),
  ['\n```\n\n', 260],
  [PROSE_AFTER, 120],
];

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-segments.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSWER = ${JSON.stringify(ANSWER)};
const DELTAS = ${JSON.stringify(DELTAS)};
const inbox = [];
let pumping = false;

async function runTurn() {
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const [text, pause] of DELTAS) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    await sleep(pause);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] } });
  await sleep(120);
  out({ type: 'result', subtype: 'success', is_error: false, result: ANSWER });
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
async function pump() {
  if (pumping) return;
  if (inbox.shift() === undefined) return;
  pumping = true;
  try { await runTurn(); } finally { pumping = false; }
}
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup ────────────────────────────────────────────────────────────────────────────

const dc = (args, opts = {}) => execFileSync(process.execPath, [CLI, ...args], {
  cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
}).toString();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── the assertions ───────────────────────────────────────────────────────────────────

const visOn = (page, sel) => page.locator(`${sel}:visible`);

const untilOn = async (page, fn, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(90); }
  return false;
};

/** Open the agent surface and send the one message the stand-in answers. Same shape as
 *  chat-html.mjs's opener — kept local so this script has no cross-script dependency. */
async function openChatAndAsk(page, base) {
  const vis = (sel) => visOn(page, sel);
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
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  const opened = await untilOn(page, async () => (await vis('.chat-cmp-input').count()) > 0, 20000);
  await page.waitForTimeout(800);

  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('GO');
  await page.keyboard.press('Enter');
  return opened;
}

/**
 * Installed BEFORE the turn starts, sampling every animation frame.
 *
 * A poll would miss what this is for. The collapse-then-snap being ruled out is a single
 * frame long: the placeholder unmounts, the iframe mounts at its pre-measurement height, and
 * a measurement replaces it on the next commit. Polling at 90ms sees the settled height and
 * proves nothing about the frame in between.
 */
const SAMPLER = `(() => {
  const s = { frameHeights: [], outlineRows: [], pendingCaret: [] };
  window.__dcSeg = s;
  const tick = () => {
    const f = document.querySelector('iframe.chat-htmlview-frame');
    if (f) s.frameHeights.push(Math.round(f.getBoundingClientRect().height));
    const pend = document.querySelector('.chat-htmlpending');
    if (pend) {
      s.outlineRows.push([...pend.querySelectorAll('.chat-htmlpending-outline li')].map((li) => li.textContent.trim()));
      s.pendingCaret.push(document.querySelectorAll('.chat-msg-caret').length);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

/** The geometry of one assistant answer, read in one round trip. */
const GEOMETRY = `(() => {
  const row = document.querySelector('.chat-msg-assistant-row');
  if (!row) return null;
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; };
  const proseEls = [...row.querySelectorAll('.chat-msg-assistant-body')];
  const card = row.querySelector('.chat-htmlview:not(.chat-htmlpending)');
  return {
    prose: proseEls.map((el) => ({ ...box(el), text: el.innerText.trim() })),
    card: card ? box(card) : null,
    cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null,
    // The order the reader actually meets them in, straight off the DOM.
    order: [...row.children].map((el) => (
      el.classList.contains('chat-msg-assistant-body') ? 'prose'
        : el.classList.contains('chat-htmlpending') ? 'pending'
          : el.classList.contains('chat-htmlview') ? 'card' : el.className.split(' ')[0]
    )),
  };
})()`;

/** The finished card's rendered width, for comparison against the slot that held its place. */
const cardWidth = (geom) => Math.round(geom?.cardWidth ?? -1);

async function runTheme(base, theme, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const vis = (sel) => visOn(page, sel);
  const ok = (label, cond, detail = '') => report.check(theme, label, cond, detail);

  ok('a chat session opens against the real WS route', await openChatAndAsk(page, base));
  await page.evaluate(SAMPLER);

  // ── mid-stream: the placeholder, in the block's own slot ───────────────────────────
  const appeared = await untilOn(page, async () => (await vis('.chat-htmlpending').count()) > 0, 25000);
  ok('a still-open dream-html fence draws a placeholder', appeared);

  const midGeom = await page.evaluate(GEOMETRY);
  const pendBox = await page.locator('.chat-htmlpending').first().boundingBox().catch(() => null);
  const firstProse = midGeom?.prose?.[0] ?? null;
  ok('…under the prose already written',
    !!(pendBox && firstProse) && pendBox.y >= firstProse.bottom - 2,
    `placeholder top ${Math.round(pendBox?.y ?? -1)} vs prose bottom ${firstProse?.bottom}`);
  // THE discriminating mid-stream claim. Position alone proves little here: while a fence is
  // open it is by definition the last thing in the text, so the old bottom-of-message pill
  // sat in the same place. What changed is the FOOTPRINT — the slot is the block's own box,
  // at the transcript's measure, rather than a hug-content pill a fifth of the width. The
  // comparison against the finished card happens after it lands.
  ok('…and it is a block-SIZED slot, not a pill: it spans the transcript measure',
    !!(pendBox && midGeom?.prose?.[0]) && pendBox.width > firstProse.height * 4
      && pendBox.width > 400,
    `placeholder ${Math.round(pendBox?.width ?? -1)}px wide`);
  ok('…and it is the ONLY thing after that prose while the fence is open',
    JSON.stringify(midGeom?.order?.slice(0, 2)) === JSON.stringify(['prose', 'pending']),
    JSON.stringify(midGeom?.order));
  ok('…the old bottom-of-message pill is not used for an html fence',
    (await page.locator('.chat-view-pending').count()) === 0);

  await page.screenshot({ path: join(SHOTS, `chat-segments-pending-${theme}.png`) });

  // ── mid-stream: the outline is really in the DOM, not only in the rAF samples ──────
  const outlineShown = await untilOn(page, async () =>
    (await page.locator('.chat-htmlpending-outline li').count()) >= 2, 25000);
  ok('the placeholder shows the titles the markup has already closed', outlineShown);
  const shownRows = await page.locator('.chat-htmlpending-outline li').allInnerTexts()
    .catch(() => []);
  ok('…as real text, matching the fixture\'s own headings',
    shownRows.length >= 2 && shownRows.every((t) => TITLES.includes(t.trim())),
    JSON.stringify(shownRows));
  await page.screenshot({ path: join(SHOTS, `chat-segments-growing-${theme}.png`) });

  // ── mid-stream: it grows, and never shows half a title ─────────────────────────────
  const drawn = await untilOn(page, async () => (await vis('.chat-htmlview-frame').count()) > 0, 30000);
  ok('the fence closed and the real block mounted', drawn);

  const samples = await page.evaluate('window.__dcSeg');
  const rowCounts = (samples?.outlineRows ?? []).map((r) => r.length);
  const grew = rowCounts.some((n, i) => i > 0 && n > rowCounts[i - 1]);
  ok('the placeholder GREW while the markup streamed — dead air became legible work',
    grew && Math.max(0, ...rowCounts) >= 2,
    `outline rows went ${rowCounts.length ? `${Math.min(...rowCounts)}→${Math.max(...rowCounts)}` : 'unsampled'}`);

  const everyRow = [...new Set((samples?.outlineRows ?? []).flat())];
  ok('…and every row it ever showed was a COMPLETE title, never half of one',
    everyRow.length > 0 && everyRow.every((t) => TITLES.includes(t)),
    JSON.stringify(everyRow));
  ok('…in the order the markup closed them',
    JSON.stringify((samples?.outlineRows ?? []).at(-1)) === JSON.stringify(TITLES.slice(0, (samples?.outlineRows ?? []).at(-1)?.length ?? 0)),
    JSON.stringify((samples?.outlineRows ?? []).at(-1)));

  ok('no blinking caret was stranded in the paragraph above the placeholder',
    (samples?.pendingCaret ?? []).length > 0 && (samples.pendingCaret).every((n) => n === 0),
    `caret sightings while pending: ${(samples?.pendingCaret ?? []).filter((n) => n > 0).length}`);

  // ── the frame never sits at the old floor ──────────────────────────────────────────
  const heights = samples?.frameHeights ?? [];
  ok('the block never rendered at the old 40px floor — it grows out of the slot, not from a sliver',
    heights.length > 0 && Math.min(...heights) > OLD_FLOOR,
    `${heights.length} frames sampled, min ${heights.length ? Math.min(...heights) : 'n/a'}px`);

  // ── the finished answer: the card BETWEEN the paragraphs ───────────────────────────
  const settled = await untilOn(page, async () => {
    const g = await page.evaluate(GEOMETRY);
    return g?.prose?.length === 2 && !!g.card && g.card.height > 120;
  }, 20000);
  ok('the answer settled into two prose runs around one card', settled);

  const geom = await page.evaluate(GEOMETRY);
  ok('THE FIX: the card sits BETWEEN the paragraphs, in written order',
    JSON.stringify(geom?.order?.slice(0, 3)) === JSON.stringify(['prose', 'card', 'prose']),
    JSON.stringify(geom?.order));
  ok('…geometrically, not just in the DOM',
    !!(geom?.card && geom.prose[0] && geom.prose[1])
      && geom.card.top >= geom.prose[0].bottom - 2
      && geom.card.bottom <= geom.prose[1].top + 2,
    `prose0 ${geom?.prose?.[0]?.bottom} | card ${geom?.card?.top}-${geom?.card?.bottom} | prose1 ${geom?.prose?.[1]?.top}`);
  ok('…the trailing sentence is in the SECOND bubble — the defect was it landing in the first',
    geom?.prose?.[1]?.text === PROSE_AFTER && !geom?.prose?.[0]?.text.includes(PROSE_AFTER),
    `first: ${JSON.stringify(geom?.prose?.[0]?.text)}`);
  ok('…and the opening sentence stayed above it', geom?.prose?.[0]?.text === PROSE_BEFORE,
    JSON.stringify(geom?.prose?.[0]?.text));
  ok('…and the card landed in the footprint the placeholder was holding',
    !!(pendBox && geom?.card) && Math.abs(pendBox.width - cardWidth(geom)) < 4,
    `placeholder ${Math.round(pendBox?.width ?? -1)}px vs card ${cardWidth(geom)}px`);
  ok('the raw markup never leaked into either bubble',
    !(geom?.prose ?? []).some((p) => p.text.includes('<div class="dc-doc"')));
  ok('the placeholder is gone once the block is real',
    (await page.locator('.chat-htmlpending').count()) === 0);
  ok('the card is drawn by the kit, not by the fixture\'s own styling',
    (await page.frameLocator('iframe.chat-htmlview-frame').first()
      .locator('.dc-option--pick').count()) === 1);

  await page.screenshot({ path: join(SHOTS, `chat-segments-settled-${theme}.png`) });
  await browser.close();
}

// ─── main ─────────────────────────────────────────────────────────────────────────────

const report = {
  rows: [],
  check(theme, label, cond, detail = '') {
    this.rows.push({ theme, label, cond, detail });
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${!cond && detail ? ` — ${detail}` : ''}`);
  },
  note(msg) { console.log(`  note: ${msg}`); },
};

let server;
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  setup();
  server = await startServer(port);
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
    // A live session is persisted per vault, so the second browser would open onto the
    // restored conversation instead of a fresh composer.
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runTheme(base, theme, report);
  }
} catch (err) {
  console.error('\nharness error:', err);
  report.rows.push({ theme: '-', label: `harness: ${err.message}`, cond: false, detail: '' });
} finally {
  server?.kill();
}

const failed = report.rows.filter((r) => !r.cond);
console.log(`\n${report.rows.length - failed.length}/${report.rows.length} checks passed`);
console.log(`screenshots: ${SHOTS}`);
if (failed.length) {
  console.log('\nfailed:');
  for (const r of failed) console.log(`  [${r.theme}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
}
process.exit(failed.length ? 1 : 0);
