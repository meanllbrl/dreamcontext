#!/usr/bin/env node
/**
 * Capture the agent-written HTML answer for the v0.26.1 story.
 *
 * The release retired chat's fixed chart and page types for HTML the agent writes
 * itself, drawn in a sandbox wearing the app's own theme — and the story mentioned
 * it in one line of an "Also in this release" list, with no picture. This shoots it.
 *
 * WHY NOT REUSE THE VERIFY'S SHOT. scripts/verify/chat-html.mjs already renders a
 * dream-html block and screenshots it, but its fixture is adversarial on purpose: a
 * hot-pink heading (proving a brand override wins), a "Ran: no→yes" probe (proving
 * inline script executes), a giant DP1 label and a bare circle (proving SVG tooltips
 * exist). It is exactly right as a test and unpublishable as release notes. This
 * script keeps that harness — scratch HOME, scripted stand-in, no API call — and
 * swaps in an answer a real agent would actually write.
 *
 * WHY NOT A LIVE TURN. A real Claude turn would cost money, take 90s+ on a warm
 * vault, and produce different markup every run — so the shot could not be
 * reproduced when the story needs re-taking. The claim being illustrated is that
 * the SURFACE renders agent-authored HTML; a scripted answer demonstrates that
 * exactly as well, and deterministically.
 *
 *   npm run build
 *   node e2e/announce-shots-chat-html.mjs
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
const ID = 'v0-26-1';

/**
 * The answer the stand-in streams — written the way the surface asks for: kit classes
 * only, no hardcoded colour, one block carrying one idea. The bars are hand-rolled
 * SVG (no chart library can load in the sandbox) and each one answers a hover, which
 * is the `dc-hit` / `dc-tip` idiom the release added.
 *
 * NOTE the plain `</script>` if one is ever added below: this string travels as chat
 * message TEXT, so escaping it as `<\/script>` would leave the element unclosed.
 */
const ANSWER = [
  'Checkout loses most of its people before payment ever loads \u2014 here is the shape of it.',
  '',
  '```dream-html',
  '<div class="dc-doc">',
  '  <h2 class="dc-h2">Checkout funnel, last 28 days</h2>',
  '  <p class="dc-lede dc-muted">Hover a step for the counts behind it.</p>',
  '  <div class="dc-funnel">',
  '    <div class="dc-funnel-step">',
  '      <span class="dc-hit" tabindex="0">',
  '        <span class="dc-funnel-bar dc-bg1" style="width:340px">Cart</span>',
  '        <span class="dc-tip dc-tip--below">12,480 carts opened</span>',
  '      </span>',
  '      <span class="dc-funnel-drop">12,480</span>',
  '    </div>',
  '    <div class="dc-funnel-step">',
  '      <span class="dc-hit" tabindex="0">',
  '        <span class="dc-funnel-bar dc-bg2" style="width:243px">Address</span>',
  '        <span class="dc-tip">8,904 \u00b7 \u221228.7% from cart</span>',
  '      </span>',
  '      <span class="dc-funnel-drop">\u221228.7%</span>',
  '    </div>',
  '    <div class="dc-funnel-step">',
  '      <span class="dc-hit" tabindex="0">',
  '        <span class="dc-funnel-bar dc-bg3" style="width:80px">Payment</span>',
  '        <span class="dc-tip">2,946 \u00b7 \u221266.9% from address</span>',
  '      </span>',
  '      <span class="dc-funnel-drop">\u221266.9%</span>',
  '    </div>',
  '    <div class="dc-funnel-step">',
  '      <span class="dc-hit" tabindex="0">',
  '        <span class="dc-funnel-bar dc-bg4" style="width:70px">Paid</span>',
  '        <span class="dc-tip dc-tip--below">2,571 \u00b7 \u221212.7% from payment</span>',
  '      </span>',
  '      <span class="dc-funnel-drop">\u221212.7%</span>',
  '    </div>',
  '  </div>',
  '  <div class="dc-divider"></div>',
  '  <div class="dc-callout dc-callout--bad">',
  '    <span class="dc-strong">Address \u2192 Payment is the wall.</span> Two thirds of the',
  '    people who typed an address never saw a payment form \u2014 far more than the other',
  '    three steps put together.',
  '  </div>',
  '</div>',
  '```',
  '',
  'The address step is where I would look first.',
].join('\n');

const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see e2e/announce-shots-chat-html.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const ANSWER = ${JSON.stringify(ANSWER)};
const inbox = [];
let pumping = false;

async function runTurn() {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: ANSWER }] } });
  await new Promise((r) => setTimeout(r, 120));
  out({ type: 'result', subtype: 'success', is_error: false, result: ANSWER });
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

  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('Where are we losing people in checkout?');
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

  // Hover the LAST step so the tooltip is OPEN in the shot — the claim is that a
  // figure the agent draws answers a hover, and a closed tooltip shows none of that.
  // It has to be the FIRST one, which the fixture flips with dc-tip--below. A tip
  // defaults to opening UPWARD, so hovering a middle step lands the bubble on the bar
  // above it and hides that step's label; and a tip is centred on its hit, so hovering
  // a SHORT bar (Paid is 70px) overflows the frame's left edge and the number gets
  // clipped. The top step is both the widest and already flipped downward.
  const frame = page.frameLocator('iframe.chat-htmlview-frame');
  await frame.locator('.dc-hit').nth(0).hover({ timeout: 15000 }).catch(() => {
    console.log('  ! could not hover a bar — shooting without the tooltip open');
  });
  await page.waitForTimeout(900);

  const box = await vis('iframe.chat-htmlview-frame').first().boundingBox();
  const path = join(ROOT, ID, 'chat-dream-html.png');
  mkdirSync(dirname(path), { recursive: true });
  if (box) {
    await page.screenshot({
      path,
      clip: {
        x: Math.max(0, box.x - 16),
        y: Math.max(0, box.y - 16),
        width: Math.min(1500, box.width + 32),
        height: Math.min(1000, box.height + 32),
      },
    });
  } else {
    await page.screenshot({ path });
  }
  captured.push('chat-dream-html');
  console.log('  ✓ chat-dream-html');
} catch (err) {
  console.log('  ! aborted -', String(err.message).split('\n')[0]);
} finally {
  await browser.close();
  srv.kill();
}

console.log('captured:', captured.join(', ') || '(none)');
