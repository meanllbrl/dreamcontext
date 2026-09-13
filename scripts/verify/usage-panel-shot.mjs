#!/usr/bin/env node
/**
 * The usage popover, photographed in the REAL app.
 *
 *   npm run build && node scripts/verify/usage-panel-shot.mjs
 *
 * A redesign that has only ever been seen in a CSS harness has not been seen. This boots the
 * actual dashboard server against an isolated HOME, opens a real chat, drives one turn
 * through a scripted `claude`, and photographs:
 *
 *   1. the whole composer card — the "did anything else move?" picture
 *   2. the usage popover, closed account picker
 *   3. the usage popover, account picker open
 *   4. the model+effort menu and 5. the mode menu — both share `.chat-cmp-modelrow` and
 *      `.chat-cmp-grouplabel` with the popover, so they are where a scoping mistake in the
 *      popover's skin would show up first
 *
 * SCRATCH HOME, ALWAYS. Registry, agent-ui.json, the project, the fake `claude` and the
 * seeded `~/.claude.json` live under an isolated HOME — nothing here reads or writes the
 * developer's real `~/.dreamcontext/` or `~/.claude*`, which hold real account identifiers
 * and spend history.
 *
 * Every fixture name is fictional, per the repo's published-artifact rule: these pictures are
 * meant to be pasted into a review.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-usage-panel-shot');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'lumen-loop');
const SHOTS = process.env.SHOTS_DIR || join(SCRATCH, 'shots');

// The stand-in reports a LARGE input_tokens on purpose: the bands are the thing being
// photographed, and a 10-token session lights none of them.
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = []; let busy = false, pumping = false;
async function runTurn() {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'shot-session', model: 'claude-opus-5',
        cwd: process.cwd(), permissionMode: 'acceptEdits', slash_commands: ['compact'] });
  await sleep(120);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reconciled the ledger.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1,
        total_cost_usd: 26.78, session_id: 'shot-session',
        usage: { input_tokens: 388000, output_tokens: 8000, cache_read_input_tokens: 0 } });
  busy = false; pump();
}
async function pump() { if (pumping || busy) return; const n = inbox.shift(); if (n === undefined) return;
  pumping = true; try { await runTurn(); } finally { pumping = false; } }
let buf = '';
process.stdin.on('data', (c) => { buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const t = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (t) { inbox.push(t); pump(); } } });
process.stdin.on('end', () => process.exit(0));
`;

const ACCOUNTS = [
  ['rk-builder', 'rk.builder.long.address@example.com', 'Personal', true, null],
  ['lumen-loop', 'rk@lumen-loop.example', 'Lumen Loop', false, 'lumen-loop'],
  ['driftwood', 'rk@driftwood.example', 'Driftwood Labs', false, 'driftwood'],
  ['paper-crane', 'rk@paper-crane.example', 'Paper Crane', false, 'paper-crane'],
];

function freePort() {
  return new Promise((res, rej) => { const s = createServer();
    s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', '1.soul.md'),
    '---\nname: lumen-loop\ntype: soul\n---\n\n## Project Identity\n\nA lighting controller: scenes, schedules and presence.\n');
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: 'opus', chatDefaultEffort: 'xhigh',
  }, null, 2)}\n`);

  // The two account-level caps the popover draws. Weekly deliberately sits past the tight
  // threshold so the caution tone is in the picture.
  writeFileSync(join(HOME, '.claude.json'), `${JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() - 60_000,
      utilization: {
        five_hour: { utilization: 22, resets_at: new Date(Date.now() + 3.57 * 3600_000).toISOString() },
        seven_day: { utilization: 94, resets_at: new Date(Date.now() + 71.57 * 3600_000).toISOString() },
      },
    },
  }, null, 2)}\n`);

  writeFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), `${JSON.stringify({
    autoSwitch: true,
    accounts: ACCOUNTS.map(([id, email, org, preferred, dir], i) => ({
      id, accountUuid: `0000-uuid-${i}`, email,
      organizationUuid: `0000-org-${i}`, organizationName: org,
      tier: 'max', configDir: dir ? join(HOME, '.dreamcontext', 'claude-accounts', dir) : null,
      preferred,
    })),
  }, null, 2)}\n`);
  for (const [, , , , dir] of ACCOUNTS) if (dir) mkdirSync(join(HOME, '.dreamcontext', 'claude-accounts', dir), { recursive: true });

  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN); chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'lumen-loop', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath,
    [join(REPO, 'dist', 'index.js'), 'dashboard', '--launcher', '--no-open', '-p', String(port)],
    { cwd: SCRATCH, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.log('   server: ' + t.slice(0, 200)); });
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill(); throw new Error('dashboard server did not come up');
}

const port = await freePort();
setupScratch();
const srv = await startServer(port);
const browser = await chromium.launch();
const domClick = (page, sel, text) => page.evaluate(([s, t]) => {
  const all = [...document.querySelectorAll(s)];
  const el = t ? all.find((x) => new RegExp(t, 'i').test(x.textContent || '')) : all[0];
  el?.click();
  return !!el;
}, [sel, text ?? null]);

const boxOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}, sel);

const shot = async (page, name, sel, pad = 6) => {
  const path = join(SHOTS, `${name}.png`);
  if (!sel) { await page.screenshot({ path }); console.log(`📸 ${name}.png`); return true; }
  const b = await boxOf(page, sel);
  if (!b) { console.log(`   (no ${sel} to photograph for ${name})`); return false; }
  await page.screenshot({ path, clip: {
    x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad),
    width: b.width + pad * 2, height: b.height + pad * 2,
  } });
  console.log(`📸 ${name}.png`);
  return true;
};
try {
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 880 }, deviceScaleFactor: 2, colorScheme: theme });
    ctx.setDefaultTimeout(9000);
    ctx.addInitScript(() => { try { window.localStorage.setItem('dreamcontext.launcher.view', 'space'); } catch { /* private */ } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('   console: ' + m.text().slice(0, 160)); });
    page.on('pageerror', (e) => console.log('   pageerror: ' + String(e).slice(0, 160)));
    await page.goto(`http://127.0.0.1:${port}/?vault=lumen-loop`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(180); }
    // The Agent screen's empty state offers Start chat / Start terminal; only the first one
    // mounts the composer this script is here to photograph.
    const start = page.locator('button:has-text("Start chat")').first();
    console.log(`   [${theme}] start-chat buttons: ${await start.count()}`);
    if (await start.count()) {
      // A real DOM click, not Playwright's: the empty state renders inside a container the
      // visibility heuristic refuses (it is painted, but an ancestor reports hidden), and the
      // point here is to reach the screen the user reaches, not to assert on the button.
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Start chat/i.test(x.textContent || ''));
        b?.click();
      });
      for (let t = 0; t < 30 && !(await page.locator('.chat-cmp').count()); t++) await page.waitForTimeout(400);
      console.log(`   [${theme}] .chat-cmp after start: ${await page.locator('.chat-cmp').count()}`);
    }
    if (!(await page.locator('.chat-cmp').count())) {
      for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ timeout: 2500 }).catch(() => {}); await page.waitForTimeout(900); }
        if (await page.locator('.chat-cmp').count()) break;
      }
    }
    // Starting a chat DOCKS it — the surface exists but is collapsed to a pill, which is why
    // `.chat-cmp` mounts with a zero box. Expanding it is what puts the composer on screen.
    for (let t = 0; t < 24; t++) {
      const b = await boxOf(page, '.chat-cmp');
      if (b) break;
      await page.evaluate(() => {
        const hit = [...document.querySelectorAll('button, [role="button"], .agent-dock-row, .agent-dock-item')]
          .find((x) => /READY|Chat\s*1/i.test(x.textContent || ''));
        hit?.click();
      });
      await page.waitForTimeout(450);
    }
    if (!(await page.locator('.chat-cmp').count())) {
      console.log(`   (${theme}: the chat composer never mounted — skipping this pass)`);
      await shot(page, `${theme}-0-window-no-composer`);
      await ctx.close();
      continue;
    }
    // React owns the textarea's value, so it is set through the native setter and told about
    // it — assigning `.value` directly would leave the component's state at ''.
    await page.evaluate(() => {
      const ta = document.querySelector('.chat-cmp textarea');
      if (!ta) return;
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, 'Reconcile the ledger');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await page.waitForTimeout(2600);
    await shot(page, `${theme}-1-composer`, '.chat-cmp');
    if (await domClick(page, '.chat-cmp-usagebtn')) {
      await page.waitForTimeout(600);
      await shot(page, `${theme}-2-panel`, '.chat-cmp-usagemenu', 10);
      if (await domClick(page, '.chat-cmp-acct.is-head')) {
        await page.waitForTimeout(400);
        await shot(page, `${theme}-3-accounts-open`, '.chat-cmp-usagemenu', 10);
      } else console.log(`   (no account dropdown in ${theme} — fewer than two accounts resolved)`);
      await domClick(page, '.chat-cmp-usagebtn'); await page.waitForTimeout(350);
    } else console.log(`   (no usage ring in ${theme} — the session reported no context)`);
    // The two menus that SHARE `.chat-cmp-modelrow` and `.chat-cmp-grouplabel` with the
    // popover — where a scoping mistake in the popover's skin would show up first.
    for (const [i, name] of [[0, 'mode'], [1, 'model']]) {
      const opened = await page.evaluate((n) => {
        const t = document.querySelectorAll('.chat-cmp-modeltrigger');
        if (!t[n]) return false;
        t[n].click();
        return true;
      }, i);
      if (!opened) continue;
      await page.waitForTimeout(500);
      await shot(page, `${theme}-4-${name}-menu`, '.chat-cmp-modelmenu', 10);
      await page.evaluate((n) => document.querySelectorAll('.chat-cmp-modeltrigger')[n]?.click(), i);
      await page.waitForTimeout(300);
    }
    await shot(page, `${theme}-5-window`);
    await ctx.close();
  }
} finally {
  await browser.close(); srv.kill();
  console.log(`\nshots → ${SHOTS}`);
}
