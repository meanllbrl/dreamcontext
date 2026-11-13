#!/usr/bin/env node
/**
 * Hızlı düzenle on the board (task tahta-hizli-duzenle, plan r4 criteria 1-2, 5-11, 15, 18-19):
 * the real dashboard (API from source, the Vite UI) on a scratch vault, real Chromium.
 *
 *   dreamcontext builder heavy -- node scripts/verify/whiteboard-quick-edit.mjs           (a fake claude)
 *   dreamcontext builder heavy -- node scripts/verify/whiteboard-quick-edit.mjs --real    (the real Sonnet)
 *
 * --real runs the machine's own `claude` (signed in through the login keychain, linked into the
 * fake HOME; nothing else of the real HOME is read) and writes the measured timings, message to
 * first shape on the board, to <shots>/timings.json. Without it a deterministic stand-in answers
 * (scripts/verify/fixtures/fake-claude-quick.mjs). Light and dark, 1440 and 390 px; every state
 * screenshotted; collect, don't fail fast: every check prints ✓/✗, exit 0 iff all pass and the
 * page logged no console error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values } = parseArgs({ options: { real: { type: 'boolean', default: false } } });
const REAL = values.real;
const FAKE = join(REPO, 'scripts', 'verify', 'fixtures', 'fake-claude-quick.mjs');

const app = await openApp({ suite: REAL ? 'whiteboard-quick-edit-real' : 'whiteboard-quick-edit', claude: REAL ? 'real' : FAKE });
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass });
  process.stdout.write(`${pass ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}\n`);
};
const timings = [];

// ── the scratch board: two labelled cards, as the owner's board had ──
const env = { ...process.env, HOME: app.home, DREAMCONTEXT_DESKTOP: '1' };
const dc = (...args) => spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), ...args], { cwd: app.proj, env, encoding: 'utf-8' });
const created = await fetch(`${app.base}/api/whiteboards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sunum düzenleri' }) }).then((r) => r.json());
const SLUG = created.slug;
writeFileSync(join(app.proj, 'cards.json'), JSON.stringify({ elements: [{ type: 'row', gap: 40, items: [
  { type: 'card', text: 'Seçenek C', color: 'blue', w: 220, h: 120 },
  { type: 'card', text: 'Seçenek D', color: 'purple', w: 220, h: 120 },
] }] }));
const drew = dc('whiteboard', 'draw', SLUG, '--spec', 'cards.json', '--at', '0,0');
ok('the scratch board has two cards', drew.status === 0, (drew.stderr || '').slice(0, 200));
const BOARD_FILE = join(app.proj, '_dream_context', 'whiteboards', SLUG, `${SLUG}.excalidraw.md`);
const JOURNAL = join(app.proj, '_dream_context', 'whiteboards', '.locks', 'quick', `${SLUG}.jsonl`);

// ── reading and driving the canvas ──
const sceneOf = (page) => page.evaluate(() => {
  const root = document.querySelector('.wbp-canvas .excalidraw');
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
  for (let f = key ? root[key] : null; f; f = f.return) {
    const a = f.stateNode;
    if (a?.scene && a.state?.zoom) {
      const r = root.getBoundingClientRect();
      return {
        left: r.left, top: r.top, width: r.width, height: r.height, zoom: a.state.zoom.value, scrollX: a.state.scrollX, scrollY: a.state.scrollY,
        selected: Object.keys(a.state.selectedElementIds || {}).filter((k) => a.state.selectedElementIds[k]),
        elements: a.scene.getNonDeletedElements().map((e) => ({
          id: e.id, type: e.type, ...(e.points?.length ? (() => { const xs = e.points.map((q) => q[0]); const ys = e.points.map((q) => q[1]); return { x: e.x + Math.min(...xs), y: e.y + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; })() : { x: e.x, y: e.y, w: e.width, h: e.height }), fill: e.backgroundColor, text: e.text ?? null,
          pts: e.points ? [e.points.length, e.points[0], e.points[e.points.length - 1]] : null, containerId: e.containerId ?? null, groups: e.groupIds ?? [], version: e.version, nonce: e.versionNonce,
        })),
      };
    }
  }
  return null;
});
const until = async (fn, ms = 10_000, step = 40) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, step)); }
  return false;
};
const screen = (s, x, y) => ({ x: s.left + (x + s.scrollX) * s.zoom, y: s.top + (y + s.scrollY) * s.zoom });
/** A kit card is a rectangle with its label either bound (containerId) or beside it in one group. */
const sameGroup = (a, b) => (a.groups ?? []).some((g) => (b.groups ?? []).includes(g));
const cardOf = (s, label) => {
  const t = s.elements.find((e) => e.type === 'text' && (e.text ?? '').includes(label));
  if (!t) return null;
  return t.containerId ? s.elements.find((e) => e.id === t.containerId) : s.elements.find((e) => e.type !== 'text' && sameGroup(e, t)) ?? null;
};
const labelOf = (s, card) => s.elements.find((e) => e.type === 'text' && (e.containerId === card.id || sameGroup(e, card)));
/** An empty screen rect (px) inside the canvas, clear of every element and of the field. */
const emptySpot = async (page, s, w, h) => {
  const field = await page.locator('[data-testid="board-super-field"]').boundingBox();
  const boxes = s.elements.map((e) => {
    const a = screen(s, e.x, e.y);
    return { x: a.x - 12, y: a.y - 12, w: e.w * s.zoom + 24, h: e.h * s.zoom + 24 };
  });
  if (field) boxes.push({ x: field.x - 12, y: field.y - 60, w: field.width + 24, h: field.height + 72 });
  const meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // Clear of every element AND of the page's own controls over the canvas (toolbar, Saved,
  // Agents, side tools): every probe point of the rect must hit the drawing canvas itself.
  const bare = (r) => page.evaluate(({ x, y, w, h }) => {
    for (const fx of [0.02, 0.5, 0.98]) for (const fy of [0.02, 0.5, 0.98]) {
      const el = document.elementFromPoint(x + w * fx, y + h * fy);
      if (!el || el.tagName !== 'CANVAS') return false;
    }
    return true;
  }, r);
  for (let y = s.top + 110; y + h < s.top + s.height - 20; y += 20) {
    for (let x = s.left + 20; x + w < s.left + s.width - 20; x += 20) {
      const r = { x, y, w, h };
      if (!boxes.some((b) => meets(r, b)) && await bare(r)) return r;
    }
  }
  return null;
};
const drag = async (page, r) => {
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 6 });
  await page.mouse.move(r.x + r.w, r.y + r.h, { steps: 6 });
  await page.mouse.up();
};
const clickScene = async (page, s, x, y) => { const p = screen(s, x, y); await page.mouse.click(p.x, p.y); };
const field = (page) => page.locator('[data-testid="board-super-field"]');
const ask = async (page, words) => {
  const input = field(page).locator('.bsf-input');
  await input.click();
  await input.fill(words);
  const t0 = Date.now();
  await input.press('Enter');
  return t0;
};
const lineText = (page) => field(page).locator('.bsf-line').innerText().catch(() => '');
const boardBytes = () => readFileSync(BOARD_FILE, 'utf-8');
const journal = () => (existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const waitIdle = (page) => until(async () => (await field(page).locator('[data-testid="board-quick-running"]').count()) === 0, 70_000);
const inside = (e, r) => e.x >= r[0] - 2 && e.y >= r[1] - 2 && e.x + e.w <= r[0] + r[2] + 2 && e.y + e.h <= r[1] + r[3] + 2;
const regionOf = async (page) => {
  const t = await field(page).locator('[data-testid="board-quick-region-chip"]').innerText().catch(() => '');
  return t;
};

/** The new shell lands on the chat: reach the Whiteboards page by its rail (or the More menu on a phone), then the board. */
async function openBoard(page) {
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
  const rail = page.getByTestId('ns-rail-whiteboards').first();
  if (await rail.isVisible().catch(() => false)) await rail.click();
  else {
    await page.getByTestId('ns-rail-more').first().click();
    await page.getByTestId('ns-more-whiteboards').first().click();
  }
  await page.waitForTimeout(600);
  const loaded = async () => ((await sceneOf(page))?.elements.length ?? 0) >= 4;
  if (!(await until(loaded, 4000))) {
    const toggle = page.locator('.wbp-explorer-toggle').first();
    if ((await page.locator('.wbx').count()) === 0 && await toggle.isVisible().catch(() => false)) await toggle.click();
    await page.locator('.wbx .wbx-row-open', { hasText: 'Sunum düzenleri' }).first().click();
    await until(loaded, 15_000);
  }
}

let shotN = 0;
const shot = async (page, theme, w, name) => {
  const file = join(app.shots, `${String(++shotN).padStart(2, '0')}-${theme}-${w.name}-${name}.png`);
  await page.screenshot({ path: file });
  app.taken.push(file);
};

/** An add in a fresh empty region, timed from Enter to the first new shape on the board. */
async function timedAdd(page, theme, w, words, { shots = false } = {}) {
  let s = await sceneOf(page);
  await page.keyboard.press('Escape');
  const spot = await emptySpot(page, s, Math.min(260, s.width / 3), Math.min(200, s.height / 5));
  if (!spot) { ok(`${theme}@${w.name}: an empty spot for a region`, false); return null; }
  await drag(page, spot);
  const chipped = await until(async () => /(Area|Alan) · \d+×\d+/.test(await regionOf(page)), 3000);
  ok(`${theme}@${w.name}: a drag over empty canvas leaves a region and its chip`, chipped && (await page.locator('[data-testid="board-region"]').count()) === 1, await regionOf(page));
  if (shots) await shot(page, theme, w, 'region');
  s = await sceneOf(page);
  const region = [(spot.x - s.left) / s.zoom - s.scrollX, (spot.y - s.top) / s.zoom - s.scrollY, spot.w / s.zoom, spot.h / s.zoom].map(Math.round);
  const before = new Set(s.elements.map((e) => e.id));
  const t0 = await ask(page, words);
  if (shots) {
    await until(async () => (await field(page).locator('[data-testid="board-quick-running"]').count()) === 1, 3000, 20);
    await shot(page, theme, w, 'running');
  }
  let added = [];
  const landed = await until(async () => {
    const now = await sceneOf(page);
    added = now.elements.filter((e) => !before.has(e.id));
    return added.length > 0;
  }, 70_000, 25);
  const ms = Date.now() - t0;
  await waitIdle(page);
  const after = await sceneOf(page);
  const all = after.elements.filter((e) => !before.has(e.id));
  const note = await lineText(page);
  const grewNote = /taştı|runs past the area/.test(note);
  const within = all.length > 0 && (all.every((e) => inside(e, region)) || grewNote);
  // never on the cards that were already there, never under the toolbar
  const cards = after.elements.filter((e) => before.has(e.id));
  const hitCard = all.some((e) => cards.some((c) => e.x < c.x + c.w && c.x < e.x + e.w && e.y < c.y + c.h && c.y < e.y + e.h));
  const bar = await page.locator('.App-menu, .App-toolbar').first().boundingBox().catch(() => null);
  const underBar = !!bar && all.some((e) => { const a = screen(after, e.x, e.y); return a.x < bar.x + bar.width && bar.x < a.x + e.w * after.zoom && a.y < bar.y + bar.height && bar.y < a.y + e.h * after.zoom; });
  ok(`${theme}@${w.name}: the drawing covers no card and is not under the toolbar`, !hitCard && !underBar, `card ${hitCard}, bar ${underBar}`);
  if (!within) {
    const disk = JSON.parse((/```json\n([\s\S]*?)\n```/.exec(boardBytes()) ?? [])[1] ?? '{"elements":[]}').elements;
    const bad = all.filter((e) => !inside(e, region))[0];
    const d = disk.find((e) => e.id === bad.id);
    process.stdout.write(`DISK ${JSON.stringify({ x: d?.x, y: d?.y, w: d?.width, h: d?.height, pts: d?.points?.slice(0, 3), n: d?.points?.length, last: d?.points?.at(-1) })}\n`);
  }
  if (!within) process.stdout.write(`OUTSIDE region ${JSON.stringify(region)}: ${JSON.stringify(all.filter((e) => !inside(e, region)).slice(0, 6).map((e) => [e.type, Math.round(e.x), Math.round(e.y), Math.round(e.w), Math.round(e.h), e.text, e.pts]))}\n`);
  const selected = all.length > 0 && all.every((e) => after.selected.includes(e.id));
  ok(`${theme}@${w.name}: "${words}" lands with no reload`, landed, `${ms} ms`);
  ok(`${theme}@${w.name}: the added shapes are selected and the region is cleared`, selected && (await page.locator('[data-testid="board-region"]').count()) === 0);
  ok(`${theme}@${w.name}: the drawing lies wholly inside the region (criterion 19)`, within, JSON.stringify(region));
  ok(`${theme}@${w.name}: the field shows the reply and Geri al`, (await field(page).locator('[data-testid="board-quick-undo"]').count()) === 1, await lineText(page));
  if (shots) await shot(page, theme, w, 'done');
  return { kind: 'add in region', words, ms, inside: within, ids: all.map((e) => e.id) };
}

// ── screens: the real Sonnet draws a phone and a desktop window mockup from one empty area each ──
// (a variant of whiteboard-quick-edit.mjs: same scratch vault, fake HOME, real `claude`; light theme.)
// Screenshots: <shots>/<tag>-<prompt>.png, the board after each prompt, zoomed to the new drawing.
const PROMPTS = [['iphone', 'bir iphone mockup çiz'], ['masaustu', "bir masaüstü uygulama ekranı mockup'ı çiz"]];
const TAG = process.env.SHOT_TAG || 'sonra';
await app.look(`/?vault=proj#wb=${SLUG}`, async (page, w) => {
  await openBoard(page);
  for (const [name, words] of PROMPTS) {
    // back to the cards at 100%, so the next prompt finds an empty spot as the owner would
    await page.evaluate(() => {
      const root = document.querySelector('.wbp-canvas .excalidraw');
      const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key ? root[key] : null; f; f = f.return) {
        const api = f.stateNode;
        if (api?.scene && api.state?.zoom) {
          api.updateScene({ appState: { zoom: { value: 1 } } });
          const cards = api.scene.getNonDeletedElements().filter((e) => /Seçenek/.test(e.text ?? '') || e.type === 'rectangle' && e.width === 220);
          api.scrollToContent(cards, { fitToViewport: false, animate: false });
          return;
        }
      }
    });
    await page.waitForTimeout(500);
    const t = await timedAdd(page, 'light', w, words);
    if (t) timings.push(t);
    const s = await sceneOf(page);
    const mine = s.elements.filter((e) => t?.ids.includes(e.id));
    const log = journal().at(-1);
    ok(`"${words}": ${mine.length} shapes, cost $${log?.costUsd}, reply: ${log?.reply}`, mine.length > 0);
    await page.evaluate((ids) => {
      const root = document.querySelector('.wbp-canvas .excalidraw');
      const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key ? root[key] : null; f; f = f.return) {
        const api = f.stateNode;
        if (api?.scene && api.state?.zoom) {
          const els = api.scene.getNonDeletedElements().filter((e) => ids.includes(e.id));
          api.updateScene({ appState: { selectedElementIds: {} } });
          api.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.6, animate: false });
          return;
        }
      }
    }, t?.ids ?? []);
    await page.waitForTimeout(700);
    const file = join(app.shots, `${TAG}-${name}.png`);
    await page.screenshot({ path: file });
    app.taken.push(file);
    process.stdout.write(`shot: ${file}\n`);
  }
}, { name: 'light', init: () => `try { localStorage.setItem('dreamcontext-theme', 'light'); } catch {}` });
writeFileSync(join(app.shots, `${TAG}-journal.json`), JSON.stringify(journal(), null, 2));
const failed = results.filter((r) => !r.pass).length;
const code = await app.finish();
process.exit(failed === 0 && code === 0 ? 0 : 1);
