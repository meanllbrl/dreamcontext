#!/usr/bin/env node
/**
 * MEETING ROOM — the hidden launcher surface where all agents convene, end to end.
 *
 *   npm run build && npm run verify:meeting-room
 *
 * Proves, in the real app against the real launcher-mode server, the claims the feature
 * rests on:
 *
 *   §1  the space-core LOGO click opens the room in ITS OWN window/tab (geometry-asserted on
 *       the new page, not presence) — the launcher stays put, + Add Project still in the bar,
 *       and the room mounts the REAL chat composer: model+effort trigger present, mode and
 *       attach controls absent (no session to brief, no project to attach into)
 *   §2  one announcement fans out to ALL 3 scratch vaults; each reply carries the cwd of
 *       ITS OWN project directory — the run happened THERE, not here
 *   §3  a new post ARCHIVES the previous thread (rail shows both, exactly one active)
 *   §4  a stand-in that answers PASS is marked passed and NEVER appears as a thread message
 *   §5  a user @mention delivers to exactly ONE agent
 *   §6  agent-mentions-agent: the directed answer AND the asker's follow-up both land
 *   §8  ONE ANSWER PER AGENT PER MESSAGE: two agents naming the same third one in a round
 *       wake it ONCE, and the coalesced mention says so in the thread (owner report 08-27)
 *   §9  AN AGENT'S OWN HTML IS DRAWN HERE TOO: a reply carrying a ```dream-html block renders
 *       as the real sandboxed frame, not as dropped text — and a `dream-view` the room cannot
 *       resolve is NOTICED rather than vanishing
 *
 * WHAT MAKES §2 HONEST: the scripted `claude` stand-in echoes its OWN `process.cwd()` —
 * a room that rendered three replies out of one process would pass a DOM check and fail
 * this one.
 *
 * SCRATCH HOME, ALWAYS: registry, meeting store, all three vaults and the fake `claude`
 * live under an isolated HOME. Nothing reads or writes the developer's real
 * `~/.dreamcontext/` or `~/.claude*`.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST: every check prints ✓/✗ with evidence and the
 * run continues. Exit 0 iff everything passed. Screenshots land in SHOTS either way.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-meeting-room');
const HOME = join(SCRATCH, 'home');
const VAULTS = ['alpha', 'beta', 'gamma'];
const SHOTS = process.env.MEETING_SHOTS_DIR || join(SCRATCH, 'shots');

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
//
// Invoked by runPeerHeadless as `claude -p "<prompt>" --output-format json
// --permission-mode auto` inside a login shell rooted in the TARGET vault's project
// directory. It answers with the two facts this script exists to check — its own cwd and
// a slice of the fenced message it was asked about — and follows four rules:
//   [skip:<name>] in the message  → this vault answers exactly PASS
//   FOLLOW-UP prompt              → "FOLLOWUP from=<name>" (closing a mention loop)
//   [chain] in the message, alpha → alpha's reply mentions @beta (the directed-run test)
//   [dup] in the message, a/b     → BOTH alpha and beta mention @gamma (the coalescing test)
//   [html] in the message, alpha   → a reply carrying a real dream-html block AND a dream-view
//                                    the room cannot resolve (the render/notice test)
//   otherwise                     → "REPLY from=<name> cwd=<cwd> re=<message slice>"
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --output-format json\` — see scripts/verify/meeting-room-ui.mjs. */
const path = require('path');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : ''; };
const prompt = flag('-p');
const name = path.basename(process.cwd());
const cwd = process.cwd();

const open = prompt.indexOf('<<<MEETING-MESSAGE\\n');
const close = prompt.lastIndexOf('\\nMEETING-MESSAGE');
const msg = open >= 0 && close > open ? prompt.slice(open + 19, close) : '';

(async () => {
  // [slow] keeps this agent THINKING for a while — the poll-cadence probe's window.
  if (msg.includes('[slow]')) await new Promise((r) => setTimeout(r, 6000));
  let result;
  if (msg.includes('[skip:' + name + ']')) {
    result = 'PASS';
  } else if (prompt.includes('FOLLOW-UP')) {
    result = 'FOLLOWUP from=' + name + ' cwd=' + cwd;
  } else if (msg.includes('[chain]') && name === 'alpha') {
    result = 'REPLY from=alpha cwd=' + cwd + ' — @beta please confirm';
  } else if (msg.includes('[dup]') && (name === 'alpha' || name === 'beta')) {
    result = 'REPLY from=' + name + ' cwd=' + cwd + ' — @gamma this one is yours';
  } else if (msg.includes('[html]') && name === 'alpha') {
    // Written the way an agent writes it: prose, a drawn block, prose. Plus a dream-view the
    // room has no project to resolve — which must be SAID, not silently dropped.
    result = [
      'REPLY from=alpha cwd=' + cwd + ' — here is the shape of it:',
      '',
      '\`\`\`dream-html',
      '<div class="dc-doc"><h2 class="dc-h2">DRAWN-IN-THE-ROOM</h2>',
      '<p class="dc-p">This came from alpha, rendered by the chat kit.</p></div>',
      '\`\`\`',
      '',
      'and the number itself:',
      '',
      '\`\`\`dream-view',
      '{"type":"insight","id":"weekly-active-users","view":"card"}',
      '\`\`\`',
    ].join('\\n');
  } else {
    result = 'REPLY from=' + name + ' cwd=' + cwd + ' re=' + msg.replace(/\\s+/g, ' ').slice(0, 40);
  }
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result, session_id: 'verify-' + name,
  }) + '\\n');
})();
`;

// ─── setup ────────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function dc(args, cwd = SCRATCH) {
  return spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args],
    { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  const souls = {
    alpha: 'A payments backend: invoicing, ledgers and reconciliation.',
    beta: 'A mobile client: onboarding flows and push messaging.',
    gamma: 'A data pipeline: nightly aggregation and reports.',
  };
  for (const name of VAULTS) {
    const root = join(SCRATCH, name);
    mkdirSync(join(root, '_dream_context', 'core'), { recursive: true });
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    // The soul is what the roster glance (and the presence chip tooltip) reads.
    writeFileSync(join(root, '_dream_context', 'core', '0.soul.md'),
      `---\nname: "${name}"\ntype: soul\n---\n\n## Project Identity\n\n${souls[name]}\n`);
    spawnSync('git', ['init', '-q'], { cwd: root });
  }

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  for (const name of VAULTS) {
    const add = dc(['vaults', 'add', name, join(SCRATCH, name)]);
    if (add.status !== 0) throw new Error(`vaults add ${name} failed: ${add.stderr || add.stdout}`);
  }
}

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
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

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function run(chromium, base, report) {
  const browser = await chromium.launch();
  // An explicit CONTEXT, not `browser.newPage()`: the room is its own window now, so it
  // arrives as a `page` event on the context — and it needs the same init script (the poll
  // spy §7 measures) as the launcher that opened it.
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, colorScheme: 'dark' });
  const launcher = await context.newPage();
  // `page` is REBOUND to the room window in §1; every helper below reads it through the
  // closure, so the assertions after §1 all run against the room rather than the launcher.
  let page = launcher;
  // The room's entrance is the SPACE view's core; the launcher defaults to List.
  await context.addInitScript(() => {
    try { window.localStorage.setItem('dreamcontext.launcher.view', 'space'); } catch {}
    // Poll spy: every /api/meeting/state fetch is timestamped, so §7 can measure
    // the cadence instead of trusting the hook's constants.
    window.__dcStateCalls = [];
    const nativeFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        if (String(args[0]).includes('/api/meeting/state')) window.__dcStateCalls.push(Date.now());
      } catch { /* spy must never break the app */ }
      return nativeFetch.apply(this, args);
    };
  });
  context.on('page', (p) => p.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`)));
  launcher.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const ok = (label, cond, detail) => report.check(label, cond, detail);
  const until = async (fn, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const feedText = async () => (await vis('.meeting-feed').first().innerText()).replace(/\s+/g, ' ');
  const shot = async (name) => {
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    report.note(`  📸 ${name}.png`);
  };
  // The composer is the CHAT's (`.chat-cmp-*`), which is the point of the rebuild — these
  // selectors are the ones ChatPane and the peer panel drive too.
  const composer = () => vis('.chat-cmp-input').first();
  const send = () => vis('.chat-cmp-send').first().click();
  const postAnnouncement = async (text) => {
    // A NEW announcement, explicitly: with a thread active the composer replies,
    // so the rail's "+ New announcement" is what archives-and-starts-fresh.
    await vis('.meeting-rail-new').first().click();
    const input = composer();
    await input.click();
    await input.fill(text);
    await send();
  };
  /** The stand-in echoes its REAL cwd, which on macOS is the /private realpath of
   *  the /var/... scratch path — assert on the invariant suffix, not equality. */
  const cwdOf = async (name) => {
    const m = (await feedText()).match(new RegExp(`from=${name} cwd=(\\S+)`));
    return m ? m[1] : '(absent)';
  };
  const cwdIsVault = (cwd, name) => cwd.endsWith(`/dreamcontext-verify-meeting-room/${name}`);
  /** Presence chip state, read off the class list. */
  const chipState = async (name) => {
    const chips = vis('.meeting-presence-chip');
    for (let i = 0; i < await chips.count(); i++) {
      const chip = chips.nth(i);
      if ((await chip.innerText()).includes(name)) {
        const cls = (await chip.getAttribute('class')) ?? '';
        return (cls.match(/state-(\w+)/) ?? [])[1] ?? '';
      }
    }
    return 'absent';
  };

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape'); // announcements popup eats first clicks on a fresh profile

  // ── §1 the logo opens the room ───────────────────────────────────────────────────
  console.log('\n── §1 the logo click');
  ok('the Space renders its core', await until(async () => (await vis('.space-core').count()) === 1, 20000));
  ok('…and + Add Project is in the top bar (the front door stays)',
    (await page.getByRole('button', { name: '+ Add Project' }).count()) === 1);
  const opened = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
  await vis('.space-core').first().click();
  const room = await opened;
  ok('clicking the core opens the Meeting Room in its OWN window', !!room);
  if (!room) throw new Error('no meeting window opened — nothing after §1 can be checked');
  await room.waitForLoadState('domcontentloaded');
  ok('…at the room URL', room.url().includes('meeting=1'), room.url());
  // The launcher is STILL THERE — the whole reason this stopped being a modal.
  ok('…and the launcher stayed on the Space behind it',
    !launcher.isClosed() && (await launcher.locator('.space-core:visible').count()) === 1);
  page = room; // every helper below reads `page` through the closure
  ok('the room renders', await until(async () => (await vis('.meeting-window').count()) === 1, 15000));
  // GEOMETRY, not presence — a collapsed shell would pass a DOM-only check.
  const box = await vis('.meeting-window').first().boundingBox();
  ok('…which actually fills the window', !!box && box.width > 600 && box.height > 400,
    box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'no box');
  ok('…and no add-project wizard opened instead', (await vis('.onboarding-overlay, .wizard').count()) === 0);

  // THE COMPOSER IS THE CHAT'S, minus what the room hasn't got. Presence of the chat
  // classes is what proves the shared component mounted rather than a look-alike.
  ok('the room mounts the real chat composer', (await vis('.chat-cmp-card').count()) === 1);
  ok('…with the model+effort trigger (the room-wide, app-global pick)',
    (await vis('.chat-cmp-model-wrap').count()) === 1);
  ok('…and NO mode/permission trigger — a headless run has no mode to brief',
    (await vis('.chat-cmp-perm-wrap').count()) === 0);
  ok('…and NO attach control — no project to put bytes in',
    (await vis('.chat-cmp-iconbtn').count()) === 0);
  ok('…and none of the old hand-rolled composer survives',
    (await page.locator('.meeting-input, .meeting-send, .meeting-mention-menu').count()) === 0);
  await shot('01-room-open');

  // ── §2 one announcement wakes all three, each in its OWN directory ───────────────
  console.log('\n── §2 the fan-out');
  await postAnnouncement('Hello everyone — status, please.');
  for (const name of VAULTS) {
    ok(`${name} replied`, await until(async () => (await feedText()).includes(`REPLY from=${name}`), 45000));
    const cwd = await cwdOf(name);
    ok(`…from a process whose cwd IS ${name}'s project root`, cwdIsVault(cwd, name), cwd);
  }
  ok('the presence strip reports all three replied', await until(async () =>
    (await chipState('alpha')) === 'replied' && (await chipState('beta')) === 'replied'
    && (await chipState('gamma')) === 'replied', 15000),
    `alpha=${await chipState('alpha')} beta=${await chipState('beta')} gamma=${await chipState('gamma')}`);
  await shot('02-fanout');

  // ── §3 a new post archives the previous thread ───────────────────────────────────
  console.log('\n── §3 archive on new post');
  await postAnnouncement('Second topic [skip:gamma] — thoughts?');
  ok('the rail lists both threads',
    await until(async () => (await vis('.meeting-rail-item').count()) === 2, 10000),
    `items=${await vis('.meeting-rail-item').count()}`);
  ok('…with exactly ONE active', (await vis('.meeting-rail-item.is-active').count()) === 1);
  const railText = (await vis('.meeting-rail-list').first().innerText()).replace(/\s+/g, ' ');
  ok('…the old thread kept with its title', railText.includes('Hello everyone'), railText.slice(0, 160));

  // ── §4 a PASS never becomes a message ────────────────────────────────────────────
  console.log('\n── §4 reply-or-PASS');
  ok('alpha and beta replied in the new thread', await until(async () => {
    const f = await feedText();
    return f.includes('re=Second topic') && f.includes('from=alpha') && f.includes('from=beta');
  }, 45000));
  ok('gamma is marked PASSED in the presence strip',
    await until(async () => (await chipState('gamma')) === 'passed', 20000),
    `gamma=${await chipState('gamma')}`);
  const feed4 = await feedText();
  ok('…and NO gamma message is in the thread', !feed4.includes('from=gamma'), feed4.slice(-200));
  ok('…and the literal PASS never rendered', !/\bPASS\b/.test(feed4), feed4.slice(-200));
  await shot('04-pass');

  // ── §5 a user @mention delivers to exactly one ───────────────────────────────────
  console.log('\n── §5 the directed mention');
  const alphaCountBefore = ((await feedText()).match(/from=alpha/g) ?? []).length;
  const input = composer();
  await input.click();
  await page.keyboard.type('@al');
  ok("typing @ opens the CHAT's picker, fed by the room's roster",
    await until(async () => (await vis('.chat-cmp-mention').count()) === 1, 5000));
  const menuText = (await vis('.chat-cmp-mention').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('…filtered to exactly the matching vault',
    (await vis('.chat-cmp-mention-row').count()) === 1 && menuText.includes('@alpha')
    && !menuText.includes('@beta') && !menuText.includes('@gamma'), menuText);
  // A GAIN from reusing the chat's picker rather than the room's old bare list: each row
  // carries the project's one-line identity, which is what makes a project you have not
  // touched in a month recognisable by more than its name.
  ok('…and each row carries the project\'s identity glance',
    (await vis('.chat-cmp-mention-what').count()) === 1, menuText);
  await page.keyboard.press('Enter');
  const draft = await input.inputValue();
  ok('⏎ completes the exact registered name', draft === '@alpha ', JSON.stringify(draft));
  await page.keyboard.type('just you: ping');
  await send();
  ok('alpha (alone) answered the directed reply', await until(async () =>
    (await feedText()).includes('re=@alpha just you: ping'), 45000));
  const feed5 = await feedText();
  const mention5 = feed5.match(/from=alpha cwd=(\S+) re=@alpha just you/);
  ok('…and it IS alpha answering, in its own directory',
    !!mention5 && cwdIsVault(mention5[1], 'alpha'), mention5 ? mention5[1] : feed5.slice(-220));
  ok('…exactly one new alpha message, none from beta',
    ((feed5.match(/from=alpha/g) ?? []).length === alphaCountBefore + 1)
    && !/from=beta cwd=\S+ re=@alpha just you/.test(feed5),
    `alpha ${alphaCountBefore} → ${(feed5.match(/from=alpha/g) ?? []).length}`);
  await shot('05-mention');

  // ── §6 agent-mentions-agent: directed answer + follow-up ─────────────────────────
  console.log('\n── §6 the mention chain');
  await postAnnouncement('@alpha coordinate the rollout [chain]');
  ok('alpha replied mentioning @beta', await until(async () =>
    (await feedText()).includes('@beta please confirm'), 45000));
  ok("the directed run appended BETA's answer, run in beta's directory", await until(async () => {
    const m = (await feedText()).match(/REPLY from=beta cwd=(\S+)/);
    return !!m && cwdIsVault(m[1], 'beta');
  }, 45000), (await feedText()).slice(-220));
  ok("…and ALPHA's follow-up carrying it", await until(async () => {
    const m = (await feedText()).match(/FOLLOWUP from=alpha cwd=(\S+)/);
    return !!m && cwdIsVault(m[1], 'alpha');
  }, 45000), (await feedText()).slice(-220));
  ok('gamma never woke for this thread (mentioned announcement)', (await chipState('gamma')) === 'idle',
    `gamma=${await chipState('gamma')}`);
  await shot('06-chain');

  // ── §8 one answer per agent per message (owner report 08-27) ─────────────────────
  //
  // THE REPORTED BUG, reproduced in the real app: two agents each write `@gamma` into their
  // own reply to one announcement. Before the wave rule, that was two directed runs on top of
  // gamma's own announcement run — three answers to one question, two of them the same.
  console.log('\n── §8 the coalescing rule');
  await postAnnouncement('Everyone weigh in [dup]');
  ok('alpha and beta both named @gamma', await until(async () => {
    const f = await feedText();
    return (f.match(/@gamma this one is yours/g) ?? []).length === 2
      && f.includes('from=alpha') && f.includes('from=beta');
  }, 60000), (await feedText()).slice(-260));
  ok('gamma answered the announcement', await until(async () =>
    (await feedText()).includes('from=gamma'), 60000));
  // Let any second run that WOULD have been spawned finish before counting.
  await page.waitForTimeout(6000);
  const feed8 = await feedText();
  ok('…exactly ONCE — no second run per mention',
    ((feed8.match(/from=gamma/g) ?? []).length) === 1,
    `gamma messages=${(feed8.match(/from=gamma/g) ?? []).length}`);
  ok('…and the coalesced mention is VISIBLE in the thread, not silent',
    /already answering this round/.test(feed8), feed8.slice(-260));
  ok('…gamma consumed one run, not three',
    await page.evaluate(async () => {
      const r = await fetch('/api/meeting/state').then((x) => x.json());
      const p = (r.active?.participants ?? []).find((x) => x.name === 'gamma');
      return p ? p.runs : -1;
    }) === 1);
  await shot('08-coalesced');

  // ── §9 the agent's own HTML, drawn in the room ───────────────────────────────────
  //
  // `dream-html` is this surface's main expressive channel, and until 08-27 the room DROPPED
  // it: the transcript gated every block on `onAction && conversationId`, which HTML needs
  // neither of. A block that vanishes in silence is the one failure the degradation contract
  // forbids, so both halves are checked — the render AND the notice for what cannot render.
  console.log('\n── §9 dream-html in the room');
  await postAnnouncement('@alpha draw me the shape of it [html]');
  ok('alpha replied', await until(async () => (await feedText()).includes('here is the shape of it'), 45000));
  ok('the reply\'s dream-html renders as a real frame, not as dropped text',
    await until(async () => (await vis('.chat-htmlview').count()) >= 1, 20000),
    `frames=${await vis('.chat-htmlview').count()}`);
  // INSIDE the iframe — a frame that mounted but never painted the agent's markup would pass
  // the count above. The kit is same-origin-less by design, so read it through Playwright's
  // frame API rather than the DOM.
  ok('…and the agent\'s own markup is INSIDE that frame',
    await until(async () => {
      for (const f of page.frames()) {
        const t = await f.locator('body').innerText().catch(() => '');
        if (t.includes('DRAWN-IN-THE-ROOM')) return true;
      }
      return false;
    }, 20000));
  ok('the prose around the block survived too',
    (await feedText()).includes('and the number itself'));
  ok('…and the dream-view the room cannot resolve is NOTICED, not silently dropped',
    await until(async () => (await vis('.chat-view-notice').count()) >= 1, 10000),
    (await feedText()).slice(-260));
  await shot('09-dream-html');

  // ── §7 the poll cadence: ~2s thinking, ~10s idle, stopped when closed ────────────
  console.log('\n── §7 the poll cadence');
  const stateCalls = () => page.evaluate(() => window.__dcStateCalls.length);

  // THINKING: a [slow] run holds alpha for ~6s — a 2s cadence lands ≥2 polls in it.
  await postAnnouncement('@alpha take your time [slow]');
  await until(async () => (await chipState('alpha')) === 'thinking', 10000);
  const cThinking0 = await stateCalls();
  await page.waitForTimeout(5000);
  const thinkingPolls = (await stateCalls()) - cThinking0;
  ok('while thinking, the room polls at ~2s', thinkingPolls >= 2, `${thinkingPolls} polls in 5s`);

  // IDLE: the thread stays active but everyone settled — a 10s cadence lands ≤2
  // polls in 11s where a 2s cadence would land ~5.
  ok('the slow run settled', await until(async () => (await chipState('alpha')) === 'replied', 20000));
  await page.waitForTimeout(1500);
  const cIdle0 = await stateCalls();
  await page.waitForTimeout(11000);
  const idlePolls = (await stateCalls()) - cIdle0;
  ok('when idle, it backs off to ~10s', idlePolls >= 1 && idlePolls <= 2, `${idlePolls} polls in 11s`);

  // CLOSED: no active thread → the loop STOPS (zero polls once the close lands).
  await page.evaluate(() => fetch('/api/meeting/close', { method: 'POST' }));
  await until(async () => (await vis('.meeting-rail-item.is-active').count()) === 0, 15000);
  await page.waitForTimeout(2500); // let the final refresh (which sees active=null) settle
  const cClosed0 = await stateCalls();
  await page.waitForTimeout(8000);
  const closedPolls = (await stateCalls()) - cClosed0;
  ok('once the thread is closed, polling STOPS', closedPolls === 0, `${closedPolls} polls in 8s`);

  // Light theme, for the screenshot set.
  const light = await browser.newPage({ viewport: { width: 1400, height: 950 }, colorScheme: 'light' });
  // Straight to the room's own URL — the entrance is already proven in §1 and a second
  // popup dance would only add a way for the screenshot step to fail.
  await light.goto(`${base}/?meeting=1`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await light.waitForTimeout(3000);
  await light.screenshot({ path: join(SHOTS, '07-light-room.png') }).catch(() => {});
  await light.close().catch(() => {});

  await browser.close();
}

// ─── report ───────────────────────────────────────────────────────────────────────────

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
