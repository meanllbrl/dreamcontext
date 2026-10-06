#!/usr/bin/env node
/**
 * Whiteboard round two (owner feedback 2026-10-06), in real Chromium, one recorded video per item.
 *
 *   npm run build && node scripts/verify/whiteboard-round2.mjs
 *
 * Boots the REAL dashboard server (desktop mode) from the BUILT dashboard + CLI on an isolated
 * scratch vault (fake HOME), seeds a board with the CLI, then for each item opens a fresh page
 * that records a video, with a caption bar and a visible cursor so the owner can follow it:
 *   W1  the wheel over an HTML block: inactive pans the board; active and too long scrolls the
 *       block; at its top the next wheel pans the board; a pinch zooms the board.
 *   W8  short content fills its card: an HTML block's heading on top, its grid takes the spare
 *       height, its last line on the card's bottom edge; a pie insight's chart fills its card.
 *   W3  a new agent card from the palette comes in at 376x572.
 *   W2  the web block shows a project .html file, a picture, a page on this machine (after
 *       Load), and a file outside the project only after Allow access; the palette takes a
 *       file path and refuses a .txt with a reason; the CLI takes localhost and a file and
 *       refuses http://example.com, `..` and a .txt.
 *   W7  a picture dropped from Finder stays on the board: its bytes land in the board's folder,
 *       it is there after a reload, `whiteboard add <slug> image --file` puts one on the open
 *       board, and an SVG is refused with a reason and leaves nothing behind.
 *   E   no console or page errors.
 * Videos (mp4) and screenshots go to tmp/videos/round2 in the repo.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-whiteboard-round2');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const DC = join(PROJ, '_dream_context');
const OUTSIDE = join(SCRATCH, 'outside');
const OUT = join(REPO, 'tmp', 'videos', 'round2');
const RAW = join(SCRATCH, 'raw-video');
const PORT = 45768;
const DEV_PORT = 45769;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');
const BOARD = 'tur-iki';
const VIEW = { width: 1440, height: 900 };

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
const dc = (args, cwd = PROJ) => execFileSync('node', [CLI, ...args], { cwd, env: { ...process.env, HOME }, encoding: 'utf-8' });
const dcFails = (args) => { try { execFileSync('node', [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, stdio: 'pipe' }); return null; } catch (e) { return String(e.stderr || e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

/** A one-page PDF that says `text`, with a correct xref. */
function tinyPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 28 Tf 40 160 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const ids = {};
function setup(pngBytes) {
  rmSync(SCRATCH, { recursive: true, force: true });
  // Not the whole folder: the agent panel suite writes its own items' videos beside these.
  for (const d of [join(DC, 'state'), join(HOME, '.dreamcontext'), OUTSIDE, OUT, RAW, join(PROJ, 'docs')]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], REPO);
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }

  writeFileSync(join(PROJ, 'docs', 'rapor.html'), '<!doctype html><html><body style="font-family:system-ui;padding:16px"><h1 id="doc-title">Haftalık rapor</h1><p>Bu dosya projenin docs klasöründen açıldı.</p><ul><li>Kayıt: 1.284</li><li>Deneme: 312</li><li>Abonelik: 96</li></ul></body></html>', 'utf-8');
  writeFileSync(join(PROJ, 'docs', 'grafik.png'), pngBytes);
  writeFileSync(join(PROJ, 'docs', 'sunum.pdf'), tinyPdf('Sunum PDF'), 'latin1');
  writeFileSync(join(PROJ, 'docs', 'notlar.txt'), 'plain text', 'utf-8');
  writeFileSync(join(OUTSIDE, 'disaridaki.html'), '<!doctype html><html><body style="font-family:system-ui;padding:16px"><h1 id="outside-title">Proje dışındaki dosya</h1><p>İzin verildikten sonra gösterildi.</p></body></html>', 'utf-8');

  mkdirSync(join(DC, 'lab', 'scripts'), { recursive: true });
  dc(['lab', 'create', 'kaynaklar', '--title', 'Trafik kaynakları', '--render', 'pie', '--adapter', 'script']);
  writeFileSync(join(DC, 'lab', 'scripts', 'kaynaklar.mjs'), `export default async function () {
  const t = new Date().toISOString();
  return [['Organik', 420], ['Reklam', 260], ['Referans', 140], ['Direkt', 95]].map(([name, v]) => ({ name, points: [{ t, v }] }));
}
`, 'utf-8');
  dc(['lab', 'sync', 'kaynaklar']);

  const promptFile = join(SCRATCH, 'prompt.md');
  writeFileSync(promptFile, 'Summarise the board.\n', 'utf-8');
  dc(['automations', 'create', 'pano-yardimcisi', '--title', 'Pano yardımcısı', '--mode', 'call', '--no-notify', '--prompt-file', promptFile]);

  dc(['whiteboard', 'create', 'Tur iki']);
  const add = (args) => JSON.parse(dc(['whiteboard', 'add', BOARD, ...args, '--json'])).id;
  // W1: a block far too long for its card, and one that fits.
  const huge = '<div class="dc-stack"><h3 class="dc-h3">Uzun liste</h3>' + Array.from({ length: 60 }, (_, i) => `<p class="dc-p">Satır ${i + 1}</p>`).join('') + '<p class="dc-p" id="huge-last">SON</p></div>';
  ids.huge = add(['html', '--title', 'Uzun blok', '--text', huge, '--at', '0,0', '--size', '376,376']);
  ids.short = add(['html', '--title', 'Kısa blok', '--text', '<div class="dc-doc"><div class="dc-h3">Kısa</div><p class="dc-p">Kartına sığıyor.</p></div>', '--at', '392,0', '--size', '376,376']);
  // W8: the owner's "İş akışı" shape, the roadmap shape, and a pie.
  const flow = '<div class="dc-doc"><div class="dc-h3" id="flow-head">İş akışı</div><p class="dc-muted">Darboğaz incelemede: 32 iş onay bekliyor.</p>'
    + '<div class="dc-grid dc-grid--3"><div class="dc-stat"><div class="dc-stat-label">Todo</div><div class="dc-value">54</div></div>'
    + '<div class="dc-stat"><div class="dc-stat-label">Sürüyor</div><div class="dc-value">8</div></div>'
    + '<div class="dc-stat" id="flow-stat"><div class="dc-stat-label">İncelemede</div><div class="dc-value" id="flow-value">32</div></div></div>'
    + '<div class="dc-divider"></div><div class="dc-label">Kural</div><p class="dc-p" id="flow-foot">Yeni iş açmadan önce bekleyen 3 işi kapat.</p></div>';
  ids.flow = add(['html', '--title', 'İş akışı', '--text', flow, '--at', '0,1176', '--size', '376,572']);
  const goals = '<div class="dc-doc"><div class="dc-h2">Hedefler</div><p class="dc-muted">5 hedeften 4\'ü kayıyor.</p><div class="dc-stack">'
    + [['Gelir', 43], ['Ekip', 95], ['Sade arayüz', 68], ['Uyku', 68], ['Hatırlama', 54]].map(([l, w]) => `<div class="dc-bar"><span class="dc-bar-label">${l}</span><div class="dc-bar-track"><div class="dc-bar-fill" style="width:${w}%"></div></div><span class="dc-bar-value">${w}%</span></div>`).join('')
    + '</div><div class="dc-row" id="goals-foot"><span class="dc-chip dc-chip--bad">4 kayıyor</span><span class="dc-chip dc-chip--good">1 yolunda</span></div></div>';
  ids.goals = add(['html', '--title', 'Hedefler', '--text', goals, '--at', '392,1176', '--size', '768,572']);
  ids.pie = add(['insight', '--ref', 'kaynaklar', '--title', 'Trafik kaynakları', '--at', '1176,1176', '--size', '376,376']);
  // W2: files and a page on this machine.
  ids.webHtml = add(['web', '--url', 'docs/rapor.html', '--title', 'rapor.html', '--at', '0,2352', '--size', '376,376']);
  ids.webPng = add(['web', '--url', './docs/grafik.png', '--title', 'grafik.png', '--at', '392,2352', '--size', '376,376']);
  ids.webPdf = add(['web', '--url', 'docs/sunum.pdf', '--title', 'sunum.pdf', '--at', '784,2352', '--size', '376,376']);
  ids.webLocal = add(['web', '--url', `localhost:${DEV_PORT}`, '--title', 'Geliştirme sunucusu', '--at', '0,2744', '--size', '376,376']);
  ids.webOutside = add(['web', '--url', join(OUTSIDE, 'disaridaki.html'), '--title', 'disaridaki.html', '--at', '392,2744', '--size', '376,376']);
}

/** The Excalidraw App instance (scene + state + its own methods). */
const APP = `(() => {
  const root = document.querySelector('.wbp-canvas .excalidraw');
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
  for (let f = key ? root[key] : null; f; f = f.return) { const s = f.stateNode; if (s && s.scene && s.state && s.state.zoom) return s; }
  return null;
})()`;
const readScene = (page) => page.evaluate(`(() => { const s = ${APP}; if (!s) return null; const st = s.state;
  return { zoom: st.zoom.value, scrollX: st.scrollX, scrollY: st.scrollY, offsetLeft: st.offsetLeft, offsetTop: st.offsetTop,
    elements: s.scene.getElementsIncludingDeleted().filter((e) => !e.isDeleted).map((e) => ({ id: e.id, type: e.type, fileId: e.fileId, x: e.x, y: e.y, width: e.width, height: e.height, kind: e.customData?.dc?.kind, size: e.customData?.dc?.size })) }; })()`);
/** The picture data the canvas holds for `fileId` (its mime type), or null. */
const heldFile = (page, fileId) => page.evaluate(`(() => { const s = ${APP}; const f = s && s.files && s.files[${JSON.stringify(fileId ?? '')}]; return f && typeof f.dataURL === 'string' && f.dataURL.startsWith('data:') ? f.mimeType : null; })()`);
/** Drop a file onto the canvas at a client point, as Finder does. */
const dropFile = (page, at, b64, name, type) => page.evaluate(({ at, b64, name, type }) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type }));
  const target = document.elementFromPoint(at.x, at.y);
  for (const kind of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, dataTransfer: dt }));
  }
}, { at, b64, name, type });
const toClient = (s, x, y) => ({ x: (x + s.scrollX) * s.zoom + s.offsetLeft, y: (y + s.scrollY) * s.zoom + s.offsetTop });
/** Bring these elements into view, fitted, the way the board's own zoom-to-fit does. */
const showElements = (page, list) => page.evaluate(`(() => { const s = ${APP}; const want = new Set(${JSON.stringify(list)});
  const els = s.scene.getNonDeletedElements().filter((e) => want.has(e.id));
  s.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.85, animate: false }); })()`);

/** A caption bar and a visible cursor: Playwright's video shows neither on its own. */
const OVERLAY = `(() => {
  // The top page only: an init script also runs in every frame, and a caption inside a board
  // block would be a second root element in it (the fill rule keys on a lone root).
  if (window.top !== window) return;
  const install = () => {
    if (document.getElementById('rec-cap')) return;
    const cap = document.createElement('div');
    cap.id = 'rec-cap';
    cap.style.cssText = 'position:fixed;left:50%;bottom:140px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;'
      + 'background:rgba(20,18,30,.92);color:#fff;font:600 17px/1.35 system-ui;padding:10px 18px;border-radius:12px;max-width:80vw;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35)';
    document.body.appendChild(cap);
    const dot = document.createElement('div');
    dot.id = 'rec-cursor';
    dot.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;z-index:2147483647;pointer-events:none;'
      + 'background:rgba(124,92,255,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4);transition:transform .08s';
    document.body.appendChild(dot);
    const move = (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; };
    addEventListener('pointermove', move, true);
    addEventListener('pointerdown', () => { dot.style.transform = 'scale(.7)'; }, true);
    addEventListener('pointerup', () => { dot.style.transform = ''; }, true);
  };
  if (document.body) install(); else addEventListener('DOMContentLoaded', install);
})()`;
const caption = (page, text) => page.evaluate((t) => { const c = document.getElementById('rec-cap'); if (c) { c.textContent = t; c.style.display = t ? '' : 'none'; } }, text);

async function glide(page, from, to, steps = 18) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.move(to.x, to.y, { steps });
}
async function wheelSlowly(page, dy, times, opts = {}) {
  for (let i = 0; i < times; i++) {
    if (opts.ctrl) await page.keyboard.down('Control');
    await page.mouse.wheel(0, dy);
    if (opts.ctrl) await page.keyboard.up('Control');
    await sleep(opts.pause ?? 140);
  }
}

async function main() {
  const browser = await chromium.launch();
  // A real picture for the web block, drawn once.
  const pngPage = await browser.newPage({ viewport: { width: 480, height: 300 } });
  await pngPage.setContent('<body style="margin:0;display:grid;place-items:center;height:100vh;background:linear-gradient(135deg,#7c5cff,#22c1c3);font:700 42px system-ui;color:#fff">grafik.png</body>');
  const png = await pngPage.screenshot();
  // W7: the picture dropped onto the board.
  await pngPage.setContent('<body style="margin:0;display:grid;place-items:center;height:100vh;background:linear-gradient(135deg,#ff7a59,#ffc857);font:700 40px system-ui;color:#1d1630">Haftalık tablo</body>');
  const tablo = await pngPage.screenshot();
  await pngPage.close();
  setup(png);

  const dev = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><body style="font-family:system-ui;padding:16px;background:#fff8e6"><h1 id="dev-title">Geliştirme sunucusu</h1><p>localhost üzerinde çalışan sayfa.</p></body>');
  }).listen(DEV_PORT, '127.0.0.1');

  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  const errors = [];
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${ORIGIN}/api/whiteboards`)).ok) break; } catch { /* not yet */ } await sleep(200); }

    async function enterBoard(page) {
      await sleep(800);
      if (await page.locator('.announcements-modal-scrim').count()) { await page.keyboard.press('Escape'); await sleep(300); }
      await page.locator('.sidebar-item', { hasText: /Whiteboard(?!s)/ }).first().click();
      await page.locator('.wbt-tab', { hasText: 'Tur iki' }).first().click({ timeout: 10000 }).catch(async () => {
        await page.locator('.wbt-all').click();
        await page.locator('.wbs-panel--boards .wbs-row-open', { hasText: 'Tur iki' }).click();
      });
      await page.locator('.wb-widget').first().waitFor({ state: 'attached', timeout: 15000 });
    }
    async function openBoard(name) {
      const t0 = Date.now();
      const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: RAW, size: VIEW }, colorScheme: 'dark' });
      await ctx.addInitScript(OVERLAY);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|status of 40[34]/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
      await page.goto(`${ORIGIN}/?vault=proj#wb=${BOARD}`, { waitUntil: 'networkidle' });
      await enterBoard(page);
      await page.evaluate(OVERLAY);
      await sleep(1200);
      // The video starts at the board, not at the app loading under the What's New card.
      ctx.trimStart = Math.max(0, (Date.now() - t0) / 1000 - 0.5);
      return { ctx, page };
    }
    async function finish(name, ctx, page) {
      await caption(page, '');
      await sleep(400);
      const video = page.video();
      await ctx.close();
      const webm = await video.path();
      const mp4 = join(OUT, `${name}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(ctx.trimStart ?? 0), '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', mp4]);
    }
    const centreOf = async (page, id) => {
      const s = await readScene(page);
      const el = s.elements.find((e) => e.id === id);
      return toClient(s, el.x + el.width / 2, el.y + el.height / 2);
    };
    const frameFor = async (page, needle) => {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        if (await f.locator(needle).count().catch(() => 0)) return f;
      }
      return null;
    };

    // ── W1 the wheel over an HTML block ─────────────────────────────────────────────────────
    {
      const { ctx, page } = await openBoard('W1');
      await showElements(page, [ids.huge, ids.short]);
      await sleep(900);
      await caption(page, '1) HTML üstünde kaydırma: kart AKTİF DEĞİLKEN tekerlek tahtayı kaydırır');
      await sleep(1500);
      let c = await centreOf(page, ids.short);
      await glide(page, { x: c.x - 300, y: c.y + 260 }, c);
      let before = await readScene(page);
      await wheelSlowly(page, 60, 6);
      let after = await readScene(page);
      ok('W1 over an inactive block the wheel pans the board', after.scrollY !== before.scrollY, JSON.stringify({ b: before.scrollY, a: after.scrollY }));
      await sleep(600);
      await showElements(page, [ids.huge, ids.short]);
      await sleep(700);
      await caption(page, 'Uzun bloğa tıklayıp aktif edince: tekerlek önce bloğun İÇERİĞİNİ kaydırır, tahta durur');
      c = await centreOf(page, ids.huge);
      await glide(page, { x: c.x + 200, y: c.y }, c);
      await page.mouse.click(c.x, c.y);
      await sleep(900);
      c = await centreOf(page, ids.huge);
      await page.mouse.move(c.x + 5, c.y + 5);
      await page.mouse.move(c.x, c.y);
      const hugeFrame = await frameFor(page, '#huge-last');
      before = await readScene(page);
      const top0 = hugeFrame ? await hugeFrame.evaluate(() => (document.scrollingElement || document.documentElement).scrollTop) : -1;
      await wheelSlowly(page, 80, 8);
      after = await readScene(page);
      const top1 = hugeFrame ? await hugeFrame.evaluate(() => (document.scrollingElement || document.documentElement).scrollTop) : -1;
      ok('W1 an active block too long for its card scrolls its own content…', top1 > top0, JSON.stringify({ top0, top1 }));
      ok('W1 …and the board stays', after.scrollY === before.scrollY && after.scrollX === before.scrollX);
      await sleep(700);
      await caption(page, 'Yukarı geri kaydırınca: içerik başa dönünce sıradaki tekerlek tahtayı kaydırır');
      await wheelSlowly(page, -80, 8);
      await sleep(300);
      // A forwarded pan moves the card from under the pointer: re-enter it, as a hand would.
      c = await centreOf(page, ids.huge);
      await page.mouse.move(c.x + 3, c.y + 3);
      await page.mouse.move(c.x, c.y);
      before = await readScene(page);
      await wheelSlowly(page, -60, 4);
      after = await readScene(page);
      ok('W1 scrolled back to its top, the next wheel up pans the board', after.scrollY > before.scrollY, JSON.stringify({ b: before.scrollY, a: after.scrollY }));
      await sleep(700);
      await caption(page, 'Kıstırma (Ctrl + tekerlek) aktif bloğun üstünde tahtayı yakınlaştırır');
      c = await centreOf(page, ids.huge);
      await page.mouse.move(c.x + 3, c.y + 3);
      await page.mouse.move(c.x, c.y);
      before = await readScene(page);
      await wheelSlowly(page, -40, 6, { ctrl: true, pause: 180 });
      after = await readScene(page);
      ok('W1 a pinch over an active block zooms the board', after.zoom > before.zoom, JSON.stringify({ b: before.zoom, a: after.zoom }));
      await sleep(1200);
      await page.screenshot({ path: join(OUT, 'W1.png') });
      await finish('W1-html-ustunde-kaydirma', ctx, page);
    }

    // ── W8 short content fills its card ─────────────────────────────────────────────────────
    {
      const { ctx, page } = await openBoard('W8');
      await showElements(page, [ids.flow, ids.goals, ids.pie]);
      await sleep(1500);
      await caption(page, '2) Kartlar yüksekliği doldurur: başlık üstte, ızgara ve çubuklar boşluğu alır, alt satır kartın altında');
      await sleep(3500);
      const flowFrame = await frameFor(page, '#flow-foot');
      const flow = flowFrame ? await flowFrame.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        return { head: r('flow-head').top, foot: r('flow-foot').bottom, statBottom: r('flow-stat').bottom, value: r('flow-value').bottom, vh: innerHeight };
      }) : null;
      ok('W8 İş akışı: heading at the top, last line on the card\'s bottom edge', !!flow && flow.head < 40 && flow.foot >= flow.vh - 24 && flow.foot <= flow.vh + 1, JSON.stringify(flow));
      ok('W8 …the stat value sits at its tile\'s bottom', !!flow && flow.statBottom - flow.value < 24, JSON.stringify(flow));
      const goalsFrame = await frameFor(page, '#goals-foot');
      const goals = goalsFrame ? await goalsFrame.evaluate(() => ({ foot: document.getElementById('goals-foot').getBoundingClientRect().bottom, vh: innerHeight })) : null;
      ok('W8 Hedefler: its chips end on the card\'s bottom edge', !!goals && goals.foot >= goals.vh - 24 && goals.foot <= goals.vh + 1, JSON.stringify(goals));
      const pie = await page.locator('.wb-widget--insight').filter({ hasText: 'Trafik kaynakları' }).evaluate((card) => {
        const body = card.querySelector('.wb-widget-body').getBoundingClientRect();
        const svg = card.querySelector('.wb-widget-body svg')?.getBoundingClientRect();
        let bottom = body.top;
        for (const n of card.querySelectorAll('.wb-widget-body *')) { const r = n.getBoundingClientRect(); if (r.width > 0 && r.height > 0) bottom = Math.max(bottom, r.bottom); }
        return { h: body.height, svgH: svg?.height ?? 0, bottom, bodyBottom: body.bottom };
      });
      ok('W8 the pie fills its card', pie.svgH >= pie.h * 0.55 && pie.bottom <= pie.bodyBottom + 1 && pie.bottom >= pie.bodyBottom - 48, JSON.stringify(pie));
      await caption(page, 'Pasta grafiği de kartın yüksekliğini kullanıyor');
      const p = await centreOf(page, ids.pie);
      await glide(page, { x: p.x - 400, y: p.y + 200 }, p, 24);
      await sleep(2500);
      await page.screenshot({ path: join(OUT, 'W8.png') });
      await finish('W8-kartlar-yuksekligi-doldurur', ctx, page);
    }

    // ── W3 a new agent card comes in tall ───────────────────────────────────────────────────
    {
      const { ctx, page } = await openBoard('W3');
      // The bottom rows, with the empty slot right of the outside-file card in view.
      await showElements(page, [ids.webHtml, ids.webPdf, ids.webLocal, ids.webOutside, ids.pie]);
      await sleep(800);
      const s = await readScene(page);
      const spotPt = toClient(s, 784 + 100, 2744 + 380);
      const target = toClient(s, 784 + 188, 2744 + 188);
      await caption(page, '3) Paletten ajan eklenince kart uzun gelir: 376 x 572 (üç satır)');
      await glide(page, { x: spotPt.x - 200, y: spotPt.y }, target);
      await page.mouse.click(target.x, target.y, { button: 'right' });
      await sleep(700);
      await page.screenshot({ path: join(OUT, 'W3-palette.png') });
      await page.locator('.wb-palette-item', { hasText: /^Agent/ }).first().click({ timeout: 8000 });
      await sleep(700);
      await page.locator('.wb-picker-row', { hasText: 'Pano yardımcısı' }).first().click({ timeout: 10000 }).catch(() => {});
      const card = await until(async () => (await readScene(page)).elements.find((e) => e.kind === 'agent'), 8000);
      ok('W3 the palette adds the agent card at 376x572', !!card && card.width === 376 && card.height === 572, JSON.stringify(card));
      ok('W3 …recording the L layout', card?.size === 'l', JSON.stringify(card));
      await sleep(600);
      if (card) await showElements(page, [card.id, ids.webOutside]);
      await sleep(2500);
      await page.screenshot({ path: join(OUT, 'W3.png') });
      await finish('W3-ajan-karti-uzun-gelir', ctx, page);
    }

    // ── W2 the web block opens files and pages on this machine ──────────────────────────────
    {
      const { ctx, page } = await openBoard('W2');
      await showElements(page, [ids.webHtml, ids.webPng, ids.webPdf]);
      await caption(page, '4) Web bloğu proje dosyası açar: .html, resim ve PDF');
      await sleep(3000);
      const docFrame = await until(() => frameFor(page, '#doc-title'), 8000);
      ok('W2 a project .html file shows in the card (the board\'s reader, sandboxed)', !!docFrame);
      const img = await page.locator('.wb-widget--web').filter({ hasText: 'grafik.png' }).locator('img').first().isVisible().catch(() => false);
      ok('W2 a project picture shows in the card', img);
      const pdfShown = await until(() => page.locator('.wb-widget--web').filter({ hasText: 'sunum.pdf' }).locator('canvas, embed, iframe, .pdf-viewer, [class*="pdf"]').count(), 8000);
      // Headless Chromium has no PDF engine, so the viewer shows its own fallback here; the
      // check is that the file reached the PDF viewer, not that this browser drew the page.
      ok('W2 a project PDF goes to the board\'s PDF viewer', pdfShown > 0, String(pdfShown));
      const pc = await centreOf(page, ids.webPng);
      await glide(page, { x: pc.x - 300, y: pc.y }, pc);
      await sleep(1200);

      await showElements(page, [ids.webLocal, ids.webOutside]);
      await sleep(900);
      await caption(page, 'Bu bilgisayardaki bir sayfa (localhost): önce Yükle sorar, sonra açar');
      await sleep(1500);
      const localCard = page.locator('.wb-widget--web').filter({ hasText: 'Geliştirme sunucusu' });
      ok('W2 a localhost page waits for Load and names host and port', (await localCard.innerText()).includes(`localhost:${DEV_PORT}`), await localCard.innerText());
      // A widget takes pointer events only once active: activate it, then press Load.
      let c = await centreOf(page, ids.webLocal);
      await glide(page, { x: c.x, y: c.y + 220 }, c);
      await page.mouse.click(c.x, c.y);
      await sleep(600);
      const load = localCard.locator('.wb-widget-btn', { hasText: /^Load$/ });
      const lb = await load.boundingBox();
      if (lb) { await glide(page, c, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 }, 12); await load.click(); }
      const devFrame = await until(() => frameFor(page, '#dev-title'), 8000);
      ok('W2 …and after Load the page on this machine shows', !!devFrame);
      await sleep(1500);

      await caption(page, 'Proje dışındaki bir dosya: tam yolu gösterir, "Allow access" ile izin verilince açılır');
      const outCard = page.locator('.wb-widget--web').filter({ hasText: 'disaridaki.html' });
      await until(async () => (await outCard.innerText()).includes('Allow access'), 8000);
      const outText = await outCard.innerText();
      ok('W2 a file outside the project asks first and names the exact file', outText.includes('Allow access') && outText.includes('disaridaki.html') && !(await frameFor(page, '#outside-title')), outText);
      c = await centreOf(page, ids.webOutside);
      await glide(page, (await centreOf(page, ids.webLocal)), c, 16);
      await page.mouse.click(c.x, c.y);
      await sleep(600);
      const allow = outCard.locator('.wb-widget-btn', { hasText: 'Allow access' });
      const ab = await allow.boundingBox();
      if (ab) { await glide(page, c, { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 }, 12); await sleep(500); await allow.click(); }
      const outFrame = await until(() => frameFor(page, '#outside-title'), 8000);
      ok('W2 …and shows it once allowed', !!outFrame);
      await sleep(2000);

      await caption(page, 'Paletten: dosya yolu yazınca kart eklenir, .txt gibi gösterilemeyen dosya gerekçeyle reddedilir');
      await page.keyboard.press('Escape');
      await sleep(400);
      await showElements(page, [ids.webLocal, ids.webOutside, ids.pie]);
      await sleep(700);
      const s = await readScene(page);
      const empty = toClient(s, 1176 + 188, 2744 + 188);
      await glide(page, c, empty);
      await page.mouse.click(empty.x, empty.y, { button: 'right' });
      await sleep(600);
      await page.locator('.wb-palette-item', { hasText: /^Web/ }).first().click();
      const input = page.locator('.wb-picker-search').first();
      await input.pressSequentially('docs/notlar.txt', { delay: 45 });
      await page.locator('.wb-palette-btn', { hasText: 'Add embed' }).click();
      const err = await until(() => page.locator('.wb-picker-error').innerText().catch(() => ''), 3000);
      ok('W2 the palette refuses a .txt with a reason', /\.html/.test(err || ''), String(err));
      await sleep(1600);
      await input.fill('');
      await input.pressSequentially('docs/rapor.html', { delay: 45 });
      await sleep(300);
      const webCount = (await readScene(page)).elements.filter((e) => e.kind === 'web').length;
      await page.locator('.wb-palette-btn', { hasText: 'Add embed' }).click();
      const added = await until(async () => (await readScene(page)).elements.filter((e) => e.kind === 'web').length === webCount + 1, 5000);
      ok('W2 the palette adds a web card from a file path', !!added);
      await sleep(2500);
      await page.screenshot({ path: join(OUT, 'W2.png') });
      await finish('W2-web-blogu-yerel-dosya', ctx, page);
    }

    // ── W7 pictures on the board ────────────────────────────────────────────────────────────
    {
      const filesDir = join(DC, 'whiteboards', BOARD, 'files');
      const stored = () => { try { return readdirSync(filesDir); } catch { return []; } };
      const { ctx, page } = await openBoard('W7');
      await showElements(page, [ids.webPdf, ids.pie]);
      await sleep(900);
      let s = await readScene(page);
      const spot = toClient(s, 1176 + 188, 2352 + 188);
      await caption(page, '7) Tahtaya görsel: Finder\'dan sürükleyip bırakınca görsel tahtaya yerleşir');
      await glide(page, { x: spot.x - 320, y: spot.y + 160 }, spot, 22);
      await dropFile(page, spot, tablo.toString('base64'), 'haftalik-tablo.png', 'image/png');
      // Excalidraw places the picture first and names its file a moment later.
      const pic = await until(async () => (await readScene(page)).elements.find((e) => e.type === 'image' && e.fileId), 8000);
      ok('W7 a picture dropped onto the board lands on it', !!pic, JSON.stringify((await readScene(page)).elements.map((e) => e.type)));
      await caption(page, 'Görselin dosyası tahtanın klasörüne yazılır: whiteboards/tur-iki/files/');
      const file = await until(() => stored().find((n) => pic && n.startsWith(pic.fileId)), 10000);
      ok('W7 …its bytes are stored in the board\'s folder, as a PNG', !!file && file.endsWith('.png'), JSON.stringify(stored()));
      const saved = await until(() => JSON.parse(dc(['whiteboard', 'show', BOARD, '--json'])).elements.find((e) => e.type === 'image' && e.fileId === pic?.fileId), 8000);
      ok('W7 …and the board file names it', !!saved);
      await sleep(1800);
      await page.screenshot({ path: join(OUT, 'W7-dropped.png') });

      await caption(page, 'Sayfa yenilenince görsel yerinde: dosyası tahtanın klasöründen yüklenir');
      await sleep(1200);
      await page.reload({ waitUntil: 'load' });
      await enterBoard(page);
      await page.evaluate(OVERLAY);
      await caption(page, 'Sayfa yenilenince görsel yerinde: dosyası tahtanın klasöründen yüklenir');
      await showElements(page, [ids.webPdf, ids.pie, pic?.id].filter(Boolean));
      const back = await until(async () => pic && (await heldFile(page, pic.fileId)), 10000);
      ok('W7 after a reload the picture is there, its bytes loaded from the board', back === 'image/png', String(back));
      await sleep(2200);
      await page.screenshot({ path: join(OUT, 'W7-reloaded.png') });

      await caption(page, 'CLI ile de eklenir: dreamcontext whiteboard add tur-iki image --file docs/grafik.png');
      await sleep(1400);
      const added = JSON.parse(dc(['whiteboard', 'add', BOARD, 'image', '--file', 'docs/grafik.png', '--at', '1568,2352', '--json']));
      const cliPic = await until(async () => (await readScene(page)).elements.find((e) => e.id === added.id), 10000);
      ok('W7 a picture added with the CLI appears on the open board', !!cliPic);
      await showElements(page, [ids.webPdf, ids.pie, pic?.id, added.id].filter(Boolean));
      const cliHeld = await until(() => heldFile(page, added.fileId), 10000);
      ok('W7 …with its bytes', cliHeld === 'image/png', String(cliHeld));
      await sleep(2400);
      await page.screenshot({ path: join(OUT, 'W7-cli.png') });

      await caption(page, 'SVG gibi tahtanın tutamayacağı bir dosya gerekçeyle reddedilir, geride bir şey kalmaz');
      s = await readScene(page);
      const svgAt = toClient(s, 1568 + 240, 2352 + 400);
      await glide(page, spot, svgAt, 16);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#7c5cff"/></svg>';
      const before = stored().length;
      await dropFile(page, svgAt, Buffer.from(svg).toString('base64'), 'logo.svg', 'image/svg+xml');
      const toast = await until(async () => { const t = await page.locator('.Toast__message').innerText().catch(() => ''); return /could not be kept/.test(t) ? t : null; }, 10000);
      ok('W7 an SVG is refused with a reason', !!toast, String(toast));
      const left = await until(async () => (await readScene(page)).elements.filter((e) => e.type === 'image').length === 2, 5000);
      ok('W7 …and leaves no picture and no file behind', !!left && stored().length === before, JSON.stringify(stored()));
      await sleep(2600);
      await page.screenshot({ path: join(OUT, 'W7-svg.png') });
      await finish('W7-tahtaya-gorsel-eklenir', ctx, page);
    }

    // ── W2 the CLI ──────────────────────────────────────────────────────────────────────────
    const shown = JSON.parse(dc(['whiteboard', 'show', BOARD, '--json']));
    const urls = (shown.elements ?? []).filter((e) => e.kind === 'web').map((e) => e.url);
    ok('W2 CLI: a bare localhost:port is stored as its http URL', urls.includes(`http://localhost:${DEV_PORT}/`), JSON.stringify(urls));
    ok('W2 CLI: ./docs/grafik.png is stored as docs/grafik.png', urls.includes('docs/grafik.png'), JSON.stringify(urls));
    const refusedHttp = dcFails(['whiteboard', 'add', BOARD, 'web', '--url', 'http://example.com']);
    ok('W2 CLI refuses http://example.com, naming what it takes', !!refusedHttp && /localhost/.test(refusedHttp), String(refusedHttp));
    const refusedUp = dcFails(['whiteboard', 'add', BOARD, 'web', '--url', '../secret.html']);
    ok('W2 CLI refuses a path with ..', !!refusedUp && /\.\./.test(refusedUp), String(refusedUp));
    const refusedTxt = dcFails(['whiteboard', 'add', BOARD, 'web', '--url', 'docs/notlar.txt']);
    ok('W2 CLI refuses a .txt', !!refusedTxt && /\.html/.test(refusedTxt), String(refusedTxt));

    ok('E no console or page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  } finally {
    server.kill();
    dev.close();
    await browser.close();
  }
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(failed ? `\n${failed} failed` : `\nall ${results.length} green`);
  console.log(`videos: ${OUT}`);
  for (const f of readdirSync(RAW)) { try { renameSync(join(RAW, f), join(RAW, `done-${f}`)); } catch { /* best-effort */ } }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
