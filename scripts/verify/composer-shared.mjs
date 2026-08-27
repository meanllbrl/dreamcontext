#!/usr/bin/env node
/**
 * ONE COMPOSER, TWO SURFACES — the atomicity claim, proved and photographed.
 *
 *   npm run build && npm run verify:composer-shared
 *
 * The Meeting Room used to ship its own textarea-plus-Post box. The claim after the rebuild
 * is that it now mounts the SAME `Composer` component a project chat does, differing only in
 * the controls it has nothing behind. A claim about component identity is not something a
 * screenshot can settle on its own and not something a DOM count can make visible, so this
 * script does both, against ONE running server:
 *
 *   §1  DOM IDENTITY — walk every element inside `.chat-cmp` on each surface and compare the
 *       class-name SETS. The shared skeleton must match exactly; the only permitted
 *       difference is the two controls the room deliberately drops (mode+permission, attach).
 *       A second implementation that merely copied the class names would pass this — which is
 *       why §2 exists.
 *   §2  BEHAVIOUR IDENTITY — four things a hand-rolled box does NOT get for free, driven
 *       through the real keyboard in the ROOM: auto-grow past two lines, the drag handle,
 *       ↑ prompt-history recall, and the `@` picker completing on ⏎.
 *   §3  THE PICTURE — both composers cropped at the same width and stitched into one image
 *       (`shots/side-by-side.png`), so "is it the same composer?" is answerable by looking.
 *
 * SCRATCH HOME, ALWAYS: registry, agent-ui.json, the project and the fake `claude` live under
 * an isolated HOME. Nothing reads or writes the developer's real `~/.dreamcontext/` or
 * `~/.claude*`.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST: every check prints ✓/✗ with evidence and the run
 * continues. Exit 0 iff everything passed. Screenshots land in SHOTS either way.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-composer-shared');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-payments');
const SHOTS = process.env.COMPOSER_SHOTS_DIR || join(SCRATCH, 'shots');

/**
 * The chat stand-in, COPIED from `scripts/verify/chat-composer-ui.mjs` (minus its
 * plan-to-develop hand-off button, which this comparison has no use for).
 *
 * Copied rather than shared because a verify script is a self-contained fixture — the
 * convention every script in this directory follows, on the grounds that a shared fixture
 * makes one script's tightening silently change another's meaning. What it MUST be is a
 * faithful `--input-format stream-json` peer: it reads user frames off stdin and answers with
 * an init + assistant + result triple, and it acks control requests. A naive stand-in that
 * only printed an init frame leaves the session short of `open`, so the composer never mounts
 * and the comparison has nothing to compare. (That was the first cut of this script.)
 */
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — copied from chat-composer-ui.mjs. */
const fs = require('fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };

const PERM = flag('--permission-mode') || 'none';
// The mode brief is APPENDED to CHAT_SURFACE_BRIEFING in one file (see chat-modes.ts), so the
// heading is what identifies it. No heading = Basic, i.e. the surface briefing alone.
let MODE = 'none';
const briefPath = flag('--append-system-prompt-file');
if (briefPath) {
  try {
    const m = /^# Mode: (.+)$/m.exec(fs.readFileSync(briefPath, 'utf-8'));
    if (m) MODE = m[1].trim();
  } catch { /* no brief readable — MODE stays 'none' */ }
}
const FACTS = 'FACTS perm=' + PERM + ' mode=' + MODE;

async function runTurn(prompt) {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5',
        cwd: process.cwd(), permissionMode: PERM, slash_commands: ['compact'] });
  await sleep(120);
  out({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: FACTS },
  ] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1,
        total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  busy = false;
  // "DIE" makes the child exit for real, so the pane shows the Session-ended banner whose
  // Resume path §10 checks. stdin EOF is the graceful exit everywhere else.
  if (prompt.includes('DIE')) { await sleep(150); process.exit(0); }
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
    if (o.type === 'control_request') {
      const req = o.request || {};
      // Mirror the REAL CLI's asymmetry (2.1.220, measured through this very route — see the
      // \`setPermissionMode\` arm in src/server/routes/agent-chat.ts): a live switch INTO
      // \`bypassPermissions\` is REFUSED by a process that did not boot with
      // \`--dangerously-skip-permissions\`, while a switch back to \`auto\` lands. Acking
      // everything success — which this stand-in used to do — tested a path production never
      // takes and let a regression through in which Bypass was simply unreachable: the client
      // took its respawn fallback and the fallback re-adopted the mode being left. The
      // refusal is the interesting case, so it has to be the scripted one.
      if (req.subtype === 'set_permission_mode' && req.mode === 'bypassPermissions'
          && PERM !== 'bypassPermissions') {
        out({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id,
              error: 'Cannot set permission mode to bypassPermissions because the session was not '
                   + 'launched with --dangerously-skip-permissions' } });
        continue;
      }
      // Everything else acks success. \`set_permission_mode\` → \`auto\` MUST, because the
      // client only keeps \`session.bypass\` in lockstep on a successful ack, and B3's whole
      // argument is that \`cs.bypass\` is therefore the session's real current mode.
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
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', '1.soul.md'),
    '---\nname: acme-payments\ntype: soul\n---\n\n## Project Identity\n\nA payments backend: invoicing, ledgers and reconciliation.\n');
  // chatView TRUE so the project window opens the Chat surface (not the legacy terminal), and
  // a model/effort pinned so BOTH triggers have the same label to draw — the picture is about
  // the control, so an unpinned side would compare "Default" against "Opus".
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: 'opus', chatDefaultEffort: 'xhigh',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'acme-payments', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  // LAUNCHER mode: the meeting routes live in the launcher-mode server, and `?vault=` still
  // resolves a registered project, so one server serves both surfaces.
  const srv = spawn(process.execPath,
    [join(REPO, 'dist', 'index.js'), 'dashboard', '--launcher', '--no-open', '-p', String(port)], {
      cwd: SCRATCH,
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

/** Every class name used anywhere inside the composer card, as a sorted set. */
function composerClassesIn(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.chat-cmp');
    if (!root) return null;
    const out = new Set();
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const c of el.classList) if (c.startsWith('chat-cmp')) out.add(c);
    }
    return [...out].sort();
  });
}

async function run(chromium, base, report) {
  const ok = (label, cond, detail) => report.check(label, cond, detail);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  // A missing element must REPORT, not hang. Playwright's 30s default, multiplied by the
  // handful of actions that follow a surface failing to open, turned the first cut of this
  // script into a five-minute silence with no output at all — the failure policy in the header
  // is only honest if every action has a short leash.
  context.setDefaultTimeout(8000);
  await context.addInitScript(() => {
    try { window.localStorage.setItem('dreamcontext.launcher.view', 'space'); } catch { /* private mode */ }
  });

  const until = async (page, fn, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  /** Crop the composer card, padded, at a fixed width so the two crops stack honestly. */
  const cropComposer = async (page, name) => {
    const box = await page.locator('.chat-cmp:visible').first().boundingBox();
    if (!box) return null;
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path, clip: { x: box.x, y: box.y - 4, width: box.width, height: box.height + 8 } });
    report.note(`📸 ${name}.png`);
    return path;
  };

  // ── the PROJECT chat ───────────────────────────────────────────────────────────────
  console.log('\n── the project window');
  const chat = await context.newPage();
  await chat.goto(`${base}/?vault=acme-payments`, { waitUntil: 'domcontentloaded' });
  await chat.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) { await chat.keyboard.press('Escape'); await chat.waitForTimeout(200); }
  if (!(await chat.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = chat.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await chat.waitForTimeout(1200); }
      if (await chat.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await chat.locator('.chat-cmp-input:visible').count())) {
    await chat.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  ok('a project chat opens with the composer mounted',
    await until(chat, async () => (await chat.locator('.chat-cmp-input:visible').count()) > 0, 25000));
  await chat.waitForTimeout(1200);
  const chatClasses = await composerClassesIn(chat);
  const chatShot = await cropComposer(chat, '01-project-chat-composer');

  // ── the MEETING ROOM ──────────────────────────────────────────────────────────────
  console.log('\n── the meeting room window');
  const room = await context.newPage();
  await room.goto(`${base}/?meeting=1`, { waitUntil: 'domcontentloaded' });
  ok('the room opens with the composer mounted',
    await until(room, async () => (await room.locator('.chat-cmp-input:visible').count()) > 0, 25000));
  await room.waitForTimeout(1500);
  const roomClasses = await composerClassesIn(room);
  const roomShot = await cropComposer(room, '02-meeting-room-composer');

  // ── §1 DOM identity ───────────────────────────────────────────────────────────────
  console.log('\n── §1 the same component, not a look-alike');
  ok('both surfaces render a `.chat-cmp` card', !!chatClasses && !!roomClasses);
  if (chatClasses && roomClasses) {
    // The three controls the room drops, with the classes each takes with it. Anything else
    // missing on either side means the two surfaces are NOT rendering one component.
    const DROPPED = {
      'mode + permission trigger': ['chat-cmp-perm-wrap'],
      'attach (+)': ['chat-cmp-iconbtn'],
    };
    const droppedAll = Object.values(DROPPED).flat();
    const onlyInChat = chatClasses.filter((c) => !roomClasses.includes(c));
    const onlyInRoom = roomClasses.filter((c) => !chatClasses.includes(c));
    const shared = chatClasses.filter((c) => roomClasses.includes(c));

    ok(`the shared skeleton is substantial, not incidental (${shared.length} classes)`,
      shared.length >= 12, shared.join(' '));
    ok('the room invents NOTHING of its own inside the composer',
      onlyInRoom.length === 0, onlyInRoom.join(' ') || '(none)');
    ok('every difference is a control the room deliberately drops',
      onlyInChat.every((c) => droppedAll.includes(c)), `only-in-chat: ${onlyInChat.join(' ') || '(none)'}`);
    for (const [what, classes] of Object.entries(DROPPED)) {
      ok(`…${what} is absent in the room, present in the chat`,
        classes.every((c) => chatClasses.includes(c) && !roomClasses.includes(c)),
        classes.join(' '));
    }
    // The one control the room KEEPS, because model+effort is its whole point.
    ok('the model+effort trigger is present on BOTH',
      chatClasses.includes('chat-cmp-model-wrap') && roomClasses.includes('chat-cmp-model-wrap'));
    ok('…and reads the same app-global pick on both',
      (await chat.locator('.chat-cmp-model-wrap:visible').first().innerText()).replace(/\s+/g, ' ').trim()
      === (await room.locator('.chat-cmp-model-wrap:visible').first().innerText()).replace(/\s+/g, ' ').trim(),
      `chat="${(await chat.locator('.chat-cmp-model-wrap:visible').first().innerText()).replace(/\s+/g, ' ').trim()}" room="${(await room.locator('.chat-cmp-model-wrap:visible').first().innerText()).replace(/\s+/g, ' ').trim()}"`);
  }

  // ── §2 behaviour identity ─────────────────────────────────────────────────────────
  // Four things the room's old textarea did NOT do. They are not asserted on the chat side:
  // they are the chat's own long-tested behaviour, and the point is that the ROOM has them
  // now without a line of its own code.
  console.log('\n── §2 the behaviour a hand-rolled box would not have');
  const input = room.locator('.chat-cmp-input:visible').first();
  const bodyH = async () => (await room.locator('.chat-cmp-body:visible').first().boundingBox())?.height ?? 0;

  await input.click();
  const restH = await bodyH();
  await input.fill('one\ntwo\nthree\nfour\nfive');
  await room.waitForTimeout(400);
  const grownH = await bodyH();
  ok('the box AUTO-GROWS with the draft', grownH > restH + 10, `${Math.round(restH)}px → ${Math.round(grownH)}px`);

  ok('…and carries the chat\'s drag handle', (await room.locator('.chat-cmp-handle:visible').count()) === 1);

  // Prompt history: post once, then ↑ in an empty box must recall it.
  await input.fill('history probe one');
  await room.keyboard.press('Enter');
  ok('the post landed', await until(room, async () =>
    (await room.locator('.meeting-feed:visible').first().innerText()).includes('history probe one'), 20000));
  await input.click();
  await room.keyboard.press('ArrowUp');
  await room.waitForTimeout(250);
  ok('↑ walks this room\'s OWN prompt history',
    (await input.inputValue()) === 'history probe one', JSON.stringify(await input.inputValue()));
  await input.fill('');

  // The `@` picker, fed by the room's roster rather than a vault's peers.
  await input.click();
  await room.keyboard.type('@acme');
  ok('typing @ opens the chat\'s picker',
    await until(room, async () => (await room.locator('.chat-cmp-mention:visible').count()) === 1, 6000));
  await room.keyboard.press('Enter');
  ok('…and ⏎ completes the registered project name',
    (await input.inputValue()) === '@acme-payments ', JSON.stringify(await input.inputValue()));
  await input.fill('');
  await room.waitForTimeout(300);
  await cropComposer(room, '03-meeting-room-composer-mention');

  // ── §3 the picture ────────────────────────────────────────────────────────────────
  console.log('\n── §3 the side-by-side');
  if (chatShot && roomShot) {
    // Stitched in a throwaway page rather than with an image library, and the two PNGs go in
    // as base64 DATA URIs — not `file://` srcs, which a `setContent` page (origin
    // `about:blank`) is not allowed to load and which silently rendered two broken-image icons
    // the first time this ran. Labels are drawn in the page so the picture is self-describing.
    const dataUri = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
    const stitch = await context.newPage();
    await stitch.setViewportSize({ width: 900, height: 520 });
    await stitch.setContent(`
      <style>
        :root { color-scheme: dark; }
        body { margin: 0; background: #0f1117; font: 13px -apple-system, system-ui, sans-serif; color: #e6e8ef; }
        .wrap { padding: 20px 22px 24px; }
        h1 { font-size: 15px; margin: 0 0 2px; }
        p { margin: 0 0 18px; color: #9aa1b1; font-size: 12px; }
        .row { display: flex; flex-direction: column; gap: 18px; }
        .lab { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
        .lab b { font-size: 12px; }
        .lab span { color: #9aa1b1; font-size: 11px; }
        img { display: block; width: 100%; border: 1px solid #262a36; border-radius: 10px; }
      </style>
      <div class="wrap">
        <h1>One <code>Composer</code>, two surfaces</h1>
        <p>Same component, same build, same running server. The room drops the two controls it has nothing behind.</p>
        <div class="row">
          <div>
            <div class="lab"><b>Project chat</b><span>— mode+permission · attach · model+effort</span></div>
            <img src="${dataUri(chatShot)}">
          </div>
          <div>
            <div class="lab"><b>Meeting Room</b><span>— no mode (no session to brief) · no attach (no project) · same model+effort</span></div>
            <img src="${dataUri(roomShot)}">
          </div>
        </div>
      </div>
    `);
    await stitch.waitForTimeout(600);
    const el = stitch.locator('.wrap');
    const box = await el.boundingBox();
    await stitch.setViewportSize({ width: 900, height: Math.ceil((box?.height ?? 500) + 8) });
    await stitch.waitForTimeout(300);
    await stitch.screenshot({ path: join(SHOTS, 'side-by-side.png'), fullPage: true });
    report.note('📸 side-by-side.png');
    // A picture of two broken-image icons is not a picture of two composers. `naturalWidth`
    // is 0 for an <img> that failed to decode, which is exactly what the first cut produced.
    const drawn = await stitch.evaluate(() =>
      [...document.querySelectorAll('img')].map((i) => i.naturalWidth));
    ok('…and both composers actually DREW in it',
      drawn.length === 2 && drawn.every((w) => w > 200), `naturalWidth=[${drawn.join(', ')}]`);
    await stitch.close();
  } else {
    ok('the side-by-side picture was produced', false, 'one of the crops is missing');
  }

  await browser.close();
}

function makeReport() {
  const failures = [];
  let passed = 0;
  return {
    check(label, cond, detail) {
      if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
      else { failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
    },
    note(msg) { console.log(`    ${msg}`); },
    finish() {
      console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed`);
      console.log(`  screenshots: ${SHOTS}`);
      if (failures.length) { for (const f of failures) console.log(`   - ${f}`); }
      return failures.length === 0 ? 0 : 1;
    },
  };
}

async function main() {
  const { chromium } = await import('playwright');
  console.log('── setup');
  setupScratch();
  const port = await freePort();
  const srv = await startServer(port);
  console.log(`  server on ${port}, scratch ${SCRATCH}`);
  const report = makeReport();
  try {
    await run(chromium, `http://127.0.0.1:${port}`, report);
  } catch (err) {
    console.log(`\n✗ threw: ${err && err.stack ? err.stack : String(err)}`);
    report.check('the run completed without throwing', false, String(err).slice(0, 200));
  } finally {
    srv.kill();
  }
  process.exit(report.finish());
}

main();
