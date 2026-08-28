#!/usr/bin/env node
/**
 * A run that opens itself must not cost the user their saved chats.
 *
 *   npm run build && npm run verify:automation-tab-restore
 *
 * THE BUG THIS EXISTS TO PIN DOWN, in the shape the owner reported it: automations were
 * given the ability to open as chat tabs (D7), and past chats started disappearing.
 *
 * THE RACE, AND WHY THE RESTORE KEPT LOSING IT. `AutomationAttentionOpener` polls on the
 * SYNCHRONOUS localStorage settings seed, so it can fire on the first render and needs one
 * round-trip; the roster restore waits for `settingsReady` — the SERVER settings — and so
 * needs two, sequentially. The opener therefore wins often, and when it does, the restore's
 * `prev.length > 0 ? prev : restored` read that one tab as "someone already populated the
 * roster" and threw the whole restore away. `hydratedRef` then flipped, the persist effect
 * unblocked, and the survivor was mirrored back AS THE WHOLE ROSTER. Every past chat, gone
 * from disk — not hidden for one launch, deleted.
 *
 * THE ADVERSE ORDER IS FORCED, NOT AWAITED. Left to the machine this reproduces perhaps
 * half the time, which is a test that reports the weather. `/api/agent/sessions` is held
 * for 2.5s below so the opener ALWAYS wins — the interleaving the invariant has to survive,
 * every run, on any machine.
 *
 * SO THE LOAD-BEARING ASSERTION IS THE FILE, NOT THE SCREEN. A build could show the tabs
 * and still overwrite `.agent-sessions.json` a debounce later; this script waits for that
 * write and reads what actually landed.
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/api/automations/attention` and
 * `/api/agent/sessions` routes, and the real React surface in Chromium. Isolated fake HOME,
 * a scratch project, synthesized transcripts, and `claude` replaced by a stand-in on that
 * HOME's PATH: restoring three tabs spawns three processes that are sent nothing and spend
 * no tokens.
 *
 * ONE THEME ONLY, deliberately — unlike its UI siblings this asserts behaviour and a file on
 * disk, and nothing here renders differently in light.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dc-ui-automation-tab-restore');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-automation-tab-restore');
const TRANSCRIPTS = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
const ROSTER = join(PROJ, '_dream_context', 'state', '.agent-sessions.json');

const SLUG = 'funnel-watch';
const TITLE = 'CalBuddy Funnel Watch';

/** The two conversations the user had by hand and expects to find again. */
const CHATS = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Recall ranking spike' },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Paywall copy pass' },
];
/** The run that FAILED and therefore wants a human — what makes a tab open by itself. */
const SESSION_AUTO = '33333333-3333-4333-8333-333333333333';

const STANDIN = `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

const jsonl = (e) => e.map((x) => JSON.stringify(x)).join('\n') + '\n';

/** Enough of a transcript that `findTranscriptBySessionId` sees a conversation and the
 *  restore has something to replay. The turns themselves are not under test here. */
function transcript(id, text) {
  return jsonl([
    {
      type: 'user', isSidechain: false, uuid: `${id}-u0`, timestamp: '2026-08-27T09:00:00.000Z',
      cwd: PROJ, sessionId: id, gitBranch: 'main', version: '2.1.220',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
    {
      type: 'assistant', isSidechain: false, uuid: `${id}-a0`, sessionId: id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Looked at it.' }] },
    },
  ]);
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(TRANSCRIPTS, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const cli = (args) => {
    const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args],
      { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  };
  cli(['vaults', 'add', 'proj', PROJ]);
  cli(['automations', 'create', SLUG, '--title', TITLE, '--days', 'daily', '--at', '11:00']);

  // ── What the user had open when they last closed the app ────────────────────
  for (const c of CHATS) writeFileSync(join(TRANSCRIPTS, `${c.id}.jsonl`), transcript(c.id, c.title));
  writeFileSync(ROSTER, JSON.stringify({
    sessions: CHATS.map((c) => ({
      title: c.title, kind: 'chat', bypass: false, minimized: false, size: 1, sessionId: c.id,
    })),
  }, null, 2) + '\n');

  // ── The run that wants a human ──────────────────────────────────────────────
  // `failed` + a transcript + a binding THIS machine recorded is exactly what
  // `attentionRuns` requires; anything less and the tab never opens, which would
  // make this script pass for the wrong reason.
  writeFileSync(join(TRANSCRIPTS, `${SESSION_AUTO}.jsonl`), transcript(SESSION_AUTO, 'automation brief'));
  const firedAt = new Date(Date.now() - 3_600_000).toISOString();
  mkdirSync(join(PROJ, '_dream_context', 'automations', 'cache'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'automations', 'cache', `${SLUG}.json`), JSON.stringify({
    slug: SLUG, lastRunAt: firedAt, lastFireAt: firedAt, status: 'failed', durationMs: 12000,
    outputPath: null, error: 'the funnel query returned no rows', exitCode: 1,
    history: [{
      firedAt, startedAt: firedAt, finishedAt: firedAt, status: 'failed', durationMs: 12000,
      outputPath: null, error: 'the funnel query returned no rows', exitCode: 1,
      sessionId: SESSION_AUTO, costUsd: 0.22, numTurns: 4, permissionDenials: 0,
    }],
  }, null, 2));

  // The binding is TTL'd (90d) against the CLOCK, so it is written at `now` — a
  // fixture date here would silently expire the binding and take the tab with it.
  mkdirSync(join(HOME, '.dreamcontext', 'automations'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'automations', `${SLUG}.sessions.json`), JSON.stringify({
    [SESSION_AUTO]: { sessionId: SESSION_AUTO, slug: SLUG, at: new Date().toISOString() },
  }, null, 2) + '\n', { mode: 0o600 });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
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

const report = { pass: 0, fail: 0 };
const check = (label, ok, ev = '') => {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
};

const readRoster = () => {
  try { return JSON.parse(readFileSync(ROSTER, 'utf-8')).sessions ?? []; } catch { return []; }
};

async function run(base) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => check(`no page error (${String(e).slice(0, 120)})`, false));

  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(150); }
    return false;
  };
  const tabTexts = async () => page.locator('.agent-tab:visible').allInnerTexts();

  // FORCE THE LOSING ORDER. Hold the roster read long enough that the attention poll is
  // always first to put a tab on screen — the interleaving that produced the bug. Only
  // the GET: the PUT that persists the roster shares this URL and must not be delayed,
  // since the assertions at the bottom wait on it.
  await page.route('**/api/agent/sessions*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((r) => setTimeout(r, 2500));
    return route.continue();
  });

  // The attention poll fires on load; nothing is clicked to make the tabs appear.
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });

  // A fresh profile greets you with the release notes, and its scrim eats pointer
  // events at the window level — every later click then fails as a 30s timeout that
  // reads like a broken button rather than a covered one. It also opens LATE (behind
  // its own fetch), so this is retried rather than checked once.
  const dismissAnnouncements = async () => {
    for (let i = 0; i < 5; i += 1) {
      if (!(await page.locator('.announcements-modal-scrim').count())) return;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }
  };
  await dismissAnnouncements();

  check('the failed run opens as a tab with nobody clicking anything',
    await until(async () => (await tabTexts()).some((t) => t.includes('CalBuddy'))),
    JSON.stringify(await tabTexts()));

  check('…and both saved chats are restored ALONGSIDE it, not instead of it',
    await until(async () => {
      const t = (await tabTexts()).join(' | ');
      return CHATS.every((c) => t.includes(c.title));
    }),
    JSON.stringify(await tabTexts()));

  const tabs = await tabTexts();
  check('exactly three tabs — two chats and the run, nothing duplicated',
    tabs.length === 3, JSON.stringify(tabs));

  // The run that needs a human is the one you are looking at: a launch-time restore is
  // background furniture and must not take the foreground from it.
  const active = await page.locator('.agent-tab.active:visible').innerText().catch(() => '');
  check('the run that wants a human is the tab in front', active.includes('CalBuddy'), JSON.stringify(active));

  await page.screenshot({ path: join(SHOTS, 'restored-with-automation.png') });

  // ── THE ASSERTION THIS SCRIPT EXISTS FOR ───────────────────────────────────
  //
  // THE LOSS IS NOT INSTANT, AND THAT MATTERS TO HOW THIS IS TESTED. On the broken
  // build `hydratedRef` flips inside an async callback, which schedules no render, so
  // the persist effect does not re-run on hydration alone — it waits for the next
  // roster CHANGE. Reading the file straight after load therefore finds it untouched
  // and every survival assertion passes for the wrong reason. That is also why the
  // owner saw chats vanish gradually rather than all at once: the write lands on the
  // next thing you do.
  //
  // So DO the next thing. RENAMING the tab, rather than closing it, because the mutation
  // has to be one that behaves the same on a broken build and a fixed one: closing the
  // automation is the more natural reaction, but on a broken build it closes the ONLY
  // tab, the surface collapses, and the unmount clears the debounce before it ever
  // fires — the test would then pass by accident, on the build with the bug. A rename
  // leaves the strip standing either way and still forces the roster through the wire.
  await dismissAnnouncements();
  check('the release-notes popup is out of the way',
    (await page.locator('.announcements-modal-scrim').count()) === 0);

  const RENAMED = 'The run I looked at';
  await page.locator('.agent-tab:visible', { hasText: 'CalBuddy' }).first().click({ button: 'right' });
  const menu = page.locator('.agent-tab-menu');
  await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await menu.locator('[role="menuitem"]', { hasText: 'Rename' }).click();
  const editor = page.locator('.agent-tab-rename');
  await editor.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await editor.fill(RENAMED);
  await page.keyboard.press('Enter');

  // Persist is debounced 400ms behind the roster settling. Wait for the rename to reach
  // the file — that is what proves a write happened AT ALL, without which every
  // assertion below would pass by simply reading the untouched fixture.
  const wrote = await until(() => Promise.resolve(
    readRoster().some((s) => s.title === RENAMED)), 20000);
  check('the roster was re-saved after an ordinary edit', wrote, JSON.stringify(readRoster()));

  const saved = readRoster();
  check('THE SAVED CHATS SURVIVED THAT SAVE — a tab that opened itself does not delete the ones you opened',
    CHATS.every((c) => saved.some((s) => s.sessionId === c.id)),
    JSON.stringify(saved, null, 2));

  check('…with their names and kind intact, so the next launch restores them again',
    CHATS.every((c) => saved.some((s) => s.sessionId === c.id && s.title === c.title && s.kind === 'chat')),
    JSON.stringify(saved, null, 2));

  await browser.close();
}

(async () => {
  console.log('▸ automation tab restore — a run that opens itself must not cost the saved chats');
  setup();
  const port = await freePort();
  const srv = await startServer(port);
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    srv.kill();
  }
  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
  console.log(`Screenshots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
