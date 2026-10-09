#!/usr/bin/env node
/**
 * The Node setup screen behaves, in a real browser, the way the shell expects it to.
 *
 *   node scripts/verify/node-setup-page.mjs
 *
 * The page (desktop/src-tauri/frontend-placeholder/node-setup.html) is self-contained, so
 * this needs no build and no server: Chromium loads it from disk with a fake
 * `window.__TAURI_INTERNALS__` injected before its scripts. The fake records every invoke
 * and answers `node_setup_status` with whatever status this script sets, which is how each
 * phase the Rust side reports (src/node_setup.rs `SetupStatus`) is played to the page.
 *
 * What it proves (plan rows P1-P5):
 *   P1  the install starts on load with no click; download progress, checking, unpacking
 *       and the Ready moment render; the shell's exit hook fades the card; light and dark
 *       paint different card colours (the token blocks work).
 *   P2  every error kind shows its copy and Retry (os: only "Get Node.js yourself"); Retry
 *       starts again; Cancel stops and offers "Set it up"; Quit is visible in every state;
 *       no command is ever sent with an argument.
 *   P3  the too-old reason opens with its own sentence.
 *   P4  error mode renders the startup message as text (markup in it stays inert), offers
 *       "Try again" (a relaunch) and never starts an install.
 *   P5  under reduced motion nothing animates.
 *
 * Collects every check rather than failing fast; exit 0 only when all pass.
 * Screenshots: tmp/verify/node-setup-page/.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = pathToFileURL(join(REPO, 'desktop', 'src-tauri', 'frontend-placeholder', 'node-setup.html')).href;
const OUT = join(REPO, 'tmp', 'verify', 'node-setup-page');
/** The setup window's size (node_setup.rs `inner_size`). */
const VIEW = { width: 720, height: 460 };
/** Long enough for several 200 ms status polls to land. */
const SETTLE_MS = 700;

const MOCK = `
  window.__calls = [];
  window.__status = { mode: 'install', phase: 'idle', received: 0, total: null, reason: 'missing' };
  window.__TAURI_INTERNALS__ = {
    invoke: function (cmd, args) {
      window.__calls.push({ cmd: cmd, hasArgs: args !== undefined });
      if (cmd === 'node_setup_status') return Promise.resolve(JSON.parse(JSON.stringify(window.__status)));
      return Promise.resolve(null);
    },
  };
`;

const results = [];
function check(name, ok, evidence = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${evidence ? `  (${evidence})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, { scheme = 'light', reducedMotion = 'no-preference', url = PAGE, status } = {}) {
  const context = await browser.newContext({ viewport: VIEW, colorScheme: scheme, reducedMotion });
  await context.addInitScript(MOCK + (status ? `window.__status = ${JSON.stringify(status)};` : ''));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await sleep(SETTLE_MS);
  return { page, context, errors };
}

const setStatus = async (page, s) => {
  await page.evaluate((st) => { window.__status = st; }, s);
  await sleep(SETTLE_MS);
};
const calls = (page) => page.evaluate(() => window.__calls);
const text = (page, sel) => page.locator(sel).textContent();
const visible = (page, sel) => page.locator(sel).isVisible();
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

async function p1(browser) {
  const cardBg = {};
  for (const scheme of ['light', 'dark']) {
    const { page, context, errors } = await open(browser, { scheme });
    const c = await calls(page);
    if (scheme === 'light') {
      check('P1 the install starts on load, without a click', c.some((x) => x.cmd === 'node_setup_start'));
      check('P1 status is polled', c.filter((x) => x.cmd === 'node_setup_status').length >= 2);
      check('P1 Cancel and Quit are offered while it starts', (await visible(page, '#b-cancel')) && (await visible(page, '#b-quit')));

      await setStatus(page, { mode: 'install', phase: 'downloading', received: 12_400_000, total: 48_000_000, reason: 'missing' });
      const s = await text(page, '#status-text');
      const width = await page.locator('#fill').evaluate((el) => el.getBoundingClientRect().width);
      check('P1 download progress names the megabytes', /12\.4 of 48\.0 MB/.test(s ?? ''), s ?? '');
      check('P1 the rail fills in proportion', width > 0, `${width.toFixed(1)}px`);
      await shot(page, 'p1-downloading');

      await setStatus(page, { mode: 'install', phase: 'verifying', received: 48_000_000, total: 48_000_000, reason: 'missing' });
      check('P1 verifying reads "Checking the download"', (await text(page, '#status-text')) === 'Checking the download');
      await setStatus(page, { mode: 'install', phase: 'unpacking', received: 48_000_000, total: 48_000_000, reason: 'missing' });
      check('P1 unpacking reads "Unpacking"', (await text(page, '#status-text')) === 'Unpacking');

      await setStatus(page, { mode: 'install', phase: 'done', received: 48_000_000, total: 48_000_000, reason: 'missing' });
      check('P1 done shows the Ready moment', (await text(page, '#title')) === 'Node.js is ready' && (await visible(page, '.check')));
      check('P1 done offers no action but Quit', !(await visible(page, '#b-cancel')) && (await visible(page, '#b-quit')));
      await shot(page, 'p1-ready');

      await page.evaluate(() => window.__dcNodeSetupExit());
      await sleep(400);
      const opacity = await page.locator('#card').evaluate((el) => getComputedStyle(el).opacity);
      check('P1 the exit hook fades the card', opacity === '0', `opacity ${opacity}`);
    }
    const bg = await page.locator('#card').evaluate((el) => getComputedStyle(el).backgroundColor);
    cardBg[scheme] = bg;
    check(`P1 no script errors (${scheme})`, errors.length === 0, errors.join('; '));
    await shot(page, `p1-${scheme}`);
    await context.close();
  }
  check('P1 light and dark paint different cards', cardBg.light !== cardBg.dark, `${cardBg.light} / ${cardBg.dark}`);
}

async function p2(browser) {
  const { page, context, errors } = await open(browser);
  const expected = {
    offline: /offline/i,
    checksum: /didn’t check out/,
    disk: /free space/,
    other: /went wrong/,
  };
  for (const [kind, rx] of Object.entries(expected)) {
    await setStatus(page, { mode: 'install', phase: 'error', received: 0, total: null, error: kind, reason: 'missing' });
    const s = (await text(page, '#status-text')) ?? '';
    check(`P2 ${kind}: its own copy, Retry and Quit`, rx.test(s) && (await visible(page, '#b-retry')) && (await visible(page, '#b-quit')), s);
  }
  await page.evaluate(() => { window.__calls = []; });
  await page.click('#b-retry');
  await sleep(100);
  check('P2 Retry starts the install again', (await calls(page)).some((x) => x.cmd === 'node_setup_start'));
  await shot(page, 'p2-error');

  await setStatus(page, { mode: 'install', phase: 'error', received: 0, total: null, error: 'os', reason: 'missing' });
  check('P2 os: no Retry, "Get Node.js yourself" instead', !(await visible(page, '#b-retry')) && (await visible(page, '#b-download')));
  await page.click('#b-download');
  await sleep(100);
  check('P2 the download page is asked for', (await calls(page)).some((x) => x.cmd === 'node_setup_open_download_page'));

  await setStatus(page, { mode: 'install', phase: 'downloading', received: 1, total: 10, reason: 'missing' });
  await page.click('#b-cancel');
  await setStatus(page, { mode: 'install', phase: 'idle', received: 0, total: null, reason: 'missing' });
  check('P2 Cancel is sent', (await calls(page)).some((x) => x.cmd === 'node_setup_cancel'));
  check('P2 a cancelled install offers "Set it up"', (await visible(page, '#b-start')) && !(await visible(page, '#b-cancel')));
  await page.click('#b-quit');
  await sleep(100);
  const all = await calls(page);
  check('P2 Quit is sent', all.some((x) => x.cmd === 'node_setup_quit'));
  check('P2 no command carries an argument', all.every((x) => !x.hasArgs));
  check('P2 no script errors', errors.length === 0, errors.join('; '));
  await context.close();
}

async function p3(browser) {
  const { page, context } = await open(browser, { status: { mode: 'install', phase: 'downloading', received: 0, total: null, reason: 'too-old' } });
  const lede = (await text(page, '#lede')) ?? '';
  check('P3 too-old opens with its own sentence', /newer Node\.js/.test(lede), lede);
  check('P3 an unknown size shows the sweep, not a fraction', /^Downloading Node\.js$/.test((await text(page, '#status-text')) ?? ''));
  await shot(page, 'p3-too-old');
  await context.close();
}

async function p4(browser) {
  const message = '<img src=x onerror="window.__pwned=1"> Öğretmen: the dashboard server did not answer';
  const url = `${PAGE}?mode=error#${encodeURIComponent(message)}`;
  const { page, context, errors } = await open(browser, { url, status: { mode: 'error', phase: 'idle', received: 0, total: null, reason: 'missing' } });
  check('P4 error mode title', (await text(page, '#title')) === 'dreamcontext couldn’t start');
  check('P4 the message is rendered as text, exactly', (await text(page, '#detail')) === message);
  const injected = await page.evaluate(() => ({ img: document.querySelectorAll('#detail img').length, pwned: window.__pwned === 1 }));
  check('P4 markup in the message stays inert', injected.img === 0 && !injected.pwned);
  check('P4 offers "Try again" and Quit, no install controls', (await visible(page, '#b-restart')) && (await visible(page, '#b-quit')) && !(await visible(page, '#b-cancel')) && !(await visible(page, '#progress')));
  check('P4 never starts an install', !(await calls(page)).some((x) => x.cmd === 'node_setup_start'));
  await page.click('#b-restart');
  await sleep(100);
  check('P4 Try again asks for a relaunch', (await calls(page)).some((x) => x.cmd === 'node_setup_retry'));
  check('P4 no script errors', errors.length === 0, errors.join('; '));
  await shot(page, 'p4-error-mode');
  await context.close();
}

async function p5(browser) {
  const { page, context } = await open(browser, { reducedMotion: 'reduce' });
  const running = await page.evaluate(() => document.getAnimations().length);
  check('P5 reduced motion: nothing animates while starting', running === 0, `${running} animations`);
  await setStatus(page, { mode: 'install', phase: 'done', received: 1, total: 1, reason: 'missing' });
  const afterDone = await page.evaluate(() => document.getAnimations().length);
  check('P5 reduced motion: the Ready moment is still', afterDone === 0, `${afterDone} animations`);
  check('P5 reduced motion: status text is still present', (await text(page, '#status-text')) === 'Ready');
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  await p1(browser);
  await p2(browser);
  await p3(browser);
  await p4(browser);
  await p5(browser);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
