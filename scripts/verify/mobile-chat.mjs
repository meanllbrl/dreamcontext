#!/usr/bin/env node
/**
 * The phone layout — runtime proof, on a real phone-shaped Chromium.
 *
 *   npm run build && npm run verify:mobile-chat
 *
 * The claim under test: on a phone the app IS the chat. It opens straight into the surface,
 * the desktop tab strip is gone, and the sessions live in a left DRAWER a thumb can drive.
 *
 * WHAT IS PROVEN, in the real app (real server, real bundle, real touch emulation):
 *   P0  the page genuinely matches BOTH halves of `useIsMobile` — narrow AND coarse-pointer.
 *       Asserted first and explicitly: if Chromium's emulation stopped reporting
 *       `pointer: coarse`, every check below would "pass" against the desktop layout for the
 *       wrong reason, and this script would be measuring nothing.
 *   T1  the surface auto-expands with NO click — the phone lands in chat (A2)
 *   T2  `[data-mobile]` is on, and the surface fills the viewport instead of sitting under a
 *       header/sidebar inset that does not exist here (A2)
 *   T3  the desktop tab strip is not rendered at all, and the hamburger is (A4)
 *   T4  tapping it opens the drawer, which lists the live session(s) (A5)
 *   T5  "New chat" adds a session; the drawer then lists BOTH and tapping the first switches
 *       back to it and closes itself (A5, A6)
 *   T6  the scrim dismisses the drawer (A7)
 *   T7  nothing overflows sideways at 390px — the document is exactly as wide as the screen
 *       (A9)
 *   T8  the touch targets that matter clear 44px, and the composer input is ≥16px so iOS
 *       Safari does not zoom the page on focus (A10)
 *   T13 the drawer's project row lists every registered project, and picking another one
 *       actually moves the window to it (A13)
 *   T14 "Past chats" lists conversations this project had before, and tapping one brings it
 *       back as a live tab (A14)
 *
 * HONEST LIMIT — this is Chromium's phone emulation, not an iPhone. `env(safe-area-inset-*)`
 * and the on-screen-keyboard behaviour (`100dvh` under a shrinking visual viewport) cannot be
 * exercised here; they are written from the platform rules and stay unverified until the
 * surface is opened on real hardware.
 *
 * SCRATCH HOME, ALWAYS — vault registry, agent-ui.json and the fake `claude` live in an
 * isolated HOME the server is spawned with. Nothing reads the developer's own ~/.claude*.
 *
 * FAILURE POLICY — collect, don't fail fast. Exit 0 iff every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-mobile-chat');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const PROJ2 = join(SCRATCH, 'proj2');
const SHOT_DIR = process.env.SHOT_DIR || join(REPO, 'tmp', 'mobile-chat');

/** Two conversations this project "had" before today — the Past chats fixture. */
const PAST = ['Fix the login redirect loop', 'Rename the payout column'];
const PAST_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
// Inert: it speaks enough stream-json to be a live session and answers one short line, so
// the transcript has something in it for the overflow check to be about.
const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/mobile-chat.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'verify-session-' + process.pid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading /Users/someone/projects/a-very-long-path/that/should/not/push/the/column/sideways.ts' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-session-' + process.pid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

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
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  // A SECOND project, so "switch project" has somewhere to go.
  mkdirSync(join(PROJ2, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ2 });

  for (const [name, path] of [['proj', PROJ], ['proj2', PROJ2]]) {
    const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', name, path],
      { env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }

  // Past conversations, written where Claude Code writes them: `~/.claude/projects/<slug>/`,
  // slug = the project root with every non-alphanumeric character replaced by '-'. Each line
  // also carries `cwd`, which is the encoding-independent fallback `resolveProjectDir` uses —
  // so this fixture survives a change to the slug rule instead of silently listing nothing.
  const projectsDir = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectsDir, { recursive: true });
  PAST.forEach((title, i) => {
    const when = new Date(Date.now() - (i + 1) * 3_600_000).toISOString();
    const line = JSON.stringify({
      type: 'user', cwd: PROJ, gitBranch: 'main', sessionId: PAST_IDS[i], timestamp: when,
      message: { role: 'user', content: title },
    });
    writeFileSync(join(projectsDir, `${PAST_IDS[i]}.jsonl`), `${line}\n`);
  });
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
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── the run ──────────────────────────────────────────────────────────────────────────

let server;
let browser;
try {
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;

  browser = await chromium.launch();
  // A real device profile, not a hand-set viewport: `isMobile` + `hasTouch` are what make
  // Chromium report `pointer: coarse`, which is half of `useIsMobile`'s definition.
  const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
  const page = await context.newPage();
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };
  // The VISIBLE hamburger. After a project switch two ProjectInstances are mounted — the
  // previous one stays in the DOM `hidden`+`inert` — so a bare selector matches twice and
  // Playwright refuses it. `:visible` is the right discriminator, not `.first()`: the hidden
  // one is FIRST in document order.
  const burger = () => vis('.mchat-head-btn[aria-label="Sessions"]').first();
  const projectRow = () => vis('.mchat-project').first();
  const shot = async (name) => {
    const path = join(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path });
    console.log(`      shot: ${path}`);
  };

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // First run pops the "What's New" modal over everything — dismiss it before measuring the
  // surface underneath. (It is modal on the desktop too; that it also covers the phone's
  // chat on first open is expected, not the thing under test here.)
  const gotIt = page.getByRole('button', { name: /^Got it$/ });
  if (await gotIt.count()) { await gotIt.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }

  // ── P0 — the emulation really is a phone, by BOTH of useIsMobile's tests ─────────
  const mq = await page.evaluate(() => ({
    narrow: matchMedia('(max-width: 768px)').matches,
    coarse: matchMedia('(pointer: coarse)').matches,
    width: innerWidth,
  }));
  check('P0 the page matches narrow AND coarse-pointer — useIsMobile is genuinely exercised',
    mq.narrow && mq.coarse, `narrow=${mq.narrow} coarse=${mq.coarse} width=${mq.width}`);

  // ── T1 — it opened into chat by itself ──────────────────────────────────────────
  // NOT clicked open: the only interaction so far is the navigation.
  const autoOpened = await until(async () => (await page.locator('.agent-surface.expanded').count()) > 0, 15000);
  check('T1 the surface auto-expanded with no click — the phone lands in chat', autoOpened);

  // A chat session has to exist for the rest; on a fresh vault the surface offers a start
  // button rather than spawning unasked.
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  const liveChat = await until(async () => (await vis('.chat-cmp-input').count()) > 0, 25000);
  check('precondition: a chat pane is live', liveChat);
  await page.waitForTimeout(800);
  await shot('01-landing');

  // ── T2 — full viewport, not the desktop inset ───────────────────────────────────
  const geom = await page.evaluate(() => {
    const el = document.querySelector('.agent-surface');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { mobile: el.getAttribute('data-mobile'), top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight };
  });
  check('T2 [data-mobile] is on and the surface fills the viewport',
    geom?.mobile === 'true' && geom.top === 0 && geom.left === 0 && geom.w === geom.vw && Math.abs(geom.h - geom.vh) <= 1,
    JSON.stringify(geom));

  // ── T3 — the desktop strip is gone, the hamburger is there ──────────────────────
  const strip = await page.locator('.agent-overlay-tabs').count();
  const burgerCount = await page.locator('.mchat-head-btn[aria-label="Sessions"]').count();
  check('T3 the desktop tab strip is not rendered, and a Sessions button is',
    strip === 0 && burgerCount === 1, `tabstrip=${strip} burger=${burgerCount}`);

  // ── T4 — the drawer opens and lists the session ─────────────────────────────────
  await burger().tap();
  const drawerOpen = await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) > 0, 5000);
  await page.waitForTimeout(400);
  const rows1 = await page.locator('.mchat-row').count();
  check('T4 tapping Sessions opens the drawer and it lists the live session',
    drawerOpen && rows1 >= 1, `open=${drawerOpen} rows=${rows1}`);
  await shot('02-drawer');

  const firstTitle = await page.locator('.mchat-row .mchat-row-title').first().innerText().catch(() => '');

  // ── T5 — New chat adds one, and tapping a row switches back ─────────────────────
  await page.locator('.mchat-new').tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) === 0, 4000);
  await page.waitForTimeout(2500);
  await burger().tap();
  await page.waitForTimeout(500);
  const rows2 = await page.locator('.mchat-row').count();
  check('T5a "New chat" added a session — the drawer now lists both',
    rows2 === rows1 + 1, `before=${rows1} after=${rows2}`);

  await page.locator('.mchat-row').first().locator('.mchat-row-main').tap();
  const closedOnPick = await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) === 0, 4000);
  await page.waitForTimeout(600);
  const headTitle = await page.locator('.mchat-head-title').innerText().catch(() => '');
  check('T5b tapping a row switches to that session and closes the drawer',
    closedOnPick && headTitle.trim() === firstTitle.trim(),
    `closed=${closedOnPick} header="${headTitle.trim()}" expected="${firstTitle.trim()}"`);

  // ── T6 — the scrim dismisses ────────────────────────────────────────────────────
  await burger().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) > 0, 4000);
  await page.waitForTimeout(400);
  // Tap the far right of the screen, which is scrim (the panel caps at 320px).
  await page.touchscreen.tap(mq.width - 12, 400);
  const closedOnScrim = await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) === 0, 4000);
  check('T6 tapping the scrim closes the drawer', closedOnScrim);

  // ── T7 — nothing overflows sideways ─────────────────────────────────────────────
  await vis('.chat-cmp-input').first().fill('hello from a phone');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    const wide = [...document.querySelectorAll('.agent-surface *')]
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 5)
      .map((e) => `${e.className || e.tagName}@${Math.round(e.getBoundingClientRect().right)}`);
    return { scrollW: d.scrollWidth, client: d.clientWidth, wide };
  });
  check('T7 the document is exactly as wide as the screen — nothing pushes it sideways',
    overflow.scrollW <= overflow.client + 1,
    `scrollWidth=${overflow.scrollW} clientWidth=${overflow.client} offenders=${JSON.stringify(overflow.wide)}`);
  await shot('03-transcript');

  // ── T8 — touch targets and the iOS zoom floor ───────────────────────────────────
  const targets = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const input = document.querySelector('.chat-cmp-input');
    return {
      burger: pick('.mchat-head-btn[aria-label="Sessions"]'),
      send: pick('.chat-cmp-send'),
      inputFont: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
    };
  });
  const big = (t) => !!t && t.w >= 44 && t.h >= 44;
  check('T8 the header and send targets clear 44px, and the input is ≥16px (no iOS zoom)',
    big(targets.burger) && big(targets.send) && targets.inputFont >= 16,
    JSON.stringify(targets));
  // ── T9 — one pane, and no split affordance to make a second ─────────────────────
  const panes = await page.locator('.agent-pane-slot[data-pane]').count();
  const splitBtn = await page.locator('.agent-new-split').count();
  check('T9 one pane, and the split affordances are not rendered at all',
    panes === 1 && splitBtn === 0, `panes=${panes} splitControls=${splitBtn}`);

  // ── T10 — Esc and the BACK gesture both dismiss the drawer ──────────────────────
  await burger().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) > 0, 4000);
  await page.keyboard.press('Escape');
  const closedOnEsc = await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) === 0, 4000);
  check('T10a Esc closes the drawer', closedOnEsc);

  await burger().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) > 0, 4000);
  await page.waitForTimeout(400);
  await page.goBack();
  const closedOnBack = await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) === 0, 4000);
  // And the back press must have been SPENT on the drawer, not on the app: still the same page.
  const stillHere = (await page.locator('.agent-surface.expanded').count()) > 0;
  check('T10b the back gesture closes the drawer instead of navigating the app away',
    closedOnBack && stillHere, `closed=${closedOnBack} surfaceStillUp=${stillHere}`);

  // ── T14 — Past chats are listed, and one comes back as a live tab ───────────────
  // Before T13, because switching the project away would take this project's history with it.
  await burger().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) > 0, 4000);
  const pastListed = await until(async () => {
    const t = await page.$$eval('.mchat-row-title', (els) => els.map((e) => e.textContent?.trim()));
    return PAST.every((x) => t.includes(x));
  }, 10000);
  const pastTitles = await page.$$eval('.mchat-row-title', (els) => els.map((e) => e.textContent?.trim()));
  check('T14a the drawer lists the conversations this project had before',
    pastListed, JSON.stringify(pastTitles));
  await shot('06-past-chats');

  const beforeTabs = await page.locator('.mchat-row').count();
  await page.locator('.mchat-row-main', { hasText: PAST[0] }).first().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) === 0, 4000);
  await page.waitForTimeout(3000);
  const resumedHeader = (await page.locator('.mchat-head-title').innerText().catch(() => '')).trim();
  check('T14b tapping a past chat brings it back as the live session',
    resumedHeader === PAST[0], `header="${resumedHeader}" expected="${PAST[0]}" (rows before=${beforeTabs})`);

  // ── T13 — the project row switches the window to another project ────────────────
  await burger().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) > 0, 4000);
  const shownProject = (await projectRow().innerText()).trim();
  await projectRow().tap();
  const listed = await until(async () => (await page.locator('.mchat-project-row').count()) >= 2, 8000);
  const projectNames = await page.$$eval('.mchat-project-row-name', (els) => els.map((e) => e.textContent?.trim()));
  check('T13a the project row names the current project and lists every registered one',
    shownProject === 'proj' && listed && projectNames.includes('proj') && projectNames.includes('proj2'),
    `shown="${shownProject}" list=${JSON.stringify(projectNames)}`);
  await shot('07-projects');

  await page.locator('.mchat-project-row', { hasText: 'proj2' }).first().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) === 0, 4000);
  await page.waitForTimeout(3500);
  // Reopen and read the row back: the drawer's own label is the switch's user-visible result.
  await burger().tap();
  const switched = await until(async () => {
    const t = await projectRow().innerText().catch(() => '');
    return t.trim() === 'proj2';
  }, 8000);
  const instances = await page.locator('.project-instance').count();
  check('T13b picking another project moves the window to it',
    switched && instances === 2, `projectRow="${(await projectRow().innerText().catch(() => '')).trim()}" instances=${instances}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ── T11 — the escape hatch gives the dashboard (and its chrome) back ─────────────
  const barHiddenWhileChat = await page.locator('.window-chrome-bar').isVisible().catch(() => false);
  await burger().tap();
  await until(async () => (await page.locator('.mchat-drawer[data-open]').count()) > 0, 4000);
  await page.waitForTimeout(300);
  await vis('.mchat-exit').first().tap();
  // VISIBLE, not "in the DOM": by now the window holds two ProjectInstances and the
  // backgrounded one keeps its own expanded surface inside a `hidden` subtree.
  const collapsed = await until(async () => (await vis('.agent-surface.expanded').count()) === 0, 6000);
  await page.waitForTimeout(600);
  const barBack = await page.locator('.window-chrome-bar').isVisible().catch(() => false);
  check('T11 "Show full dashboard" collapses chat and restores the app chrome it had hidden',
    !barHiddenWhileChat && collapsed && barBack,
    `barVisibleDuringChat=${barHiddenWhileChat} collapsed=${collapsed} barBackAfter=${barBack}`);
  await shot('04-dashboard-after-exit');

  // ── T12 — the same at a second phone size ───────────────────────────────────────
  const bigPhone = await context.newPage();
  await bigPhone.setViewportSize({ width: 430, height: 932 });
  await bigPhone.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await bigPhone.waitForTimeout(3500);
  const gotIt2 = bigPhone.getByRole('button', { name: /^Got it$/ });
  if (await gotIt2.count()) { await gotIt2.first().click({ force: true }).catch(() => {}); await bigPhone.waitForTimeout(600); }
  await bigPhone.waitForTimeout(2500);
  const wide = await bigPhone.evaluate(() => ({
    mobile: document.querySelector('.agent-surface')?.getAttribute('data-mobile'),
    scrollW: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  check('T12 at 430x932 the phone layout still holds and nothing overflows',
    wide.mobile === 'true' && wide.scrollW <= wide.client + 1, JSON.stringify(wide));
  await bigPhone.screenshot({ path: join(SHOT_DIR, '05-430px.png') });
  console.log(`      shot: ${join(SHOT_DIR, '05-430px.png')}`);
} catch (err) {
  check('the run completed', false, String(err?.stack || err).slice(0, 600));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
