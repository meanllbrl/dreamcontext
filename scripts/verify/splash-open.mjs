#!/usr/bin/env node
/**
 * The opening screen PLAYS ITS CLIP, WITH SOUND, when only a gesture may start a video —
 * measured frame by frame in real Chrome.
 *
 *   node scripts/verify/splash-open.mjs            # dark appearance, the working-tree page
 *   node scripts/verify/splash-open.mjs --light    # prefers-color-scheme: light
 *   node scripts/verify/splash-open.mjs --old      # the pre-fix splash.html: MUST report FAIL
 *
 * Owner, 2026-10-04: the desktop app opened on the final lockup only, without sound. Cause
 * (measured): macOS Low Power Mode makes WebKit refuse every <video> play() no user gesture
 * started, muted or not, and the old page called play() itself. The fix lets the shell start
 * the clip through `webview.eval`, which WebKit counts as a gesture.
 *
 * This harness rebuilds that world in Chrome:
 *   - `--autoplay-policy=document-user-activation-required`: Chrome itself refuses an unmuted
 *     play() that no activation started. Chrome still lets a MUTED clip autoplay, which
 *     WebKit's Low Power Mode does not, so the instrumented play() also refuses a muted call
 *     made without activation (`navigator.userActivation.isActive`), as WebKit does.
 *   - The page is served over plain HTTP with NO Range support, like Tauri's asset handler.
 *   - A fake `window.__TAURI_INTERNALS__` is injected before the page's scripts. Its
 *     `invoke('splash_play')` reaches Node, which answers the way splash.rs does: it evaluates
 *     `window.__dcSplashPlay && window.__dcSplashPlay()` through CDP `Runtime.evaluate` with
 *     `userGesture: true` (the shell's eval). `invoke('splash_done')` is recorded.
 * Then it samples the card every ~100 ms (a screenshot plus video.currentTime) and decides
 * from what was painted: consecutive frames must differ, and the first frame of playback
 * must differ clearly from the last (the scattered dots against the finished lockup).
 *
 * Playwright's bundled Chromium has no H.264/AAC, so this drives the system Google Chrome
 * (`channel: 'chrome'`). Artifacts: tmp/verify/splash-open/<run>/.
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE_DIR = join(REPO, 'desktop', 'src-tauri', 'frontend-placeholder');
const ARGS = process.argv.slice(2);
const unknown = ARGS.filter((a) => a !== '--old' && a !== '--light');
if (unknown.length) {
  console.error(`splash-open: unknown argument(s) ${unknown.map((a) => JSON.stringify(a)).join(' ')} (expected --old, --light)`);
  process.exit(2);
}
const OLD = ARGS.includes('--old');
/** The last commit whose splash.html still played the clip itself; HEAD holds the fixed page once committed. */
const OLD_PAGE_COMMIT = '55c6ff92';
const LIGHT = process.argv.includes('--light');
const RUN = `${OLD ? 'old' : 'new'}-${LIGHT ? 'light' : 'dark'}`;
const OUT = join(REPO, 'tmp', 'verify', 'splash-open', RUN);
/** The splash window's size (splash.rs `inner_size`). */
const VIEW = { width: 720, height: 405 };
const SAMPLE_EVERY_MS = 100;
const SAMPLE_FOR_MS = 3200;
/**
 * Frames are compared as the share of pixels that moved (any channel by more than PIXEL_DELTA
 * of 255), not a mean: the light card is mostly near-white, and a mean drowns the motion in it.
 */
const PIXEL_DELTA = 20;
/** A consecutive pair "changed" when this share of its pixels moved. */
const FRAME_CHANGE = 0.005;
const MIN_CHANGING_PAIRS = 8;
/** The first frame of playback against the last sampled: the dots against the lockup. */
const FIRST_LAST_CHANGE = 0.02;

/** The directory to serve: the working tree, or the pre-fix page beside the same media. */
function pageRoot() {
  if (!OLD) return PAGE_DIR;
  const dir = join(REPO, 'tmp', 'verify', 'splash-open', 'old-page');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(PAGE_DIR)) if (f !== 'splash.html') copyFileSync(join(PAGE_DIR, f), join(dir, f));
  const head = execFileSync('git', ['show', `${OLD_PAGE_COMMIT}:desktop/src-tauri/frontend-placeholder/splash.html`], { cwd: REPO });
  writeFileSync(join(dir, 'splash.html'), head);
  return dir;
}

/** Full 200 bodies, Content-Type by extension, no Range, no Accept-Ranges: Tauri's handler. */
function serve(root) {
  const types = { '.html': 'text/html', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png' };
  const ranges = [];
  const srv = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
    if (req.headers.range) ranges.push(`${path} ${req.headers.range}`);
    const file = join(root, path || 'index.html');
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, ranges })));
}

/** Runs before the page's own script: the fake shell and the media instrumentation. */
const INIT = () => {
  const log = (window.__dcLog = []);
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  window.__TAURI_INTERNALS__ = {
    invoke(cmd) {
      log.push({ t: at(), kind: 'invoke', cmd });
      if (cmd === 'splash_play') return window.__dcVerifyShell(cmd);
      return Promise.resolve();
    },
  };
  const P = HTMLMediaElement.prototype;
  const play = P.play;
  P.play = function () {
    const active = navigator.userActivation.isActive;
    const entry = { t: at(), kind: 'play', muted: this.muted, volume: this.volume, active, result: 'pending' };
    log.push(entry);
    // WebKit's Low Power Mode refuses a muted clip too; Chrome would let it autoplay.
    if (this.muted && !active) {
      entry.result = 'rejected NotAllowedError (low-power: muted needs a gesture too)';
      return Promise.reject(new DOMException('play() needs a user gesture', 'NotAllowedError'));
    }
    const r = play.apply(this, arguments);
    r.then(() => { entry.result = 'resolved'; entry.mutedAtResolve = this.muted; },
      (e) => { entry.result = `rejected ${e.name}`; });
    return r;
  };
  for (const ev of ['canplay', 'playing', 'pause', 'ended', 'error']) {
    document.addEventListener(ev, (e) => log.push({ t: at(), kind: 'media', ev, ct: e.target.currentTime }), true);
  }
};

async function main() {
  const root = pageRoot();
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true });
  const { srv, port, ranges } = await serve(root);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=document-user-activation-required'],
  });
  try {
    const context = await browser.newContext({ viewport: VIEW, colorScheme: LIGHT ? 'light' : 'dark', reducedMotion: 'no-preference' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const shell = [];
    // splash.rs `splash_play`: answer, then eval `__dcSplashPlay` in the page as a gesture.
    await page.exposeBinding('__dcVerifyShell', async (_src, cmd) => {
      shell.push(cmd);
      cdp.send('Runtime.evaluate', {
        expression: 'window.__dcSplashPlay && window.__dcSplashPlay()',
        userGesture: true,
      }).catch((e) => shell.push(`eval failed: ${e.message}`));
    });
    await page.addInitScript(INIT);
    await page.goto(`http://127.0.0.1:${port}/splash.html`);

    const card = page.locator('#card');
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < SAMPLE_FOR_MS) {
      const tick = Date.now();
      const png = await card.screenshot({ animations: 'allow' });
      const state = await page.evaluate(() => {
        const v = document.getElementById('clip');
        return { ct: v.currentTime, paused: v.paused, muted: v.muted, card: document.getElementById('card').className };
      });
      const i = samples.length;
      writeFileSync(join(OUT, `f${String(i).padStart(2, '0')}.png`), png);
      samples.push({ ms: tick - start, png, ...state });
      const wait = SAMPLE_EVERY_MS - (Date.now() - tick);
      if (wait > 0) await page.waitForTimeout(wait);
    }
    // Let a late `ended` (and the page's done report) land.
    await page.waitForTimeout(800);
    const log = await page.evaluate(() => window.__dcLog);

    // Decode every frame small and compare consecutive pairs.
    const raws = await Promise.all(samples.map((s) =>
      sharp(s.png).resize(180, 101, { fit: 'fill' }).removeAlpha().raw().toBuffer()));
    const diff = (a, b) => {
      let moved = 0;
      for (let k = 0; k < a.length; k += 3) {
        if (Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2])) > PIXEL_DELTA) moved++;
      }
      return moved / (a.length / 3);
    };
    samples.forEach((s, i) => { s.diff = i ? diff(raws[i - 1], raws[i]) : 0; });
    const changing = samples.filter((s) => s.diff > FRAME_CHANGE).length;
    // The first frame showing the clip (currentTime moved), else the first frame at all.
    const first = Math.max(0, samples.findIndex((s) => s.ct > 0));
    const firstLast = diff(raws[first], raws[raws.length - 1]);

    const plays = log.filter((e) => e.kind === 'play');
    const unmutedPlay = plays.find((p) => p.result === 'resolved' && p.muted === false && p.mutedAtResolve === false);
    const maxCt = Math.max(...samples.map((s) => s.ct), ...log.filter((e) => e.kind === 'media').map((e) => e.ct));
    const ended = log.some((e) => e.kind === 'media' && e.ev === 'ended');
    const stilled = samples.some((s) => /\bstill\b/.test(s.card));
    // A timer must not cut a playing clip: done comes after `ended` (not applicable to the still).
    const endedAt = log.findIndex((e) => e.kind === 'media' && e.ev === 'ended');
    const doneAt = log.findIndex((e) => e.kind === 'invoke' && e.cmd === 'splash_done');
    const doneEvent = log[doneAt];
    const endedEvent = log[endedAt];
    const order = stilled
      ? ['splash_done after ended: n/a (still mode)', true]
      : [`splash_done reported only after ended (ended@${endedEvent ? endedEvent.t : '-'}ms, done@${doneEvent ? doneEvent.t : '-'}ms)`,
        endedAt > -1 && doneAt > endedAt];
    const invokes = log.filter((e) => e.kind === 'invoke').map((e) => `${e.cmd}@${e.t}`);

    console.log(`\nsplash-open  ${RUN}  (page: ${OLD ? `${OLD_PAGE_COMMIT} splash.html` : 'working tree'}, Chrome, autoplay needs activation)`);
    console.log('  ms    currentTime  paused  muted  card            moved-vs-prev');
    for (const s of samples) {
      console.log(`  ${String(s.ms).padStart(4)}  ${s.ct.toFixed(2).padStart(11)}  ${String(s.paused).padEnd(6)}  ${String(s.muted).padEnd(5)}  ${s.card.padEnd(14)}  ${(s.diff * 100).toFixed(1).padStart(5)}%${s.diff > FRAME_CHANGE ? ' *' : ''}`);
    }
    console.log('\n  play() calls:');
    for (const p of plays) console.log(`    @${p.t}ms muted=${p.muted} vol=${p.volume} activation=${p.active} -> ${p.result}`);
    console.log(`  invokes: ${invokes.join(', ') || '(none)'}   shell answered: ${shell.join(', ') || '(none)'}`);
    console.log(`  Range requests seen (served as full 200): ${ranges.length}`);

    const checks = [
      ['play() resolved with muted=false', !!unmutedPlay],
      [`currentTime reached >= 2.4 (max ${maxCt.toFixed(2)})`, maxCt >= 2.4],
      ['ended fired', ended],
      ['card never in still mode', !stilled],
      [`>= ${MIN_CHANGING_PAIRS} consecutive frame pairs changed > ${FRAME_CHANGE * 100}% (got ${changing})`, changing >= MIN_CHANGING_PAIRS],
      [`first playing frame (#${first}) vs last: > ${FIRST_LAST_CHANGE * 100}% of pixels moved (got ${(firstLast * 100).toFixed(1)}%)`, firstLast > FIRST_LAST_CHANGE],
      ['splash_done reported', doneAt > -1],
      order,
    ];
    console.log('');
    for (const [name, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
    const pass = checks.every(([, ok]) => ok);
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({
      run: RUN, pass, checks, plays, invokes, shell, ranges,
      samples: samples.map(({ png, ...s }) => s),
    }, null, 2));
    console.log(`\n${pass ? 'PASS' : 'FAIL'}  splash-open ${RUN}   frames: ${OUT}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await browser.close();
    srv.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
