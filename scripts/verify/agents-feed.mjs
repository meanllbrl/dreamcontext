#!/usr/bin/env node
/**
 * Agents step 2 — runtime proof that a finished run becomes a message.
 *
 *   npm run build && npm run verify:agents-feed
 *
 * Every check below is driven against the REAL dashboard server, the REAL
 * `/api/automations/threads*` routes, the REAL runner (it actually spawns a
 * scripted stand-in for `claude` and writes its own thread entries), and the
 * REAL React surface in Chromium. Nothing is asserted by reading source: a
 * component that typechecks and a component that renders are two claims, and
 * this file exists for the second one.
 *
 * WHAT IT PROVES, one checkpoint per acceptance criterion:
 *   1. A scheduled run appears as ONE message: photo, name, time, status word,
 *      duration and cost.
 *   2. The body is what the agent POSTED — written by the run itself through
 *      `dreamcontext automations post`, with no ids, binding through the
 *      environment the runner set.
 *   3. A run that posted NOTHING falls back to its document's opening line and
 *      says so; a failed run reads `failed`.
 *   4. The published document is a file card, and clicking it OPENS the
 *      document.
 *   5. Filter chips carry live counts and actually filter; an empty filter
 *      answers the question it was asked.
 *   6. Unread: an accent bar, a New divider, a sidebar badge equal to the
 *      project-wide count — and the watermark advances only once a message has
 *      been on screen, clearing the badge.
 *   7. The thread panel opens, lists the run's entries in id order with the
 *      system rows as grey one-liners, and its composer is disabled with the
 *      step-4 note.
 *
 * WHAT IT DOES NOT TOUCH — your machine. Isolated fake HOME, a scratch
 * project, and a stand-in on PATH instead of `claude`: no model runs, no
 * tokens, no auth.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  chromeText, contrast, dashLines, dispatcherState, distIndex, fillContrast, lineTops, minGradientContrast, mockDispatcher,
  overlapArea, rect, resolveColor, scratchDir, setTheme, shotsDir,
} from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);

const SCRATCH = scratchDir('dc-ui-agents-feed');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const AUTOMATIONS_DIR = join(CONTEXT_ROOT, 'automations');
const SHOTS = shotsDir(REPO, 'agents-feed');

/** The sentence the posting agent puts in the channel. Asserted verbatim in
 *  the DOM, so a body that silently came from somewhere else cannot pass. */
const POSTED = 'WAU is down 4% week-over-week; the onboarding modal is the likely cause.';
/** The opening line of the SILENT agent's document — the fallback body. */
const RESULT_LINE = 'Two competitor changes this week, neither touches our positioning.';
/** The answer an AUDIT ask gets: markdown with bold and blank lines, long enough to fill the
 *  preview's three lines — the shape that printed raw asterisks and empty clamp slots (F1). */
const REPORT_POST = 'Signups fell **31%** this week, and the trial step is where the drop happens.\n\n'
  + 'The pricing change on Monday is the likely cause: trial starts fell the same day, while landing traffic held steady and paid conversion from trial barely moved at all.\n\n'
  + 'Reverting the pricing page for one week would confirm it without touching anything else in the funnel, and the full report has the cohort table.';

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8',
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`cli ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/**
 * The stand-in for `claude`. It branches on DREAMCONTEXT_AUTOMATION_SLUG — the
 * variable the runner now exports — which is itself the point: the posting
 * branch calls `dreamcontext automations post <slug> "<text>"` with NO run id
 * and NO --run, so if the env binding is broken the post has nothing to bind
 * to, the CLI refuses, and check 2 fails. That is the end-to-end proof the
 * unit tests cannot give.
 */
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const slug = process.env.DREAMCONTEXT_AUTOMATION_SLUG || '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

// THE ASK, read back out of the prompt this process was actually given. The
// composer's proof is end-to-end only if the agent can show the words reached
// it — so the stand-in fishes them out of its own argv and answers with them.
const prompt = (() => { const i = process.argv.indexOf('-p'); return i === -1 ? '' : (process.argv[i + 1] || ''); })();
const askMatch = prompt.match(/--- THE OWNER JUST ASKED YOU THIS, IN THE #agents CHANNEL ---\\n([\\s\\S]*?)\\n--- END OF WHAT THEY SAID ---/);
const ask = askMatch ? askMatch[1].trim() : '';

// THE AUDIT AGENTS (the second half of this script).
if (ask && slug === 'reporter') {
  spawnSync(process.execPath, [${JSON.stringify(DIST_INDEX)}, 'automations', 'post', slug, ${JSON.stringify(REPORT_POST)}], { encoding: 'utf-8' });
  out({ session_id: 'standin-reporter', is_error: false, result: 'Signups fell 31% this week.\\n\\n## Cohorts\\n\\n| Week | Trials |\\n|---|---|\\n| 38 | 3,326 |\\n| 39 | 2,295 |\\n',
    total_cost_usd: 0.05, num_turns: 2, duration_ms: 12000, permission_denials: [] });
  process.exit(0);
}
if (ask && slug === 'flaky') { process.stderr.write('the analytics API returned 500\\n'); process.exit(2); }
if (!ask && (slug === 'crawler' || slug === 'slowpoke')) {
  // Holds its run for a while, so something else can meet it in flight.
  const until = Date.now() + (slug === 'crawler' ? 15000 : 25000);
  while (Date.now() < until) { /* busy */ }
  out({ session_id: 'standin-' + slug, is_error: false, result: 'Crawl done.\\n', total_cost_usd: 0.01, num_turns: 1, duration_ms: 20000, permission_denials: [] });
  process.exit(0);
}
if (!ask && slug === 'asker') {
  const r = spawnSync(process.execPath, [${JSON.stringify(DIST_INDEX)}, 'automations', 'propose', slug, '--title', 'Ship the rollback?',
    '--body', 'Signups are down. Revert the pricing page or keep measuring?', '--choice', 'Revert it', '--choice', 'Keep measuring'], { encoding: 'utf-8' });
  if (r.status !== 0) process.stderr.write('PROPOSE FAILED: ' + (r.stderr || r.stdout) + '\\n');
  out({ session_id: 'standin-asker', is_error: false, result: 'Proposed.\\n', total_cost_usd: 0.02, num_turns: 1, duration_ms: 5000, permission_denials: [] });
  process.exit(0);
}

if (ask) {
  // An ASKED run always posts, whatever the agent is — the human is at the
  // keyboard waiting for an answer, which is exactly when zero posts is wrong.
  spawnSync(process.execPath, [${JSON.stringify(DIST_INDEX)}, 'automations', 'post', slug, 'You asked for: ' + ask], { encoding: 'utf-8' });
  out({ session_id: 'standin-ask-' + slug, is_error: false, result: 'Answered: ' + ask + '\\n\\n## Detail\\n\\nRows.\\n',
    total_cost_usd: 0.04, num_turns: 2, duration_ms: 9000, permission_denials: [] });
  process.exit(0);
}

// A RESUME, which is what an @mention to a SCHEDULED agent with a bound session now
// starts (see D8): the prompt is \`buildThreadMessagePreamble\`, not the run's ask block,
// so it carries a different marker and this branch has to read it. Answering with the
// words back is the same end-to-end proof the ask branch gives — it shows the human's
// sentence reached the RESUMED prompt rather than merely landing in the channel.
const replyMatch = prompt.match(/--- THE HUMAN'S MESSAGE \\(verbatim\\) ---\\n([\\s\\S]*?)\\n--- END MESSAGE ---/);
const replied = replyMatch ? replyMatch[1].trim() : '';
if (replied) {
  spawnSync(process.execPath, [${JSON.stringify(DIST_INDEX)}, 'automations', 'post', slug, 'You asked for: ' + replied], { encoding: 'utf-8' });
  out({ session_id: 'standin-reply-' + slug, is_error: false, result: 'Answered: ' + replied,
    total_cost_usd: 0.02, num_turns: 1, duration_ms: 4000, permission_denials: [] });
  process.exit(0);
}

if (slug === 'breaker') { process.stderr.write('the site returned 403\\n'); process.exit(2); }

if (slug === 'digest') {
  // No --run, no --slug beyond the positional: the environment is the binding.
  const r = spawnSync(process.execPath, [${JSON.stringify(DIST_INDEX)}, 'automations', 'post', slug, ${JSON.stringify(POSTED)},
    '--file', 'automations/output/digest/note.md'], { encoding: 'utf-8' });
  if (r.status !== 0) process.stderr.write('POST FAILED: ' + (r.stderr || r.stdout) + '\\n');
}

const result = slug === 'digest'
  ? 'WAU dropped four percent.\\n\\n## Detail\\n\\nRows.\\n'
  : ${JSON.stringify(RESULT_LINE)} + '\\n\\n## Detail\\n\\nRows.\\n';
out({ session_id: 'standin-' + slug, is_error: false, result,
  total_cost_usd: 0.31, num_turns: 4, duration_ms: 252000, permission_denials: [] });
`;

/** A 1x1 PNG, so at least one message wears a real PHOTO rather than initials
 *  — the avatar is half of "who said this" and initials would not prove the
 *  photo path reaches the feed. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  cli(['vaults', 'add', 'proj', PROJ]);

  // The transcripts the real CLI would leave behind for the sessions the stand-in reports.
  // "Open session" reopens a run as a chat tab only once `findTranscriptBySessionId` finds
  // `~/.claude/projects/<any dir>/<session id>.jsonl` (transcript-locate.ts), and a stand-in
  // writes none, so without these the opener can only ever say "no transcript on disk".
  const transcripts = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(transcripts, { recursive: true });
  for (const sid of ['standin-digest', 'standin-reply-digest', 'standin-ask-digest']) {
    const at = new Date().toISOString();
    writeFileSync(join(transcripts, `${sid}.jsonl`), [
      { type: 'user', sessionId: sid, uuid: `${sid}-u1`, timestamp: at, cwd: PROJ, message: { role: 'user', content: 'Run the daily insight digest.' } },
      { type: 'assistant', sessionId: sid, uuid: `${sid}-a1`, parentUuid: `${sid}-u1`, timestamp: at, cwd: PROJ,
        message: { role: 'assistant', content: [{ type: 'text', text: 'WAU dropped four percent.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  // A file for the posting agent to attach, and the photo it wears.
  mkdirSync(join(AUTOMATIONS_DIR, 'output', 'digest'), { recursive: true });
  writeFileSync(join(AUTOMATIONS_DIR, 'output', 'digest', 'note.md'), '# The note\n\nAttached by the run.\n');
  mkdirSync(join(AUTOMATIONS_DIR, 'photos'), { recursive: true });
  writeFileSync(join(AUTOMATIONS_DIR, 'photos', 'digest.png'), PNG_1PX);

  cli(['automations', 'create', 'digest', '--title', 'Daily insight digest', '--days', 'daily', '--at', '09:00']);
  cli(['automations', 'create', 'watcher', '--title', 'Competitor watch', '--days', 'daily', '--at', '10:00']);
  cli(['automations', 'create', 'breaker', '--title', 'Changelog scraper', '--days', 'daily', '--at', '11:00']);

  // `photo` is a hashed manifest field with no CLI flag of its own (it is set
  // from the dashboard), so the fixture writes it straight into the manifest —
  // BEFORE approval, or the run would block on an unapproved change.
  const digestPath = join(AUTOMATIONS_DIR, 'digest.md');
  writeFileSync(digestPath,
    readFileSync(digestPath, 'utf-8').replace(/^photo: null$/m, 'photo: automations/photos/digest.png'));
  for (const slug of ['digest', 'watcher', 'breaker']) cli(['automations', 'approve', slug, '--yes']);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

/** Run one automation FOR REAL through the runner, with the stand-in on PATH. */
function runAgent(slug) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  return spawnSync(process.execPath, [DIST_INDEX, 'automations', 'run', slug, '--force'], {
    cwd: PROJ, env: { ...process.env, HOME, PATH }, encoding: 'utf-8',
  });
}

function threadEntries(slug) {
  const dir = join(AUTOMATIONS_DIR, 'threads', slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const raw = readFileSync(join(dir, f), 'utf-8');
    return [...raw.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function main() {
  console.log('· fixture (isolated HOME, real manifests, real runner, stand-in claude)…');
  seed();

  // ── 0: the runner writes the channel ──────────────────────────────────
  console.log('\n═══ 0. Three real runs ═══');
  for (const slug of ['digest', 'watcher', 'breaker']) runAgent(slug);

  const digest = threadEntries('digest');
  check('the posting run wrote started → post → ok',
    digest.map((e) => e.event ?? e.kind).join(' ') === 'started agent ok',
    `got: ${digest.map((e) => e.event ?? e.kind).join(' ')}`);
  check('…and the post bound to its run through the ENVIRONMENT alone',
    digest.some((e) => e.kind === 'agent' && e.text === POSTED && e.runId === digest[0]?.runId),
    JSON.stringify(digest.find((e) => e.kind === 'agent') ?? null));
  const breaker = threadEntries('breaker');
  check('a failing run closes with system:failed',
    breaker.some((e) => e.event === 'failed'), breaker.map((e) => e.event).join(' '));
  const watcher = threadEntries('watcher');
  check('a SILENT run leaves only its two system rows',
    watcher.map((e) => e.event).join(' ') === 'started ok', watcher.map((e) => e.event).join(' '));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await page.waitForTimeout(150); }
    return false;
  };

  const dismissOverlays = async () => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      if (await page.locator('.announcements-modal-scrim').count() === 0) break;
    }
  };

  try {
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissOverlays();

    // ── 1: the sidebar badge, BEFORE the channel is opened ───────────────
    console.log('\n═══ 1. The sidebar badge ═══');
    const badge = page.locator('.sidebar-item', { hasText: 'Agentic Automations' }).locator('.sidebar-badge');
    const badged = await until(async () => (await badge.count()) > 0, 20000);
    check('the rail carries an unread badge before the page is ever opened', badged);
    const badgeText = badged ? await badge.innerText() : '';
    // 3 runs · (2 system + 1 post) + 2 + 2 = 7 entries, none of them the user's.
    check('…and it equals the project-wide unread count', badgeText.trim() === '7', `badge="${badgeText}"`);
    await page.screenshot({ path: join(SHOTS, '1-sidebar-badge.png') });

    // R2-1 (owner decision 1a), the hardest case: the hero row carries its unread badge AND its
    // Beta tag, which left the label about 75px of the 137 it needs ("Agentic A…").
    // `getClientRects` is not clipped by `overflow`, so a truncated label reports its hidden words.
    const heroGeo = await page.evaluate(() => {
      const item = document.querySelector('.sidebar-item[data-hero]');
      const label = item?.querySelector('.sidebar-label');
      if (!item || !label) return null;
      const box = label.getBoundingClientRect();
      const row = item.getBoundingClientRect();
      const tops = [];
      let spill = 0;
      const range = document.createRange();
      range.selectNodeContents(label);
      for (const q of range.getClientRects()) {
        if (q.width <= 0) continue;
        tops.push(Math.round(q.top));
        spill = Math.max(spill, q.right - box.right, q.bottom - box.bottom);
      }
      tops.sort((a, b) => a - b);
      const inside = (sel) => { const e = item.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.left >= row.left - 0.5 && r.right <= row.right + 0.5 && r.bottom <= row.bottom + 0.5; };
      return {
        lines: tops.filter((t, i) => i === 0 || t - tops[i - 1] > 2).length,
        spill: Math.round(spill * 10) / 10, labelW: Math.round(box.width), badgeIn: inside('.sidebar-badge'), tagIn: inside('.sidebar-maturity'),
      };
    });
    check('[R2-1] with its unread badge and Beta tag, "Agentic Automations" paints on 2 lines inside its box, badge and tag in the row (was 1 line in ~75px, spilling past it)',
      heroGeo?.lines === 2 && heroGeo.spill <= 0.5 && heroGeo.badgeIn === true && heroGeo.tagIn === true, JSON.stringify(heroGeo));
    // R2-5: the unread badge is a filled accent control carrying text (its count).
    const badgeInk = badged ? await fillContrast(badge.first()) : null;
    check('[R2-5] the unread badge count reads at >=4.5:1 on its fill in light (was 4.15)', (badgeInk ?? 0) >= 4.5, `contrast=${badgeInk}`);

    await page.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
    await page.waitForTimeout(1500);

    // ── 2: one message per run ───────────────────────────────────────────
    console.log('\n═══ 2. A run is a message ═══');
    const gotFeed = await until(async () => (await page.locator('.agent-msg').count()) >= 3, 20000);
    check('the channel opens on the feed with one message per run', gotFeed,
      `found ${await page.locator('.agent-msg').count()}`);
    await page.screenshot({ path: join(SHOTS, '2-feed.png'), fullPage: false });

    const digestMsg = page.locator('.agent-msg', { hasText: 'Daily insight digest' }).first();
    check('the message shows the agent\'s NAME', (await digestMsg.locator('.agent-msg-name').innerText()).trim() === 'Daily insight digest');
    check('…a photo, not initials', await digestMsg.locator('.agent-msg-av .agent-av img').count() === 1);
    check('…a time', /\d/.test(await digestMsg.locator('.agent-msg-time').innerText()));
    check('…the status WORD "done"', (await digestMsg.locator('.agent-msg-status').innerText()).trim() === 'done');
    const meta = await digestMsg.locator('.agent-msg-meta').innerText().catch(() => '');
    check('…duration and cost', /4m 12s/.test(meta) && /\$0\.31/.test(meta), `meta="${meta}"`);

    // ── 3: the body ──────────────────────────────────────────────────────
    console.log('\n═══ 3. The body is what the agent said ═══');
    check('the body is the agent\'s own post, verbatim',
      (await digestMsg.locator('.agent-msg-md').innerText()).trim() === POSTED);
    check('…and it is not labelled as coming from the document',
      await digestMsg.locator('.agent-msg-from').count() === 0);

    const watcherMsg = page.locator('.agent-msg', { hasText: 'Competitor watch' }).first();
    check('a SILENT run falls back to its document\'s opening line',
      (await watcherMsg.locator('.agent-msg-md').innerText()).trim() === RESULT_LINE);
    check('…and says so, rather than passing it off as a post',
      (await watcherMsg.locator('.agent-msg-from').innerText()).includes('it posted nothing'));

    const breakerMsg = page.locator('.agent-msg', { hasText: 'Changelog scraper' }).first();
    check('a failed run reads "failed"',
      (await breakerMsg.locator('.agent-msg-status').innerText()).trim() === 'failed');
    // The first pass of this screen said "Nothing to report." over a run that
    // had failed — not thin, WRONG, because there was plenty to report.
    const breakerText = await breakerMsg.locator('.agent-msg-text').innerText();
    check('…and its body is the REASON, not "nothing to report"',
      breakerText.trim().length > 0 && !/nothing to report/i.test(breakerText), `body="${breakerText}"`);
    // The caption keeps its meaning and loses its dash (F16); "own error" is what both say.
    check('…labelled as the run\'s own error',
      (await breakerMsg.locator('.agent-msg-from').innerText()).includes('own error'));
    check('…and it offers NO file card, having published nothing',
      await breakerMsg.locator('.agent-msg-file').count() === 0,
      `found ${await breakerMsg.locator('.agent-msg-file').count()} card(s)`);

    // ── 4: the file card opens the document ──────────────────────────────
    console.log('\n═══ 4. The file card ═══');
    const files = digestMsg.locator('.agent-msg-file');
    // A7: the run's own document is the thread's report and a Files-view row, not a dated
    // card riding on the message (and silently dropped by the four-file cap).
    check('[A7] the message carries the posted file only, not a dated document card (was 2 cards)', await files.count() === 1,
      `found ${await files.count()}: ${(await files.allInnerTexts()).join(' | ').replace(/\s+/g, ' ')}`);
    await files.first().click();
    const opened = await until(async () => (await page.locator('.chat-slideover-panel').count()) > 0, 10000);
    check('clicking one OPENS the document', opened);
    await page.screenshot({ path: join(SHOTS, '3-file-open.png') });
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.chat-slideover-panel').count()) === 0, 5000);

    // ── 5: the filter chips ──────────────────────────────────────────────
    console.log('\n═══ 5. Filter chips ═══');
    const chipCount = async (label) =>
      (await page.locator('.agents-chip', { hasText: label }).first().locator('.agents-chip-count').innerText()).trim();
    check('All counts every message', await chipCount('All') === '3');
    check('Failed counts the one that failed', await chipCount('Failed') === '1');
    check('there is a chip per agent', await page.locator('.agents-chip').count() === 4 + 3 - 3 + 3,
      `found ${await page.locator('.agents-chip').count()}`);
    await page.locator('.agents-chip', { hasText: 'Failed' }).first().click();
    await page.waitForTimeout(400);
    check('…and clicking Failed shows only that run', await page.locator('.agent-msg').count() === 1);
    await page.screenshot({ path: join(SHOTS, '4-filter-failed.png') });

    await page.locator('.agents-chip', { hasText: 'Needs you' }).first().click();
    await page.waitForTimeout(400);
    check('an EMPTY filter answers its own question',
      (await page.locator('.agents-feed-note').innerText()).includes('No agent is waiting on you'));
    await page.locator('.agents-chip', { hasText: 'All' }).first().click();
    await page.waitForTimeout(400);

    // ── 6: unread ────────────────────────────────────────────────────────
    console.log('\n═══ 6. Unread ═══');
    // The New divider is pinned from the first render, so it is asserted here
    // even though the watermark has by now begun advancing underneath it.
    check('a red New divider marks where the reader came in',
      await page.locator('.agents-feed-new').count() === 1);
    const cleared = await until(async () => (await badge.count()) === 0, 25000);
    check('the watermark advances once the messages have been on screen, clearing the badge', cleared,
      `badge still reads "${await badge.innerText().catch(() => '')}"`);
    await page.screenshot({ path: join(SHOTS, '5-read.png') });

    // ── 7: the thread panel ──────────────────────────────────────────────
    console.log('\n═══ 7. The thread panel ═══');
    // The Slack thread line — its own control, beside "Open session".
    await digestMsg.locator('.agent-thread-bar').click();
    const panel = page.locator('.agent-thread');
    check('it opens on the right', await until(async () => (await panel.count()) > 0, 10000));
    const sysRows = panel.locator('.agent-thread-sys');
    // The panel FETCHES its entries, so the assertion has to wait for the
    // fetch rather than race it — asserting on the first paint passed or
    // failed depending on machine speed, which is a failing test either way.
    await until(async () => (await panel.locator('.agent-thread-post, .agent-thread-sys').count()) >= 3, 10000);
    check('the run\'s system rows live HERE and nowhere else', await sysRows.count() === 2,
      `found ${await sysRows.count()}`);
    check('…and the feed never showed them', await page.locator('.agent-msg .agent-thread-sys').count() === 0);
    const sysText = await sysRows.first().innerText();
    check('the first is the run opening', sysText.includes('Run started'), sysText);
    // T1: a scheduled run's ROOT is its post, so the post must not come back as a reply under
    // itself. Counted as the posted sentence outside the answer card.
    const postTimes = await panel.evaluate((el, s) => [...el.querySelectorAll('.agent-msg-md, .agent-thread-post-text')]
      .filter((n) => !n.closest('.agent-thread-answer') && n.textContent.includes(s)).length, POSTED);
    check('[T1] the agent\'s post appears ONCE in its thread, as the root (was root + the same post as a reply)',
      postTimes === 1, `occurrences=${postTimes}`);
    // THE DETAIL: the run's whole document, drawn with the chat's own answer card —
    // the reason to open a thread at all.
    check('…followed by the run\'s WHOLE answer, in the chat\'s answer card',
      await until(async () => (await panel.locator('.agent-thread-answer .chat-msg-assistant-body .markdown-body').count()) === 1, 10000));
    // THE COMPOSER IS THE CHAT'S OWN, not a bespoke box — and these two
    // selectors are the proof BY CONSTRUCTION (pattern-component-reuse-over):
    // if the panel ever regresses to a hand-rolled textarea, the `.chat-cmp-*`
    // classes vanish and this fails, which is the only way that regression is
    // caught mechanically rather than by someone noticing.
    check('the thread mounts the chat\'s real Composer — the input',
      await until(async () => (await panel.locator('.chat-cmp-input').count()) > 0, 10000));
    check('…and its Send button', await panel.locator('.chat-cmp-send').count() > 0);
    check('the step-4 "read only" note is gone',
      !(await panel.locator('.agent-thread-note').count())
      || !(await panel.locator('.agent-thread-note').first().innerText()).includes('step 4'));
    await page.screenshot({ path: join(SHOTS, '6-thread-panel.png') });

    // ── 8: THE COMPOSER — calling an agent by typing at it ───────────────
    console.log('\n═══ 8. The composer ═══');
    // CLOSING THE PANEL IS AN ASSERTION, not a best-effort gesture. This line used to
    // swallow its own failure with `.catch(() => {})`, and that is exactly what hid a real
    // bug: the panel's composer was stretched over the whole panel, so the close button was
    // unclickable, the panel never closed, and the NEXT line spent 30s being intercepted by
    // it before the script died. A control that does not close is worse than none — so the
    // click is awaited on its own terms and the panel is then asserted GONE.
    await panel.locator('.agent-thread-close').click({ timeout: 5000 });
    check('the thread panel closes when you ask it to',
      await until(async () => (await page.locator('.agent-thread').count()) === 0, 5000));
    check('…and stops intercepting the channel behind it',
      await page.locator('.agents-chip').first().isEnabled());
    await page.locator('.agents-chip', { hasText: 'All' }).first().click();

    // THE CHANNEL MOUNTS THE CHAT'S OWN COMPOSER (`agentsChannelHost.ts`), so
    // every selector here is the chat's — `.chat-cmp-*`. That is the assertion,
    // not an implementation detail: the owner asked for our composer and its
    // style, and a hand-rolled `.agent-say-field` reappearing would fail here.
    const composer = page.locator('.agents-composer .chat-cmp');
    const field = composer.locator('.chat-cmp-input');
    const send = composer.locator('.chat-cmp-send[aria-label="Send"]');
    check('the channel has the CHAT composer, not one of its own',
      await composer.count() === 1 && await page.locator('.agent-say-field').count() === 0);
    check('…with the attach control the owner asked for',
      await composer.locator('.chat-cmp-iconbtn[aria-label="Attach"]').count() === 1);
    check('…and NO model/effort trigger, which would change nothing here',
      await composer.locator('.chat-cmp-modeltrigger').count() === 0);
    check('…and Send is off until something is typed', await send.isDisabled());

    // A sentence with NO mention must not be DELIVERED: there would be nobody
    // to answer it, and a message that lands and is never answered is worse
    // than one refused out loud. The chat's Send comes on for any text, so the
    // refusal happens at the host — which means the draft must come BACK.
    const NOBODY = 'somebody look at the paywall numbers';
    await field.fill(NOBODY);

    // …and it is refused with a REAL ATTACHMENT staged, which is the case that separates
    // "the composer put the draft back" from "the composer never took anything away". Pasted
    // rather than picked: the native picker is a desktop bridge call, but a pasted image goes
    // through `POST /api/agent/drop` — the real route, on this real server — and comes back
    // with a real path, so this is a genuinely sendable chip and not a stub.
    await field.evaluate((el) => {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const chip = composer.locator('.chat-cmp-attachment');
    check('a pasted image stages as an attachment chip', await until(async () => (await chip.count()) === 1, 8000));
    check('…and it really uploaded, so it is sendable rather than a stub',
      await until(async () => (await chip.locator('.chat-cmp-attachment-note').count()) === 0, 15000),
      await chip.innerText().catch(() => '(gone)'));

    await send.click();
    check('a message addressed to NOBODY is refused',
      (await page.locator('.agents-composer-note--error').innerText()).includes('Name an agent'));
    check('…and the sentence is put back, not eaten',
      await until(async () => (await field.inputValue()) === NOBODY, 3000), `field: "${await field.inputValue()}"`);
    // THE ONE A DRAFT-RESTORE WOULD HAVE MISSED. `commit` clears the chips one line after the
    // delivery returns, so a host that refuses and then restores the TEXT still loses the
    // file. The refusal has to stop the clear from running at all.
    check('…and so is the attachment, which a text-only restore would have dropped',
      await chip.count() === 1, `chips left: ${await chip.count()}`);
    // AND IT SURVIVES A VIEW SWITCH. The Messages/Agents toggle unmounts the feed — so does
    // clicking an agent's name in any message — and the chips are keyed by channel, not by
    // component, precisely so a glance at the roster does not throw away a file you just
    // attached. The bucket is dropped when the PAGE goes, not when the feed remounts.
    await page.locator('.agents-switch-opt', { hasText: 'Agents' }).first().click();
    await page.locator('.agents-switch-opt', { hasText: 'Messages' }).first().click();
    check('a staged attachment survives a trip to the roster and back',
      await until(async () => (await chip.count()) === 1, 5000), `chips: ${await chip.count()}`);

    // Cleared by hand so the rest of section 8 sends a plain-text ask, as it always has.
    await composer.locator('.chat-cmp-chip-x').first().click();
    check('…and the user can still take it off themselves', await until(async () => (await chip.count()) === 0, 3000));

    // Now address it, through the picker, the way a person would.
    await field.fill('');
    await field.type('@dig');
    const picker = page.locator('.chat-cmp-mention-row');
    check('typing @ offers the agents by name', await until(async () => (await picker.count()) > 0, 5000));
    check('…and filters to the one being typed', (await picker.first().innerText()).includes('Daily insight digest'),
      await picker.first().innerText());
    check('…wearing the agent\'s own photo, not the peer glyph',
      (await picker.first().locator('.chat-cmp-mention-face img').first().getAttribute('src', { timeout: 5000 }).catch(() => null) ?? '').includes('/automations/digest/photo'),
      await picker.first().locator('.chat-cmp-mention-face img').first().getAttribute('src', { timeout: 1000 }).catch(() => '(no face img)'));
    await picker.first().click();
    check('picking one addresses the field', (await field.inputValue()).startsWith('@digest '));

    // The note is DERIVED from the draft, never latched at send time. A red "name an agent"
    // still sitting under a sentence that now names one is the field arguing with what is on
    // screen — which is exactly what the first pass shipped.
    const note = page.locator('.agents-composer-note');
    check('addressing the field retires the refusal',
      await until(async () => (await page.locator('.agents-composer-note--error').count()) === 0, 3000),
      await note.innerText().catch(() => '(none)'));
    check('…and says who will run instead', (await note.innerText()).includes('Daily insight digest'),
      await note.innerText());
    check('…with only ONE sentence under the field (K5)', await note.count() === 1);

    const ASK = 'only the paywall numbers please';
    await field.type(ASK);
    check('Send comes on once there is something to send', await until(async () => !(await send.isDisabled()), 5000));
    await page.screenshot({ path: join(SHOTS, '7-composer.png') });

    await send.click();

    // The ask is written BEFORE the run starts, so it must be on screen
    // without waiting for the run — that is the whole reason the route writes
    // it synchronously.
    const you = page.locator('.agent-msg--you');
    check('your message appears in the channel as your own row',
      await until(async () => (await you.count()) > 0, 8000));
    const yourText = await you.last().locator('.agent-msg-md').first().innerText();
    check('…carrying what you typed, without the @address', yourText.trim() === ASK, `got: "${yourText}"`);
    check('…and saying who it went to', (await you.last().locator('.agent-msg-meta').innerText()).includes('Daily insight digest'));
    check('the field clears on send', (await field.inputValue()) === '');

    // AND THE MENTION OPENS ITS THREAD — the step-4 criterion. The panel needs a real
    // feed message, which does not exist when the 200 lands, so the channel parks the
    // pair and opens the panel the instant the feed carries it.
    check('the mention opens that agent\'s thread',
      await until(async () => (await page.locator('.agent-thread').count()) === 1, 10000));
    check('…on the agent that was addressed',
      (await page.locator('.agent-thread-sub').innerText()).includes('Daily insight digest'));

    // THE RUN SLOT IS NOT TAKEN, and that is correct rather than a regression.
    // `digest` is a SCHEDULED agent with a session bound on this machine, so an @mention
    // RESUMES it (see the `sched` branch of `handleAutomationsSay`) instead of starting a
    // fresh run. A resume is a reply JOB — its own id-keyed registry — while this field's
    // `unavailable` prop reads `currentAutomationJob`, the run-now slot. So the channel
    // stays writable during a reply turn, which is what you want: the slot genuinely is
    // free, and a second mention to a DIFFERENT agent should go straight through.
    //
    // This section asserted the opposite until step 4 landed, because back then every
    // mention started a run. The product moved; this is the script catching up.
    check('the channel stays writable during a reply turn — no run slot is held',
      !(await field.isDisabled()));
    await page.screenshot({ path: join(SHOTS, '8-asked.png') });

    // THE PROOF: the stand-in only answers this way when the ask reached its
    // own `-p` prompt. A broken plumb gives the scheduled body instead.
    const answered = await until(async () => {
      // The answer's opening is previewed INSIDE your message (Slack's shape).
      const rows = page.locator('.agent-msg--you .agent-reply-preview-text');
      const n = await rows.count();
      for (let i = 0; i < n; i++) if ((await rows.nth(i).innerText()).includes('You asked for: ' + ASK)) return true;
      return false;
    }, 60000);
    check('the agent ANSWERS with the words you typed', answered);
    check('…so the message reached its resumed prompt, not just the channel', answered);
    // The reply turn closes the exchange in the thread with its own terminal entry —
    // `replied` on success, which `feed.ts` maps to the `done` status word. Without that
    // mapping a mention's message would read "running" for ever, since a resume writes no
    // run-cache row for the fresh id to fall back on.
    check('…and the thread records the turn as replied',
      await until(async () => threadEntries('digest').some((e) => e.event === 'replied'), 15000));
    await page.screenshot({ path: join(SHOTS, '9-answered.png') });

    // The exchange is ONE message, and it is YOURS: the thread hangs off your
    // ask, the agent's answer is its first reply, and the ask itself is never
    // counted as one.
    const askedMsg = page.locator('.agent-msg--you').filter({ hasText: 'You asked for: ' + ASK }).first();
    const replies = await askedMsg.locator('.agent-thread-bar-count').innerText();
    check('the answer is the thread\'s one reply, and the ask is not counted', replies.trim() === '1 reply', `got: "${replies}"`);
    // A RESUMED turn (an @mention of a scheduled agent with a session) has a fresh run id the
    // run cache never recorded, so the button used to be drawn and then toast "Couldn't open
    // the session" on every click: presence proved nothing. The open is keyed on the run the
    // turn resumed (`sessionRunId`), so the check clicks it and asks for the ACK: the bridge
    // opens the chat surface (`.agent-surface.expanded`) and nothing is toasted. Running and
    // skipped rows show no button at all: that is F9, below, and agrees with this.
    const openSess = askedMsg.getByText('Open session').first();
    const offered = (await openSess.count()) > 0;
    if (offered) await openSess.click();
    const acked = offered && await until(async () => (await page.locator('.agent-surface.expanded').count()) > 0, 12000);
    const toastText = await page.locator('.agents-toast').innerText({ timeout: 500 }).catch(() => '');
    check('[F9] a resumed turn\'s "Open session" OPENS its session, no failure toast (was offered, then toasted "Couldn\'t open the session")',
      acked && !toastText, `offered=${offered} expanded=${acked} toast="${toastText}"`);
    if (toastText) await page.locator('.agents-toast').click().catch(() => {});
    if (acked) {
      await page.locator('.agent-overlay-collapse').click().catch(() => {});
      await until(async () => (await page.locator('.agent-surface.expanded').count()) === 0, 5000);
    }

    // ── 9: an ask nothing can answer is REFUSED, not swallowed ───────────
    console.log('\n═══ 9. An agent that cannot run ═══');
    const before = threadEntries('watcher').length;
    // Edited since it was approved — the hash no longer matches, which is the
    // real shape of "not approved on this machine" and needs no CLI verb.
    // A HASHED field specifically: an approval covers `timeout_minutes` among
    // others, and a first attempt that appended prose to the end of the file
    // changed nothing the payload reads, so the manifest stayed approved and
    // this check passed for the wrong reason.
    const watcherPath = join(AUTOMATIONS_DIR, 'watcher.md');
    const edited = readFileSync(watcherPath, 'utf-8').replace(/^timeout_minutes: \d+$/m, 'timeout_minutes: 23');
    if (!/timeout_minutes: 23/.test(edited)) throw new Error('fixture: timeout_minutes not found in watcher.md');
    writeFileSync(watcherPath, edited);
    const refused = await page.evaluate(async () => {
      const r = await fetch('/api/automations/threads/say', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'watcher', text: 'check the competitors' }),
      });
      return { status: r.status, body: await r.text() };
    });
    check('an unapproved agent refuses the message outright', refused.status === 409, JSON.stringify(refused));
    check('…naming the fix', /approve/i.test(refused.body), refused.body);
    check('…and NOTHING is written to its channel', threadEntries('watcher').length === before,
      `${before} → ${threadEntries('watcher').length}`);

    // ── 10: the channel uses the width, and Send is reachable ────────────
    console.log('\n═══ 10. Layout ═══');
    // MEASURED UNSPLIT, because that is what these three claims are about: the channel
    // filling the page, the composer lining up with the notice above it, and Send sitting
    // where the floating Agent button would otherwise bury it. Section 8's @mention leaves
    // the thread panel open (it now opens on the agent you addressed), and a 380px panel
    // makes all three false for a reason that has nothing to do with the property under
    // test — the composer simply is not full width any more, so Send is not under the
    // floater and the lift looks unnecessary. Close it first, and ASSERT the close rather
    // than swallowing it: a panel that will not shut is the bug this section would
    // otherwise hide a second time.
    if (await page.locator('.agent-thread').count() > 0) {
      await page.locator('.agent-thread-close').click({ timeout: 5000 });
      check('the thread panel closes before the width is measured',
        await until(async () => (await page.locator('.agent-thread').count()) === 0, 5000));
    }
    const geo = await page.evaluate(() => {
      const w = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect() : null; };
      const bar = w('.agents-head-row');    // the header row's content box
      const chips = w('.agents-chips');
      const say = w('.agents-composer .chat-cmp');
      const page_ = w('.agents-page');
      return {
        pageW: Math.round(page_?.width ?? 0),
        chipsW: Math.round(chips?.width ?? 0),
        barL: Math.round(bar?.left ?? 0), barR: Math.round(bar?.right ?? 0),
        sayL: Math.round(say?.left ?? 0), sayR: Math.round(say?.right ?? 0),
      };
    });
    // The channel used to sit centred at its content width inside the page,
    // leaving ~157px dead on each side while the bar above ran edge to edge.
    check('the channel spans the page rather than sitting centred in it',
      geo.chipsW >= geo.pageW - 4, `chips ${geo.chipsW} of page ${geo.pageW}`);
    check('…and the composer lines up with the header above it',
      Math.abs(geo.sayL - geo.barL) <= 1 && Math.abs(geo.sayR - geo.barR) <= 1,
      `bar [${geo.barL},${geo.barR}] vs field [${geo.sayL},${geo.sayR}]`);

    // The floating Agent button owns the bottom-right corner on every page, and
    // a full-width composer puts Send underneath it. A HIT TEST, not a rect
    // comparison: what matters is whether a click reaches the button.
    const reach = await page.evaluate(() => {
      const s = document.querySelector('.agents-composer .chat-cmp-send[aria-label="Send"]')?.getBoundingClientRect();
      if (!s) return { on: 'missing', off: 'missing' };
      const at = () => {
        const el = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
        // Up to the CONTROL, not the glyph: the chat's Send wraps its arrow in a bare
        // `<span aria-hidden>`, so the topmost element at that point has no class of its own
        // and reporting it would say "SPAN" for a button that is perfectly clickable.
        return el?.closest('button')?.className || el?.className || el?.tagName || '?';
      };
      const on = at();
      // Same point with the lift removed — if this does NOT come back covered,
      // the check above is passing for some reason other than the lift.
      const prev = document.documentElement.style.getPropertyValue('--dc-bottom-strip');
      document.documentElement.style.removeProperty('--dc-bottom-strip');
      const off = at();
      if (prev) document.documentElement.style.setProperty('--dc-bottom-strip', prev);
      return { on, off };
    });
    check('Send is clickable, not buried under the floating Agent button',
      String(reach.on).includes('chat-cmp-send'), `hit test returned "${reach.on}"`);
    check('…and that is the strip lift doing it, not luck',
      reach.off === 'missing' || String(reach.off).includes('agent-fab') || String(reach.off).includes('agent-dock'),
      `without the lift the hit test returned "${reach.off}" — expected the floater`);
    await page.screenshot({ path: join(SHOTS, '10-layout.png') });

    // ══ THE AUDIT PASS (goal-skill v2) ══════════════════════════════════════════════
    // A second, richer channel on the same server: an ask whose answer is markdown, a failed
    // ask, an ask that never ran, a run that asked a question, a long Turkish agent name. Seeded
    // HERE, after every count above has been asserted, so those counts keep meaning what they
    // said. Every check MEASURES what painted; labels name the finding and the pre-fix value.
    console.log('\n═══ 11. The audit channel ═══');
    const EXCLUDE = ['.agent-msg-md', '.agent-reply-preview-text', '.chat-msg-assistant-body', '.agent-thread-post-text',
      '.agent-msg-question-text', '.agent-msg-kv'];
    const say = (slug, text) => page.evaluate(async ([s, x]) => {
      const r = await fetch('/api/automations/threads/say', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: s, text: x }),
      });
      return { status: r.status, body: await r.text() };
    }, [slug, text]);
    const slotFree = () => until(async () => {
      const j = await page.evaluate(async () => (await fetch('/api/automations/runs')).json().catch(() => null));
      return !j?.job || j.job.status !== 'running';
    }, 60000);
    const openChannel = async () => {
      await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await dismissOverlays();
      await page.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
      await until(async () => (await page.locator('.agent-msg').count()) >= 3, 20000);
    };
    const askRow = (text) => page.locator('.agent-msg--you').filter({ hasText: text }).first();
    const namedRow = (title) => page.locator('article.agent-msg', { has: page.locator('.agent-msg-name', { hasText: title }) }).first();
    const feedCount = async (row) => {
      const c = row.locator('.agent-thread-bar-count');
      return (await c.count()) ? parseInt(await c.innerText(), 10) : 0;
    };
    const panelCount = async (row) => {
      await row.locator('.agent-thread-bar').click();
      const div = page.locator('.agent-thread-divider span');
      await until(async () => (await div.count()) > 0, 8000);
      await page.waitForTimeout(1500); // the thread's own fetch settles the answer card
      const n = parseInt(await div.innerText(), 10);
      return Number.isNaN(n) ? 0 : n;
    };
    const closeThread = async () => {
      if (await page.locator('.agent-thread').count()) {
        await page.locator('.agent-thread-close').click({ timeout: 5000 });
        await until(async () => (await page.locator('.agent-thread').count()) === 0, 5000);
      }
    };

    for (const [slug, title, extra] of [
      ['reporter', 'Report writer', ['--mode', 'call']],
      ['flaky', 'Analytics checker', ['--mode', 'call']],
      ['crawler', 'Site crawler', ['--mode', 'call']],
      ['slowpoke', 'Slow crawler', ['--days', 'daily', '--at', '06:00']],
      ['asker', 'Pricing watch', ['--days', 'daily', '--at', '06:30', '--review', 'agent']],
      ['haftalik', 'Haftalık Gözlem Raporu Hazırlayıcısı', ['--days', 'daily', '--at', '07:00']],
    ]) {
      cli(['automations', 'create', slug, '--title', title, ...extra]);
      cli(['automations', 'approve', slug, '--yes']);
    }
    runAgent('asker');
    await slotFree();
    const s1 = await say('reporter', 'summarise the signup drop');
    check('[guard] the audit ask is accepted', s1.status === 200, JSON.stringify(s1));
    await until(async () => threadEntries('reporter').some((e) => e.event === 'ok'), 60000);
    await slotFree();
    await say('flaky', 'check the analytics API');
    await until(async () => threadEntries('flaky').some((e) => e.event === 'failed'), 60000);
    await slotFree();
    // R2-2: a REAL skipped row, through the server path. A CLI run of the same agent holds its
    // run lock, so an @mention that lands meanwhile never becomes a run, and the job writes
    // its own "did not run" row under the ask.
    const PATHV = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
    const holder = spawn(process.execPath, [DIST_INDEX, 'automations', 'run', 'crawler', '--force'], {
      cwd: PROJ, env: { ...process.env, HOME, PATH: PATHV }, stdio: 'ignore',
    });
    await page.waitForTimeout(2500);
    const s3 = await say('crawler', 'how far did the crawl get?');
    const skippedRow = await until(async () => threadEntries('crawler').some((e) => e.event === 'skipped'), 30000);
    check('[guard] a second ask while the agent\'s run holds its lock leaves a real "did not run" row', skippedRow,
      `${JSON.stringify(s3)} :: ${threadEntries('crawler').map((e) => e.event ?? e.kind).join(' ')}`);
    await new Promise((r) => holder.on('exit', r));
    await slotFree();

    await openChannel();
    await page.screenshot({ path: join(SHOTS, '11-audit-feed.png') });

    // F20 first: a row is unread only until it has been on screen and the next poll lands.
    const unread = page.locator('article.agent-msg.agent-msg--unread').first();
    const bar = (await unread.count()) ? await unread.evaluate((el) => {
      const b = getComputedStyle(el, '::before');
      return { content: b.content, top: parseFloat(b.top), bottom: parseFloat(b.bottom), edge: getComputedStyle(el).borderLeftColor };
    }) : null;
    check('[F20] an unread row\'s bar is an inset pseudo-element, not a full-height border that merges with the next (was border, no ::before)',
      !!bar && bar.content !== 'none' && bar.top >= 2 && bar.bottom >= 2 && bar.edge === 'rgba(0, 0, 0, 0)', JSON.stringify(bar));

    const reporterAsk = askRow('summarise the signup drop');
    const preview = reporterAsk.locator('.agent-reply-preview-text');
    await until(async () => (await preview.innerText()).length > 40, 15000);
    const pText = await preview.innerText();
    const tops = await lineTops(preview);
    const gaps = tops.slice(1).map((v, i) => v - tops[i]);
    check('[F1] the answer preview is prose: no raw ** and three evenly spaced lines (was "**31%**", gaps 22/45)',
      !pText.includes('*') && tops.length === 3 && Math.max(...gaps) - Math.min(...gaps) <= 2,
      `text="${pText.slice(0, 80)}" tops=${JSON.stringify(tops)}`);
    const label = await reporterAsk.locator('.agent-reply-preview').getAttribute('aria-label');
    check('[F19] the preview is named "Open Report writer\'s answer", not the whole card (was the card\'s text)',
      label === 'Open Report writer\'s answer', `aria-label=${label}`);
    const snap = await reporterAsk.locator('.agent-thread-bar').ariaSnapshot().catch(() => '');
    check('[F19] the thread line does not read both halves of its hover swap (was "… Last reply … View thread")',
      !snap.includes('View thread'), snap.replace(/\s+/g, ' '));
    check('[F5] the thread-line count reads at >=4.5:1 on paper (was 4.15)',
      await contrast(reporterAsk.locator('.agent-thread-bar-count')) >= 4.5,
      `contrast=${await contrast(reporterAsk.locator('.agent-thread-bar-count')).catch(() => '?')}`);
    const toR = await rect(reporterAsk.locator('.agent-msg-to'));
    const nameR = await rect(namedRow('Daily insight digest').locator('.agent-msg-name'));
    check('[F18] the agent name and the "to <agent>" link are 24px targets (was 21 / 18)', nameR.height >= 24 && toR.height >= 24,
      `name=${nameR.height} to=${toR.height}`);

    const flakyAsk = askRow('check the analytics API');
    const secondary = await resolveColor(page, 'var(--color-text-secondary)', '.agents-page');
    const flakyInk = await flakyAsk.locator('.agent-reply-preview-text').evaluate((el) => getComputedStyle(el).color);
    check('[F10] a failed ask\'s preview is set in secondary ink, not as an answer (was --color-text)', flakyInk === secondary,
      `ink=${flakyInk} secondary=${secondary}`);

    const crawlerAsk = askRow('how far did the crawl get?');
    const skipPreview = await crawlerAsk.locator('.agent-reply-preview-text').innerText().catch(() => '');
    check('[F16/R2-2] the "did not run" preview carries no em dash (was "It did not run — …")',
      skipPreview.length > 0 && !skipPreview.includes('—'), `preview="${skipPreview}"`);
    check('[F9] a run that never ran offers no "Open session" (was offered, then toasted a failure)',
      await crawlerAsk.getByText('Open session').count() === 0);
    check('[guard] a finished run still offers its session', await namedRow('Daily insight digest').getByText('Open session').count() === 1);

    // F2 — the feed row and its open thread print ONE number.
    for (const [row, want, what] of [
      [reporterAsk, 2, 'an ask with a post and a report'],
      [namedRow('Daily insight digest'), 1, 'a scheduled post with its report'],
      [flakyAsk, 0, 'a failed ask'],
    ]) {
      const f = await feedCount(row);
      const pc = await panelCount(row);
      check(`[F2] ${what}: the feed and the thread agree on ${want} (was feed/thread disagreeing)`, f === want && pc === want,
        `feed=${f} thread=${pc}`);
      await closeThread();
    }

    // F3 — status ink on paper, light theme.
    const inks = {
      failed: await contrast(namedRow('Changelog scraper').locator('.agent-msg-status--failed')),
      skipped: await contrast(crawlerAsk.locator('.agent-msg-status--skipped')),
      needs: await contrast(namedRow('Pricing watch').locator('.agent-msg-needs')),
      newDivider: (await page.locator('.agents-feed-new span').count()) ? await contrast(page.locator('.agents-feed-new span')) : null,
    };
    check('[F3] failed, skipped, needs-you and the New divider all read at >=4.5:1 in light (was 3.91 / 2.61)',
      Object.values(inks).every((v) => v !== null && v >= 4.5), JSON.stringify(inks));
    const chipCountEl = page.locator('.agents-chip:not(.agents-chip--on) .agents-chip-count').first();
    const chipOpacity = await chipCountEl.evaluate((el) => getComputedStyle(el).opacity);
    const chipInk = await contrast(chipCountEl);
    check('[F7] a chip\'s count is full ink, >=4.5:1 (was opacity 0.7, ~3.1)', chipOpacity === '1' && chipInk >= 4.5,
      `opacity=${chipOpacity} contrast=${chipInk}`);
    const notice = await page.locator('.agents-needyou').innerText().catch(() => '');
    check('[F21] one waiting agent is spoken to in the singular (was "Open them to read what they are asking.")',
      notice.length > 0 && !notice.includes('Open them'), `notice="${notice.replace(/\s+/g, ' ')}"`);

    // F16 — the app's own words carry no em dash: the feed, then each kind of thread.
    const sweep = async (where) => {
      const text = await chromeText(page, '.agents-page', EXCLUDE);
      return dashLines(text).map((l) => `${where}: ${l}`);
    };
    const dashes = [...await sweep('feed')];
    for (const [row, where] of [[reporterAsk, 'ask thread'], [namedRow('Changelog scraper'), 'failed thread'], [crawlerAsk, 'did-not-run thread']]) {
      await row.locator('.agent-thread-bar').click();
      await until(async () => (await page.locator('.agent-thread-sys, .agent-thread-post').count()) > 0, 8000);
      await page.waitForTimeout(1200);
      dashes.push(...await sweep(where));
      await closeThread();
    }
    const fabLabel = await page.locator('.agent-fab').first().getAttribute('aria-label').catch(() => null);
    if (fabLabel?.includes('—')) dashes.push(`fab: ${fabLabel}`);
    check('[F16] no em dash in the app\'s own text, titles, labels or placeholders (was "the run\'s own error — it never published", "Agent — Agent")',
      dashes.length === 0, dashes.slice(0, 6).join(' | '));
    await crawlerAsk.locator('.agent-thread-bar').click();
    await until(async () => (await page.locator('.agent-thread-sys').count()) > 0, 8000);
    const skipSys = (await page.locator('.agent-thread-sys').allInnerTexts()).join(' | ');
    check('[F16/R2-2] the thread\'s "did not run" system row carries no em dash (was "It did not run — …")',
      /did not run/i.test(skipSys) && !skipSys.includes('—'), skipSys);
    await closeThread();

    // T8 + F9 + R2-4 — a run started through the SERVER, not by this page. Round 2 (owner
    // decision 4): the run slot is PER AGENT. The channel field used to go read-only for the
    // whole project while any agent ran; now only a draft that names the RUNNING agent is
    // refused, and a different agent can be called and finish in parallel.
    console.log('\n═══ 12. A run the page did not start ═══');
    const started = await fetch(`${base}/api/automations/slowpoke/run`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'proj' }, body: '{}',
    });
    check('[guard] the slow run is started from outside the page', started.ok, `status=${started.status}`);
    const runningRow = namedRow('Slow crawler');
    // Wait until the FEED knows the run (its row reads "running"), then one more fast poll, so
    // the field's state is read after the page has had every chance to react to the slot.
    await until(async () => (await runningRow.locator('.agent-msg-status--running').count()) > 0, 20000);
    await page.waitForTimeout(2500);
    check('[F9] a run still in flight offers no "Open session" (was offered)', (await runningRow.count()) > 0
      && await runningRow.getByText('Open session').count() === 0, `rows=${await runningRow.count()}`);
    // With the vault header, as the app sends it: the run was registered under the VAULT's
    // path, and a header-less read resolves the server's cwd (the same folder, spelled through
    // /private), which is a different key.
    const slots = await page.evaluate(async () => (await (await fetch('/api/automations/threads', { headers: { 'x-dreamcontext-vault': 'proj' } })).json()).runSlots ?? null);
    check('[R2-4] the feed carries a per-agent slot map naming the running agent (was a single runSlot)',
      !!slots && typeof slots === 'object' && 'slowpoke' in slots, JSON.stringify(slots));
    const fieldDown = await field.isDisabled();
    check('[R2-4] while one agent runs the channel field stays open (was read-only for the whole channel)',
      !fieldDown, `disabled=${fieldDown} placeholder="${await field.getAttribute('placeholder')}"`);
    // A draft that names the running agent is refused HERE, with its words and chips kept.
    const sayCalls = [];
    const onReq = (r) => { if (r.url().includes('/api/automations/threads/say')) sayCalls.push(r.method()); };
    page.on('request', onReq);
    let busyNote = '';
    let kept = '';
    if (!fieldDown) {
      await field.click();
      await field.fill('@slowpoke how far along are you');
      await page.waitForTimeout(400);
      busyNote = (await page.locator('.agents-composer .agents-composer-note--error').innerText().catch(() => '')).trim();
      await field.press('Enter');
      await page.waitForTimeout(800);
      kept = await field.inputValue();
    }
    page.off('request', onReq);
    check('[R2-4] a draft naming the running agent says so and is not sent, its words kept (was: the field was disabled)',
      /Slow crawler is still running/.test(busyNote) && sayCalls.length === 0 && kept.includes('how far along'),
      `note="${busyNote}" say=${sayCalls.length} kept="${kept}"`);
    if (!fieldDown) await field.fill('');
    // A DIFFERENT agent is called while the first still runs, and finishes first.
    const parallelAt = Date.now();
    const s4 = await page.evaluate(async () => {
      const r = await fetch('/api/automations/threads/say', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'proj' },
        body: JSON.stringify({ slug: 'reporter', text: 'summarise the week in one line' }),
      });
      return { status: r.status, body: await r.text() };
    });
    const reporterDone = await until(async () => {
      const e = threadEntries('reporter');
      return e.some((x) => x.event === 'ok' && Date.parse(x.at) >= parallelAt - 1000);
    }, 20000);
    const slowStillRunning = !threadEntries('slowpoke').some((e) => ['ok', 'failed', 'timeout'].includes(e.event ?? ''));
    check('[R2-4] a different agent is called and finishes while the first still runs (was 409 say_busy)',
      s4.status === 200 && reporterDone && slowStillRunning,
      `say=${s4.status} ${s4.body.slice(0, 120)} reporterDone=${reporterDone} slowStillRunning=${slowStillRunning}`);
    await slotFree();

    // R2-5 (owner decision 5a) — every filled accent control that carries text reads at >=4.5:1.
    // White on --color-accent was 4.15:1 in light (#7b68ee) and 2.75:1 in dark (#9d8cff); the
    // strong token (#6647f0) reads 5.64 in both. Measured as the control paints: fill and text
    // together, opacity and brightness filters included, so a hover state is its own number.
    console.log('\n═══ 12b. Text on an accent fill ═══');
    // A control this channel only draws in some states is measured on a PROBE carrying the
    // real class, in the real place, so the stylesheet's own rule is what paints it.
    const probe = (hostSel, tag, cls, text) => page.evaluate(([h, t, c, x]) => {
      const host = document.querySelector(h);
      if (!host) return false;
      document.querySelectorAll('[data-verify-probe]').forEach((e) => e.remove());
      const el = document.createElement(t);
      el.className = c;
      el.textContent = x;
      el.setAttribute('data-verify-probe', '1');
      host.appendChild(el);
      return true;
    }, [hostSel, tag, cls, text]);
    for (const theme of ['light', 'dark']) {
      await setTheme(page.context(), theme);
      await openChannel();
      const was = theme === 'light' ? '4.15' : '2.75';
      const inks = {};
      inks.chipOn = await fillContrast(page.locator('.agents-chip--on').first());
      const choice = page.locator('.agent-msg-question-choice').first();
      if (await choice.count()) {
        await choice.scrollIntoViewIfNeeded();
        inks.choice = await fillContrast(choice);
        await choice.hover();
        await page.waitForTimeout(350);
        inks.choiceHover = await fillContrast(choice);
        await page.mouse.move(1, 1);
      } else {
        inks.choice = inks.choiceHover = null;
      }
      await probe('.agents-feed-scroll', 'button', 'agent-msg-question-send', 'Send');
      inks.send = await fillContrast(page.locator('[data-verify-probe]'));
      await page.evaluate(() => document.querySelectorAll('[data-verify-probe]').forEach((e) => e.remove()));
      inks.newAgent = await minGradientContrast(page.locator('.agents-new-btn').first());
      check(`[R2-5] ${theme}: the selected chip, a question's choices (at rest and hovered), its Send and "New agent" all read at >=4.5:1 (was ${was})`,
        Object.values(inks).every((v) => v !== null && v >= 4.5), JSON.stringify(inks));
      if (theme === 'dark') {
        // The unread badge was dark ink on the light violet in dark (6.51) — already fine, so
        // this is the guard that the strong fill did not break it.
        const real = page.locator('.sidebar-item[data-hero] .sidebar-badge');
        if (!(await real.count())) await probe('.sidebar-item[data-hero]', 'span', 'sidebar-badge', '3');
        const b = (await real.count()) ? real.first() : page.locator('[data-verify-probe]');
        const badgeDark = await fillContrast(b);
        await page.evaluate(() => document.querySelectorAll('[data-verify-probe]').forEach((e) => e.remove()));
        check('[guard] dark: the unread badge count reads at >=4.5:1 on its fill', badgeDark >= 4.5, `contrast=${badgeDark}`);
      }
      await page.screenshot({ path: join(SHOTS, `12b-accent-${theme}.png`) });
    }
    await setTheme(page.context(), 'light');

    // F11 + F14 — narrow, with the thread open.
    console.log('\n═══ 13. 1100 wide ═══');
    await page.setViewportSize({ width: 1100, height: 950 });
    await openChannel();
    await namedRow('Daily insight digest').locator('.agent-thread-bar').click();
    await until(async () => (await page.locator('.agent-thread').count()) === 1, 8000);
    await page.waitForTimeout(600);
    const chips = page.locator('.agents-chips');
    const mask = await chips.evaluate((el) => ({
      mask: getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage,
      more: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    }));
    check('[F11] an overflowing chip row fades at its edge (was a hard cut, no cue)', mask.more && mask.mask !== 'none', JSON.stringify(mask));
    const untitled = await chips.evaluate((el) => [...el.querySelectorAll('.agents-chip-label')]
      .filter((l) => l.scrollWidth > l.clientWidth + 1)
      .filter((l) => l.closest('.agents-chip')?.getAttribute('title') !== l.textContent)
      .map((l) => l.textContent));
    const clipped = await chips.evaluate((el) => [...el.querySelectorAll('.agents-chip-label')].filter((l) => l.scrollWidth > l.clientWidth + 1).length);
    check('[F11] every cut-off chip label carries its full name as a tooltip (was none)', clipped > 0 && untitled.length === 0,
      `clipped=${clipped} untitled=${JSON.stringify(untitled)}`);
    await chips.evaluate((el) => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(400);
    const maskEnd = await chips.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
    check('[guard] scrolled to its end, the chip row does not fade', maskEnd === 'none', `mask=${maskEnd}`);
    await closeThread();
    const scroller = page.locator('.agents-feed-scroll');
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(500);
    // The corner floater: the Agent button, or the session dock once a session exists (the
    // Open-session check above opened one). The same pair the feed's clearance observes.
    const fab = page.locator('.agent-fab, .agent-dock:not(.agent-dock--floating)').first();
    const lastRow = page.locator('.agents-feed-scroll article.agent-msg').last();
    const fabR = (await fab.count()) ? await rect(fab) : null;
    const lastR = await rect(lastRow);
    check('[F14] scrolled to the bottom, the floating Agent button covers no part of the last message (was overlapping)',
      !!fabR && overlapArea(lastR, fabR) === 0, `fab=${JSON.stringify(fabR)} last=${JSON.stringify(lastR)}`);
    await page.screenshot({ path: join(SHOTS, '13-1100.png') });

    // F13 — the header row at four widths.
    console.log('\n═══ 14. The header at four widths ═══');
    for (const w of [1500, 1100, 900, 760]) {
      await page.setViewportSize({ width: w, height: 950 });
      await page.waitForTimeout(500);
      const head = await page.evaluate(() => {
        const rowEl = document.querySelector('.agents-head-row');
        if (!rowEl) return null;
        const rr = rowEl.getBoundingClientRect();
        const over = [...rowEl.children].filter((c) => c.getBoundingClientRect().right > rr.right + 0.5)
          .map((c) => `${c.className}:${Math.round(c.getBoundingClientRect().right)}>${Math.round(rr.right)}`);
        const sub = document.querySelector('.agents-channel-sub');
        const subCut = sub && sub.getClientRects().length && sub.scrollWidth > sub.clientWidth + 1
          ? `sub ${sub.scrollWidth}/${sub.clientWidth}` : null;
        return { over, subCut };
      });
      // 1500 already fitted before the fix; it stays as the guard that the fix did not break it.
      check(`${w === 1500 ? '[guard]' : '[F13]'} at ${w} nothing in the header row clips or truncates (was the subtitle cut at 1100, New agent past the edge at 760)`,
        !!head && head.over.length === 0 && !head.subCut, JSON.stringify(head));
      await page.screenshot({ path: join(SHOTS, `14-header-${w}.png`), clip: { x: 0, y: 0, width: w, height: 160 } });
    }

    // F15 + F4 + F22 — the scheduler bar, mocked (launchd is never touched).
    console.log('\n═══ 15. The scheduler bar ═══');
    await page.setViewportSize({ width: 1100, height: 950 });
    await mockDispatcher(page, dispatcherState({ projectRegistered: false }));
    await openChannel();
    const warnBar = page.locator('.auto-dispatch--warn').first();
    await until(async () => (await warnBar.count()) > 0, 10000);
    const heights = await page.evaluate(() => {
      const h = (s) => document.querySelector(s)?.getBoundingClientRect().height ?? 0;
      return { head: h('.agents-head'), notice: h('.agents-needyou'), warn: h('.auto-dispatch--warn'), feed: h('.agents-feed-scroll') };
    });
    check('[F15] with a WARN bar and a waiting agent at 1100x950 the feed keeps >=500px (was 447, head+notice 225)',
      heights.head + heights.notice <= 170 && heights.warn <= 48 && heights.feed >= 500, JSON.stringify(heights));
    await page.screenshot({ path: join(SHOTS, '15-warn-1100.png') });
    const warnInks = {};
    const warnHover = {};
    const warnDashes = [];
    for (const theme of ['light', 'dark']) {
      await setTheme(page.context(), theme);
      for (const [name, state] of [['unwatched', { projectRegistered: false }], ['stale', { current: false }]]) {
        await mockDispatcher(page, dispatcherState(state));
        await openChannel();
        const btn = page.locator('.auto-dispatch--warn .auto-dispatch-btn').first();
        await until(async () => (await btn.count()) > 0, 10000);
        warnInks[`${theme}/${name}`] = (await btn.count()) ? await contrast(btn) : null;
        if (await btn.count()) {
          await btn.hover();
          await page.waitForTimeout(300);
          warnHover[`${theme}/${name}`] = await fillContrast(btn);
          await page.mouse.move(1, 1);
        }
        warnDashes.push(...dashLines(await chromeText(page, '.agents-head', [])).map((l) => `${theme}/${name}: ${l}`));
      }
    }
    check('[F4] the WARN button reads at >=4.5:1 in both states and both themes (was 3.24 / 3.40)',
      Object.values(warnInks).every((v) => v !== null && v >= 4.5), JSON.stringify(warnInks));
    // R2-5: hovered, the WARN button fills with the accent and carries its label on it.
    const hoverLight = Object.entries(warnHover).filter(([k]) => k.startsWith('light/'));
    const hoverDark = Object.entries(warnHover).filter(([k]) => k.startsWith('dark/'));
    check('[R2-5] light: the hovered WARN button reads at >=4.5:1 on its accent fill (was 4.15)',
      hoverLight.length === 2 && hoverLight.every(([, v]) => v >= 4.5), JSON.stringify(warnHover));
    check('[guard] dark: the hovered WARN button reads at >=4.5:1 on its accent fill (was dark ink on light violet, 6.51)',
      hoverDark.length === 2 && hoverDark.every(([, v]) => v >= 4.5), JSON.stringify(warnHover));
    check('[F16] …and the WARN bars carry no em dash (was "… here — the usual cause …")',
      warnDashes.length === 0, warnDashes.slice(0, 3).join(' | '));
    await setTheme(page.context(), 'light');
    await mockDispatcher(page, dispatcherState({ installed: false }), { installDelayMs: 3000 });
    await openChannel();
    const pill = page.locator('.auto-dispatch-pill').first();
    await until(async () => (await pill.count()) > 0, 10000);
    await pill.click();
    await page.waitForTimeout(600);
    const busyPill = await pill.evaluate((el) => ({
      disabled: el.disabled,
      opacity: getComputedStyle(el).opacity,
      pulse: getComputedStyle(el.querySelector('.auto-dispatch-dot')).animationName,
    }));
    check('[F22] while switching, the pill keeps full ink and its dot pulses (was opacity 0.6, no motion)',
      busyPill.disabled && busyPill.opacity === '1' && busyPill.pulse === 'agentDotPulse', JSON.stringify(busyPill));
    await page.waitForTimeout(3000);
    await page.unroute(/\/api\/automations\/dispatcher(\?|$)/);
    await page.unroute(/\/api\/automations\/dispatcher\/install/);
    await page.setViewportSize({ width: 1500, height: 1000 });

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
  console.log(`  screenshots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
