#!/usr/bin/env node
/**
 * Quick edit places live widgets and reads dropped/pasted pictures (task tahta-hizli-duzenle,
 * owner 12 Nov l0aw9x + a3fmsj): the real dashboard (API from source, the Vite UI) on a scratch
 * vault, real Chromium, the machine's own `claude` (Sonnet) in a fake HOME.
 *
 *   dreamcontext builder heavy -- node scripts/verify/whiteboard-quick-widgets.mjs
 *
 * Light theme, 1440 px. For each request: drag an empty area, type it, wait for the edit, read the
 * board file and screenshot. Collect, don't fail fast: every check prints ✓/✗, exit 0 iff all pass
 * and the page logged no console error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = await openApp({ suite: 'whiteboard-quick-widgets', claude: 'real' });
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass });
  process.stdout.write(`${pass ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}\n`);
};

// ── a fictional vault: an insight, two tasks, a board with one card ──
const env = { ...process.env, HOME: app.home, DREAMCONTEXT_DESKTOP: '1' };
const dc = (...args) => spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), ...args], { cwd: app.proj, env, encoding: 'utf-8' });
const must = (label, r) => ok(`fixture: ${label}`, r.status === 0, (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0]?.slice(0, 160));
must('the MRR insight', dc('lab', 'create', 'mrr', '--title', 'MRR', '--render', 'number', '--adapter', 'script', '--unit', 'usd'));
must('a task', dc('tasks', 'create', 'Ödeme sayfasını yenile', '--why', 'A fictional fixture task.'));
must('another task', dc('tasks', 'create', 'Kayıt formunu kısalt', '--why', 'A fictional fixture task.'));
const created = await fetch(`${app.base}/api/whiteboards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Kontrol paneli' }) }).then((r) => r.json());
const SLUG = created.slug;
writeFileSync(join(app.proj, 'card.json'), JSON.stringify({ elements: [{ type: 'card', text: 'Haftalık özet', color: 'blue', w: 220, h: 120 }] }));
must('the board card', dc('whiteboard', 'draw', SLUG, '--spec', 'card.json', '--at', '0,0'));
const BOARD_FILE = join(app.proj, '_dream_context', 'whiteboards', SLUG, `${SLUG}.excalidraw.md`);
const onDisk = () => JSON.parse((/```json\n([\s\S]*?)\n```/.exec(readFileSync(BOARD_FILE, 'utf-8')) ?? [])[1] ?? '{"elements":[]}').elements.filter((e) => !e.isDeleted);

// ── driving the canvas (the same reads as whiteboard-quick-edit.mjs) ──
const sceneOf = (page) => page.evaluate(() => {
  const root = document.querySelector('.wbp-canvas .excalidraw');
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
  for (let f = key ? root[key] : null; f; f = f.return) {
    const a = f.stateNode;
    if (a?.scene && a.state?.zoom) {
      const r = root.getBoundingClientRect();
      return {
        left: r.left, top: r.top, width: r.width, height: r.height, zoom: a.state.zoom.value, scrollX: a.state.scrollX, scrollY: a.state.scrollY,
        elements: a.scene.getNonDeletedElements().map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.width, h: e.height })),
      };
    }
  }
  return null;
});
const until = async (fn, ms = 10_000, step = 60) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, step)); }
  return false;
};
const field = (page) => page.locator('[data-testid="board-super-field"]');
const lineText = (page) => field(page).locator('.bsf-line').innerText().catch(() => '');
const running = async (page) => (await field(page).locator('[data-testid="board-quick-running"]').count()) > 0;
const screenOf = (s, x, y) => ({ x: s.left + (x + s.scrollX) * s.zoom, y: s.top + (y + s.scrollY) * s.zoom });

/** An empty screen rect clear of every element, of the field and of the page's own controls. */
async function emptySpot(page, w, h) {
  const s = await sceneOf(page);
  const f = await field(page).boundingBox();
  const boxes = s.elements.map((e) => { const a = screenOf(s, e.x, e.y); return { x: a.x - 16, y: a.y - 16, w: e.w * s.zoom + 32, h: e.h * s.zoom + 32 }; });
  if (f) boxes.push({ x: f.x - 12, y: f.y - 80, w: f.width + 24, h: f.height + 92 });
  const meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const bare = (r) => page.evaluate(({ x, y, w, h }) => {
    for (const fx of [0.02, 0.5, 0.98]) for (const fy of [0.02, 0.5, 0.98]) {
      const el = document.elementFromPoint(x + w * fx, y + h * fy);
      if (!el || el.tagName !== 'CANVAS') return false;
    }
    return true;
  }, r);
  for (let y = s.top + 60; y + h < s.top + s.height - 20; y += 30) {
    for (let x = s.left + 30; x + w < s.left + s.width - 20; x += 30) {
      const r = { x, y, w, h };
      if (!boxes.some((b) => meets(r, b)) && await bare(r)) return r;
    }
  }
  return null;
}
/** Scroll the board's view down by one screen (Excalidraw's own state, like a wheel scroll). */
async function panDown(page) {
  await page.evaluate(() => {
    const root = document.querySelector('.wbp-canvas .excalidraw');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? root[key] : null; f; f = f.return) {
      const a = f.stateNode;
      if (a?.scene && a.state?.zoom) { a.setState({ scrollY: a.state.scrollY - root.getBoundingClientRect().height * 0.8 / a.state.zoom.value }); return; }
    }
  });
  await page.waitForTimeout(300);
}
async function drag(page, r) {
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 6 });
  await page.mouse.move(r.x + r.w, r.y + r.h, { steps: 6 });
  await page.mouse.up();
}
/** Put files into the field the way the owner's hand does: a drop on the field, or a paste in its input. */
async function giveFiles(page, how, files) {
  await page.evaluate(({ how, files }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    if (how === 'drop') {
      const el = document.querySelector('[data-testid="board-super-field"]');
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    } else {
      document.querySelector('[data-testid="board-super-field"] .bsf-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  }, { how, files });
  return until(async () => {
    const states = await field(page).locator('[data-testid="board-field-attachment"]').evaluateAll((els) => els.map((e) => e.dataset.state));
    return states.length >= files.length && states.every((s) => s === 'ready');
  }, 15_000);
}

let shotN = 0;
const shot = async (page, name) => {
  const file = join(app.shots, `${String(++shotN).padStart(2, '0')}-light-1440-${name}.png`);
  await page.screenshot({ path: file });
  app.taken.push(file);
};

/** One request in a fresh empty area: answers the elements it added (read from the board file). */
async function request(page, name, words, { files, how = 'drop', area = [320, 240], expectAdd = true } = {}) {
  await page.keyboard.press('Escape');
  const before = new Set(onDisk().map((e) => e.id));
  let spot = await emptySpot(page, area[0], area[1]);
  // The view fills up as the run adds: move it down to fresh canvas, as his scroll would.
  for (let i = 0; !spot && i < 4; i++) { await panDown(page); spot = await emptySpot(page, area[0], area[1]); }
  if (!spot) { ok(`${name}: an empty area`, false); return []; }
  await drag(page, spot);
  await until(async () => (await field(page).locator('[data-testid="board-quick-region-chip"]').count()) === 1, 3000);
  if (files) ok(`${name}: the ${how === 'drop' ? 'dropped' : 'pasted'} file shows as a chip in the field`, await giveFiles(page, how, files));
  if (files) await shot(page, `${name}-staged`);
  const input = field(page).locator('.bsf-input');
  await input.click();
  await input.fill(words);
  const t0 = Date.now();
  await input.press('Enter');
  await until(() => running(page), 4000, 30);
  await until(async () => !(await running(page)), 120_000);
  const ms = Date.now() - t0;
  await page.waitForTimeout(1200);
  const added = onDisk().filter((e) => !before.has(e.id));
  const line = await lineText(page);
  if (expectAdd) ok(`${name}: "${words}" adds to the board`, added.length > 0, `${ms} ms · ${added.map((e) => e.customData?.dc?.kind ?? e.type).join(',')} · ${line}`);
  else ok(`${name}: "${words}" adds nothing and says why`, added.length === 0 && line.trim().length > 0, `${ms} ms · ${line}`);
  ok(`${name}: the reply names no command or internal name`, !/dreamcontext |whiteboard add|--ref|\bCLI\b|```/.test(line), line);
  await shot(page, name);
  return added;
}
const kinds = (els) => els.map((e) => e.customData?.dc?.kind).filter(Boolean);

await app.look(`/?vault=proj#wb=${SLUG}`, async (page, w) => {
  if (w.name !== 'desktop') return;
  try {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
    await page.getByTestId('ns-rail-whiteboards').first().click();
    await page.waitForTimeout(600);
    if (!(await until(async () => ((await sceneOf(page))?.elements.length ?? 0) >= 2, 4000))) {
      const toggle = page.locator('.wbp-explorer-toggle').first();
      if ((await page.locator('.wbx').count()) === 0 && await toggle.isVisible().catch(() => false)) await toggle.click();
      await page.locator('.wbx .wbx-row-open', { hasText: 'Kontrol paneli' }).first().click();
      await until(async () => ((await sceneOf(page))?.elements.length ?? 0) >= 2, 15_000);
    }
    ok('the field opens in quick edit', (await field(page).locator('[data-testid="board-mode-quick"][aria-pressed="true"]').count()) === 1);

    const ins = await request(page, 'insight', "MRR insight'ını buraya ekle");
    ok('insight: an insight widget naming mrr', ins.some((e) => e.customData?.dc?.kind === 'insight' && e.customData.dc.ref === 'mrr'), kinds(ins).join(','));

    const web = await request(page, 'web', 'buraya şu siteyi koy https://example.com', { area: [420, 300] });
    ok('web: a web widget on https://example.com', web.some((e) => e.customData?.dc?.kind === 'web' && /^https:\/\/example\.com/.test(e.customData.dc.url ?? e.customData.dc.ref ?? '')), kinds(web).join(','));

    const html = await request(page, 'html', 'buraya bu haftanın görevlerini gösteren bir HTML kart yap', { area: [420, 320] });
    ok('html: an HTML widget naming a fixture task', html.some((e) => e.customData?.dc?.kind === 'html' && /Ödeme|Kayıt/.test(JSON.stringify(e.customData.dc))), kinds(html).join(','));

    const task = await request(page, 'task', 'Ödeme sayfasını yenile görevini buraya ekle');
    ok('task: a task widget', task.some((e) => e.customData?.dc?.kind === 'task'), kinds(task).join(','));

    const unknown = await request(page, 'unknown-insight', "Churn insight'ını buraya ekle", { expectAdd: false });
    ok('unknown insight: nothing guessed', unknown.length === 0);

    const secret = await request(page, 'outside-file', 'buraya /etc/hosts dosyasını web sayfası olarak koy', { expectAdd: false });
    ok('a file outside the project: refused', secret.every((e) => !/hosts/.test(JSON.stringify(e.customData ?? {}))));

    // A real screen as the picture: the board page itself, cropped.
    const picture = (await page.screenshot({ clip: { x: 0, y: 0, width: 720, height: 450 } })).toString('base64');
    const mock = await request(page, 'mockup-from-drop', "bunun mockup'ını yap", { files: [{ name: 'ekran.png', type: 'image/png', b64: picture }], area: [520, 380] });
    ok('mockup: drawn from the dropped picture (shapes, not the picture itself)', mock.length >= 3 && mock.some((e) => e.type !== 'image'), `${mock.length} elements`);

    const pasted = await request(page, 'picture-from-paste', 'bu resmi buraya koy', { files: [{ name: 'ekran.png', type: 'image/png', b64: picture }], how: 'paste', area: [420, 300] });
    ok('paste: the picture itself lands as an image', pasted.some((e) => e.type === 'image'), pasted.map((e) => e.type).join(','));

    const note = Buffer.from('Hafta 46 hedefleri:\n- Ödeme dönüşümü %3,2\n- Kayıt süresi 40 sn altı\n', 'utf-8').toString('base64');
    const fromFile = await request(page, 'note-from-file', 'bu dosyadaki hedefleri buraya not olarak yaz', { files: [{ name: 'hedefler.txt', type: 'text/plain', b64: note }], area: [380, 260] });
    ok('text file: its words reach the board', /3,2|40 sn/.test(JSON.stringify(fromFile)), kinds(fromFile).join(',') || fromFile.map((e) => e.type).join(','));

    // Undo takes the last edit's additions off again.
    const undo = field(page).locator('[data-testid="board-quick-undo"]');
    if (await undo.count()) {
      await undo.click();
      await until(async () => (await field(page).locator('[data-testid="board-quick-undone"]').count()) === 1, 8000);
      await page.waitForTimeout(1200);
      const left = new Set(onDisk().map((e) => e.id));
      ok('undo removes what the last edit added', fromFile.every((e) => !left.has(e.id)));
    } else ok('undo removes what the last edit added', false, 'no Geri al');
    await page.keyboard.press('Escape');
    await shot(page, 'final');
  } catch (err) {
    ok('the scenario ran to its end', false, String(err?.message ?? err).split('\n')[0].slice(0, 200));
    await shot(page, 'threw').catch(() => {});
  }
}, { name: 'light', init: () => "try { localStorage.setItem('dreamcontext-theme', 'light'); } catch {}" });

const failed = results.filter((r) => !r.pass).length;
const code = await app.finish();
process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 && code === 0 ? 0 : 1);
