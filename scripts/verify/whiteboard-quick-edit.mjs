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
          id: e.id, type: e.type, x: e.x, y: e.y, w: e.width, h: e.height, fill: e.backgroundColor, text: e.text ?? null,
          containerId: e.containerId ?? null, groups: e.groupIds ?? [], version: e.version, nonce: e.versionNonce,
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
  for (let y = s.top + 20; y + h < s.top + s.height - 20; y += 20) {
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
  const within = all.length > 0 && all.every((e) => inside(e, region));
  const selected = all.length > 0 && all.every((e) => after.selected.includes(e.id));
  ok(`${theme}@${w.name}: "${words}" lands with no reload`, landed, `${ms} ms`);
  ok(`${theme}@${w.name}: the added shapes are selected and the region is cleared`, selected && (await page.locator('[data-testid="board-region"]').count()) === 0);
  ok(`${theme}@${w.name}: the drawing lies wholly inside the region (criterion 19)`, within, JSON.stringify(region));
  ok(`${theme}@${w.name}: the field shows the reply and Geri al`, (await field(page).locator('[data-testid="board-quick-undo"]').count()) === 1, await lineText(page));
  if (shots) await shot(page, theme, w, 'done');
  return { kind: 'add in region', words, ms, inside: within, ids: all.map((e) => e.id) };
}

/** A change to the selected card, timed from Enter until the card shows it. */
async function timedChange(page, theme, w, label, words, kind, changed) {
  let s = await sceneOf(page);
  await page.keyboard.press('Escape');
  const card = cardOf(s, label);
  await clickScene(page, s, card.x + 20, card.y + 20);
  await until(async () => (await sceneOf(page)).selected.includes(card.id), 3000);
  s = await sceneOf(page);
  const before = { card: s.elements.find((e) => e.id === card.id), label: labelOf(s, card) };
  const t0 = await ask(page, words);
  const landed = await until(async () => changed(await sceneOf(page), before), 70_000, 25);
  const ms = Date.now() - t0;
  await waitIdle(page);
  ok(`${theme}@${w.name}: "${words}" changes the selected card`, landed, `${ms} ms · ${await lineText(page)}`);
  return { kind, words, ms };
}

const fillOf = (s, id) => s.elements.find((e) => e.id === id)?.fill;

async function scenario(page, w, theme, full) {
  const f = field(page);
  ok(`${theme}@${w.name}: the field shows with Super off`, await until(async () => (await f.count()) === 1, 20_000));
  ok(`${theme}@${w.name}: Hızlı düzenle is the default; Super'e sor says Super is off`,
    (await f.locator('[data-testid="board-mode-quick"]').getAttribute('aria-pressed')) === 'true'
    && await f.locator('[data-testid="board-mode-super"]').isDisabled());
  await until(async () => !!(await sceneOf(page)), 10_000);

  // An add in a region, with the region, running and done states drawn.
  const first = await timedAdd(page, theme, w, 'Buraya bir elma ekle', { shots: true });
  if (first) timings.push(first);

  // Geri al, after a moment (the page must not have bumped what it received, or undo skips).
  await new Promise((r) => setTimeout(r, 2500));
  await f.locator('[data-testid="board-quick-undo"]').click();
  const undone = await until(async () => (await f.locator('[data-testid="board-quick-undone"]').count()) === 1, 10_000);
  const gone = first ? (await sceneOf(page)).elements.every((e) => !first.ids.includes(e.id)) : false;
  ok(`${theme}@${w.name}: Geri al removes the drawing in one click, nothing skipped`, undone && gone && !/left as you|dokunulmadı/.test(await lineText(page)), await lineText(page));
  await shot(page, theme, w, 'undone');

  // Not a board change: nothing written, Super'e sor offered.
  const bytes = boardBytes();
  await ask(page, 'Bu hafta kaç görev kapattık?');
  const nb = await until(async () => (await f.locator('[data-testid="board-quick-notboard"]').count()) === 1, 70_000);
  ok(`${theme}@${w.name}: a non-board request writes nothing and offers Super'e sor`, nb && boardBytes() === bytes && (await f.locator('[data-testid="board-quick-ask-super"]').count()) === 1, await lineText(page));
  await shot(page, theme, w, 'not-board');
  if (!full) return;

  // A change to a shape he did not select: nothing written, "select it".
  await page.keyboard.press('Escape');
  await clickScene(page, await sceneOf(page), -400, -400);
  const bytes2 = boardBytes();
  await ask(page, "Seçenek D'yi kırmızı yap");
  const oos = await until(async () => (await f.locator('[data-testid="board-quick-outofscope"], [data-testid="board-quick-done"]').count()) === 1, 70_000);
  const oosLine = await lineText(page);
  ok(`${theme}@${w.name}: a change to an unselected shape writes nothing and says to select it`, oos && boardBytes() === bytes2 && (await f.locator('[data-testid="board-quick-outofscope"]').count()) === 1, oosLine);
  await shot(page, theme, w, 'out-of-scope');

  // Recolor, rename, grow the selected card.
  const s0 = await sceneOf(page);
  const d = cardOf(s0, 'Seçenek D');
  timings.push(await timedChange(page, theme, w, 'Seçenek D', 'Bunu yeşil yap', 'recolor', (s, b) => fillOf(s, d.id) !== b.card.fill));
  timings.push(await timedChange(page, theme, w, 'Seçenek D', 'Adını Seçenek E yap', 'rename', (s) => (labelOf(s, d)?.text ?? '').includes('Seçenek E')));
  const renamedOk = await until(async () => (labelOf(await sceneOf(page), d)?.text ?? '').includes('Seçenek E'), 1000);
  ok(`${theme}@${w.name}: the label of the selected shape changes (criterion 9)`, renamedOk);
  // Undo the rename: the label comes back, nothing skipped (the page kept the agent's identity).
  await new Promise((r) => setTimeout(r, 2500));
  await f.locator('[data-testid="board-quick-undo"]').click();
  const back = await until(async () => (labelOf(await sceneOf(page), d)?.text ?? '').includes('Seçenek D'), 10_000);
  ok(`${theme}@${w.name}: Geri al restores the label, nothing skipped`, back && !/left as you|dokunulmadı/.test(await lineText(page)), await lineText(page));
  timings.push(await timedChange(page, theme, w, 'Seçenek D', 'Biraz büyüt', 'scale', (s, b) => (s.elements.find((e) => e.id === d.id)?.w ?? 0) > b.card.w + 1));
  const c = cardOf(s0, 'Seçenek C');
  timings.push(await timedChange(page, theme, w, 'Seçenek C', 'Rengini sarı yap', 'recolor', (s, b) => fillOf(s, c.id) !== b.card.fill));
  timings.push(await timedChange(page, theme, w, 'Seçenek C', 'Adını Seçenek A yap', 'rename', (s) => (labelOf(s, c)?.text ?? '').includes('Seçenek A')));
  for (const words of ['Buraya küçük bir güneş çiz', 'Buraya bir ok çiz', 'Buraya bir yıldız ekle']) {
    const t = await timedAdd(page, theme, w, words);
    if (t) timings.push(t);
  }

  // Durdur before the apply: the board file stays byte-identical.
  await page.keyboard.press('Escape');
  let s = await sceneOf(page);
  const spot = await emptySpot(page, s, Math.min(220, s.width / 3), Math.min(180, s.height / 5));
  await drag(page, spot);
  await until(async () => /(Area|Alan) ·/.test(await regionOf(page)), 3000);
  const frozen = boardBytes();
  await ask(page, REAL ? 'Buraya ayrıntılı bir ev çiz, pencereleri ve kapısıyla' : 'Buraya yavaş bir elma çiz');
  const stopBtn = f.locator('[data-testid="board-quick-stop"]');
  await until(async () => (await stopBtn.count()) === 1, 3000, 15);
  await shot(page, theme, w, 'running-stop');
  await stopBtn.click();
  const stopped = await until(async () => (await f.locator('[data-testid="board-quick-stopped"], [data-testid="board-quick-done"]').count()) === 1, 30_000);
  const wasStopped = (await f.locator('[data-testid="board-quick-stopped"]').count()) === 1;
  ok(`${theme}@${w.name}: Durdur ends the edit and the board file is byte-identical (criterion 5)`, stopped && wasStopped && boardBytes() === frozen, wasStopped ? 'stopped' : `the apply had begun: ${await lineText(page)}`);

  // The owner's hand during a run: he moves the card the edit is about; his move survives.
  {
    await page.keyboard.press('Escape');
    s = await sceneOf(page);
    const cc = cardOf(s, 'Seçenek');
    await clickScene(page, s, cc.x + 20, cc.y + 20);
    await until(async () => (await sceneOf(page)).selected.includes(cc.id), 3000);
    await ask(page, REAL ? 'Bunu turuncu yap' : 'yavaş yeşil yap');
    await until(async () => (await f.locator('[data-testid="board-quick-running"]').count()) === 1, 3000);
    const s1 = await sceneOf(page);
    const x0 = s1.elements.find((e) => e.id === cc.id).x;
    // His hand: drag the card 80 px right with the mouse while the edit runs.
    const from = screen(s1, cc.x + 30, cc.y + 30);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y, { steps: 5 });
    await page.mouse.move(from.x + 80, from.y, { steps: 5 });
    await page.mouse.up();
    const moved = (await sceneOf(page)).elements.find((e) => e.id === cc.id).x;
    await waitIdle(page);
    await new Promise((r) => setTimeout(r, 2500));
    const disk = JSON.parse((/```json\n([\s\S]*?)\n```/.exec(boardBytes()) ?? [])[1] ?? '{"elements":[]}').elements.find((e) => e.id === cc.id);
    ok(`${theme}@${w.name}: a hand edit during a run wins: his move stays, the shape is named as skipped`,
      moved > x0 && disk && Math.abs(disk.x - moved) < 1 && /left as you|dokunulmadı/.test(await lineText(page)), `x ${x0} → ${moved}, disk ${disk?.x}; ${await lineText(page)}`);
    await shot(page, theme, w, 'hand-wins');
  }
}

for (const theme of ['light', 'dark']) {
  await app.look(`/?vault=proj#wb=${SLUG}`, async (page, w) => {
    try {
      await openBoard(page);
      await scenario(page, w, theme, theme === 'light' && w.name === 'desktop');
    } catch (err) {
      // Collect, don't fail fast: the next theme and width still run, and the state is on a shot.
      ok(`${theme}@${w.name}: the scenario ran to its end`, false, String(err?.message ?? err).split('\n')[0].slice(0, 200));
      await shot(page, theme, w, 'threw').catch(() => {});
    }
  }, { name: `${theme}`, init: () => `try { localStorage.setItem('dreamcontext-theme', '${theme}'); } catch {}` });
}

// The journal: one record per edit that wrote, with its cost (criterion 15).
const records = journal();
const costs = records.map((r) => r.costUsd).filter((c) => typeof c === 'number');
const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const byKind = (k) => timings.filter((t) => t && (k === 'add' ? t.kind === 'add in region' : t.kind !== 'add in region')).map((t) => t.ms);
const summary = {
  real: REAL,
  model: records[0]?.model ?? null,
  runs: timings.filter(Boolean),
  medianAddMs: median(byKind('add')),
  medianChangeMs: median(byKind('change')),
  medianCostUsd: median(costs),
  costs,
  before: { path: 'Super (Opus) → child', firstShapeMs: 35_600, costUsd: 0.459 },
};
writeFileSync(join(app.shots, 'timings.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`timings: ${join(app.shots, 'timings.json')}\n${JSON.stringify({ medianAddMs: summary.medianAddMs, medianChangeMs: summary.medianChangeMs, medianCostUsd: summary.medianCostUsd, n: summary.runs.length })}\n`);
if (REAL) {
  ok('median add in a region ≤ 8 s (criterion 15)', summary.medianAddMs !== null && summary.medianAddMs <= 8000, `${summary.medianAddMs} ms`);
  ok('median recolor/rename ≤ 4 s (criterion 15)', summary.medianChangeMs !== null && summary.medianChangeMs <= 4000, `${summary.medianChangeMs} ms`);
  ok('median cost per edit ≤ $0.03 (criterion 15)', summary.medianCostUsd !== null && summary.medianCostUsd <= 0.03, `$${summary.medianCostUsd}`);
}

const failed = results.filter((r) => !r.pass).length;
const code = await app.finish();
process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 && code === 0 ? 0 : 1);
