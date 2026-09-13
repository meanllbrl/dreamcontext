#!/usr/bin/env node
/**
 * Capture the agent-drawn DIAGRAM for the v0.28.0 story.
 *
 * The release put a real layout engine behind `dream-html`: the answer names nodes and
 * edges, and the kit places the boxes and draws the arrows between them — including the
 * ones that branch and rejoin, which no stack of rows can show. This shoots one.
 *
 * WHY A SCRIPTED STAND-IN, NOT A LIVE TURN — the same three reasons as the v0.26.1
 * capture this is copied from: a real turn costs money, takes 90s+ on a warm vault, and
 * produces different markup every run, so the shot could not be re-taken when the story
 * needs it. The claim being illustrated is that the SURFACE lays out and draws what the
 * agent writes; a fixed answer demonstrates that exactly as well, and deterministically.
 * Everything below the answer is the real thing: real server, real sandbox, real kit.
 *
 *   npm run build
 *   node e2e/announce-shots-0-28-diagram.mjs
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-announce-chat-html');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CLI = join(REPO, 'dist', 'index.js');
const ROOT = process.env.SHOT_ROOT ?? join(REPO, 'dashboard/public/announcements/shots');
const ID = 'v0-28-0';

/**
 * The answer the stand-in streams — written the way the surface asks for: kit classes
 * only, no hardcoded colour, one block carrying one idea. Nothing is positioned here;
 * every node is a name and every edge is a pair of ids, and the engine does the rest.
 *
 * NOTE the plain `</script>` if one is ever added below: this string travels as chat
 * message TEXT, so escaping it as `<\/script>` would leave the element unclosed.
 */
const ANSWER = [
  'A failed charge does not mean a failed order — here is every path a checkout can take once payment is submitted.',
  '',
  '```dream-html',
  '<div class="dc-graph">',
  '  <div class="dc-node" id="submit">Payment submitted</div>',
  '  <div class="dc-node dc-node--decision" id="auth">Authorised?</div>',
  '  <div class="dc-node dc-node--good" id="placed">Order placed</div>',
  '  <div class="dc-node dc-node--decision" id="retry">Retryable code?</div>',
  '  <div class="dc-node" id="second">Second attempt</div>',
  '  <div class="dc-node dc-node--bad" id="declined">Declined for good</div>',
  '  <div class="dc-node dc-node--ghost" id="cart">Back to cart</div>',
  '  <div class="dc-edge" data-from="submit" data-to="auth"></div>',
  '  <div class="dc-edge dc-edge--good" data-from="auth" data-to="placed" data-label="yes"></div>',
  '  <div class="dc-edge" data-from="auth" data-to="retry" data-label="no"></div>',
  '  <div class="dc-edge" data-from="retry" data-to="second" data-label="soft"></div>',
  '  <div class="dc-edge dc-edge--bad" data-from="retry" data-to="declined" data-label="hard"></div>',
  '  <div class="dc-edge" data-from="second" data-to="auth"></div>',
  '  <div class="dc-edge dc-edge--dashed" data-from="declined" data-to="cart"></div>',
  '</div>',
  '```',
  '',
  'The loop is the part worth knowing: a soft decline goes back through the same',
  'authorisation, so a shopper can be charged on the second attempt without ever seeing',
  'the first one fail.',
].join('\n');

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see e2e/announce-shots-chat-html.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const ANSWER = ${JSON.stringify(ANSWER)};
const inbox = [];
let pumping = false;

async function runTurn() {
  // A TOKEN FOOTPRINT, so the context reading exists at all. The composer draws its usage
  // trigger only when there is something to measure, and this release's headline — the
  // window as BANDS plus the ECO pill — lives behind that trigger. 450k of a 1M window puts
  // the reading one third into the middle band: the first is spent, the second is filling,
  // the third is untouched, which is the whole point of drawing three.
  const usage = { input_tokens: 12000, cache_read_input_tokens: 432000, cache_creation_input_tokens: 4000, output_tokens: 2000 };
  // role and model are NOT decoration: the usage parser drops any frame whose message is
  // not an assistant turn, so a footprint without them is silently ignored and the context
  // reading never exists. (No backticks in here — this block lives inside a template
  // literal, and one would end the string.)
  out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: ANSWER }], usage } });
  await new Promise((r) => setTimeout(r, 120));
  out({ type: 'result', subtype: 'success', is_error: false, result: ANSWER, usage });
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request' && o.request && o.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) { inbox.push(text); pump(); }
  }
});
async function pump() {
  if (pumping) return;
  if (inbox.shift() === undefined) return;
  pumping = true;
  try { await runTurn(); } finally { pumping = false; }
}
process.stdin.on('end', () => process.exit(0));
`;

const dc = (args, opts = {}) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: PROJ,
    env: { ...process.env, HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).toString();

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

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try {
    dc(['init', '--yes']);
  } catch {
    /* scaffold best-effort */
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
    [CLI, 'dashboard', '--no-open', '-p', String(port)],
    {
      cwd: PROJ,
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

console.log('setting up scratch home…');
setup();
const port = await freePort();
const srv = await startServer(port);
console.log(`server on ${port}`);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1500, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
/**
 * THE DESKTOP FLAG IS FAKED, and only so the microphone exists.
 *
 * `isDesktop()` reads `window.__TAURI_INTERNALS__`, and the composer draws its mic ONLY in
 * the desktop app — the web dashboard has no microphone path at all, so Chromium without
 * this flag photographs J.A.R.V.I.S mode as a mode with no way to talk to it. Nothing else
 * is stubbed: every pixel is the same component tree the .app renders, and the Tauri calls
 * it might make are dynamically imported and already fall back on absence.
 */
await page.addInitScript(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
});

const vis = (sel) => page.locator(sel).locator('visible=true');
const captured = [];

try {
  // Same open sequence as scripts/verify/chat-html.mjs: the agent surface starts
  // collapsed, so the composer does not exist until something expands it — and the
  // What's New popup eats the first few clicks on a fresh profile.
  await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !(await vis('.chat-cmp-input').count())) {
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);

  // J.A.R.V.I.S FIRST, then the question — switching mode respawns the session and clears
  // the transcript, so a mode change after the answer photographs an empty chat. Asked in
  // this mode, one window carries both halves of the release: the answer it drew, and the
  // microphone the next question is asked with.
  try {
    await vis('.chat-cmp-modeltrigger').first().click();
    await page.waitForTimeout(700);
    await page.getByText('J.A.R.V.I.S', { exact: false }).first().click();
    await page.waitForTimeout(3000);
  } catch (err) {
    console.log('  ! could not switch to J.A.R.V.I.S -', String(err.message).split('\n')[0]);
  }

  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('What happens after a card payment is submitted?');
  await page.keyboard.press('Enter');

  // Wait for the frame to mount AND settle at its real height — the block grows out
  // of a skeleton, so shooting on first paint catches the placeholder.
  const frameUp = Date.now() + 60_000;
  while (Date.now() < frameUp) {
    const h = await page
      .locator('iframe.chat-htmlview-frame')
      .locator('visible=true')
      .first()
      .boundingBox()
      .catch(() => null);
    if (h && h.height > 180) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(2000);
  await page.addStyleTag({ content: '.agent-dock, .agent-fab { display: none !important; }' });

  // A DIAGRAM NOW GROWS INTO ITS PANE, so the block is taller than the window this session
  // was opened at and a 1000px clip would photograph the middle of it. The window is given
  // the height for this one frame and the block is scrolled fully into view; both are put
  // back before the hero, which is a shot of the window itself.
  await page.setViewportSize({ width: 1600, height: 1400 });
  await page.waitForTimeout(1200);
  await vis('iframe.chat-htmlview-frame').first()
    .evaluate((n) => n.scrollIntoView({ block: 'center' }))
    .catch(() => {});
  await page.waitForTimeout(900);
  // The zoom control rests invisible and appears on hover — park the pointer off the block
  // so the exported frame carries the diagram and not its chrome.
  await page.mouse.move(12, 12);
  await page.waitForTimeout(400);
  const box = await vis('iframe.chat-htmlview-frame').first().boundingBox();
  const path = join(ROOT, ID, 'chat-diagram.png');
  mkdirSync(dirname(path), { recursive: true });
  if (box) {
    await page.screenshot({
      path,
      clip: {
        x: Math.max(0, box.x - 16),
        y: Math.max(0, box.y - 16),
        width: Math.min(1500, box.width + 32),
        height: Math.min(1400 - Math.max(0, box.y - 16), box.height + 32),
      },
    });
  } else {
    await page.screenshot({ path });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(900);
  captured.push('chat-diagram');
  console.log('  ✓ chat-diagram');

  // The composer at rest in this mode: a microphone, and one line telling you how to hold
  // it. Nothing is opened, no key is set, nothing is transcribed.
  const cbox = await vis('.chat-cmp-card').first().boundingBox();
  await page.screenshot({
    path: join(ROOT, ID, 'voice-composer.png'),
    ...(cbox
      ? {
          clip: {
            x: Math.max(0, cbox.x - 20),
            y: Math.max(0, cbox.y - 20),
            width: Math.min(1500, cbox.width + 40),
            height: Math.min(1000, cbox.height + 40),
          },
        }
      : {}),
  });
  captured.push('voice-composer');
  console.log('  ✓ voice-composer');

  // The whole window in one frame — the only shot where the release's two halves are the
  // same picture, which is what makes it the hero.
  await page.screenshot({ path: join(ROOT, ID, 'hero.png') });
  captured.push('hero');
  console.log('  ✓ hero');

  /** Clip to one popover, with a little air around it. */
  const shotOf = async (name, selector) => {
    const box = await vis(selector).first().boundingBox();
    await page.screenshot({
      path: join(ROOT, ID, `${name}.png`),
      ...(box
        ? {
            clip: {
              x: Math.max(0, box.x - 18),
              y: Math.max(0, box.y - 18),
              width: Math.min(1500 - Math.max(0, box.x - 18), box.width + 36),
              height: Math.min(1000 - Math.max(0, box.y - 18), box.height + 36),
            },
          }
        : {}),
    });
    captured.push(name);
    console.log('  ✓', name);
  };

  // ─── ECO mode and the context bands ───────────────────────────────────────
  // The release's headline lives in one popover: the window drawn as bands rather than a
  // percentage, and the ECO pill that decides what happens when the window runs out.
  try {
    await vis('.chat-cmp-usagebtn').first().click();
    await page.waitForTimeout(1200);
    // Turn ECO ON before shooting. Off, the pill says "off" and the feature is a word; on,
    // it names the token count it hands off at, which is the whole claim.
    const eco = vis('.chat-cmp-eco').first();
    if (await eco.count()) {
      await eco.click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    await shotOf('eco-context', '.chat-cmp-usagemenu');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch (err) {
    console.log('  ! skipped eco-context -', String(err.message).split('\n')[0]);
  }

  // ─── The mode menu, with the ALPHA chip on J.A.R.V.I.S ────────────────────
  try {
    await vis('.chat-cmp-modeltrigger').first().click();
    await page.waitForTimeout(1000);
    await shotOf('mode-menu', '.chat-cmp-menu, [role="menu"]');
  } catch (err) {
    console.log('  ! skipped mode-menu -', String(err.message).split('\n')[0]);
  }
} catch (err) {
  console.log('  ! aborted -', String(err.message).split('\n')[0]);
} finally {
  await browser.close();
  srv.kill();
}

console.log('captured:', captured.join(', ') || '(none)');
