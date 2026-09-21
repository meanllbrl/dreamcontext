#!/usr/bin/env node
/**
 * Reopening the app must give you back the arrangement you left, and the permission mode you
 * chose.
 *
 *   npm run build && npm run verify:pane-layout-restore
 *
 * THE REPORT (owner, 2026-09-18): "sessionlar geri açılırken Placement'lar kayboluyor —
 * yan yana 5 pencere kapanıp açılıyor ve o durumda tüm chat'ler tek bir pencerede, sadece
 * biri görünür şekilde açılıyor." Five side-by-side panes came back as ONE pane holding
 * every chat, with one of them visible and the rest to be hunted for in a tab strip. Plus:
 * "auto→bypass modundaki seçimim hatırlanmalı" — the permission mode was back on `auto`
 * every launch.
 *
 * WHY BOTH LIVE IN ONE SCRIPT. They are the same defect with two faces: the desktop app picks
 * a FRESH loopback port every launch, so the origin is new and `localStorage` is empty, and
 * the only per-vault state that survives is what the server writes to
 * `_dream_context/state/.agent-sessions.json`. That file used to hold titles and nothing else
 * — the client's own comment said so ("the pane layout itself is not persisted — restored
 * tabs reopen in a single pane"). The layout and the remembered mode now ride in it.
 *
 * WHAT MAKES THE ASSERTIONS HONEST. Two independent channels, because either alone can lie:
 *   • the DOM — how many panes, which tabs in which one, which tab is in front, which pane
 *     has focus;
 *   • the WS upgrade URLs (an init script wraps `window.WebSocket`) — every restored tab's
 *     `bypass=0|1` next to its `resume=<uuid>`. A chip can render `auto` over a process
 *     spawned `--permission-mode bypassPermissions`; the URL cannot.
 * And then the FILE, read back off disk, because a build can restore correctly on screen and
 * still overwrite the roster a debounce later.
 *
 * THE FIXTURE IS ADVERSARIAL ON PURPOSE. The stored mode is `bypass` while one restored tab
 * was saved on `auto`. Under the old code every tab inherited the project default, so that
 * tab's `bypass=0` is exactly what proves a tab reopens under ITS OWN answer rather than the
 * vault's.
 *
 * Isolated fake HOME, a scratch project, synthesized transcripts, and `claude` replaced by a
 * stand-in on that HOME's PATH: restoring four tabs spawns four processes that are sent
 * nothing and spend no tokens. No verify script may touch the developer's real `~/.claude`.
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
const SCRATCH = join(tmpdir(), 'dc-ui-pane-layout-restore');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-pane-layout-restore');
const TRANSCRIPTS = join(HOME, '.claude', 'projects', PROJ.replace(/[^A-Za-z0-9]/g, '-'));
const ROSTER = join(PROJ, '_dream_context', 'state', '.agent-sessions.json');

/**
 * What the user had open when they closed the app: THREE panes, the middle one holding the
 * bypass session and the left one holding two tabs with the FIRST in front.
 *
 * `bypass` is deliberately mixed against a stored default of `bypass` (see the header).
 */
const TABS = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Plan the migration', pane: 0, active: true, bypass: false },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Scratch notes', pane: 0, active: false, bypass: false },
  { id: '33333333-3333-4333-8333-333333333333', title: 'Build the route', pane: 1, active: true, bypass: true },
  { id: '44444444-4444-4444-8444-444444444444', title: 'Watch the logs', pane: 2, active: true, bypass: false },
];
/** Which pane had focus. Deliberately NOT 0, so "it restored the first one" cannot pass. */
const ACTIVE_PANE = 1;

const STANDIN = `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

/** Captures every chat WS upgrade this page opens — the client's request, independent of
 *  anything the DOM claims about it. */
const WS_SPY = `
  window.__dcChatSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    try { if (String(url).includes('/api/agent/chat')) window.__dcChatSockets.push(String(url)); } catch {}
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
`;

const jsonl = (e) => e.map((x) => JSON.stringify(x)).join('\n') + '\n';

/** Enough of a transcript that `findTranscriptBySessionId` sees a conversation and the
 *  restore has something to `--resume`. The turns are not under test here. */
function transcript(id, text) {
  return jsonl([
    {
      type: 'user', isSidechain: false, uuid: `${id}-u0`, timestamp: '2026-09-18T09:00:00.000Z',
      cwd: PROJ, sessionId: id, gitBranch: 'main', version: '2.1.276',
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

  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);

  for (const t of TABS) writeFileSync(join(TRANSCRIPTS, `${t.id}.jsonl`), transcript(t.id, t.title));
  writeFileSync(ROSTER, JSON.stringify({
    chatPermissionMode: 'bypass',
    activePane: ACTIVE_PANE,
    sessions: TABS.map((t) => ({
      title: t.title, kind: 'chat', bypass: t.bypass, minimized: false, size: 1,
      sessionId: t.id, pane: t.pane, ...(t.active ? { active: true } : {}),
    })),
  }, null, 2) + '\n');

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

const report = { pass: 0, fails: [] };
const check = (label, ok, ev = '') => {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fails.push(label); console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
};

const readRosterFile = () => {
  try { return JSON.parse(readFileSync(ROSTER, 'utf-8')); } catch { return null; }
};

async function run(base) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
  await page.addInitScript(WS_SPY);
  page.on('pageerror', (e) => check(`no page error (${String(e).slice(0, 120)})`, false));

  const until = async (fn, ms = 25000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const sockets = () => page.evaluate(() => window.__dcChatSockets ?? []);
  /** Tab titles per pane, in pane order — each pane renders its own `.agent-pane-tabbar`. */
  const paneTabs = () => page.$$eval('.agent-overlay-tabs .agent-pane-tabbar',
    (bars) => bars.map((b) => [...b.querySelectorAll('.agent-tab .agent-tab-title')].map((t) => t.textContent.trim())));
  /** The tab in FRONT of each pane, in pane order ('' when a pane has none). */
  const paneActive = () => page.$$eval('.agent-overlay-tabs .agent-pane-tabbar',
    (bars) => bars.map((b) => b.querySelector('.agent-tab.active .agent-tab-title')?.textContent.trim() ?? ''));

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });

  // A fresh profile greets you with the release notes, and its scrim eats pointer events at
  // the window level — every later click then fails as a 30s timeout that reads like a broken
  // button rather than a covered one. It opens LATE (behind its own fetch), so retry.
  for (let i = 0; i < 6; i += 1) {
    if (!(await page.locator('.announcements-modal-scrim').count())) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  console.log('\n── §1 the arrangement comes back, not a single stack');
  const restored = await until(async () => (await paneTabs()).length >= 3);
  check('the three panes reopen as three panes', restored,
    `panes=${JSON.stringify(await paneTabs())}`);
  check('…and every tab lands in the pane it was left in',
    JSON.stringify(await paneTabs()) === JSON.stringify([
      ['Plan the migration', 'Scratch notes'], ['Build the route'], ['Watch the logs'],
    ]), JSON.stringify(await paneTabs()));
  check('…with the tab that was in FRONT still in front (not just the first one)',
    JSON.stringify(await paneActive()) === JSON.stringify([
      'Plan the migration', 'Build the route', 'Watch the logs',
    ]), JSON.stringify(await paneActive()));

  const focusedIndex = await page.$$eval('.agent-overlay-tabs .agent-pane-tabbar',
    (bars) => bars.findIndex((b) => b.classList.contains('active')));
  check(`…and the pane that had focus still has it (pane ${ACTIVE_PANE})`,
    focusedIndex === ACTIVE_PANE, `focused=${focusedIndex}`);

  check('each pane got its own mounted slot, so the panes are real and not a tab strip',
    (await page.locator('.agent-pane-slot[data-pane]').count()) === 3,
    `${await page.locator('.agent-pane-slot[data-pane]').count()} slot(s)`);

  await page.screenshot({ path: join(SHOTS, 'restored-panes.png') });

  console.log('\n── §2 each tab reopens under ITS OWN permission answer');
  // The stored default is `bypass`, so a tab that inherits it is indistinguishable from one
  // that remembered it — EXCEPT for "Watch the logs", saved on `auto`. That one is the whole
  // assertion: under the old code every restored tab took the project default.
  const resumeUrls = await until(async () => (await sockets()).length >= TABS.length)
    ? (await sockets()) : (await sockets());
  const urlFor = (id) => resumeUrls.find((u) => u.includes(`resume=${id}`)) ?? '';
  for (const t of TABS) {
    const u = urlFor(t.id);
    check(`"${t.title}" resumes with bypass=${t.bypass ? 1 : 0} — its own answer, not the project's`,
      !!u && u.includes(`bypass=${t.bypass ? '1' : '0'}`), u || `no upgrade found for ${t.id}`);
  }

  console.log('\n── §3 the remembered mode survived the relaunch');
  // localStorage is empty on this origin (a fresh port every launch is the whole point), so a
  // NEW chat opening under `bypass` can only have come from the roster file.
  const before = (await sockets()).length;
  // The restore runs with the overlay COLLAPSED — the panes are homed and their tab bars are
  // in the DOM (which is why §1 reads them with `$$eval`, not with a `:visible` locator), but
  // nothing is clickable until the surface is expanded. Expanding is not part of what is under
  // test; it is how you reach the control.
  // A collapsed surface shows the DOCK — one chip per live session — and a chip is what
  // reopens it. (`.agent-fab` is the empty-surface affordance; with four sessions restored the
  // dock is what is on screen.)
  // The release-notes modal opens LATE, behind its own fetch, and its scrim eats pointer
  // events at the window level — so it is re-dismissed here rather than only on load.
  for (let i = 0; i < 6; i += 1) {
    if (!(await page.locator('.announcements-modal-scrim').count())) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  for (let round = 0; round < 3; round += 1) {
    for (const sel of ['.agent-dock-chip', '.agent-fab', '.agent-overlay-head', '.agent-dock-anchor']) {
      if (await page.locator('.agent-surface.expanded').count()) break;
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
    }
    if (await page.locator('.agent-surface.expanded').count()) break;
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    await page.screenshot({ path: join(SHOTS, 'collapsed.png') });
  }
  check('the surface expands so its controls are reachable',
    (await page.locator('.agent-surface.expanded').count()) === 1);
  // The ＋ New button rather than its ⌘T shortcut: the chord is bound on the surface host with
  // a composer guard, so whether it fires depends on where focus happens to be — which is a
  // fact about this script's clicking, not about the restore under test.
  await page.locator('.agent-add-btn:visible').first().click({ timeout: 10000 }).catch(() => {});
  const opened = await until(async () => (await sockets()).length > before);
  const fresh = (await sockets()).slice(before);
  check('＋ New opens a new chat', opened, JSON.stringify(fresh));
  check('…and it spawns under the REMEMBERED bypass, with no localStorage to read it from',
    fresh.some((u) => u.includes('bypass=1') && !u.includes('resume=')),
    JSON.stringify(fresh.map((u) => u.slice(-110))));

  console.log('\n── §4 what lands back on disk is still the arrangement');
  // A build can restore correctly on screen and overwrite the roster a debounce later — that
  // is how a previous restore bug deleted every past chat. So the file is read back.
  const persisted = await until(async () => {
    const r = readRosterFile();
    return !!r && (r.sessions ?? []).length >= TABS.length + 1;
  }, 15000);
  const saved = readRosterFile();
  check('the roster was re-written with the new tab included, not trimmed back to it', persisted,
    JSON.stringify((saved?.sessions ?? []).map((m) => m.title)));
  check('…and it still carries the placement rather than flattening it',
    new Set((saved?.sessions ?? []).map((m) => m.pane)).size >= 3,
    JSON.stringify((saved?.sessions ?? []).map((m) => ({ t: m.title, pane: m.pane, active: m.active }))));
  check('…and the remembered permission mode',
    saved?.chatPermissionMode === 'bypass', JSON.stringify(saved?.chatPermissionMode));
  check('…and every tab still carries its own permission answer',
    (saved?.sessions ?? []).find((m) => m.title === 'Watch the logs')?.bypass === false,
    JSON.stringify((saved?.sessions ?? []).map((m) => ({ t: m.title, bypass: m.bypass }))));

  await browser.close();
}

const port = await freePort();
setup();
const server = await startServer(port);
try {
  await run(`http://127.0.0.1:${port}`);
} finally {
  server.kill();
}

console.log(`\n${report.fails.length ? '❌' : '✅'} ${report.pass} passed, ${report.fails.length} failed`);
for (const f of report.fails) console.log(`   ✗ ${f}`);
process.exit(report.fails.length ? 1 : 0);
