#!/usr/bin/env node
/**
 * The notch OPENS WITH A VISIBLE GROW, and folds the same way — measured in real Chromium.
 *
 *   npm run build && node scripts/verify/notch-open-motion.mjs
 *   DC_VERIFY_DIST=tmp/x/index.js node scripts/verify/notch-open-motion.mjs --expect=jump
 *   node scripts/verify/notch-open-motion.mjs --reduced --expect=jump
 *
 * Owner, 2026-10-04: the notch "just appears". The window is transparent; what the owner sees
 * is the black island the webview draws. So this samples THAT, on every animation frame for
 * 600 ms after a click on the pill: the island's painted height (the root's height minus its
 * computed clip-path insets while open, the pill's own rect while folded). A grow passes
 * through intermediate heights over ~150-300 ms; the old notch went from the pill to the full
 * panel in one frame.
 *
 * `--expect=jump` inverts the verdict: the mutation proof (an older build, or reduced motion)
 * must show ONE jump and no intermediate height, or the instrument cannot tell the two apart.
 *
 * The real dashboard server on a scratch HOME and its own port; never the owner's server.
 * The browser preview (no Tauri) is what is driven: the window frame does not move there,
 * which is exactly the point — whatever grows is the CSS island.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distIndex, scratchDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = distIndex(REPO);
const SCRATCH = scratchDir('dreamcontext-verify-notch-motion');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'projects', 'acme-app');
const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const EXPECT = (process.argv.find((a) => a.startsWith('--expect=')) ?? '--expect=grow').slice('--expect='.length);
const REDUCED = process.argv.includes('--reduced');
/** The open notch's own size (Notch.tsx PANEL_W x PANEL_H). */
const VIEW = { width: 580, height: 560 };
const SAMPLE_MS = 600;

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
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(PROJ, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error(`dashboard server did not come up\n${log}`);
}

/**
 * In the page: click the pill, then read the island's painted height on every frame.
 * Open, the island is the root clipped by its computed clip-path (the CSS grow); folded it is
 * the pill. Insets are resolved against the root's box, whatever form Chromium serialises
 * them in (`38px`, `calc(100% - 38px)`, `calc(-112.5px + 37.5%)`).
 */
function sampleAfterClick({ ms, target = '.dc-notch__pill' }) {
  const resolve = (v, size) => {
    let total = 0;
    for (const m of v.replace(/^calc\(|\)$/g, '').matchAll(/([+-]?)\s*([\d.]+)(px|%)/g)) {
      const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
      total += m[3] === '%' ? (n / 100) * size : n;
    }
    return total;
  };
  const insets = (clip, w, h) => {
    const m = /^inset\((.*)\)$/.exec(clip.trim());
    if (!m) return { top: 0, right: 0, bottom: 0, left: 0 };
    const body = m[1].split(/\s+round\s+/)[0];
    const vals = body.match(/calc\([^)]*\)|[-\d.]+(?:px|%)?/g) ?? ['0px'];
    const [t, r = t, b = t, l = r] = vals;
    return { top: resolve(t, h), right: resolve(r, w), bottom: resolve(b, h), left: resolve(l, w) };
  };
  const read = () => {
    const root = document.querySelector('.dc-notch');
    if (!root) return null;
    const box = root.getBoundingClientRect();
    if (!root.classList.contains('dc-notch--open')) {
      const pill = root.querySelector('.dc-notch__pill').getBoundingClientRect();
      // A peek is the pill grown down by the peek: the frame seatPeek gives the desktop window
      // (the browser preview's window never shrinks to it, so the root's own box would lie).
      const peek = root.classList.contains('dc-notch--peek') ? root.querySelector('.dc-peek')?.getBoundingClientRect().height ?? 0 : 0;
      return { h: Math.round((pill.height + peek) * 10) / 10, open: false, peek: peek > 0, clip: 'none' };
    }
    const clip = getComputedStyle(root).clipPath;
    const i = insets(clip, box.width, box.height);
    return { h: Math.round((box.height - i.top - i.bottom) * 10) / 10, w: Math.round((box.width - i.left - i.right) * 10) / 10, open: true, clip };
  };
  return new Promise((done) => {
    const out = [];
    const t0 = performance.now();
    const first = read();
    out.push({ t: 0, ...first });
    document.querySelector(target).click();
    const tick = () => {
      const t = performance.now() - t0;
      out.push({ t: Math.round(t), ...read() });
      if (t < ms) requestAnimationFrame(tick); else done(out);
    };
    requestAnimationFrame(tick);
  });
}

/** How the sampled heights moved: intermediate values strictly between the two ends, and over how long. */
function analyse(samples) {
  const hs = samples.map((s) => s.h);
  const start = hs[0];
  const end = hs.at(-1);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const between = samples.filter((s) => s.h > lo + 0.5 && s.h < hi - 0.5);
  const firstMove = samples.findIndex((s) => Math.abs(s.h - start) > 0.5);
  let lastMove = -1;
  for (let i = samples.length - 1; i >= 0; i--) if (Math.abs(samples[i].h - end) > 0.5) { lastMove = i + 1; break; }
  const span = firstMove >= 0 && lastMove >= 0 ? samples[lastMove].t - samples[firstMove].t : 0;
  let monotonic = true;
  for (let i = 1; i < hs.length; i++) if ((end >= start && hs[i] < hs[i - 1] - 0.5) || (end < start && hs[i] > hs[i - 1] + 0.5)) monotonic = false;
  return { start, end, intermediate: between.length, span, monotonic };
}

const fails = [];
let pass = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
};
const show = (samples) => samples.map((s) => `${s.t}ms:${s.h}`).join('  ');

let server = null;
let browser = null;
try {
  if (!existsSync(join(dirname(CLI), 'dashboard', 'index.html'))) throw new Error(`${join(dirname(CLI), 'dashboard')} missing — build first`);
  console.log(`· build: ${CLI}\n· expect: ${EXPECT}${REDUCED ? ' (prefers-reduced-motion: reduce)' : ''}`);
  setupScratch();
  const port = await freePort();
  console.log(`· scratch dashboard server on ${port} (HOME=${HOME})`);
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  // The real assistant (its chat pane is what the grow must not re-lay out every frame).
  const created = await fetch(`${base}/api/assistant/create`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nova' }),
  }).then((r) => r.status).catch(() => 0);
  console.log(`· POST /api/assistant/create → ${created}`);

  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEW, reducedMotion: REDUCED ? 'reduce' : 'no-preference' });
  await page.goto(`${base}/?assistant=1`);
  await page.waitForSelector('.dc-notch__pill', { timeout: 20_000 });
  await page.waitForTimeout(800);   // boot settles (status, first seat)

  console.log('\n── open: click the pill, island height per frame');
  const open = await page.evaluate(sampleAfterClick, { ms: SAMPLE_MS });
  console.log(`  ${show(open)}`);
  const a = analyse(open);
  console.log(`  start ${a.start}px → end ${a.end}px, ${a.intermediate} intermediate frames over ${a.span} ms, monotonic=${a.monotonic}`);
  ok('open ends on the full panel', a.end >= VIEW.height - 2, `end ${a.end}`);
  ok('open starts at the pill', a.start < 60, `start ${a.start}`);

  await page.waitForTimeout(300);
  console.log('\n── fold: click the pill again');
  const fold = await page.evaluate(sampleAfterClick, { ms: SAMPLE_MS });
  console.log(`  ${show(fold)}`);
  const f = analyse(fold);
  console.log(`  start ${f.start}px → end ${f.end}px, ${f.intermediate} intermediate frames over ${f.span} ms, monotonic=${f.monotonic}`);
  ok('fold ends on the pill', f.end < 60, `end ${f.end}`);

  if (EXPECT === 'jump') {
    ok('MUTATION: open is one jump (no intermediate height)', a.intermediate === 0, `${a.intermediate} intermediate`);
    ok('MUTATION: fold is one jump (no intermediate height)', f.intermediate === 0, `${f.intermediate} intermediate`);
  } else {
    ok('open grows through intermediate heights (≥ 4 frames)', a.intermediate >= 4, `${a.intermediate} intermediate`);
    ok('open takes ~150-300 ms', a.span >= 150 && a.span <= 320, `${a.span} ms`);
    ok('open only ever grows', a.monotonic);
    ok('fold shrinks through intermediate heights (≥ 4 frames)', f.intermediate >= 4, `${f.intermediate} intermediate`);
    ok('fold takes ~150-300 ms', f.span >= 150 && f.span <= 320, `${f.span} ms`);
    ok('fold only ever shrinks', f.monotonic);
    // Last request wins: fold in the middle of an open ends folded, open in the middle of a fold ends open.
    console.log('\n── supersede: open then fold 90 ms in; fold then open 90 ms in');
    const race = await page.evaluate(async () => {
      const pill = () => document.querySelector('.dc-notch__pill');
      const root = () => document.querySelector('.dc-notch');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      pill().click(); await wait(90); pill().click(); await wait(500);
      const afterOpenFold = { open: root().classList.contains('dc-notch--open'), panelHidden: document.querySelector('.dc-notch__panel').hidden, clip: getComputedStyle(root()).clipPath };
      pill().click(); await wait(500);
      pill().click(); await wait(90); pill().click(); await wait(500);
      const afterFoldOpen = { open: root().classList.contains('dc-notch--open'), panelHidden: document.querySelector('.dc-notch__panel').hidden, clip: getComputedStyle(root()).clipPath };
      return { afterOpenFold, afterFoldOpen };
    });
    ok('open → fold mid-grow ends folded (pill, panel hidden)', !race.afterOpenFold.open && race.afterOpenFold.panelHidden, JSON.stringify(race.afterOpenFold));
    ok('fold → open mid-shrink ends open and unclipped', race.afterFoldOpen.open && !race.afterFoldOpen.panelHidden && race.afterFoldOpen.clip === 'none', JSON.stringify(race.afterFoldOpen));
  }

  // Opening FROM a peek: the hover peek's "Open the assistant" (NotchPeek onOpenChat → expand).
  // The island must grow from the peek it was, not snap back to the pill first.
  console.log('\n── open from a peek: hover the pill, click "Open the assistant", island height per frame');
  await page.evaluate(() => { if (document.querySelector('.dc-notch--open')) document.querySelector('.dc-notch__pill').click(); });
  await page.waitForTimeout(500);
  const pill = await page.locator('.dc-notch__pill').boundingBox();
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await page.waitForSelector('.dc-peek .dc-peek__open', { timeout: 5000 });
  await page.waitForTimeout(400);   // the peek's own drop-in (220 ms) has settled
  const peekH = await page.evaluate(() => {
    const pillH = document.querySelector('.dc-notch__pill').getBoundingClientRect().height;
    return Math.round((pillH + document.querySelector('.dc-peek').getBoundingClientRect().height) * 10) / 10;
  });
  const fromPeek = await page.evaluate(sampleAfterClick, { ms: SAMPLE_MS, target: '.dc-peek .dc-peek__open' });
  console.log(`  peek drawn at ${peekH}px`);
  console.log(`  ${show(fromPeek)}`);
  const p = analyse(fromPeek);
  const firstOpen = fromPeek.find((s) => s.open);
  console.log(`  start ${p.start}px → end ${p.end}px, first open frame ${firstOpen?.h}px, ${p.intermediate} intermediate frames over ${p.span} ms, monotonic=${p.monotonic}`);
  ok('a peek was showing before the click', fromPeek[0].peek === true && Math.abs(fromPeek[0].h - peekH) <= 1, JSON.stringify(fromPeek[0]));
  ok('peek open ends on the full panel', p.end >= VIEW.height - 2, `end ${p.end}`);
  if (EXPECT === 'jump') {
    ok('MUTATION: open from the peek is one jump', p.intermediate === 0, `${p.intermediate} intermediate`);
  } else {
    ok('the first open frame starts at the peek\'s height (±8 px), not the pill\'s', firstOpen && Math.abs(firstOpen.h - peekH) <= 8, `first open ${firstOpen?.h}, peek ${peekH}`);
    ok('open from the peek grows through intermediate heights (≥ 4 frames)', p.intermediate >= 4, `${p.intermediate} intermediate`);
    ok('open from the peek takes ~150-300 ms', p.span >= 150 && p.span <= 320, `${p.span} ms`);
    ok('open from the peek only ever grows', p.monotonic);
  }
} catch (err) {
  fails.push(String(err?.stack ?? err));
  console.log(`  ✗ ${err?.stack ?? err}`);
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
