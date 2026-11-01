/**
 * What one board costs: the same pan and zoom script against a COPY of a real board, in a real
 * browser, with the numbers printed as a table. Before and after a change run the same script,
 * so the two tables compare. The source board is only ever read.
 *
 *   node scripts/verify/whiteboard-perf.mjs --board <dir holding <slug>.excalidraw.md> \
 *     [--label before] [--engine chromium|webkit] [--limit 40] [--trace] [--dark]
 *
 * --limit keeps the first N elements, the "small board" control. --trace adds a Chromium trace
 * and a CPU profile; both slow the page down, so the timing tables never come from a traced run.
 * Server and UI are the built ones (DC_VERIFY_DIST picks which): a dev build's timings are not
 * the product's.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = (name) => process.argv.includes(`--${name}`);

const boardDir = resolve(arg('board', ''));
const slug = basename(boardDir);
const label = arg('label', 'run');
const engine = arg('engine', 'chromium');
const limit = Number(arg('limit', 0));
const out = resolve('tmp', 'wb-perf');
mkdirSync(out, { recursive: true });
const name = `${label}-${engine}${limit ? `-small${limit}` : ''}${flag('dark') ? '-dark' : ''}${flag('trace') ? '-trace' : ''}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tree() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command=']).toString().trim().split('\n').map((l) => {
    const [, pid, ppid, rss, command] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command };
  });
}
function descendants(root, rows) {
  const seen = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (seen.has(r.ppid) && !seen.has(r.pid)) { seen.add(r.pid); grew = true; }
  }
  seen.delete(root);
  return seen;
}

const app = await openApp({ suite: 'whiteboard-perf', build: true });
const report = { label, engine, board: slug, limit, phases: {} };
let browser;
try {
  // ── the copy ───────────────────────────────────────────────────────────────────────────
  const dest = join(app.proj, '_dream_context', 'whiteboards', slug);
  cpSync(boardDir, dest, { recursive: true });
  const file = join(dest, `${slug}.excalidraw.md`);
  if (limit) {
    const text = readFileSync(file, 'utf8');
    const m = /```json\n([\s\S]*?)```/.exec(text);
    const doc = JSON.parse(m[1]);
    doc.elements = doc.elements.filter((e) => !e.isDeleted).slice(0, limit);
    writeFileSync(file, text.replace(m[1], `${JSON.stringify(doc, null, '\t')}\n`));
  }
  const doc = JSON.parse(/```json\n([\s\S]*?)```/.exec(readFileSync(file, 'utf8'))[1]);
  const live = doc.elements.filter((e) => !e.isDeleted);
  const images = live.filter((e) => e.type === 'image');
  report.board_facts = {
    elements: live.length,
    images: images.length,
    embeddables: live.filter((e) => e.type === 'embeddable').length,
    files: existsSync(join(dest, 'files')) ? readdirSync(join(dest, 'files')).length : 0,
  };

  // ── the browser: ours, so its processes are the only ones counted ──────────────────────
  const before = new Set(descendants(process.pid, tree()));
  // WebKit's web and GPU processes are launchd's children (XPC), not the browser's.
  const webkitBefore = new Set(tree().filter((r) => /ms-playwright\/webkit/.test(r.command)).map((r) => r.pid));
  const launcher = engine === 'webkit' ? webkit : chromium;
  browser = await launcher.launch(engine === 'chromium'
    ? { channel: 'chromium', args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] }
    : {});
  const ours = () => {
    const rows = tree();
    const set = descendants(process.pid, rows);
    return rows.filter((r) => (set.has(r.pid) && !before.has(r.pid)) || (/ms-playwright\/webkit/.test(r.command) && !webkitBefore.has(r.pid)));
  };
  const rssMb = () => Math.round(ours().reduce((s, r) => s + r.rss, 0) / 1024);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: flag('dark') ? 'dark' : 'light' });
  await markAnnouncementsSeen(context, app.base);
  await context.addInitScript(() => {
    const p = { long: [], frames: null, loaf: [] };
    window.__perf = p;
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) p.long.push({ t: e.startTime, d: e.duration }); })
        .observe({ type: 'longtask', buffered: true });
    } catch { p.noLongTask = true; }
    p.start = () => {
      p.long.length = 0;
      p.frames = [];
      let last = performance.now();
      const tick = (now) => {
        if (!p.frames) return;
        p.frames.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    p.stop = () => { const frames = p.frames; p.frames = null; return { frames, long: p.long.map((l) => l.d) }; };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const fileHits = { count: 0, bytes: 0, last: 0 };
  page.on('response', async (r) => {
    if (!/\/files\//.test(r.url())) return;
    fileHits.count += 1;
    fileHits.last = Date.now();
    fileHits.bytes += (await r.request().sizes().catch(() => null))?.responseBodySize ?? 0;
  });

  const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
  if (cdp) await cdp.send('Performance.enable');
  const metrics = async () => {
    const m = { rss_mb: rssMb() };
    if (cdp) {
      const { metrics: list } = await cdp.send('Performance.getMetrics');
      const by = Object.fromEntries(list.map((x) => [x.name, x.value]));
      m.js_heap_mb = Math.round(by.JSHeapUsedSize / 1e6);
      m.dom_nodes = by.Nodes;
    }
    m.canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
    m.iframes = await page.evaluate(() => document.querySelectorAll('iframe').length);
    m.widgets = await page.evaluate(() => document.querySelectorAll('.excalidraw__embeddable-container').length);
    return m;
  };

  // ── open: from navigation until the page has been quiet for two seconds ────────────────
  await page.goto(`${app.base}/?vault=proj&page=whiteboards#wb=${slug}`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  await page.evaluate(() => window.__perf.start());
  await page.waitForLoadState('load').catch(() => {});
  const rail = page.locator('.sidebar-item, [role="navigation"] button, nav button').filter({ has: page.locator('svg') });
  const named = page.locator('[aria-label*="hiteboard"], [title*="hiteboard"], .sidebar-item:has-text("Whiteboard")').first();
  await named.click({ timeout: 15_000 }).catch(async () => { console.log('rail items:', await rail.count()); throw new Error('no whiteboard rail item'); });
  await page.locator('.excalidraw canvas.static').first().waitFor({ state: 'visible', timeout: 60_000 });
  const firstCanvasMs = Date.now() - t0;
  for (let quiet = 0, seen = -1; quiet < 8 && Date.now() - t0 < 120_000; await sleep(250)) {
    const longs = await page.evaluate(() => window.__perf.long.length);
    const now = fileHits.count * 1000 + longs;
    quiet = now === seen ? quiet + 1 : 0;
    seen = now;
  }
  const openStats = await page.evaluate(() => window.__perf.stop());
  report.open = {
    first_canvas_ms: firstCanvasMs,
    settled_ms: Date.now() - t0 - 2000,
    file_requests: fileHits.count,
    file_mb: Math.round(fileHits.bytes / 1e6),
    ...summary(openStats),
    ...(await metrics()),
  };
  await page.screenshot({ path: join(out, `${name}-1-open.png`) });

  // ── the script, the same every run ─────────────────────────────────────────────────────
  const box = await page.locator('.excalidraw canvas.static').first().boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  report.canvas = box;
  await page.mouse.move(centre.x, centre.y);
  const zoomText = () => page.locator('.reset-zoom-button, .zoom-reset').first().innerText({ timeout: 1000 }).catch(() => '?');
  const pan = async (events = 240, pace = 16) => {
    for (let i = 0; i < events; i += 1) {
      const a = (i / events) * Math.PI * 4;
      await page.mouse.wheel(Math.round(Math.cos(a) * 60), Math.round(Math.sin(a) * 60));
      await sleep(pace);
    }
  };
  const zoomSweep = async (steps = 24, rounds = 3, pace = 16) => {
    await page.keyboard.down('Control');
    for (let r = 0; r < rounds; r += 1) {
      for (const dir of [-1, 1]) {
        for (let i = 0; i < steps; i += 1) {
          await page.mouse.wheel(0, dir * 10);
          await sleep(pace);
        }
      }
    }
    await page.keyboard.up('Control');
  };
  const zoomPct = async () => parseInt(await zoomText(), 10);
  /** Wheel to `pct`, however fast this engine takes the events. */
  const zoomTo = async (pct) => {
    await page.keyboard.down('Control');
    for (let i = 0; i < 200; i += 1) {
      const now = await zoomPct();
      if (Math.abs(now - pct) <= Math.max(5, pct * 0.06)) break;
      await page.mouse.wheel(0, now < pct ? -10 : 10);
      await sleep(30);
    }
    await page.keyboard.up('Control');
  };
  /** Stop at each level: Excalidraw rebuilds every visible picture's bitmap once the wheel rests. */
  const zoomStops = async () => {
    for (const pct of [25, 50, 100, 150, 100, 50, 25, 10]) {
      await zoomTo(pct);
      await sleep(700);
    }
  };
  const phase = async (key, act, shot) => {
    await page.evaluate(() => window.__perf.start());
    const started = Date.now();
    await act();
    await sleep(600); // the settle the owner also waits through: the redraw after the gesture
    const stats = await page.evaluate(() => window.__perf.stop());
    report.phases[key] = { ms: Date.now() - started, zoom: await zoomText(), ...summary(stats), ...(await metrics()) };
    if (shot) await page.screenshot({ path: join(out, `${name}-${shot}.png`) });
  };

  let tracing = false;
  if (flag('trace') && engine === 'chromium') {
    await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.image_decoding', 'cc', 'gpu', 'toplevel', 'v8', 'blink.canvas', 'disabled-by-default-v8.gc'], screenshots: false });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    tracing = true;
  }
  const zoom0 = await zoomText();
  await phase('pan-fit', () => pan(), '2-pan-fit');
  await phase('zoom-sweep', () => zoomSweep(), '3-zoom-sweep');
  await phase('zoom-stops', () => zoomStops(), '3b-zoom-stops');
  await zoomTo(100);
  if (await zoomText() === zoom0) throw new Error(`the wheel never reached the board: zoom stayed ${zoom0}`);
  await sleep(1500);
  await phase('pan-100', () => pan(), '4-pan-100');
  await zoomTo(300);
  await sleep(1500);
  await phase('pan-close', () => pan(120), '5-pan-close');
  if (tracing) {
    const { profile } = await cdp.send('Profiler.stop');
    const buffer = await browser.stopTracing();
    report.trace = summariseTrace(buffer);
    report.cpu = summariseProfile(profile);
  }
  await sleep(2500);
  await page.screenshot({ path: join(out, `${name}-6-rest-close.png`) });
  report.rest = await metrics();
  report.errors = [...new Set(errors)].slice(0, 12);
} finally {
  await browser?.close().catch(() => {});
  await app.stop();
}

writeFileSync(join(out, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`);
printTable(report);
process.exit(0);

// ───────────────────────────────────────────────────────────────────────────────────────────

function summary({ frames, long }) {
  const f = (frames ?? []).slice(1).sort((a, b) => a - b);
  const at = (q) => Math.round(f[Math.min(f.length - 1, Math.floor(f.length * q))] ?? 0);
  const share = (lim) => (f.length ? Math.round((f.filter((d) => d <= lim).length / f.length) * 100) : 0);
  return {
    frames: f.length,
    median_ms: at(0.5),
    p95_ms: at(0.95),
    p99_ms: at(0.99),
    max_ms: Math.round(f[f.length - 1] ?? 0),
    within_33ms_pct: share(34),
    over_100ms: f.filter((d) => d > 100).length,
    long50: long.length,
    long100: long.filter((d) => d > 100).length,
    long_max_ms: Math.round(Math.max(0, ...long)),
    long_sum_ms: Math.round(long.reduce((a, b) => a + b, 0)),
  };
}

function summariseTrace(buffer) {
  const { traceEvents = [] } = JSON.parse(buffer.toString());
  const threads = new Map();
  for (const e of traceEvents) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args?.name);
  const by = new Map();
  for (const e of traceEvents) {
    if (e.ph !== 'X' || !e.dur) continue;
    const key = `${threads.get(`${e.pid}:${e.tid}`) ?? '?'} | ${e.name}`;
    const cur = by.get(key) ?? { ms: 0, n: 0 };
    cur.ms += e.dur / 1000;
    cur.n += 1;
    by.set(key, cur);
  }
  return [...by.entries()].map(([k, v]) => ({ k, ms: Math.round(v.ms), n: v.n })).sort((a, b) => b.ms - a.ms).slice(0, 45);
}

function summariseProfile(profile) {
  const self = new Map(profile.nodes.map((n) => [n.id, 0]));
  (profile.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0)));
  const by = new Map();
  for (const n of profile.nodes) {
    const c = n.callFrame;
    const key = `${c.functionName || '(anon)'} ${c.url ? `${c.url.split('/').pop()}:${c.lineNumber}` : ''}`.trim();
    by.set(key, (by.get(key) ?? 0) + self.get(n.id));
  }
  return [...by.entries()].map(([k, us]) => ({ k, ms: Math.round(us / 1000) })).sort((a, b) => b.ms - a.ms).slice(0, 30);
}

function printTable(r) {
  const row = (k, p) => `| ${k} | ${p.zoom ?? ''} | ${p.frames} | ${p.median_ms} | ${p.p95_ms} | ${p.max_ms} | ${p.within_33ms_pct}% | ${p.over_100ms} | ${p.long100}/${p.long50} | ${p.long_sum_ms} | ${p.rss_mb} | ${p.js_heap_mb ?? '-'} |`;
  console.log(`\n${name}  ${JSON.stringify(r.board_facts)}`);
  console.log(`open: first canvas ${r.open.first_canvas_ms} ms, settled ${r.open.settled_ms} ms, ${r.open.file_requests} file requests, ${r.open.file_mb} MB, canvases ${r.open.canvases}, iframes ${r.open.iframes}, widgets ${r.open.widgets}, DOM ${r.open.dom_nodes}`);
  console.log('| phase | zoom | frames | median | p95 | max | ≤33ms | >100ms frames | long >100/>50 | long sum | RSS MB | JS heap MB |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  console.log(row('open', r.open));
  for (const [k, p] of Object.entries(r.phases)) console.log(row(k, p));
  console.log(`rest: RSS ${r.rest.rss_mb} MB, heap ${r.rest.js_heap_mb ?? '-'} MB`);
  if (r.errors?.length) console.log('errors:', r.errors);
  if (r.trace) { console.log('\ntrace top:'); for (const t of r.trace.slice(0, 30)) console.log(`${String(t.ms).padStart(7)} ms ×${t.n}  ${t.k}`); }
  if (r.cpu) { console.log('\ncpu self top:'); for (const c of r.cpu.slice(0, 18)) console.log(`${String(c.ms).padStart(7)} ms  ${c.k}`); }
}
