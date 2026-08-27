#!/usr/bin/env node
/**
 * Capture the Meeting Room for the v0.26.1 What's New story — POPULATED.
 *
 * WHY THIS EXISTS. The first cut of the story illustrated the release's headline
 * feature with an empty room: "No meetings yet", a rail with nothing in it, and a
 * placeholder where the thread should be. It photographed the chrome and proved
 * nothing — and it was shot against the MODAL the release then replaced, so it
 * showed a surface that is no longer in the product.
 *
 * The obvious fix — shoot the author's real room — publishes the author's real
 * projects into a file that ships inside the npm tarball. That already happened
 * five times. So this script borrows the isolation the FEATURE'S OWN VERIFY uses
 * (scripts/verify/meeting-room-ui.mjs): a scratch HOME, synthetic vaults, and a
 * scripted stand-in on PATH in place of `claude`.
 *
 * WHAT'S DIFFERENT FROM THE VERIFY. The verify's stand-in echoes `REPLY from=<name>
 * cwd=<path>` because its job is to PROVE each answer came from its own directory —
 * diagnostic output, exactly right there and unpublishable here. This stand-in
 * answers in the prose a real agent would, from the acme demo projects the rest of
 * the feed already uses, so the shot carries the claim instead of the mechanism.
 *
 * Nothing here costs a Claude turn and nothing here reads the real machine:
 * `os.homedir()` honours $HOME, so the registry, the meeting store and every vault
 * resolve under the scratch tree.
 *
 *   npm run build
 *   node e2e/announce-shots-meeting-room.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that can't be reached is reported and skipped.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-announce-meeting-room');
const HOME = join(SCRATCH, 'home');
const SHOTS = process.env.SHOT_ROOT ?? join(REPO, 'dashboard/public/announcements/shots');
const ID = 'v0-26-1';

/** The synthetic working set — the same fictional companies the rest of the feed uses,
 *  so a reader moving between stories sees one coherent set of projects. */
const VAULTS = ['acme-storefront', 'acme-payments', 'acme-design', 'atlas-mobile'];

const SOULS = {
  'acme-storefront': 'Customer-facing shop for the Acme demo company — catalogue, cart, checkout.',
  'acme-payments': 'Payments and payout service for the Acme demo company.',
  'acme-design': 'The shared design system behind every Acme surface.',
  'atlas-mobile': 'The Atlas demo iOS/Android client.',
};

/**
 * The scripted stand-in for `claude -p --output-format json`.
 *
 * It answers as the project it was launched in. `atlas-mobile` returns exactly PASS,
 * which is the behaviour the story claims and the empty shot could never show: an
 * agent with nothing to add stays out of the thread and only shows in the presence
 * strip. `acme-design` names another project, which is what puts the coalescing
 * notice on screen.
 */
const STANDIN = `#!${process.execPath}
/** Scripted stand-in — see e2e/announce-shots-meeting-room.mjs. Never contacts an API. */
(async () => {
  const cwd = process.cwd();
  const name = ${JSON.stringify(VAULTS)}.find((v) => cwd.endsWith('/' + v)) || 'unknown';
  const answers = {
    'acme-payments': [
      'Yes — one thing, and it will bite you on the retry path.',
      '',
      'Refunds are idempotent on the GATEWAY\\'s refund id, not on ours: it is',
      'written before the ledger row and read back inside the same transaction,',
      'so a replayed webhook lands on the existing row instead of a second payout.',
      'If checkout mints its own key you lose that, and a duplicate webhook pays',
      'twice. Reuse \`gateway_refund_id\` and you inherit the guarantee for free.',
    ].join('\\n'),
    'acme-design': [
      'From the design side the checkout tokens moved in the dark-mode pass —',
      '\`--surface-raised\` is what the card uses now, \`--surface-2\` is gone.',
      '',
      '@acme-storefront you are still importing the old name in two places.',
    ].join('\\n'),
    'acme-storefront': [
      'Taking this one. Plan is the new payments API behind a flag, both paths',
      'live for a week, then the old client comes out in a single revert-able',
      'commit. Nothing in the cart schema changes.',
    ].join('\\n'),
    'atlas-mobile': 'PASS',
  };
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: answers[name] ?? 'PASS', session_id: 'announce-' + name,
  }) + '\\n');
})();
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function dc(args, cwd = SCRATCH) {
  return spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], {
    cwd,
    env: { ...process.env, HOME },
    encoding: 'utf-8',
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });

  for (const name of VAULTS) {
    const root = join(SCRATCH, name);
    mkdirSync(join(root, '_dream_context', 'core'), { recursive: true });
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    // The soul is what the presence chip's tooltip and the @ picker read.
    writeFileSync(
      join(root, '_dream_context', 'core', '0.soul.md'),
      `---\nname: "${name}"\ntype: soul\n---\n\n## Project Identity\n\n${SOULS[name]}\n`,
    );
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
  const PATH = [
    join(HOME, '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    dirname(process.execPath),
  ].join(':');
  const srv = spawn(
    process.execPath,
    [join(REPO, 'dist', 'index.js'), 'dashboard', '--launcher', '--no-open', '-p', String(port)],
    {
      cwd: SCRATCH,
      env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function main() {
  console.log('setting up scratch home…');
  setupScratch();
  const port = await freePort();
  const srv = await startServer(port);
  console.log(`server on ${port}`);

  const browser = await chromium.launch();
  // Taller than the verify's window on purpose: the story frame has to hold the
  // announcement, the presence strip and enough of the thread to show that the
  // answers are substantive. A 950px window cuts the first reply mid-sentence.
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1180 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  // The room's entrance is the SPACE view's core; the launcher defaults to List.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('dreamcontext.launcher.view', 'space');
    } catch {}
  });

  const launcher = await context.newPage();
  const captured = [];

  const shot = async (page, name, sel) => {
    const path = join(SHOTS, ID, `${name}.png`);
    mkdirSync(dirname(path), { recursive: true });
    if (sel) {
      const box = await page.locator(sel).locator('visible=true').first().boundingBox();
      if (!box) throw new Error('no box for ' + sel);
      await page.screenshot({
        path,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      });
    } else {
      await page.screenshot({ path });
    }
    captured.push(name);
    console.log('  ✓', name);
  };

  const until = async (fn, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  };

  try {
    await launcher.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await launcher.waitForTimeout(3000);
    await launcher.keyboard.press('Escape'); // the What's New popup eats the first click

    // NOT the place to shoot the launcher. These scratch vaults carry no logo and no
    // connections, and every one of them reads UPDATE against the bundled version — so
    // the Space view photographs here as four grey pills round an empty ring. The
    // launcher shot belongs to the DEMO VAULT SET (e2e/announce-demo-vaults.mjs), which
    // has the marks and the wires the hero actually claims.
    await until(async () => (await launcher.locator('.space-core:visible').count()) === 1, 20000);
    await launcher.waitForTimeout(1200);

    // ── Open the room in its own window ──────────────────────────────────────
    const opened = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await launcher.locator('.space-core:visible').first().click();
    const room = await opened;
    if (!room) throw new Error('no meeting window opened');
    await room.waitForLoadState('domcontentloaded');
    await until(async () => (await room.locator('.meeting-window:visible').count()) === 1, 15000);
    await room.waitForTimeout(1200);

    // ── Post the announcement and let every project answer ───────────────────
    const ANNOUNCEMENT =
      'Monday we move checkout onto the new payments API. Anything I should know before I start?';
    const box = room.locator('.chat-cmp-card textarea, .chat-cmp-card [contenteditable="true"]').first();
    await box.click();
    await box.fill(ANNOUNCEMENT);
    await room.keyboard.press('Enter');

    const feedText = async () =>
      (await room.locator('.meeting-feed:visible').first().innerText().catch(() => '')) || '';

    // Three answer in prose; atlas-mobile passes and must never become a message.
    const arrived = await until(async () => {
      const f = await feedText();
      return f.includes('gateway') && f.includes('surface-raised') && f.includes('Taking this one');
    }, 90000);
    if (!arrived) console.log('  ! not every reply landed — shooting what is there');
    await room.waitForTimeout(2500);

    // The feed auto-scrolls to the newest message, which frames the shot on whatever
    // landed last and clips the message above it mid-sentence. The story wants the
    // thread from its TOP: the announcement, then the answers under it in order.
    await room
      .locator('.meeting-feed:visible')
      .first()
      .evaluate((el) => {
        el.scrollTop = 0;
      })
      .catch(() => {});
    await room.waitForTimeout(900);

    try {
      await shot(room, 'meeting-room');
    } catch (err) {
      console.log('  ! skipped meeting-room -', err.message.split('\n')[0]);
    }

    // The presence strip alone — it is where the PASS shows, and it is the detail
    // that carries "the ones with nothing to add never clutter the thread".
    try {
      await shot(room, 'meeting-presence', '.meeting-presence, .meeting-chips');
    } catch (err) {
      console.log('  ! skipped meeting-presence -', err.message.split('\n')[0]);
    }
  } catch (err) {
    console.log('  ! run aborted -', err.message.split('\n')[0]);
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log('captured:', captured.join(', ') || '(none)');
}

await main();
