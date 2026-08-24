#!/usr/bin/env node
/**
 * The pinned shelf — end-to-end verification in a real browser.
 *
 *   npm run build && npm run verify:chat-shelf-ui
 *
 * Proves the four properties the shelf exists for, and that no unit test can reach, because
 * every one of them is about GEOMETRY:
 *
 *   1. the resting state is ONE tag line — no open row, no border, no card;
 *   2. a row opens ABOVE it, and the tag line and the composer do not move a pixel;
 *   3. the two-row ceiling holds no matter how many rows the agent asks for — the excess
 *      demotes to `⌃` chips rather than growing a third row;
 *   4. it does not react to scroll: identical boxes at scroll top, middle and bottom.
 *
 * Plus M2b (a user-opened detail moves nothing below it), the `+N` fold opening upward,
 * dismissal leaving its neighbours alone, and pins surviving a reload.
 *
 * Same harness contract as scripts/verify/dream-actions.mjs: the real server, the real
 * `/api/agent/chat` WS route, a real browser, a scripted stand-in for `claude` in an isolated
 * fake HOME so no tokens are spent, and COLLECT-DON'T-FAIL-FAST reporting.
 *
 * ISOLATION — the fixture HOME is load-bearing, not incidental. Everything the server reads
 * from `homedir()` (vault registry, `~/.claude`) resolves inside the scratch dir, so this
 * script can neither read nor write the developer's real Claude state.
 *
 * TOLERANCE — geometry is compared at ±2px, the repo's own precedent (chat-scroll.mjs:423).
 * Sub-pixel layout rounding is not a regression, and asserting exact equality would make this
 * script flaky in the one place it must be trusted.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-shelf-ui');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');

/** Geometry tolerance — see the header. */
const EPS = 2;

const TASK_SLUG = 'shelf-verify-task';
/** A task whose Acceptance Criteria section holds prose and no checkboxes. There is nothing to
 *  divide by, so there is no percent — and the panel has to SAY so rather than draw an empty
 *  checklist frame under a header with no number in it. */
const EMPTY_SLUG = 'shelf-verify-no-criteria';

/** Set VERIFY_SHOTS=<dir> to drop PNGs of the states asserted below. Declared here rather than
 *  at the one old call site so the run-progress panel — which overflows `.pin-shelf` and so
 *  cannot be captured by an element shot of it — can be photographed where it is open. */
const SHOTS = process.env.VERIFY_SHOTS;

/** A task file with 11 acceptance criteria, 7 ticked → the design's own 64% / 7-of-11. */
const TASK_MD = `---
id: task_shelfverify
name: Shelf verify task
status: in_progress
---

## Acceptance Criteria

### Part A - wiring

- [x] read the capability allowlist
- [x] map the dev proxy entry
- [x] dedupe the dev proxy entry
- [x] patch vite.config.ts
- [x] patch dev.json

### Part B - the surface

- [x] regenerate capability types
- [x] restart the dev server
- [ ] loopback url exception
- [ ] route the port pin through one source

### Validation

- [ ] smoke test tauri dev
- [ ] note it in the 0.25.0 changelog

## Changelog

### 2026-08-23 - Session Update
- restarted the dev server and re-read the allowlist
`;

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Four turns, each driving one state of the shelf. The prompt selects the turn, so the
// browser side stays a sequence of ordinary messages.
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-shelf-ui.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;

const fence = (obj) => '\\n\\n\`\`\`dream-view\\n' + JSON.stringify(obj) + '\\n\`\`\`\\n';

// FACTS — a tag-weight pin carrying a loopback port plus several plain labels, enough that a
// 470px pane must fold some of them.
const FACTS = fence({
  type: 'pin', id: 'dev', weight: 'tag',
  facts: [
    { label: ':5173', url: 'http://localhost:5173' },
    { label: 'node 22.3.0' },
    { label: 'db local' },
    { label: 'PR #218' },
    { label: 'api staging' },
    { label: 'cache warm' },
  ],
});

// LONG — a row-weight pin with prose and no lede, so the SHELF clamps it and must say so.
const LONG = fence({
  type: 'pin', id: 'summary', weight: 'row',
  detail: '16 tasks deleted after the placement review: everything under the right-rail branch, plus the four spikes on the tab-bar strip. 0.24.2 folded into 0.25.0 — the shelf ships in one release, not two. Placement A chosen: the shelf docks to the composer, grows upward, and never reacts to scroll. Remaining open question is the ceiling behaviour once three long pins exist at once; current answer is demotion, oldest first. '.repeat(6),
});

// PROGRESS — derived from the task file on disk, never from this payload.
const PROGRESS = fence({ type: 'progress', task: '${TASK_SLUG}' });

// NOCRIT — a progress block for a task with no checkboxes at all. Degrades loudly or fails.
const NOCRIT = fence({ type: 'progress', task: '${EMPTY_SLUG}' });

// CEILING — five row-weight pins in ONE turn. The shelf must still show exactly one row.
const MANY = [1, 2, 3, 4, 5].map((n) => fence({
  type: 'pin', id: 'many' + n, weight: 'row',
  lede: 'row pin number ' + n + ' with a lede long enough to earn its row rather than a chip',
  detail: 'detail for row pin ' + n,
})).join('');

// A long transcript, so the scroll-invariance check has something to scroll through.
const FILLER = Array.from({ length: 60 }, (_, i) =>
  'Line ' + (i + 1) + ' of filler prose, long enough to give the transcript a real scroll range so the shelf can be observed at the top, the middle and the bottom of it.').join('\\n\\n');

// MANYTAGS — four tag-weight pins, six facts each, so the tag area MUST wrap at any width
// the app is usable at. The replacement for the deleted fold checks.
const MANYTAGS = [1, 2, 3, 4].map((n) => fence({
  type: 'pin', id: 'bulk' + n, weight: 'tag',
  facts: [1, 2, 3, 4, 5, 6].map((f) => ({ label: 'tag-' + n + '-' + f })),
})).join('');

function reply(prompt) {
  // MANYTAGS is tested BEFORE MANY: 'MANYTAGS' contains 'MANY', so the narrower match has to
  // win or this turn would silently deliver five row pins instead.
  if (prompt.includes('MANYTAGS')) return 'Pinned a lot of tags.' + MANYTAGS;
  if (prompt.includes('FACTS')) return 'Pinned this session\\'s facts.' + FACTS;
  if (prompt.includes('LONG')) return 'Pinned a summary.' + LONG;
  // NOCRIT before PROGRESS: neither string contains the other, but keeping the degenerate arm
  // first matches the order the checks run in and costs nothing.
  if (prompt.includes('NOCRIT')) return 'Tracking a task with nothing to count.' + NOCRIT;
  if (prompt.includes('PROGRESS')) return 'Tracking the run.' + PROGRESS;
  if (prompt.includes('MANY')) return 'Pinned five rows.' + MANY;
  if (prompt.includes('FILL')) return FILLER;
  return 'ANSWER ' + prompt;
}

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-shelf', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: ['compact'] });
  await sleep(120);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply(prompt) }] } });
  await sleep(120);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-shelf' });
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

// ─── setup (mirrors scripts/verify/dream-actions.mjs) ────────────────────────────────

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
  // The task the progress row reads. Written to the SCRATCH project, never anywhere real.
  writeFileSync(join(PROJ, '_dream_context', 'state', `${TASK_SLUG}.md`), TASK_MD);
  writeFileSync(join(PROJ, '_dream_context', 'state', `${EMPTY_SLUG}.md`),
    '---\nid: task_nocrit\nstatus: in_progress\n---\n\n## Acceptance Criteria\n\nProse only, no checkboxes.\n');
  spawnSync('git', ['init', '-q', '-b', 'feat/pin-surface'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

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

async function runWidth(chromium, base, width, report) {
  const label = `${width}px`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };
  const idle = () => until(async () => (await vis('.chat-cmp-stop').count()) === 0, 30000);
  const ok = (name, cond, detail) => report.check(label, name, cond, detail);
  const box = async (sel) => { const b = await vis(sel).first().boundingBox(); return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null; };
  const near = (a, b, key) => a && b && Math.abs(a[key] - b[key]) <= EPS;
  /**
   * "Did it move?" for BOTTOM-DOCKED chrome, which is what the shelf and composer are.
   *
   * The top edge is the wrong probe now that `.pin-tags` wraps: adding a tag can add a line,
   * which moves the top edge down-to-up BY DESIGN while the seam with the composer stays
   * exactly where it was. The bottom edge is what the eye is actually anchored to — nothing
   * the user was reading has shifted iff the bottoms hold — so it is the stronger claim, not
   * a weaker one. Where the tag SET is unchanged (scroll, expand/collapse) the top edge is
   * asserted too, since there the two are equivalent and a top-edge move would be a real bug.
   */
  const bottomOf = (b) => (b ? { b: b.y + b.h } : null);
  const bottomHeld = (a, b) => near(bottomOf(a), bottomOf(b), 'b');

  // The reload check above leaves the surface collapsed, so anything that has to TYPE after it
  // must re-open the pane first. Factored out of the opening sequence rather than duplicated,
  // so a future change to how the surface is opened only has to be made once.
  const expandSurface = async () => {
    if (await page.locator('.agent-surface.expanded').count()) return;
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  };

  const say = async (text) => {
    await vis('.chat-cmp-input').first().click();
    await vis('.chat-cmp-input').first().fill(text);
    await page.keyboard.press('Enter');
    await idle();
    await page.waitForTimeout(400);
  };

  console.log(`\n═══ ${label} ═══`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  await expandSurface();
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(1200);

  // ── 1 — the resting state is ONE tag line ────────────────────────────────────────
  console.log('── rest: one tag line, no row, no card');
  ok('the branch the session acts on is on the tag line, server-derived',
    await until(async () => (await vis('.pin-tags').count()) > 0 && (await vis('.pin-tags').first().innerText()).includes('feat/pin-surface'), 20000),
    await vis('.pin-tags').first().innerText().catch(() => '(no tag line)'));
  ok('at rest there is no open row', (await vis('.pin-row').count()) === 0);
  ok('…and no shell border — the resting shelf is a tag line, not a card',
    (await page.locator('.pin-shell.has-rows').count()) === 0);
  ok('…and the composer keeps its full radius', (await page.locator('.chat-cmp-card.is-shelved').count()) === 0);
  const restTags = await box('.pin-tags');
  const restCard = await box('.chat-cmp-card');

  await say('FACTS please');
  ok('an agent pin adds its facts to the SAME tag line, still with no row',
    (await vis('.pin-row').count()) === 0 && (await vis('.pin-tags').first().innerText()).includes('5173'),
    await vis('.pin-tags').first().innerText());
  // The NORMALIZED destination, trailing slash and all — that is what `sanitizeLoopbackUrl`
  // stored and what the OS will actually open. Showing the pre-normalization spelling would
  // be showing something other than where the click goes, which is the opposite of M2.9c.
  ok('a loopback fact is a link chip that shows where it goes (M2.9c)',
    (await vis('.pin-chip.is-link').count()) > 0
    && (await vis('.pin-chip.is-link').first().getAttribute('title')) === 'http://localhost:5173/',
    await vis('.pin-chip.is-link').first().getAttribute('title').catch(() => '(none)'));

  // ── 2 — a row opens ABOVE, and nothing below it moves ────────────────────────────
  console.log('── active: the row opens above, the tag line holds its pixel');
  await say('FILL the transcript');
  await say('PROGRESS on the run');
  ok('a progress block opens exactly ONE row', (await vis('.pin-row').count()) === 1);
  ok('the row reads the percentage off the task file, not off the payload',
    (await vis('.pin-pct').first().innerText()).trim() === '64%',
    await vis('.pin-pct').first().innerText().catch(() => '(none)'));
  ok('…and the criteria count with it', (await vis('.pin-count').first().innerText()).trim() === '7/11',
    await vis('.pin-count').first().innerText().catch(() => '(none)'));
  ok('…and names the criterion in flight',
    (await vis('.pin-now').first().innerText()).includes('loopback url exception'),
    await vis('.pin-now').first().innerText().catch(() => '(none)'));
  ok('the accent track is filled to the derived percentage',
    Math.abs(await vis('.pin-track-fill').first().evaluate((el) => {
      const track = el.parentElement;
      return (el.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100;
    }) - 64) <= 2);
  ok('the shell became one object with the composer (border + squared corners)',
    (await page.locator('.pin-shell.has-rows').count()) === 1
    && (await page.locator('.chat-cmp-card.is-shelved').count()) === 1);

  const activeTags = await box('.pin-tags');
  const activeCard = await box('.chat-cmp-card');
  ok('THE TAG LINE DID NOT MOVE when the row opened above it',
    bottomHeld(restTags, activeTags),
    JSON.stringify({ rest: bottomOf(restTags), active: bottomOf(activeTags) }));
  ok('…nor did the composer', bottomHeld(restCard, activeCard),
    JSON.stringify({ rest: bottomOf(restCard), active: bottomOf(activeCard) }));

  // ── 2b — the progress DETAIL is a popover, not an in-place expansion ─────────────
  // AMENDED by the owner after live testing: the row stays pinned, but its detail floats over
  // the conversation so it costs the shelf no height at all.
  console.log('── progress detail: a popover over the conversation');
  // ── the row READS AS LIVE, not as a frozen fraction ──────────────────────────────
  // The owner's complaint was not that the number was wrong — it was that nothing ever moved,
  // so a run that had stalled looked identical to one that was working. The since-last-write
  // clock is the honest signal, and this is the only way to prove it actually ticks.
  // The fixture is written at setup and is minutes old by the time this runs, which would park
  // the clock in its "3m ago" band where nothing changes inside a 2s window. Touching the file
  // puts the reading back into SECONDS — the band that has to visibly move — and then one poll
  // cycle (4s, plus margin) carries the new mtime to the row.
  const SECONDS_CLOCK = /^(\d+)s ago$/;
  utimesSync(join(PROJ, '_dream_context', 'state', `${TASK_SLUG}.md`), new Date(), new Date());
  await page.waitForTimeout(5_500);
  const clock0 = (await vis('.pin-since').first().innerText().catch(() => '')).trim();
  ok('the row carries a since-last-write clock, in seconds while the write is recent',
    SECONDS_CLOCK.test(clock0), `"${clock0}"`);
  const tagsBeforeClock = await box('.pin-tags');
  await page.waitForTimeout(2_200);
  const clock1 = (await vis('.pin-since').first().innerText().catch(() => '')).trim();
  // The point of the whole liveness change: this number advances on its OWN interval, between
  // polls and without the percent moving. A frozen fraction was the complaint.
  ok('…and it MOVES on its own — the panel is watched, not re-read',
    SECONDS_CLOCK.test(clock1)
    && Number(clock1.match(SECONDS_CLOCK)[1]) > Number(clock0.match(SECONDS_CLOCK)?.[1] ?? -1),
    JSON.stringify({ before: clock0, after: clock1 }));
  ok('…without moving the tag line, which is the one thing the shelf must never do',
    near(tagsBeforeClock, await box('.pin-tags'), 'y'),
    JSON.stringify({ before: tagsBeforeClock, after: await box('.pin-tags') }));

  const rowBefore = await box('.pin-row');
  await vis('.pin-lede').first().click();
  await page.waitForTimeout(350);
  ok('clicking the progress row opens a dialog popover, NOT an in-place panel',
    (await vis('.pin-pop').count()) === 1 && (await vis('.pin-body').count()) === 0,
    `pop=${await vis('.pin-pop').count()} body=${await vis('.pin-body').count()}`);
  const popBox = await box('.pin-pop');
  ok('it floats ABOVE the shelf, over the conversation',
    !!popBox && !!rowBefore && popBox.y + popBox.h <= rowBefore.y + EPS,
    JSON.stringify({ pop: popBox, row: rowBefore }));
  ok('it names the run and carries the derived count',
    (await vis('.pin-pop-head').first().innerText()).includes('Run progress')
    && (await vis('.pin-pop-head').first().innerText()).includes('7/11'),
    (await vis('.pin-pop-head').first().innerText().catch(() => '(none)')).replace(/\s+/g, ' '));
  ok('it caps itself and scrolls inside rather than growing',
    !!popBox && popBox.h <= 900 * 0.46 + EPS, JSON.stringify(popBox));
  // ── the CHECKLIST — the defect this panel was rebuilt to remove ──────────────────
  // It used to render exactly two rows under a header reading `7/11`: the criterion in flight
  // and the newest changelog bullet. Everything below asserts the header's denominator is now
  // something you can actually count on screen.
  const taskRows = await vis('.pin-pop .pin-task').count();
  ok('every criterion is on screen — the count matches the header\'s denominator',
    taskRows === 11, `rendered ${taskRows} rows under a header reading 7/11`);
  ok('…7 ticked, 1 in flight, 3 still to do — three states and no fourth',
    (await vis('.pin-pop .pin-task.is-done').count()) === 7
    && (await vis('.pin-pop .pin-task.is-now').count()) === 1
    && (await vis('.pin-pop .pin-task.is-todo').count()) === 3,
    JSON.stringify({
      done: await vis('.pin-pop .pin-task.is-done').count(),
      now: await vis('.pin-pop .pin-task.is-now').count(),
      todo: await vis('.pin-pop .pin-task.is-todo').count(),
    }));
  const heads = await vis('.pin-pop .pin-group-name').allInnerTexts();
  ok('…grouped under the milestone headings the task was written with',
    JSON.stringify(heads) === JSON.stringify(['Part A - wiring', 'Part B - the surface', 'Validation']),
    JSON.stringify(heads));
  const groupCounts = await vis('.pin-pop .pin-group-head .pin-count').allInnerTexts();
  ok('…and each group counts itself', JSON.stringify(groupCounts) === JSON.stringify(['5/5', '2/4', '0/2']),
    JSON.stringify(groupCounts));
  const flightStrip = (await vis('.pin-pop-flight').first().innerText()).replace(/\s+/g, ' ');
  ok('the criterion in flight is held at the top of the panel, not hunted for in the list',
    flightStrip.includes('loopback url exception') && flightStrip.includes('in flight'), flightStrip);
  ok('…and it is the SAME line the row names, so the two cannot disagree',
    (await vis('.pin-row .pin-now').first().innerText()).includes('loopback url exception'),
    (await vis('.pin-row .pin-now').first().innerText()).replace(/\s+/g, ' '));
  if (SHOTS) {
    await page.locator('.chat-pane').first()
      .screenshot({ path: `${SHOTS}/run-progress-panel.png` }).catch(() => {});
  }
  const foot = (await vis('.pin-pop-foot').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('the changelog bullet is a FOOTER, not a twelfth criterion',
    (await vis('.pin-pop-foot').count()) === 1 && foot.includes('last logged')
    && (await vis('.pin-pop-foot .pin-task').count()) === 0,
    `foot="${foot}" rows=${taskRows}`);

  // ── the panel STAYS anchored while the list scrolls under it ─────────────────────
  // This is what replaced "scroll to the in-flight row on open": sticky holds at every scroll
  // position, and `PinShelf.tsx` is forbidden from touching scroll at all.
  const stripBefore = await box('.pin-pop-flight');
  await vis('.pin-pop').first().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(250);
  const stripAfter = await box('.pin-pop-flight');
  ok('scrolling the list does NOT scroll the in-flight strip away',
    near(stripBefore, stripAfter, 'y'), JSON.stringify({ before: stripBefore, after: stripAfter }));
  ok('…and the list really did scroll (the assertion above is not vacuous)',
    (await vis('.pin-pop').first().evaluate((el) => el.scrollTop)) > 0);
  await vis('.pin-pop').first().evaluate((el) => { el.scrollTop = 0; });

  ok('THE POPOVER COSTS THE SHELF NO HEIGHT — the row did not move',
    near(rowBefore, await box('.pin-row'), 'y') && near(rowBefore, await box('.pin-row'), 'h'));
  ok('…the tag line did not move', near(activeTags, await box('.pin-tags'), 'y'));
  ok('…and neither did the composer', near(activeCard, await box('.chat-cmp-card'), 'y'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Esc closes it (overlay stack)', (await vis('.pin-pop').count()) === 0);
  await vis('.pin-lede').first().click();
  await page.waitForTimeout(300);
  await vis('.chat-scroll').first().click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(300);
  ok('a click away closes it', (await vis('.pin-pop').count()) === 0);
  await vis('.pin-lede').first().click();
  await page.waitForTimeout(300);
  await vis('.pin-pop .pin-x').first().click();
  await page.waitForTimeout(300);
  ok('its own × closes it', (await vis('.pin-pop').count()) === 0);

  // ── 2c — a reading that cannot be honest degrades LOUDLY ─────────────────────────
  // The checklist makes this arm matter MORE, not less: a task with nothing to count must
  // produce a notice and NO list — never an empty checklist frame under a blank denominator.
  // Placed here rather than at the end because the pane is open and the state is restorable:
  // this pins a second progress entry, checks it, then DISMISSES it, which hands the row back
  // to the original run and leaves the shelf exactly as the sections below expect it.
  console.log('── degradation: a task with no checkboxes at all');
  await say('NOCRIT please');
  await until(async () =>
    (await vis('.pin-row').first().innerText().catch(() => '')).includes('nothing to'), 15000);
  const degradedRow = (await vis('.pin-row').first().innerText()).replace(/\s+/g, ' ');
  ok('the row states the reason instead of drawing a bar',
    degradedRow.includes('nothing to derive') || degradedRow.includes('nothing to count'), degradedRow);
  ok('…and shows no percentage and no track fill',
    !/\d+%/.test(degradedRow) && (await page.locator('.pin-track-fill').count()) === 0, degradedRow);
  await vis('.pin-lede').first().click();
  await page.waitForTimeout(350);
  ok('…the panel carries the notice', (await vis('.pin-pop .pin-notice').count()) === 1,
    (await vis('.pin-pop').first().innerText().catch(() => '(closed)')).replace(/\s+/g, ' ').slice(0, 160));
  ok('…and NO checklist — an empty list frame would be the silent version of the bug',
    (await vis('.pin-pop .pin-task').count()) === 0
    && (await vis('.pin-pop .pin-group-head').count()) === 0
    && (await vis('.pin-pop-flight').count()) === 0,
    JSON.stringify({
      tasks: await vis('.pin-pop .pin-task').count(),
      groups: await vis('.pin-pop .pin-group-head').count(),
      flight: await vis('.pin-pop-flight').count(),
    }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  // Restore: dismissing the degenerate entry hands the row back to the real run.
  await vis('.pin-row .pin-x').first().click();
  await until(async () => (await vis('.pin-row').first().innerText().catch(() => '')).includes('7/11'), 15000);
  ok('dismissing it hands the row back to the real run, unchanged',
    (await vis('.pin-row').first().innerText()).includes('7/11'),
    (await vis('.pin-row').first().innerText()).replace(/\s+/g, ' '));

  // ── 3 — no scroll reaction ───────────────────────────────────────────────────────
  console.log('── scroll: the shelf is not in the scroller');
  const scrollTo = async (where) => {
    await vis('.chat-scroll').first().evaluate((el, w) => {
      el.scrollTop = w === 'top' ? 0 : w === 'mid' ? el.scrollHeight / 2 : el.scrollHeight;
    }, where);
    await page.waitForTimeout(500);
  };
  await scrollTo('top');
  const atTop = { tags: await box('.pin-tags'), card: await box('.chat-cmp-card'), row: await box('.pin-row') };
  await scrollTo('mid');
  const atMid = { tags: await box('.pin-tags'), card: await box('.chat-cmp-card'), row: await box('.pin-row') };
  await scrollTo('bottom');
  const atEnd = { tags: await box('.pin-tags'), card: await box('.chat-cmp-card'), row: await box('.pin-row') };
  for (const [k, name] of [['tags', 'the tag line'], ['card', 'the composer'], ['row', 'the open row']]) {
    ok(`${name} is byte-identical at scroll top / mid / bottom`,
      near(atTop[k], atMid[k], 'y') && near(atMid[k], atEnd[k], 'y')
      && near(atTop[k], atMid[k], 'h') && near(atMid[k], atEnd[k], 'h'),
      JSON.stringify({ top: atTop[k], mid: atMid[k], end: atEnd[k] }));
  }

  // ── 4 — the ceiling ──────────────────────────────────────────────────────────────
  console.log('── ceiling: five row pins, still one row');
  await say('MANY rows now');
  ok('five row-weight pins still produce exactly ONE row',
    (await vis('.pin-row').count()) === 1, `rows=${await vis('.pin-row').count()}`);
  ok('the ones that lost the slot DEMOTED to ⌃ chips — they did not close',
    (await vis('.pin-chip.is-demoted').count()) + (await page.locator('.pin-chip.is-demoted').count()) > 0,
    `demoted=${await page.locator('.pin-chip.is-demoted').count()}`);
  const ceilTags = await box('.pin-tags');
  ok('…and the tag line STILL has not moved', bottomHeld(restTags, ceilTags),
    JSON.stringify({ rest: bottomOf(restTags), ceiling: bottomOf(ceilTags) }));

  // ── 5 — M2b: the user opens a detail ─────────────────────────────────────────────
  console.log('── M2b: expansion grows upward and moves nothing below it');
  await say('LONG summary');
  // A LIVE RUN OWNS THE ROW (M3.9): while progress is on the shelf every pin is demoted to a
  // `⌃` chip, however new it is. So the run is closed first — which also asserts the other
  // half of that rule, that the pin it displaced comes BACK when the run ends rather than
  // having been thrown away.
  ok('while a run is live, even the newest pin stays demoted — progress owns the row',
    (await page.locator('.pin-chip.is-demoted').count()) > 0 && (await vis('.pin-pct').count()) === 1);
  await vis('.pin-row .pin-x').first().click();
  await page.waitForTimeout(400);
  ok('closing the run promotes the displaced pin back into the row',
    (await vis('.pin-row').count()) === 1 && (await vis('.pin-pct').count()) === 0
    && (await vis('.pin-ledetext').count()) === 1);

  const collapsed = { tags: await box('.pin-tags'), card: await box('.chat-cmp-card') };
  ok('a pin the shelf had to clamp says so with the … chip',
    (await page.locator('.pin-clamp').count()) > 0);
  await vis('.pin-lede').first().click();
  await page.waitForTimeout(400);
  // M2b is UNCHANGED by the popover amendment: a long pin's detail still expands IN PLACE,
  // growing upward into empty transcript. Only the progress detail floats.
  ok('a long pin still opens the detail IN PLACE, not as a popover',
    (await vis('.pin-body').count()) === 1 && (await vis('.pin-pop').count()) === 0);
  const expanded = { tags: await box('.pin-tags'), card: await box('.chat-cmp-card') };
  ok('THE TAG LINE DID NOT MOVE between collapsed and expanded',
    near(collapsed.tags, expanded.tags, 'y'), JSON.stringify({ collapsed: collapsed.tags?.y, expanded: expanded.tags?.y }));
  ok('…nor did the composer', near(collapsed.card, expanded.card, 'y'),
    JSON.stringify({ collapsed: collapsed.card?.y, expanded: expanded.card?.y }));
  const cap = await page.evaluate(() => {
    const body = document.querySelector('.pin-body');
    const pane = document.querySelector('.chat-pane');
    if (!body || !pane) return null;
    return { body: body.getBoundingClientRect().height, pane: pane.getBoundingClientRect().height };
  });
  ok('the detail is capped near 40% of the pane and scrolls inside itself',
    !!cap && cap.body <= cap.pane * 0.4 + EPS, JSON.stringify(cap));

  // ── 6 — every tag is visible; the line wraps rather than folding ─────────────────
  // AMENDED by the owner after live testing: there is NO fold. A fact you have to press a
  // button to see is not a pinned fact, and the width measurement that decided when to fold
  // misfired at full width. These checks are the replacement AND the guard against its return.
  console.log('── tags: all visible, wrapped, nothing hidden');
  const cardBeforeTags = await box('.chat-cmp-card');
  await say('MANYTAGS please');
  const rendered = await page.locator('.pin-tags [data-pin-tag]').count();
  const shown = await vis('.pin-tags [data-pin-tag]').count();
  ok('every rendered tag is actually visible — none is hidden',
    rendered > 0 && rendered === shown, `rendered=${rendered} visible=${shown}`);
  ok('no fold affordance exists anywhere on the shelf',
    (await page.locator('.pin-chip.is-more').count()) === 0
    && (await page.locator('.pin-fold').count()) === 0
    && (await page.locator('.pin-chip.is-folded').count()) === 0);
  const lines = await page.locator('.pin-tags [data-pin-tag]').evaluateAll(
    (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size,
  );
  const tagsBox = await box('.pin-tags');
  ok('with many tags the area WRAPS to more than one line rather than hiding any',
    lines > 1, `distinct rows=${lines} of ${rendered} tags, tagArea=${JSON.stringify(tagsBox)}`);
  const cardAfterTags = await box('.chat-cmp-card');
  ok('…and the composer still sits where it did, even though the tag area grew',
    bottomHeld(cardBeforeTags, cardAfterTags),
    JSON.stringify({ before: bottomOf(cardBeforeTags), after: bottomOf(cardAfterTags) }));
  // The bound that makes the line above true on a short pane. It is not a fold: nothing is
  // display:none, there is no count chip — the area simply stops growing at its share of the
  // pane and scrolls, exactly as the opened detail does.
  const tagCap = await page.evaluate(() => {
    const el = document.querySelector('.pin-tags');
    const pane = document.querySelector('.chat-pane');
    if (!el || !pane) return null;
    return { h: el.getBoundingClientRect().height, pane: pane.getBoundingClientRect().height };
  });
  ok('the tag area never grows past its share of the pane',
    !!tagCap && tagCap.h <= tagCap.pane * 0.25 + EPS, JSON.stringify(tagCap));

  // ── 7 — dismissal, and persistence across a reload ───────────────────────────────
  console.log('── dismiss + reload');
  const tagsBefore = (await vis('.pin-tags').first().innerText()).replace(/\s+/g, ' ');
  const linkChip = page.locator('.pin-chip.is-link').first();
  // The BRANCH CHIP's own box, not the container's: dismissing a six-fact pin removes six
  // chips, so the wrapped area legitimately re-flows and shrinks. "No other pin was disturbed"
  // is a claim about the surviving chips, and this measures exactly that.
  const survivorsBefore = await page.locator('.pin-tags [data-pin-tag]').allInnerTexts();
  const beforeTagsBox = await box('.pin-tags');
  await linkChip.hover();
  await linkChip.locator('.pin-chip-x').click();
  await page.waitForTimeout(400);
  const tagsAfter = (await vis('.pin-tags').first().innerText()).replace(/\s+/g, ' ');
  // Dismissal is ENTRY-level: the `dev` pin carried six facts, so removing it removes all six.
  // That is why the × is labelled for the pin rather than the chip.
  ok('dismissing a pin removes it', !tagsAfter.includes('5173'), tagsAfter);
  ok('…and takes the rest of THAT pin with it, as its label promised',
    !tagsAfter.includes('node 22.3.0'), tagsAfter);
  // "Does not disturb, reorder or resurrect any other" is a claim about IDENTITY and ORDER,
  // not about pixels: a wrapped, bottom-anchored area necessarily re-flows when six chips
  // leave it, and the branch chip riding that re-flow is the wrap working, not a pin being
  // disturbed. What must hold is that every survivor is still there, still in the same order.
  const survivorsAfter = await page.locator('.pin-tags [data-pin-tag]').allInnerTexts();
  const expectedSurvivors = survivorsBefore.filter((t) => !/5173|node 22\.3\.0|db local|PR #218|api staging|cache warm/.test(t));
  ok('…and leaves every surviving tag present and in the same order',
    JSON.stringify(survivorsAfter) === JSON.stringify(expectedSurvivors),
    JSON.stringify({ expected: expectedSurvivors.slice(0, 6), got: survivorsAfter.slice(0, 6) }));
  ok('…and the tag area still ends where it did — the seam with the composer held',
    bottomHeld(beforeTagsBox, await box('.pin-tags')),
    JSON.stringify({ before: bottomOf(beforeTagsBox), after: bottomOf(await box('.pin-tags')) }));
  ok('…and does not resurrect anything else', tagsBefore !== tagsAfter);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const afterReload = await until(async () => (await page.locator('.pin-tags').count()) > 0, 20000)
    ? (await page.locator('.pin-tags').first().innerText()).replace(/\s+/g, ' ')
    : '(no shelf)';
  ok('pins survive a reload (persisted per conversation)',
    afterReload.includes('16 tasks deleted') || (await page.locator('.pin-ledetext').count()) > 0,
    afterReload);
  ok('…and a DISMISSED pin stays dismissed — the store was written, not just the view',
    !afterReload.includes('5173') && !afterReload.includes('node 22.3.0'), afterReload);

  const shot = process.env.VERIFY_SHOTS;
  if (shot) await page.locator('.pin-shelf').first().screenshot({ path: `${shot}/chat-shelf-${width}.png` }).catch(() => {});

  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  notes: [],
  check(scope, label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(`[${scope}] ${label}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
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
  for (const width of (process.env.VERIFY_WIDTHS || '1200,740').split(',').map(Number)) {
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runWidth(chromium, `http://127.0.0.1:${port}`, width, report);
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
