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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = join(REPO, 'dist', 'index.js');

const SCRATCH = join(tmpdir(), 'dc-ui-agents-feed');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const AUTOMATIONS_DIR = join(CONTEXT_ROOT, 'automations');
const SHOTS = join(REPO, 'tmp', 'verify-agents-feed');

/** The sentence the posting agent puts in the channel. Asserted verbatim in
 *  the DOM, so a body that silently came from somewhere else cannot pass. */
const POSTED = 'WAU is down 4% week-over-week; the onboarding modal is the likely cause.';
/** The opening line of the SILENT agent's document — the fallback body. */
const RESULT_LINE = 'Two competitor changes this week, neither touches our positioning.';

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

if (ask) {
  // An ASKED run always posts, whatever the agent is — the human is at the
  // keyboard waiting for an answer, which is exactly when zero posts is wrong.
  spawnSync(process.execPath, [${JSON.stringify(DIST_INDEX)}, 'automations', 'post', slug, 'You asked for: ' + ask], { encoding: 'utf-8' });
  out({ session_id: 'standin-ask-' + slug, is_error: false, result: 'Answered: ' + ask + '\\n\\n## Detail\\n\\nRows.\\n',
    total_cost_usd: 0.04, num_turns: 2, duration_ms: 9000, permission_denials: [] });
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
    const badge = page.locator('.sidebar-item', { hasText: 'Agents' }).locator('.sidebar-badge');
    const badged = await until(async () => (await badge.count()) > 0, 20000);
    check('the rail carries an unread badge before the page is ever opened', badged);
    const badgeText = badged ? await badge.innerText() : '';
    // 3 runs · (2 system + 1 post) + 2 + 2 = 7 entries, none of them the user's.
    check('…and it equals the project-wide unread count', badgeText.trim() === '7', `badge="${badgeText}"`);
    await page.screenshot({ path: join(SHOTS, '1-sidebar-badge.png') });

    await page.locator('.sidebar-item', { hasText: 'Agents' }).first().click();
    await page.waitForTimeout(1500);

    // ── 2: one message per run ───────────────────────────────────────────
    console.log('\n═══ 2. A run is a message ═══');
    const gotFeed = await until(async () => (await page.locator('.agent-msg').count()) >= 3, 20000);
    check('the channel opens on the feed with one message per run', gotFeed,
      `found ${await page.locator('.agent-msg').count()}`);
    await page.screenshot({ path: join(SHOTS, '2-feed.png'), fullPage: false });

    const digestMsg = page.locator('.agent-msg', { hasText: 'Daily insight digest' }).first();
    check('the message shows the agent\'s NAME', (await digestMsg.locator('.agent-msg-name').innerText()).trim() === 'Daily insight digest');
    check('…a photo, not initials', await digestMsg.locator('.agent-av img').count() === 1);
    check('…a time', /\d/.test(await digestMsg.locator('.agent-msg-time').innerText()));
    check('…the status WORD "done"', (await digestMsg.locator('.agent-msg-status').innerText()).trim() === 'done');
    const meta = await digestMsg.locator('.agent-msg-meta').innerText().catch(() => '');
    check('…duration and cost', /4m 12s/.test(meta) && /\$0\.31/.test(meta), `meta="${meta}"`);

    // ── 3: the body ──────────────────────────────────────────────────────
    console.log('\n═══ 3. The body is what the agent said ═══');
    check('the body is the agent\'s own post, verbatim',
      (await digestMsg.locator('.agent-msg-text').innerText()).trim() === POSTED);
    check('…and it is not labelled as coming from the document',
      await digestMsg.locator('.agent-msg-from').count() === 0);

    const watcherMsg = page.locator('.agent-msg', { hasText: 'Competitor watch' }).first();
    check('a SILENT run falls back to its document\'s opening line',
      (await watcherMsg.locator('.agent-msg-text').innerText()).trim() === RESULT_LINE);
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
    check('…labelled as the run\'s own error',
      (await breakerMsg.locator('.agent-msg-from').innerText()).includes('never published'));
    check('…and it offers NO file card, having published nothing',
      await breakerMsg.locator('.agent-msg-file').count() === 0,
      `found ${await breakerMsg.locator('.agent-msg-file').count()} card(s)`);

    // ── 4: the file card opens the document ──────────────────────────────
    console.log('\n═══ 4. The file card ═══');
    const files = digestMsg.locator('.agent-msg-file');
    check('the posted file and the published document are both cards', await files.count() === 2,
      `found ${await files.count()}`);
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
    await digestMsg.locator('.agent-msg-replies').click();
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
    check('the agent\'s post is in the thread too', await panel.locator('.agent-thread-post').count() === 1);
    check('the composer is DISABLED', await panel.locator('.agent-thread-input').isDisabled());
    check('…and says when replying starts working',
      (await panel.locator('.agent-thread-note').innerText()).includes('step 4'));
    await page.screenshot({ path: join(SHOTS, '6-thread-panel.png') });

    // ── 8: THE COMPOSER — calling an agent by typing at it ───────────────
    console.log('\n═══ 8. The composer ═══');
    await page.locator('.agent-thread-close').click().catch(() => {});
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
      (await picker.first().locator('.chat-cmp-mention-logo').getAttribute('src') ?? '').includes('/automations/digest/photo'),
      await picker.first().locator('.chat-cmp-mention-logo').getAttribute('src'));
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
    const yourText = await you.last().locator('.agent-msg-text').innerText();
    check('…carrying what you typed, without the @address', yourText.trim() === ASK, `got: "${yourText}"`);
    check('…and saying who it went to', (await you.last().locator('.agent-msg-meta').innerText()).includes('Daily insight digest'));
    check('the field clears on send', (await field.inputValue()) === '');
    check('…and refuses a second ask while that run is in flight', await field.isDisabled());
    check('…saying who is holding the slot, not "Connecting…"',
      (await field.getAttribute('placeholder') ?? '').includes('Daily insight digest'),
      await field.getAttribute('placeholder'));
    await page.screenshot({ path: join(SHOTS, '8-asked.png') });

    // THE PROOF: the stand-in only answers this way when the ask reached its
    // own `-p` prompt. A broken plumb gives the scheduled body instead.
    const answered = await until(async () => {
      const rows = page.locator('.agent-msg:not(.agent-msg--you) .agent-msg-text');
      const n = await rows.count();
      for (let i = 0; i < n; i++) if ((await rows.nth(i).innerText()).includes('You asked for: ' + ASK)) return true;
      return false;
    }, 60000);
    check('the agent RUNS and answers with the words you typed', answered);
    check('…so the ask reached its prompt, not just the channel', answered);
    check('the field frees up again once the run settles',
      await until(async () => !(await field.isDisabled()), 20000));
    await page.screenshot({ path: join(SHOTS, '9-answered.png') });

    // The exchange is ONE message: the ask is the question this message
    // answers, never a reply, or the channel would claim a run nobody spoke
    // in had one.
    const askedMsg = page.locator('.agent-msg:not(.agent-msg--you)').filter({ hasText: 'You asked for: ' + ASK }).first();
    const replies = await askedMsg.locator('.agent-msg-replies').innerText();
    check('the ask is not counted as a reply', replies.trim() === 'Open thread', `got: "${replies}"`);

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
    const geo = await page.evaluate(() => {
      const w = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect() : null; };
      const bar = w('.auto-dispatch');      // the full-width notice in the header
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
    check('…and the composer lines up with the notice above it',
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
