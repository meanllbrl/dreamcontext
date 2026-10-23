#!/usr/bin/env node
/**
 * Hands-free PHONE: every picture the agent shows appears, and a gallery photo reaches the agent
 * (task hands-free-phone-shows-every-picture-the-agent-shows-and-sends-gallery-photos-to-the-agent).
 *
 *   npm run build && node scripts/verify/handsfree-phone-photo.mjs
 *
 * WHAT IT DRIVES — the real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1, the power
 * runner that only LOGS) with Mac mode started over the loopback stand-in for cloudflared
 * (DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL=1: the address IS the phone listener, so every phone request
 * goes through its route policy and every socket it opens is a phone socket). Two browsers:
 *   • the Mac's window (1440x900) on the main listener: it hands the chat over to the Super Agent,
 *     so it HOLDS the super socket, exactly as the desktop app does;
 *   • the phone (iPhone 13 at 390x844, then 375x667) signed in with the one-time QR link: it
 *     opens the Super Agent's chat as a MIRROR.
 * The `claude` is a stand-in: as the Super Agent it opens a stage picture on hand-over, answers
 * "show pictures" with a reply naming pictures in four places, opens two more stage pictures on
 * request, and echoes anything else.
 *
 *   1. Pictures in a reply: a worktree of the project's linked repo renders inline; tapping it
 *      opens it full size. A /tmp picture shows "Show"; one tap renders it. A backticked /tmp path
 *      opens the lightbox, which offers "Show" too. A picture inside a project NOT chosen at start
 *      is a card with no button. No "Open ↗" anywhere on the phone.
 *   2. Stage pictures: the picture on the Mac's stage when the phone joined, and two the Super opens
 *      while it watches, appear as strips.
 *   3. Photos: the phone's composer has a photo button and no "+"; a JPEG and a PNG picked from the
 *      "gallery" become chips, upload as JPEGs into the project's gitignored tmp, show in the
 *      owner's bubble, reach the agent as paths — and show in the SAME bubble on the Mac (AC10).
 *   4. The Mac's composer still has its "+" (1440 screenshot).
 *   Across the run: no console error on the phone; no 400; every 403 is one of the phone's own
 *   deliberate answers (needs_phone_grant, other_project).
 *
 * FAILURE POLICY — collect, don't fail fast; exit 0 iff every check passed.
 * Screenshots: tmp/verify-handsfree-phone-photo/*.png (read them).
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), `dreamcontext-verify-handsfree-phone-photo-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CODE = join(SCRATCH, 'pocket-ledger-app');
const WT = join(HOME, '.claude-worktrees', 'pocket-ledger-app-share-sheet');
const OTHER = join(SCRATCH, 'garden-planner');
const ELSEWHERE = join(SCRATCH, 'loose');
const UPLOADS = join(SCRATCH, 'gallery');
const POWER_LOG = join(SCRATCH, 'power.log');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-phone-photo');
const CLI = join(REPO, 'dist', 'index.js');

const PICS = {
  worktree: join(WT, 'tmp', 'share-sheet-390.png'),
  free: join(ELSEWHERE, 'ledger-export.png'),
  tick: join(ELSEWHERE, 'ledger-import.png'),
  other: join(OTHER, 'tmp', 'beds.png'),
  stageA: 'tmp/stage-before.png',
  stageB: 'tmp/stage-after-phone.png',
  stageC: 'tmp/stage-after-desktop.png',
};

/** The Super Agent stand-in: it reads the brief to know its role, runs the real CLI for stage verbs. */
const STANDIN = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
let brief = ''; try { brief = fs.readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const cli = (...args) => spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
const P = ${JSON.stringify(PICS)};
function answer(text) {
  if (role !== 'super') return 'CHILD ok';
  if (text.startsWith('[super handover]')) { cli('super', 'open', 'image', P.stageA, '--title', 'Before'); return 'Handed over.'; }
  if (text === 'show pictures') {
    return [
      'The share sheet, from the child worktree:', '', '![Share sheet at 390](' + P.worktree + ')', '',
      'The export screen lives in a loose folder:', '', '![Ledger export](' + P.free + ')', '',
      // Relative, as the briefing asks: a backticked ABSOLUTE path is not a chip (looksLikePath).
      'And the import screen: \`../loose/ledger-import.png\`', '',
      'This one belongs to another project:', '', '![Beds](' + P.other + ')',
    ].join('\\n');
  }
  if (text === 'open the stage pictures') { cli('super', 'open', 'image', P.stageB, P.stageC, '--titles', 'After: phone|After: desktop'); return 'Opened two pictures on the stage.'; }
  return 'ECHO ' + text;
}
let inited = false; let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const text = (typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n')).trim();
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    let said; try { said = answer(text); } catch (e) { said = 'error ' + e; }
    const message = { role: 'assistant', content: [{ type: 'text', text: said }] };
    row({ type: 'assistant', message }); out({ type: 'assistant', message });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
    return !!cond;
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: 'utf-8' });
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=v@v', '-c', 'user.name=v', ...args], { cwd, encoding: 'utf-8' });

/** A real picture (a labelled colour card), drawn by Chromium so every one decodes. */
async function drawPicture(browser, label, colour, type = 'png', size = { width: 780, height: 520 }) {
  const page = await browser.newPage({ viewport: size });
  await page.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${colour};font:600 44px -apple-system,Helvetica,sans-serif;color:#fff">${label}</body>`);
  const buf = await page.screenshot({ type, ...(type === 'jpeg' ? { quality: 92 } : {}) });
  await page.close();
  return buf;
}

async function setupScratch(browser) {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), PROJ, join(PROJ, 'tmp'), CODE, OTHER, join(OTHER, 'tmp'), ELSEWHERE, UPLOADS, SHOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  // The chosen project (the brain) and its linked code repo with a child worktree.
  git(PROJ, 'init', '-q');
  let r = cli(['init', '-y', '--name', 'pocket-ledger', '--description', 'A fictional ledger app for the hands-free photo check']);
  if (r.status !== 0) throw new Error(`init: ${r.stderr || r.stdout}`);
  r = cli(['vaults', 'add', 'pocket-ledger', PROJ]);
  if (r.status !== 0) throw new Error(`vaults add: ${r.stderr || r.stdout}`);
  git(CODE, 'init', '-q');
  git(CODE, 'remote', 'add', 'origin', 'https://github.com/acme/pocket-ledger-app.git');
  git(CODE, 'commit', '-q', '--allow-empty', '-m', 'init');
  r = git(CODE, 'worktree', 'add', '-q', '--detach', WT);
  if (r.status !== 0) throw new Error(`worktree add: ${r.stderr}`);
  r = cli(['link', 'add', 'pocket-ledger-app', CODE, '--url', 'acme/pocket-ledger-app']);
  if (r.status !== 0) throw new Error(`link add: ${r.stderr || r.stdout}`);

  // A project the owner will NOT choose at start.
  git(OTHER, 'init', '-q');
  r = cli(['init', '-y', '--name', 'garden-planner', '--description', 'A fictional garden planner'], OTHER);
  if (r.status !== 0) throw new Error(`init other: ${r.stderr || r.stdout}`);
  r = cli(['vaults', 'add', 'garden-planner', OTHER]);
  if (r.status !== 0) throw new Error(`vaults add other: ${r.stderr || r.stdout}`);

  mkdirSync(join(WT, 'tmp'), { recursive: true });
  writeFileSync(PICS.worktree, await drawPicture(browser, 'Share sheet · worktree', '#4f46e5'));
  writeFileSync(PICS.free, await drawPicture(browser, 'Ledger export · /tmp', '#0f766e'));
  writeFileSync(PICS.tick, await drawPicture(browser, 'Ledger import · /tmp', '#b45309'));
  writeFileSync(PICS.other, await drawPicture(browser, 'Garden beds · other project', '#be123c'));
  writeFileSync(join(PROJ, PICS.stageA), await drawPicture(browser, 'Before', '#334155'));
  writeFileSync(join(PROJ, PICS.stageB), await drawPicture(browser, 'After: phone', '#7c3aed'));
  writeFileSync(join(PROJ, PICS.stageC), await drawPicture(browser, 'After: desktop', '#2563eb'));
  // The "gallery": a big JPEG (a camera photo stands in) and a PNG screenshot.
  writeFileSync(join(UPLOADS, 'IMG_0042.jpg'), await drawPicture(browser, 'Camera photo', '#15803d', 'jpeg', { width: 2000, height: 3000 }));
  writeFileSync(join(UPLOADS, 'Screenshot.png'), await drawPicture(browser, 'Phone screenshot', '#9333ea', 'png', { width: 390, height: 844 }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...env(), PATH, DREAMCONTEXT_MAC_VERIFY_POWER_LOG: POWER_LOG, DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'X-Dreamcontext-Vault': 'pocket-ledger', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** The desktop's Chat surface, as super-image-group.mjs opens it. */
async function openChat(page, base) {
  await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

/** Every <img> under `scope` whose src names `needle`, and whether each has decoded pixels. */
const imgs = (page, scope, needle) => page.evaluate(([s, n]) => [...document.querySelectorAll(`${s} img`)]
  .filter((i) => i.getBoundingClientRect().height > 0 && decodeURIComponent(i.getAttribute('src') || '').includes(n))
  .map((i) => ({ w: i.naturalWidth, ok: i.complete && i.naturalWidth > 0 })), [scope, needle]);
const loaded = async (page, scope, needle, n = 1) => { const l = await imgs(page, scope, needle); return l.filter((x) => x.ok).length >= n; };

let server = null;
let browser = null;
try {
  const { chromium, devices } = await import('@playwright/test');
  browser = await chromium.launch();
  console.log('· scratch projects, pictures, server, Mac mode over the loopback stand-in…');
  await setupScratch(browser);
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;

  // ── The Mac's window: a chat handed over to the Super Agent ──
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await markAnnouncementsSeen(deskCtx, base);
  const desk = await deskCtx.newPage();
  const deskErrors = [];
  desk.on('pageerror', (e) => deskErrors.push(String(e).slice(0, 200)));
  await openChat(desk, base);
  if (!(await desk.locator('.chat-cmp-input:visible').count())) await desk.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  report.check('the Mac opens a chat', await until(async () => (await desk.locator('.chat-cmp-input:visible').count()) > 0, 25000));
  report.check('the Mac\'s composer keeps its "+" (Attach) and has no photo button', await until(async () =>
    (await desk.locator('[aria-label="Attach"]:visible').count()) > 0 && (await desk.locator('[data-testid="phone-photo-button"]').count()) === 0, 10000));
  await desk.screenshot({ path: join(SHOTS, '1440-mac-composer.png') });
  await sleep(1500);
  await desk.locator('[data-testid="super-handover-btn"]:visible').first().click();
  report.check('the Mac hands the chat over: the Super surface shows', await until(async () => (await desk.locator('[data-testid="super-surface"]:visible').count()) > 0, 25000));
  const superRecord = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return {}; } };
  report.check('the Super Agent opened a picture on the Mac\'s stage at hand-over', await until(() => (superRecord().containers ?? []).some((k) => k.ref === PICS.stageA), 40000), JSON.stringify(superRecord().containers ?? []).slice(0, 300));

  // ── Mac mode and the phone ──
  const setup = await api(port, 'POST', '/api/handsfree/mac/setup', {});
  report.check('Mac mode is set up', setup.status === 200, JSON.stringify(setup.json).slice(0, 160));
  const started = await api(port, 'POST', '/api/handsfree/mac/start', { vaults: ['pocket-ledger'] });
  report.check('Mac mode starts for ONE chosen project (garden-planner is not chosen)', started.status === 200 && JSON.stringify(started.json.exposedVaults) === '["pocket-ledger"]', JSON.stringify(started.json).slice(0, 200));
  const qr = (await api(port, 'POST', '/api/handsfree/mac/qr')).json.url;
  report.check('a one-time sign-in link on the phone listener', typeof qr === 'string' && !qr.includes(`:${port}/`), qr);

  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  await markAnnouncementsSeen(phoneCtx, base);
  const phone = await phoneCtx.newPage();
  const errors = []; const refused = []; const bad = [];
  // "Failed to load resource" lines are the network's echo; the network itself is asserted below.
  phone.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  const notFound = [];
  phone.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  phone.on('response', async (r) => {
    const what = `${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`;
    if (r.status() === 400) bad.push(what);
    if (r.status() === 404) notFound.push(decodeURIComponent(r.url().replace(/^https?:\/\/[^/]+/, '')));
    if (r.status() === 403) {
      const body = await r.json().catch(() => ({}));
      if (!['needs_phone_grant', 'other_project'].includes(body?.error)) refused.push(`${what} ${body?.error ?? ''}`);
    }
  });
  const trace = [];
  phone.on('response', (r) => { const u = r.url(); if (/phone-grant|ledger-export/.test(decodeURIComponent(u))) trace.push(`${r.request().method()} ${r.status()} ${decodeURIComponent(u).replace(/^https?:\/\/[^/]+/, '').slice(0, 90)}`); });
  const vis = (sel) => phone.locator(`${sel}:visible`);
  await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  report.check('the phone signs in through the phone listener', await until(async () => phone.url().includes('vault=pocket-ledger'), 25000), phone.url());
  for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
  report.check('the phone lists the Super Agent', await until(async () => (await vis('[data-testid="super-row"]').count()) === 1, 25000));
  await vis('[data-testid="super-row"]').click();
  report.check('the Super Agent\'s chat opens on the phone', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 15000));

  console.log('\n── 2a. The stage as the phone joined');
  report.check('the picture on the Mac\'s stage arrives as a strip, and draws', await until(async () =>
    (await vis('[data-testid="stage-media-strip"]').count()) >= 1 && loaded(phone, '[data-testid="stage-media-strip"]', PICS.stageA), 15000));

  const send = async (text) => {
    const box = vis('.chat-cmp-input').first();
    await box.click();
    await box.fill(text);
    await phone.waitForTimeout(150);
    await phone.keyboard.press('Enter');
  };
  const pane = '.chat-pane';

  console.log('\n── 1. Pictures in a reply');
  await send('show pictures');
  report.check('the worktree picture renders inline, without asking', await until(() => loaded(phone, pane, PICS.worktree), 20000), JSON.stringify(await imgs(phone, pane, PICS.worktree)));
  const cards = () => phone.evaluate(() => [...document.querySelectorAll('.chat-pane .chat-md-blocked')].filter((c) => c.getBoundingClientRect().height > 0).map((c) => ({
    name: c.querySelector('.chat-md-blocked-name')?.textContent ?? '',
    note: c.querySelector('.chat-md-blocked-note')?.textContent ?? '',
    show: !!c.querySelector('.chat-md-blocked-allow'),
    open: !!c.querySelector('.chat-md-blocked-open'),
  })));
  let cs = [];
  report.check('the /tmp picture is a card with "Show"', await until(async () => { cs = await cards(); return cs.some((c) => c.name.includes('ledger-export.png') && c.show); }, 20000), JSON.stringify(cs));
  report.check('the other project\'s picture is a card with no button', cs.some((c) => c.name.includes('beds.png') && !c.show && !c.open), JSON.stringify(cs));
  report.check('no card on the phone offers "Open ↗"', cs.every((c) => !c.open), JSON.stringify(cs));
  report.check('the other project\'s picture never draws', (await imgs(phone, pane, PICS.other)).every((x) => !x.ok));
  await phone.screenshot({ path: join(SHOTS, '390x844-reply-cards.png') });
  // The real moment: the composer still holds focus after sending, so the tap also reflows the
  // transcript (the button moves before the synthesized click arrives) — the button must act anyway.
  report.check('the tap comes while the composer still has focus (the case that moves the button)', await phone.evaluate(() => document.activeElement?.classList.contains('chat-cmp-input')));
  await phone.locator('.chat-pane .chat-md-blocked:visible').filter({ hasText: 'ledger-export.png' }).locator('.chat-md-blocked-allow').tap();
  report.check('one tap on "Show" draws the /tmp picture', await until(() => loaded(phone, pane, PICS.free), 15000), `${JSON.stringify(await imgs(phone, pane, PICS.free))} ${JSON.stringify(await cards())} ${trace.join(' | ')}`);
  await phone.screenshot({ path: join(SHOTS, '390x844-reply-pictures.png') });

  const firstImg = phone.locator('.chat-pane img.chat-md-media:visible').first();
  await firstImg.tap();
  report.check('tapping a picture opens it full size', await until(async () => {
    const v = await phone.evaluate(() => { const i = document.querySelector('.image-viewer-img'); return i ? i.naturalWidth : 0; });
    return v > 0;
  }, 10000));
  report.check('the full-size view has no laptop-only file buttons', (await phone.locator('.image-viewer-actions').count()) === 0);
  await phone.screenshot({ path: join(SHOTS, '390x844-lightbox.png') });
  await phone.keyboard.press('Escape');
  await phone.locator('.image-viewer').waitFor({ state: 'detached', timeout: 5000 }).catch(async () => { await phone.locator('.image-viewer button[aria-label*="Close" i]').first().click().catch(() => {}); });

  await phone.locator('.chat-pane code.chat-md-path:visible').filter({ hasText: 'ledger-import.png' }).first().tap();
  report.check('a backticked /tmp path opens the full-size view, which offers "Show"', await until(async () => (await phone.locator('.image-viewer .chat-btn').filter({ hasText: /^(Show|Göster)$/ }).count()) > 0, 10000));
  await phone.locator('.image-viewer .chat-btn').filter({ hasText: /^(Show|Göster)$/ }).first().tap();
  report.check('…and one tap draws it there', await until(async () => phone.evaluate(() => (document.querySelector('.image-viewer-img')?.naturalWidth ?? 0) > 0), 10000));
  await phone.screenshot({ path: join(SHOTS, '390x844-lightbox-show.png') });
  await phone.keyboard.press('Escape');
  await phone.locator('.image-viewer').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

  console.log('\n── 2b. Stage pictures opened while the phone watches');
  await send('open the stage pictures');
  report.check('two new stage pictures arrive as a strip and draw', await until(async () =>
    (await loaded(phone, '[data-testid="stage-media-strip"]', PICS.stageB)) && (await loaded(phone, '[data-testid="stage-media-strip"]', PICS.stageC)), 20000));
  await phone.screenshot({ path: join(SHOTS, '390x844-stage-strip.png') });

  console.log('\n── 3. Photos from the phone');
  report.check('the phone\'s composer has a photo button and no "+"', (await vis('[data-testid="phone-photo-button"]').count()) === 1 && (await vis('[aria-label="Attach"]').count()) === 0);
  await phone.locator('[data-testid="phone-photo-input"]').setInputFiles([join(UPLOADS, 'IMG_0042.jpg'), join(UPLOADS, 'Screenshot.png')]);
  report.check('two photo chips appear with a count line', await until(async () => (await vis('.chat-cmp-attachment-image').count()) === 2 && /2/.test(await vis('[data-testid="phone-photo-meta"]').first().innerText().catch(() => '')), 10000));
  await phone.screenshot({ path: join(SHOTS, '390x844-photo-chips.png') });
  report.check('both photos finish uploading', await until(async () => (await phone.locator('.chat-cmp-attachment-image[data-state="ready"]').count()) === 2, 20000),
    JSON.stringify(await phone.locator('.chat-cmp-attachment-image').evaluateAll((e) => e.map((x) => x.getAttribute('data-state')))));
  const drops = () => { try { return readdirSync(join(PROJ, '_dream_context', 'tmp', 'agent-drops')).filter((n) => n.startsWith('phone-')); } catch { return []; } };
  const dropped = drops();
  report.check('the Mac saved them as JPEGs (the PNG re-encoded too), server-named, in the project\'s tmp', dropped.length === 2 && dropped.every((n) => /^phone-\d+-[0-9a-f]{8}\.jpg$/.test(n)
    && readFileSync(join(PROJ, '_dream_context', 'tmp', 'agent-drops', n)).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))), JSON.stringify(dropped));
  const bigOne = dropped.map((n) => readFileSync(join(PROJ, '_dream_context', 'tmp', 'agent-drops', n))).find((b) => b.length > 0);
  report.check('the photos are small enough for mobile data (each under 1.5 MB)', dropped.every((n) => readFileSync(join(PROJ, '_dream_context', 'tmp', 'agent-drops', n)).length < 1.5 * 1024 * 1024), String(bigOne?.length));
  report.check('the tmp folder is gitignored', readFileSync(join(PROJ, '_dream_context', 'tmp', '.gitignore'), 'utf-8') === '*\n');
  await send('this row looks cut off on the phone');
  report.check('the agent receives the photos as paths in the message', await until(async () => {
    const t = (await vis(pane).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    return /ECHO this row looks cut off on the phone .*phone-\d+-[0-9a-f]{8}\.jpg.*phone-\d+-[0-9a-f]{8}\.jpg/.test(t);
  }, 20000));
  report.check('the owner\'s bubble on the phone shows both photos', await until(() => loaded(phone, '.chat-msg-user-media', '/phone-', 2), 15000), JSON.stringify(await imgs(phone, '.chat-msg-user-media', '/phone-')));
  await phone.screenshot({ path: join(SHOTS, '390x844-photo-sent.png') });
  report.check('AC10: the Mac shows the same bubble with both photos', await until(() => loaded(desk, '.chat-msg-user-media', '/phone-', 2), 20000), JSON.stringify(await imgs(desk, '.chat-msg-user-media', '/phone-')));
  await desk.screenshot({ path: join(SHOTS, '1440-mac-same-bubble.png') });

  console.log('\n── The second width');
  await phone.setViewportSize({ width: 375, height: 667 });
  await phone.waitForTimeout(600);
  report.check('at 375x667 nothing runs off the side', !(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await phone.screenshot({ path: join(SHOTS, '375x667-chat.png') });
  await phone.locator('[data-testid="phone-photo-input"]').setInputFiles([join(UPLOADS, 'Screenshot.png')]);
  await until(async () => (await phone.locator('.chat-cmp-attachment-image[data-state="ready"]').count()) === 1, 15000);
  await phone.screenshot({ path: join(SHOTS, '375x667-photo-chip.png') });

  report.check('no console error on the phone', errors.length === 0, errors.slice(0, 5).join(' | '));
  report.check('no 400 on any request the phone made', bad.length === 0, bad.slice(0, 8).join(' | '));
  // Pre-existing, on the Mac too: markdown's <img src="/abs/path.png"> is fetched by the engine
  // before the chat swaps it for the file route. Never an /api request.
  report.check('every 404 is a raw markdown picture src, never an API call', notFound.every((u) => !u.startsWith('/api/') && /\.(png|jpe?g|gif|webp)$/.test(u)), notFound.slice(0, 6).join(' | '));
  report.check('every 403 the phone saw was one of its own deliberate answers', refused.length === 0, refused.slice(0, 8).join(' | '));
  report.check('no page error on the Mac', deskErrors.length === 0, deskErrors.slice(0, 5).join(' | '));
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 800));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  // The scratch tree (projects, a worktree, pictures) never outlives the run; screenshots stay.
  if (existsSync(SCRATCH) && !process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(report.fails.length ? 1 : 0);
