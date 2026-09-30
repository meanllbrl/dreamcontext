#!/usr/bin/env node
/**
 * Whiteboards: end-to-end proof in the real dashboard, in real Chromium.
 *
 *   npm run build && npm run verify:whiteboard
 *
 * Boots the REAL dashboard server from the BUILT dashboard + CLI on an isolated scratch vault
 * (fake HOME, no user state touched, no network: the seeded insight is a local lab script,
 * every web-widget request is intercepted), then drives the Whiteboard page with Playwright.
 * Each numbered block maps to an acceptance criterion of the whiteboard task:
 *
 *   A15  the rail says "Whiteboard" (Workspace) and the old group is "System" (Packs,
 *        Settings); a click lands inside the default board, "Control Panel", no list page; the board's file
 *        exists exactly once even when the default is raced and the page reloaded twice.
 *   A4   create a board from the switcher's "+", draw, reload, still there (on disk AND through
 *        `whiteboard show --json`).
 *   A5   right-click on EMPTY canvas opens our widget palette; right-click on an element opens
 *        Excalidraw's own menu; "+ Add" opens the same palette.
 *   A6   every widget kind added through the palette renders non-empty; a dangling ref says
 *        "not found"; a widget drags like a shape; a centre click activates it; two todo ticks
 *        in a row both land (`show --json` done:true, A2's "ticked in the UI reads back").
 *   A7   a CLI `whiteboard add … todo` shows up within 3s while the page is open, and a
 *        rectangle the user drew a moment earlier (not yet saved) survives it.
 *   A8   the HTML block's iframe: sandbox exactly "allow-scripts", allow = SANDBOX_ALLOW, no
 *        REACH_BRIDGE, its script runs; a block that sets location.href is torn down; chord
 *        messages from a block change nothing (and a REAL ⌘A+Backspace does). The web widget
 *        waits for Load, carries allow="" and no allow-popups; http:// and our origin are refused.
 *   A9   element links: `/api/whiteboards` and a same-origin URL leave location unchanged and
 *        never call window.open; a dreamcontext:// link navigates in-app.
 *   A11  a PUT that fails (503) shows "Not saved", retries, and saves once unblocked; a corrupt
 *        board shows the read-only card and its bytes never change.
 *   A12  a pasted or dropped PNG is refused visibly; nothing image-typed ever lands on disk.
 *   A16  the board switcher: All boards (search, Default badge, "Cannot be read", no delete on
 *        the default, inline delete confirm, Esc, arrows + Enter); "+" creates "Günlük" (slug
 *        gunluk, name verbatim) and opens it; an edit made just before switching away is saved.
 *   A17  widget sizes S/M/L/XL: palette defaults per kind; the size picker (L then S, on disk);
 *        a handle-resize snaps to the nearest preset; a drag snaps x/y to the 196px pitch;
 *        `whiteboard add … --size xl` renders XL; an S insight is a number, an L one a chart.
 *   A18  widget elements carry a transparent stroke (palette AND CLI); Excalidraw's own
 *        interact hint shows only while an inactive widget is hovered; one click on an empty
 *        note opens its editor; empty note/HTML say so.
 *
 * Reading Excalidraw's live scene: the canvas exposes no handle to the page, so the script
 * reads the App instance off the React fiber of `.excalidraw` (read-only: viewport transform
 * and element list). That is what turns "draw at this pixel" into scene coordinates and lets
 * the script check the in-memory scene, not only the file.
 *
 * Same harness contract as lab-board.mjs / chat-html.mjs: real server, isolated fake HOME,
 * COLLECT-DON'T-FAIL-FAST reporting, non-zero exit if any check fails, screenshots in both
 * themes under <scratch>/shots (control-panel, switcher-open, switcher-new, widget-selected,
 * sizes, plus the flow shots).
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-whiteboard');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = 45761;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');
const DC = join(PROJ, '_dream_context');
const LAB = join(DC, 'lab');
const BOARDS = join(DC, 'whiteboards');

const results = [];
const ok = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);

// ─── the widget-size contract (task CONTRACT, A17) ──────────────────────────────────────────

const SIZES = { s: [180, 180], m: [376, 180], l: [376, 376], xl: [768, 376] };
const PITCH = 180 + 16;
const DEFAULT_SIZE = { insight: 'm', knowledge: 's', task: 's', todo: 'm', note: 'm', html: 'l', web: 'l' };
/** Same rule as the product (squared distance, ties to the smaller). */
function nearestSize(w, h) {
  let best = 's';
  let bestD = Infinity;
  for (const [k, [pw, ph]] of Object.entries(SIZES)) {
    const d = (w - pw) ** 2 + (h - ph) ** 2;
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}
const onGrid = (v) => Math.abs(v / PITCH - Math.round(v / PITCH)) < 1e-6;

// ─── the CLI, in the scratch vault ──────────────────────────────────────────────────────────

function dc(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  }).toString();
}

/** A CLI call whose failure is the point: exit code and output, never a throw. */
function dcTry(args) {
  const r = spawnSync('node', [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const boardPath = (slug) => join(BOARDS, slug, `${slug}.excalidraw.md`);
const sha = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');

/** `whiteboard show <slug> --json`: the agent's view of the board (live elements only). */
function show(slug) {
  return JSON.parse(dc(['whiteboard', 'show', slug, '--json']));
}

/** Every element type ever written to the file, tombstones included (the raw drawing block). */
function rawTypesOnDisk(slug) {
  const md = readFileSync(boardPath(slug), 'utf-8');
  return [...md.matchAll(/"type":\s*"([a-z_-]+)"/g)].map((m) => m[1]);
}

/** The raw elements in the file's drawing block (strokeColor and all), or [] if unreadable. */
function rawElements(slug) {
  try {
    const md = readFileSync(boardPath(slug), 'utf-8');
    const m = /##\s*Drawing\s*```json\s*([\s\S]*?)```/.exec(md);
    return m ? (JSON.parse(m[1]).elements ?? []) : [];
  } catch { return []; }
}
const rawWidgets = (slug) => rawElements(slug).filter((e) => e.type === 'embeddable' && !e.isDeleted);

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────

const INSIGHT = { slug: 'weekly-signups', title: 'Weekly signups' };
const KNOWLEDGE = { name: 'onboarding-playbook', title: 'Onboarding playbook' };
const TASK_NAME = 'Draft the onboarding checklist';
const DANGLING_REF = 'no-such-note';

/** 1×1 transparent PNG. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(DC, 'state'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  try { dc(['init', '--yes']); } catch { /* scaffold best-effort */ }

  // One insight with twelve weeks of history, backed by a local script (no network).
  mkdirSync(join(LAB, 'scripts'), { recursive: true });
  dc(['lab', 'create', INSIGHT.slug, '--title', INSIGHT.title, '--render', 'number', '--adapter', 'script', '--unit', 'users']);
  writeFileSync(join(LAB, 'scripts', `${INSIGHT.slug}.mjs`), `export default async function (ctx) {
  const { toISO } = ctx.resolvedTweaks.range;
  const end = new Date(toISO).getTime();
  const values = [2480, 2610, 2595, 2870, 3010, 2960, 3240, 3395, 3520, 3780, 3905, 4210];
  const week = 7 * 24 * 3600 * 1000;
  return [{ name: 'signups', points: values.map((v, i) => ({ t: new Date(end - (values.length - 1 - i) * week).toISOString(), v })) }];
}
`, 'utf-8');
  dc(['lab', 'sync', INSIGHT.slug]);

  // One knowledge file (with a summary), one task.
  mkdirSync(join(DC, 'knowledge'), { recursive: true });
  dc(['knowledge', 'create', KNOWLEDGE.name, '-d', 'How a new workspace gets from sign-up to its first shared board in three steps', '-t', 'onboarding',
    '-c', '# Onboarding playbook\n\nThree steps from sign-up to the first shared board.']);
  dc(['tasks', 'create', TASK_NAME, '--why', 'Verify fixture: a task the task widget can show']);
}

/** The slug the CLI gave the seeded task (the widget ref). */
function taskSlug() {
  const f = readdirSync(join(DC, 'state')).find((n) => n.startsWith('draft-the-onboarding-checklist'));
  return f ? f.replace(/\.md$/, '') : '';
}

/** Board directories on disk, and the .excalidraw.md files inside one. */
// Dot-directories (the store's `.locks`) are not boards.
const boardDirs = () => (existsSync(BOARDS)
  ? readdirSync(BOARDS).filter((n) => !n.startsWith('.') && statSync(join(BOARDS, n)).isDirectory())
  : []);
const boardFiles = (slug) => (existsSync(join(BOARDS, slug)) ? readdirSync(join(BOARDS, slug)).filter((n) => n.endsWith('.excalidraw.md')) : []);

async function waitForServer(url, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until truthy or `ms` elapses; returns the last value. */
async function until(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    await sleep(step);
  }
  return v;
}

// ─── in-page probes ─────────────────────────────────────────────────────────────────────────

/**
 * Excalidraw's live state, read off the React fiber of `.excalidraw` (read-only). Returns the
 * viewport transform and every element (tombstones included), or null before mount.
 */
function readScene(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.wbp-canvas .excalidraw');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    let f = key ? root[key] : null;
    while (f) {
      const s = f.stateNode;
      if (s && s.scene && s.state && s.state.zoom) {
        const st = s.state;
        return {
          zoom: st.zoom.value, scrollX: st.scrollX, scrollY: st.scrollY,
          offsetLeft: st.offsetLeft, offsetTop: st.offsetTop, width: st.width, height: st.height,
          active: st.activeEmbeddable ? { id: st.activeEmbeddable.element.id, state: st.activeEmbeddable.state } : null,
          elements: s.scene.getElementsIncludingDeleted().map((e) => ({
            id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height,
            isDeleted: !!e.isDeleted, version: e.version, link: e.link ?? null, strokeColor: e.strokeColor,
            kind: e.customData?.dc?.kind ?? null, size: e.customData?.dc?.size ?? null,
          })),
        };
      }
      f = f.return;
    }
    return null;
  });
}

const live = (scene) => (scene?.elements ?? []).filter((e) => !e.isDeleted);
const toClient = (s, x, y) => ({ x: (x + s.scrollX) * s.zoom + s.offsetLeft, y: (y + s.scrollY) * s.zoom + s.offsetTop });
const toScene = (s, cx, cy) => ({ x: (cx - s.offsetLeft) / s.zoom - s.scrollX, y: (cy - s.offsetTop) / s.zoom - s.scrollY });
const centreOf = (s, el) => toClient(s, el.x + el.width / 2, el.y + el.height / 2);

/** Room a new widget of `kind` needs around the click: its box plus a grid pitch, since the
 *  palette centres it on the click and then snaps the corner to the 196px grid. */
const roomFor = (kind) => ({ w: SIZES[DEFAULT_SIZE[kind]][0] + PITCH, h: SIZES[DEFAULT_SIZE[kind]][1] + PITCH });

/**
 * A client point on EMPTY canvas with room for a `size` box centred on it, clear of
 * Excalidraw's toolbars and of every live element. Found from the live scene, never assumed.
 */
function emptySpot(s, taken = [], size = { w: 376, h: 376 }) {
  const w = size.w * s.zoom;
  const h = size.h * s.zoom;
  const pad = 24;
  // 260: the shape-properties panel Excalidraw opens on the left once a drawing tool is picked.
  const left = s.offsetLeft + 260;
  const right = s.offsetLeft + s.width - 90;
  const top = s.offsetTop + 90;
  const bottom = s.offsetTop + s.height - 90;
  const boxes = [
    ...live(s).map((e) => {
      const a = toClient(s, e.x, e.y);
      return { x1: a.x, y1: a.y, x2: a.x + e.width * s.zoom, y2: a.y + e.height * s.zoom };
    }),
    ...taken,
  ];
  for (let cy = top + h / 2; cy + h / 2 <= bottom; cy += 40) {
    for (let cx = left + w / 2; cx + w / 2 <= right; cx += 40) {
      const box = { x1: cx - w / 2 - pad, y1: cy - h / 2 - pad, x2: cx + w / 2 + pad, y2: cy + h / 2 + pad };
      if (boxes.every((b) => box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2)) {
        return { x: Math.round(cx), y: Math.round(cy) };
      }
    }
  }
  return null;
}

async function main() {
  setup();
  const TASK_SLUG = taskSlug();
  ok('fixture: the seeded task has a slug', !!TASK_SLUG);
  const SANDBOX_ALLOW = /export const SANDBOX_ALLOW = '([^']*)'/.exec(
    readFileSync(join(REPO, 'dashboard', 'src', 'lib', 'sandboxHtml.ts'), 'utf-8'),
  )?.[1];
  ok('fixture: SANDBOX_ALLOW read from source', SANDBOX_ALLOW !== undefined);

  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  let browser;
  let page;
  try {
    await waitForServer(`${ORIGIN}/api/whiteboards`);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    // Every window.open is recorded and refused (A9): Excalidraw's link fallback goes through it.
    await context.addInitScript(() => {
      window.__dcOpens = [];
      window.open = function (...args) { window.__dcOpens.push(args.map(String)); return null; };
    });
    // No web-widget host is ever reached: requests are recorded and answered locally (A8).
    const webHits = [];
    await context.route(/^https:\/\/(www\.)?example\.com\//, (route) => {
      webHits.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stub</h1>' });
    });
    // A doubled `/api/api/whiteboards` prefix (a Phase-1 defect) is recorded as its own FAIL
    // below and rewritten here only so the checks past it still run. Fixed, it never matches.
    const doublePrefixHits = [];
    await context.route(/\/api\/api\/whiteboards/, (route) => {
      const url = route.request().url();
      doublePrefixHits.push(`${route.request().method()} ${new URL(url).pathname}`);
      return route.continue({ url: url.replace('/api/api/whiteboards', '/api/whiteboards') });
    });
    page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    let mainNavs = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) mainNavs += 1; });

    const setTheme = async (t) => { await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t); await page.waitForTimeout(250); };
    const shoot = async (name) => {
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
      }
      await setTheme('light');
    };
    const dismissModal = async () => {
      if (await page.locator('.announcements-modal-scrim').count()) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    };
    const scene = () => readScene(page);
    /** An empty spot (see emptySpot); zooms Excalidraw out while the visible canvas is full. */
    const spot = async (size, taken = []) => {
      for (let i = 0; i < 14; i += 1) {
        const p = emptySpot(await scene(), taken, size);
        if (p) return p;
        await page.locator('.excalidraw .zoom-out-button').click();
        await page.waitForTimeout(250);
      }
      return null;
    };
    const currentName = async () => (await page.locator('.wbs-current-name').innerText().catch(() => '')).trim();
    const panel = page.locator('.wbs-panel--boards');
    const openSwitcher = async () => {
      if (!(await panel.count())) await page.locator('.wbs-current').click();
      await panel.waitFor({ timeout: 5000 });
    };
    /**
     * Wait for a board's row in All boards. The list is a polled query (stale after 5s, polled
     * every 15s), so a board the CLI made a moment ago can take a poll to show: close and reopen
     * the popover (a remount refetches a stale list) until it does, up to `ms`.
     */
    const waitRow = async (name, ms = 20000) => {
      const end = Date.now() + ms;
      const row = panel.locator('.wbs-row-open', { hasText: name }).first();
      while (Date.now() < end) {
        await openSwitcher();
        if (await row.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) return row;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      await openSwitcher();
      return row;
    };
    /** Open a board through the switcher's All boards list, as a user does. */
    const openBoard = async (name) => {
      const row = await waitRow(name);
      await row.click();
      await until(async () => (await currentName()) === name
        && ((await scene())?.width > 0 || await page.locator('.wbp-card-state').count()), 15000);
      await page.waitForTimeout(700);
    };
    /** Deselect + deactivate: a click on empty canvas, then Escape. */
    const clearSelection = async () => {
      const p = await spot({ w: 40, h: 40 });
      if (p) await page.mouse.click(p.x, p.y);
      await focusCanvas();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    };
    /** Excalidraw hears keys only while focus is inside its own (tabIndex=0) container. */
    const focusCanvas = () => page.locator('.wbp-canvas .excalidraw-container').first().focus();
    const drawRect = async (x1, y1, x2, y2) => {
      // The testid sits on the tool's visually-hidden radio; its label is what a user clicks.
      await page.locator('.wbp-canvas label:has([data-testid="toolbar-rectangle"])').first().click();
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
      await page.mouse.move(x2, y2, { steps: 4 });
      await page.mouse.up();
      await focusCanvas();
      await page.keyboard.press('Escape');
    };
    const onDisk = (slug) => {
      try { return show(slug).elements; } catch { return []; }
    };
    const listBoards = async () => {
      const r = await (await fetch(`${ORIGIN}/api/whiteboards`)).json();
      return Array.isArray(r) ? r : (r.whiteboards ?? []);
    };
    /** Where the page's pointer rests between checks: the sidebar, off the canvas. */
    const parkPointer = () => page.mouse.move(8, 990);

    await page.goto(`${ORIGIN}/?vault=proj`, { waitUntil: 'networkidle' });
    await dismissModal();

    // ── A15: the rail, the default board, exactly one file ─────────────────────────────────
    // The feature is "Whiteboard" (owner, 2026-09-30); "Control Panel" is only the default board's name.
    const railItem = page.locator('.sidebar-item', { hasText: /Whiteboard(?!s)/ });
    ok('A15 "Whiteboard" is in the rail, once', await railItem.count() === 1, String(await railItem.count()));
    ok('A15 no rail entry says "Control Panel" any more', await page.locator('.sidebar-item', { hasText: 'Control Panel' }).count() === 0);
    ok('A15 …nor the plural "Whiteboards"', await page.locator('.sidebar-item', { hasText: 'Whiteboards' }).count() === 0);
    const rail = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.sidebar-group')].map((g) => ({
        label: (g.querySelector('.sidebar-group-label')?.textContent || '').trim(),
        items: [...g.querySelectorAll('.sidebar-item')].map((el) => (el.querySelector('.sidebar-label')?.textContent || el.textContent || '').trim()),
      }));
      const item = [...document.querySelectorAll('.sidebar-item')].find((el) => /Whiteboard(?!s)/.test(el.textContent || ''));
      return { groups, alpha: /alpha/i.test(item?.textContent || '') };
    });
    const ws = rail.groups.find((g) => /workspace/i.test(g.label));
    const sys = rail.groups.find((g) => g.label === 'System');
    ok('A15 …in the Workspace group', !!ws?.items.includes('Whiteboard'), JSON.stringify(rail.groups));
    const iAuto = ws?.items.findIndex((t) => /Automations/.test(t)) ?? -1;
    const iCp = ws?.items.indexOf('Whiteboard') ?? -1;
    ok('A15 …right after Automations', iAuto >= 0 && iCp === iAuto + 1, ws?.items.join(' | '));
    ok('A15 …tagged alpha', rail.alpha);
    ok('A15 the group holding Packs and Settings is titled "System"',
      !!sys && sys.items.includes('Packs') && sys.items.includes('Settings'), JSON.stringify(rail.groups));
    ok('A15 …and no rail group is titled "Control Panel"', !rail.groups.some((g) => g.label === 'Control Panel'),
      rail.groups.map((g) => g.label).join(' | '));
    ok('A15 fixture: no board exists before the first open', boardDirs().length === 0, boardDirs().join(','));

    // The click races two direct GETs of the default: the server makes the board once.
    const [, d1, d2] = await Promise.all([
      railItem.click(),
      fetch(`${ORIGIN}/api/whiteboards/default`).then((r) => r.json()).catch((e) => ({ error: String(e) })),
      fetch(`${ORIGIN}/api/whiteboards/default`).then((r) => r.json()).catch((e) => ({ error: String(e) })),
    ]);
    ok('A15 GET /api/whiteboards/default answers {slug: "control-panel"}', d1?.slug === 'control-panel' && d2?.slug === 'control-panel',
      JSON.stringify([d1, d2]));
    const landed = await until(async () => (await scene())?.width > 0, 15000);
    ok('A15 clicking Whiteboard lands inside a board (canvas mounted)', !!landed);
    ok('A15 …the board "Control Panel"', await currentName() === 'Control Panel', await currentName());
    ok('A15 …with no list page', await page.locator('.wbp-page, .wbp-card-open').count() === 0);
    await shoot('control-panel-empty');
    // Two rapid reloads, each re-asking for the default.
    await page.reload({ waitUntil: 'commit' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissModal();
    if (!(await page.locator('.wbs-current').count())) await railItem.click().catch(() => {});
    await until(async () => (await currentName()) === 'Control Panel' && (await scene())?.width > 0, 15000);
    ok('A15 after two rapid reloads the page is back on Control Panel', await currentName() === 'Control Panel', await currentName());
    ok('A15 on disk: exactly one board directory, control-panel', JSON.stringify(boardDirs()) === '["control-panel"]', JSON.stringify(boardDirs()));
    ok('A15 on disk: control-panel/control-panel.excalidraw.md exists exactly once',
      JSON.stringify(boardFiles('control-panel')) === '["control-panel.excalidraw.md"]', JSON.stringify(boardFiles('control-panel')));
    const list15 = await listBoards();
    ok('A15 the board list has one "Control Panel"', list15.filter((b) => b.slug === 'control-panel' || b.name === 'Control Panel').length === 1,
      JSON.stringify(list15.map((b) => [b.slug, b.name])));
    const delDefault = await fetch(`${ORIGIN}/api/whiteboards/control-panel`, { method: 'DELETE' });
    ok('A15 the server refuses to delete the default board (409)', delDefault.status === 409, String(delDefault.status));

    // ── A4: create from the switcher's "+", open, draw, reload, persisted ─────────────────
    await page.locator('.wbs-icon-btn').click();
    await page.locator('.wbs-create-input').fill('Verify board');
    await page.locator('.wbs-create-input').press('Enter');
    const opened = await until(async () => (await currentName()) === 'Verify board' && (await scene())?.width > 0, 15000);
    ok('A4 creating a board from "+" opens it', !!opened, await currentName());
    const SLUG = 'verify-board';
    ok('A4 the board file exists on disk', existsSync(boardPath(SLUG)));
    await page.waitForTimeout(600);

    let s = await scene();
    const c0 = { x: s.offsetLeft + s.width / 2, y: s.offsetTop + s.height / 2 };
    await page.mouse.click(c0.x, c0.y); // focus the canvas
    await drawRect(c0.x - 320, c0.y + 120, c0.x - 200, c0.y + 200);
    const rectSaved = await until(() => onDisk(SLUG).filter((e) => e.type === 'rectangle').length === 1, 8000);
    ok('A4 a drawn rectangle is saved to disk', !!rectSaved, JSON.stringify(onDisk(SLUG)));
    const RECT_ID = onDisk(SLUG).find((e) => e.type === 'rectangle')?.id;
    await page.waitForTimeout(500);
    ok('A4 the header says Saved', /Saved/.test(await page.locator('.wbp-status').innerText().catch(() => '')));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissModal();
    if (!(await page.locator('.wbs-current').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false))) {
      await railItem.click();
    }
    await openBoard('Verify board');
    s = await scene();
    ok('A4 after a reload the rectangle is back in the live scene',
      live(s).some((e) => e.id === RECT_ID && e.type === 'rectangle'), JSON.stringify(live(s)));
    ok('A4 …and `whiteboard show --json` lists it', show(SLUG).elements.some((e) => e.id === RECT_ID && e.type === 'rectangle'));
    const api = await (await fetch(`${ORIGIN}/api/whiteboards/${SLUG}`)).json();
    ok('A4 …and GET /api/whiteboards/:slug serves it', (api.elements ?? []).some((e) => e.id === RECT_ID && !e.isDeleted));

    // ── A5: right-click routing and "+ Add" ───────────────────────────────────────────────
    const paletteItems = () => page.locator('.wb-palette .wb-palette-item').allInnerTexts();
    const excaliMenu = () => page.locator('.excalidraw .context-menu').count();
    const spot5 = await spot();
    s = await scene();
    await page.mouse.click(spot5.x, spot5.y, { button: 'right' });
    await page.waitForTimeout(300);
    const rightClickItems = await paletteItems();
    ok('A5 right-click on empty canvas opens the widget palette', rightClickItems.length > 0);
    ok('A5 …and not Excalidraw\'s own menu', await excaliMenu() === 0);
    ok('A5 the palette lists all seven kinds + Canvas menu',
      ['Insight', 'Knowledge', 'Task', 'Todo', 'Note', 'HTML', 'Web', 'Canvas menu'].every((k) => rightClickItems.some((t) => t.includes(k))),
      rightClickItems.join(' | '));
    await shoot('palette-rightclick');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('A5 Escape closes the palette', await page.locator('.wb-palette').count() === 0);

    const rect = live(s).find((e) => e.id === RECT_ID);
    const rc = centreOf(s, rect);
    await page.mouse.click(rc.x, rc.y, { button: 'right' });
    await page.waitForTimeout(400);
    ok('A5 right-click on an element opens Excalidraw\'s context menu', await excaliMenu() > 0);
    ok('A5 …and not our palette', await page.locator('.wb-palette').count() === 0);
    await shoot('element-menu');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await clearSelection();

    await page.locator('.wb-add-btn').click();
    await page.waitForTimeout(300);
    const addItems = await paletteItems();
    ok('A5 "+ Add" opens the same palette',
      addItems.length > 0 && JSON.stringify(addItems) === JSON.stringify(rightClickItems.filter((t) => !/Canvas menu/.test(t))),
      `${addItems.join(' | ')} vs ${rightClickItems.join(' | ')}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ── A6: every kind through the palette ─────────────────────────────────────────────────
    const widget = (kind) => page.locator(`.wb-widget[data-widget-kind="${kind}"]`);
    const addViaPalette = async (kind, label, pick) => {
      const at = await spot(roomFor(kind));
      if (!at) return false;
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await page.waitForTimeout(250);
      await page.locator('.wb-palette .wb-palette-item', { hasText: label }).first().click();
      if (pick) await pick();
      await page.waitForTimeout(400);
      await clearSelection();
      return true;
    };
    const pickRow = (title) => async () => {
      await page.locator('.wb-picker-row', { hasText: title }).first().click({ timeout: 8000 });
    };

    ok('A6 insight added via palette', await addViaPalette('insight', 'Insight', pickRow(INSIGHT.title)));
    ok('A6 knowledge added via palette', await addViaPalette('knowledge', 'Knowledge', pickRow(KNOWLEDGE.name)));
    ok('A6 task added via palette', await addViaPalette('task', 'Task', pickRow(TASK_NAME)));
    ok('A6 todo added via palette', await addViaPalette('todo', 'Todo list'));
    ok('A6 note added via palette', await addViaPalette('note', 'Note'));
    ok('A6 html added via palette', await addViaPalette('html', 'HTML block'));

    // The web picker refuses http:// and the dashboard's own origin before it accepts https.
    const webRefusals = [];
    ok('A6 web added via palette', await addViaPalette('web', 'Web embed', async () => {
      const input = page.locator('.wb-picker-search');
      for (const bad of ['http://example.com/verify', `${ORIGIN}/`]) {
        await input.fill(bad);
        await page.locator('.wb-palette-btn').click();
        await page.waitForTimeout(150);
        webRefusals.push({ url: bad, error: await page.locator('.wb-picker-error').innerText().catch(() => '') });
      }
      await input.fill('https://example.com/verify');
      await page.locator('.wb-palette-btn').click();
    }));
    ok('A8 the web picker refuses an http:// URL', !!webRefusals[0]?.error, JSON.stringify(webRefusals[0]));
    ok('A8 the web picker refuses the dashboard\'s own origin', !!webRefusals[1]?.error, JSON.stringify(webRefusals[1]));

    const KINDS = ['insight', 'knowledge', 'task', 'todo', 'note', 'html', 'web'];
    for (const kind of KINDS) {
      const n = await widget(kind).count();
      const body = n ? (await widget(kind).first().locator('.wb-widget-body').textContent()) ?? '' : '';
      ok(`A6 the ${kind} widget renders a non-empty body`, n === 1 && body.trim().length > 0, `${n} widgets, body="${body.trim().slice(0, 80)}"`);
    }
    await page.waitForTimeout(1500);
    ok('A6 the insight widget shows the seeded insight, not a "not found"',
      !/not found/i.test(await widget('insight').textContent()) && /4,?210|Weekly signups/.test(await widget('insight').textContent()),
      (await widget('insight').textContent()).slice(0, 120));
    ok('A6 the knowledge widget shows the knowledge file', /onboarding/i.test(await widget('knowledge').textContent()) && !/not found/i.test(await widget('knowledge').textContent()));
    ok('A6 the task widget shows the task', (await widget('task').textContent()).includes(TASK_NAME));
    const kindsOnDisk = await until(() => {
      const kinds = onDisk(SLUG).map((e) => e.kind).filter(Boolean);
      return KINDS.every((k) => kinds.includes(k)) && kinds;
    }, 8000);
    ok('A6 all seven palette widgets are saved to disk', !!kindsOnDisk, JSON.stringify(onDisk(SLUG).map((e) => e.kind)));
    ok('A6 the palette widgets carry the refs they were picked with',
      onDisk(SLUG).some((e) => e.kind === 'insight' && e.ref === INSIGHT.slug)
      && onDisk(SLUG).some((e) => e.kind === 'knowledge' && e.ref === KNOWLEDGE.name)
      && onDisk(SLUG).some((e) => e.kind === 'task' && e.ref === TASK_SLUG),
      JSON.stringify(onDisk(SLUG).filter((e) => e.ref).map((e) => [e.kind, e.ref])));

    // A17: each palette widget got its kind's default size, on disk and on screen, on the grid.
    for (const kind of KINDS) {
      const d = onDisk(SLUG).find((e) => e.kind === kind);
      const [w, h] = SIZES[DEFAULT_SIZE[kind]];
      ok(`A17 a palette ${kind} gets its default size ${DEFAULT_SIZE[kind].toUpperCase()} (${w}x${h}) on disk`,
        !!d && d.bbox.w === w && d.bbox.h === h && d.size === DEFAULT_SIZE[kind], JSON.stringify(d && { bbox: d.bbox, size: d.size }));
      ok(`A17 …and renders at size ${DEFAULT_SIZE[kind]}`, await widget(kind).first().getAttribute('data-widget-size').catch(() => null) === DEFAULT_SIZE[kind]);
    }
    ok('A17 palette widgets land on the 196px grid',
      KINDS.every((k) => { const d = onDisk(SLUG).find((e) => e.kind === k); return d && onGrid(d.bbox.x) && onGrid(d.bbox.y); }),
      JSON.stringify(onDisk(SLUG).filter((e) => e.kind).map((e) => [e.kind, e.bbox.x, e.bbox.y])));
    // A18: no double frame. Every palette widget's element stroke is transparent, on disk and live.
    const strokes = rawWidgets(SLUG).map((e) => e.strokeColor);
    ok('A18 palette widgets are saved with a transparent stroke', strokes.length === 7 && strokes.every((c) => c === 'transparent'), JSON.stringify(strokes));
    ok('A18 …and carry it in the live scene', live(await scene()).filter((e) => e.type === 'embeddable').every((e) => e.strokeColor === 'transparent'));

    // The web widget: click-to-load, nothing fetched and no iframe before Load (A8).
    const web = widget('web');
    ok('A8 the web widget shows its hostname and a Load button',
      /example\.com/.test(await web.textContent()) && await web.locator('button', { hasText: 'Load' }).count() === 1);
    ok('A8 the web widget has NOT created its iframe before Load', await page.locator('iframe.wb-web-frame').count() === 0);
    ok('A8 …and nothing was requested from the host', webHits.length === 0, webHits.join(', '));
    await parkPointer();
    await shoot('board-widgets');

    // A dangling ref says "not found" (added by the CLI, which warns but writes).
    const ghostSpot = await spot(roomFor('knowledge'));
    s = await scene();
    const ghostAt = toScene(s, ghostSpot.x, ghostSpot.y);
    const ghost = dcTry(['whiteboard', 'add', SLUG, 'knowledge', '--ref', DANGLING_REF, '--title', 'Ghost note',
      '--at', `${Math.round(ghostAt.x - 90)},${Math.round(ghostAt.y - 90)}`]);
    ok('A6 the CLI accepts a dangling ref with a warning', ghost.code === 0, ghost.out);
    const ghostShown = await until(async () => {
      const w = page.locator('.wb-widget[data-widget-kind="knowledge"]', { hasText: 'Ghost note' });
      return (await w.count()) && /not found/i.test(await w.textContent()) && await w.textContent();
    }, 5000);
    ok('A6 a widget with a dangling ref shows "not found"', !!ghostShown, String(ghostShown));

    // ── A7: a CLI write lands while an unsaved user edit is in flight ──────────────────────
    // Room for BOTH: a 376×180 todo next to a small rectangle.
    const pair = await spot({ w: 820, h: 240 });
    s = await scene();
    const rSpot = { x: pair.x - 280 * s.zoom, y: pair.y };
    const todoSpotClient = { x: pair.x + 200 * s.zoom, y: pair.y };
    const todoAt = toScene(s, todoSpotClient.x, todoSpotClient.y);
    const rectsBefore = live(s).filter((e) => e.type === 'rectangle').length;
    await page.mouse.click(rSpot.x, rSpot.y);
    await drawRect(rSpot.x - 60 * s.zoom, rSpot.y - 40 * s.zoom, rSpot.x + 60 * s.zoom, rSpot.y + 40 * s.zoom);
    const drawnLive = live(await scene()).filter((e) => e.type === 'rectangle').length;
    // Whether the CLI write below races an UNSAVED rectangle (the harder case) or a just-saved one.
    const unsavedAtCli = onDisk(SLUG).filter((e) => e.type === 'rectangle').length === rectsBefore;
    // Straight away: the rectangle is still inside the 800ms save debounce.
    const t0 = Date.now();
    const cliAdd = dcTry(['whiteboard', 'add', SLUG, 'todo', '--title', 'Today', '--item', 'Ship the verify script', '--item', 'Write the report',
      '--at', `${Math.round(todoAt.x - 188)},${Math.round(todoAt.y - 90)}`, '--json']);
    const cliDone = Date.now();
    ok('A7 fixture: the new rectangle is in the live scene before the CLI write', drawnLive === rectsBefore + 1, `${drawnLive} vs ${rectsBefore + 1}`);
    ok('A7 the CLI add succeeds while the board is open', cliAdd.code === 0, cliAdd.out);
    const TODO_ID = (() => { try { return JSON.parse(cliAdd.out).id; } catch { return /"id":\s*"([^"]+)"/.exec(cliAdd.out)?.[1]; } })();
    const appeared = await until(async () => (await page.locator('.wb-widget[data-widget-kind="todo"]', { hasText: 'Ship the verify script' }).count()) > 0, 5000, 100);
    const lag = Date.now() - cliDone;
    ok('A7 the CLI todo appears in the open board within 3s', !!appeared && lag <= 3000, `${lag}ms (CLI took ${cliDone - t0}ms)`);
    console.log(`info: A7 raced an ${unsavedAtCli ? 'UNSAVED' : 'already-saved'} rectangle; todo appeared ${lag}ms after the CLI returned`);
    await page.waitForTimeout(2500);
    s = await scene();
    ok('A7 the rectangle drawn just before survives in the live scene',
      live(s).filter((e) => e.type === 'rectangle').length === rectsBefore + 1,
      `${live(s).filter((e) => e.type === 'rectangle').length} rectangles (rectangle was ${unsavedAtCli ? 'unsaved' : 'already saved'} at the CLI write)`);
    const disk7 = onDisk(SLUG);
    ok('A7 …and on disk, next to the CLI todo',
      disk7.filter((e) => e.type === 'rectangle').length === rectsBefore + 1 && disk7.some((e) => e.id === TODO_ID),
      JSON.stringify(disk7.map((e) => e.type)));
    ok('A18 the CLI todo is written with a transparent stroke',
      rawWidgets(SLUG).find((e) => e.id === TODO_ID)?.strokeColor === 'transparent',
      String(rawWidgets(SLUG).find((e) => e.id === TODO_ID)?.strokeColor));

    // ── A6 + A17: a widget drags like a shape, and lands on the grid ──────────────────────
    await clearSelection();
    s = await scene();
    const note = live(s).find((e) => e.kind === 'note');
    // A diagonal step of one pitch (plus a little, so it is a real drag) into free space.
    const others = live(s).filter((e) => e.id !== note.id);
    const clear = (dx, dy) => {
      const b = { x1: note.x + dx - 8, y1: note.y + dy - 8, x2: note.x + dx + note.width + 8, y2: note.y + dy + note.height + 8 };
      const c1 = toClient(s, b.x1, b.y1);
      const c2 = toClient(s, b.x2, b.y2);
      const onScreen = c1.x > s.offsetLeft + 60 && c1.y > s.offsetTop + 70 && c2.x < s.offsetLeft + s.width - 60 && c2.y < s.offsetTop + s.height - 60;
      return onScreen && others.every((o) => b.x2 < o.x || b.x1 > o.x + o.width || b.y2 < o.y || b.y1 > o.y + o.height);
    };
    const dirs = [[1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].map(([a, b]) => [a * PITCH, b * PITCH]);
    const [dX, dY] = dirs.find(([a, b]) => clear(a, b)) ?? dirs[0];
    const fudge = (v) => (v === 0 ? 14 : v + Math.sign(v) * 22); // off-grid on purpose
    const grab = toClient(s, note.x + note.width * 0.12, note.y + note.height * 0.1);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + (fudge(dX) * s.zoom) / 2, grab.y + (fudge(dY) * s.zoom) / 2, { steps: 5 });
    await page.mouse.move(grab.x + fudge(dX) * s.zoom, grab.y + fudge(dY) * s.zoom, { steps: 5 });
    await page.mouse.up();
    const want = { x: Math.round((note.x + fudge(dX)) / PITCH) * PITCH, y: Math.round((note.y + fudge(dY)) / PITCH) * PITCH };
    const moved = await until(() => {
      const d = onDisk(SLUG).find((e) => e.id === note.id);
      return d && (d.bbox.x !== note.x || d.bbox.y !== note.y) && d;
    }, 8000);
    ok('A6 a widget drags like a shape (its x/y change on disk)', !!moved,
      `before ${note.x},${note.y} after ${JSON.stringify(onDisk(SLUG).find((e) => e.id === note.id)?.bbox)}`);
    const snapped = await until(() => {
      const d = onDisk(SLUG).find((e) => e.id === note.id);
      return d && d.bbox.x === want.x && d.bbox.y === want.y && d;
    }, 5000);
    ok('A17 a drag snaps the widget\'s x/y to the 196px pitch on disk', !!snapped,
      `dragged ${fudge(dX)},${fudge(dY)} from ${note.x},${note.y}; want ${want.x},${want.y}; disk ${JSON.stringify(onDisk(SLUG).find((e) => e.id === note.id)?.bbox)}`);
    await clearSelection();

    // ── A18: the interact hint is Excalidraw's, on hover of an inactive widget only ────────
    s = await scene();
    const todoEl = live(s).find((e) => e.id === TODO_ID);
    const todoWidget = page.locator('.wb-widget[data-widget-kind="todo"]', { hasText: 'Ship the verify script' });
    const hints = page.locator('.excalidraw__embeddable-hint');
    const visibleHints = async () => {
      let n = 0;
      for (let i = 0; i < await hints.count(); i += 1) if (await hints.nth(i).isVisible().catch(() => false)) n += 1;
      return n;
    };
    await parkPointer();
    await page.waitForTimeout(300);
    ok('A18 no interact hint shows on a board no pointer is over', await visibleHints() === 0, String(await visibleHints()));
    ok('A18 the widget card itself carries no "Click to interact" text', !/Click to interact/.test(await todoWidget.textContent()));
    const tc = centreOf(s, todoEl);
    await page.mouse.move(tc.x - 30, tc.y - 10);
    await page.mouse.move(tc.x, tc.y, { steps: 4 });
    const hinted = await until(async () => (await visibleHints()) === 1, 3000);
    ok('A18 hovering an inactive widget shows Excalidraw\'s interact hint', !!hinted, String(await visibleHints()));
    await shoot('widget-hover-hint');
    const off = await spot({ w: 40, h: 40 });
    await page.mouse.move(off.x, off.y, { steps: 4 });
    const unhinted = await until(async () => (await visibleHints()) === 0, 3000);
    ok('A18 …and it goes away when the pointer moves off onto empty canvas', !!unhinted);
    await page.mouse.move(tc.x - 30, tc.y - 10);
    await page.mouse.move(tc.x, tc.y, { steps: 4 });
    await until(async () => (await visibleHints()) === 1, 3000);
    await parkPointer();
    const unhintedOut = await until(async () => (await visibleHints()) === 0, 3000);
    ok('A18 …and when the pointer leaves the canvas straight from the widget', !!unhintedOut, String(await visibleHints()));

    // ── A6: centre-click activates; two ticks in a row ────────────────────────────────────
    await page.mouse.click(tc.x, tc.y);
    const activated = await until(async () => (await todoWidget.getAttribute('class'))?.includes('is-active'), 3000);
    ok('A6 a centre click makes the widget interactive', !!activated);
    await page.mouse.move(tc.x + 2, tc.y + 2);
    ok('A18 an active widget shows no interact hint', await visibleHints() === 0, String(await visibleHints()));
    const boxes = todoWidget.locator('input[type="checkbox"]');
    await boxes.nth(0).click();
    await page.waitForTimeout(250);
    ok('A6 the widget is still active after the first tick', (await todoWidget.getAttribute('class'))?.includes('is-active'));
    await boxes.nth(1).click({ timeout: 3000 }).catch(() => {});
    const ticked = await until(() => {
      const t = show(SLUG).elements.find((e) => e.id === TODO_ID);
      return t && t.items?.length === 2 && t.items.every((it) => it.done === true) && t;
    }, 8000);
    ok('A6/A2 two ticks in a row both land: `show --json` reports done:true for both', !!ticked,
      JSON.stringify(show(SLUG).elements.find((e) => e.id === TODO_ID)?.items));
    await shoot('todo-ticked');
    await clearSelection();

    // ── A17: the size picker, then a handle-resize ─────────────────────────────────────────
    const noteBox = () => onDisk(SLUG).find((e) => e.id === note.id);
    const selectNote = async () => {
      const cur = await scene();
      const el = live(cur).find((e) => e.id === note.id);
      const p = toClient(cur, el.x + Math.min(24, el.width * 0.12), el.y + Math.min(20, el.height * 0.1));
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(250);
    };
    const picker = page.locator('.wb-size-picker');
    await selectNote();
    ok('A17 selecting a widget shows the S/M/L/XL picker',
      await picker.isVisible().catch(() => false)
      && JSON.stringify((await picker.locator('.wb-size-option').allInnerTexts()).map((t) => t.trim())) === '["S","M","L","XL"]',
      JSON.stringify(await picker.locator('.wb-size-option').allInnerTexts().catch(() => [])));
    ok('A17 …with the widget\'s own size checked',
      (await picker.locator('.wb-size-option[aria-checked="true"]').innerText().catch(() => '')).trim() === 'M');
    await picker.locator('.wb-size-option', { hasText: /^L$/ }).click();
    const toL = await until(() => { const d = noteBox(); return d && d.bbox.w === 376 && d.bbox.h === 376 && d.size === 'l' && d; }, 6000);
    ok('A17 the picker makes the widget L: 376x376 on disk', !!toL, JSON.stringify(noteBox() && { bbox: noteBox().bbox, size: noteBox().size }));
    ok('A17 …and it renders at L', await widget('note').first().getAttribute('data-widget-size') === 'l');
    if (!(await picker.isVisible().catch(() => false))) await selectNote();
    await picker.locator('.wb-size-option', { hasText: /^S$/ }).click();
    const toS = await until(() => { const d = noteBox(); return d && d.bbox.w === 180 && d.bbox.h === 180 && d.size === 's' && d; }, 6000);
    ok('A17 …then S: 180x180 on disk', !!toS, JSON.stringify(noteBox() && { bbox: noteBox().bbox, size: noteBox().size }));

    // Handle-resize: find the bottom-right handle by the cursor Excalidraw shows over it.
    if (!(await picker.isVisible().catch(() => false))) await selectNote();
    s = await scene();
    const nEl = live(s).find((e) => e.id === note.id);
    const corner = toClient(s, nEl.x + nEl.width, nEl.y + nEl.height);
    const cursorAt = async (x, y) => {
      await page.mouse.move(x, y);
      return page.evaluate(() => {
        const c = document.querySelector('.wbp-canvas canvas.interactive') ?? document.querySelector('.wbp-canvas .excalidraw__canvas.interactive');
        return c ? (c.style.cursor || getComputedStyle(c).cursor) : '';
      });
    };
    let handle = null;
    for (let r = 0; r <= 22 && !handle; r += 2) {
      for (const [ox, oy] of [[r, r], [r, 0], [0, r], [r - 4, r], [r, r - 4]]) {
        if (/nwse|se-resize/.test(await cursorAt(corner.x + ox, corner.y + oy))) { handle = { x: corner.x + ox, y: corner.y + oy }; break; }
      }
    }
    ok('A17 fixture: the selected widget\'s bottom-right resize handle is found', !!handle);
    let liveDuring = null;
    const before17 = noteBox()?.bbox;
    if (handle) {
      // Drag to roughly 390x200 scene px: an odd size, nearest to M.
      const tx = handle.x + (390 - nEl.width) * s.zoom;
      const ty = handle.y + (200 - nEl.height) * s.zoom;
      await page.mouse.down();
      await page.mouse.move((handle.x + tx) / 2, (handle.y + ty) / 2, { steps: 5 });
      await page.mouse.move(tx, ty, { steps: 5 });
      liveDuring = live(await scene()).find((e) => e.id === note.id);
      await page.mouse.up();
    }
    const expected = liveDuring ? nearestSize(liveDuring.width, liveDuring.height) : null;
    console.log(`info: A17 handle-resize reached ${liveDuring ? `${Math.round(liveDuring.width)}x${Math.round(liveDuring.height)}` : 'n/a'} before pointer-up; nearest preset ${expected}`);
    ok('A17 fixture: the handle drag produced an odd (non-preset) size',
      !!liveDuring && !Object.values(SIZES).some(([w, h]) => Math.abs(liveDuring.width - w) < 1 && Math.abs(liveDuring.height - h) < 1),
      JSON.stringify(liveDuring && [liveDuring.width, liveDuring.height]));
    const resnapped = await until(() => {
      const d = noteBox();
      return expected && d && d.bbox.w === SIZES[expected][0] && d.bbox.h === SIZES[expected][1] && d.size === expected && d;
    }, 6000);
    ok(`A17 a handle-resize snaps to the nearest preset on disk (${expected ?? '?'})`, !!resnapped,
      JSON.stringify(noteBox() && { bbox: noteBox().bbox, size: noteBox().size }));
    ok('A17 …keeping its top-left on the grid', !!resnapped && onGrid(resnapped.bbox.x) && onGrid(resnapped.bbox.y)
      && resnapped.bbox.x === before17?.x && resnapped.bbox.y === before17?.y,
      `before ${JSON.stringify(before17)} after ${JSON.stringify(resnapped?.bbox)}`);
    await clearSelection();

    // ── A18: empty note / HTML say so, and one click opens the note's editor ──────────────
    ok('A18 an empty note says "Empty note. Click to write."', /Empty note\. Click to write\./.test(await widget('note').first().textContent()),
      (await widget('note').first().textContent()).slice(0, 80));
    ok('A18 an empty HTML block says "Empty HTML block. Click to write."', /Empty HTML block\. Click to write\./.test(await widget('html').first().textContent()),
      (await widget('html').first().textContent()).slice(0, 80));
    s = await scene();
    const nc = centreOf(s, live(s).find((e) => e.id === note.id));
    await page.mouse.move(nc.x - 10, nc.y);
    await page.mouse.click(nc.x, nc.y);
    const editorOpen = await until(async () => widget('note').first().locator('textarea').isVisible(), 3000);
    ok('A18 ONE click on an empty note opens its editor', !!editorOpen);
    await shoot('note-editor');
    await page.keyboard.press('Escape');
    await clearSelection();

    // ── A8: the web widget's Load (network answered locally) ───────────────────────────────
    s = await scene();
    const webEl = live(s).find((e) => e.kind === 'web');
    const wc = centreOf(s, webEl);
    await page.mouse.click(wc.x, wc.y);
    await until(async () => (await web.getAttribute('class'))?.includes('is-active'), 3000);
    await web.locator('button', { hasText: /^Load$/ }).click({ timeout: 3000 }).catch(() => {});
    const webFrame = await until(async () => (await page.locator('iframe.wb-web-frame').count()) > 0, 4000);
    ok('A8 Load creates the web iframe', !!webFrame);
    if (webFrame) {
      const attrs = await page.locator('iframe.wb-web-frame').evaluate((f) => ({ allow: f.getAttribute('allow'), sandbox: f.getAttribute('sandbox') }));
      ok('A8 the web iframe carries allow=""', attrs.allow === '', JSON.stringify(attrs));
      ok('A8 the web iframe has no allow-popups / allow-top-navigation',
        !/allow-popups|allow-top-navigation/.test(attrs.sandbox ?? ''), attrs.sandbox);
    }
    await clearSelection();

    // ── A9: element links ──────────────────────────────────────────────────────────────────
    const lSpot = await spot({ w: 560, h: 100 });
    s = await scene();
    const linkFile = join(SCRATCH, 'links.json');
    const mkRect = (id, x, link) => ({
      type: 'rectangle', id, x, y: 0, width: 140, height: 80, angle: 0,
      strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
      roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 11 + x, version: 1,
      versionNonce: 7 + x, isDeleted: false, boundElements: null, updated: 1, link, locked: false,
    });
    writeFileSync(linkFile, JSON.stringify({
      type: 'excalidraw', version: 2, elements: [
        mkRect('lk-api', 0, '/api/whiteboards'),
        mkRect('lk-same', 200, `${ORIGIN}/api/whiteboards`),
        mkRect('lk-app', 400, `dreamcontext://task/${TASK_SLUG}`),
      ],
    }));
    const lC = toScene(s, lSpot.x, lSpot.y);
    const lAt = { x: lC.x - 270, y: lC.y - 40 };
    const drawn = dcTry(['whiteboard', 'draw', SLUG, '--file', linkFile, '--at', `${Math.round(lAt.x)},${Math.round(lAt.y)}`, '--tag', 'links']);
    ok('A9 fixture: three linked rectangles drawn by the CLI', drawn.code === 0, drawn.out);
    const linked = await until(async () => {
      const wantLinks = ['/api/whiteboards', `${ORIGIN}/api/whiteboards`, `dreamcontext://task/${TASK_SLUG}`];
      const cur = live(await scene()).filter((e) => e.type === 'rectangle' && wantLinks.includes(e.link));
      return cur.length === 3 && cur;
    }, 5000);
    ok('A9 the linked rectangles reach the open board', !!linked);

    const openLink = async (el) => {
      const cur = await scene();
      const e = live(cur).find((x) => x.id === el.id);
      const p = centreOf(cur, e);
      await page.mouse.click(p.x, p.y);
      const a = page.locator('.excalidraw-hyperlinkContainer-link');
      await a.waitFor({ timeout: 3000 }).catch(() => {});
      if (!(await a.count())) return false;
      await a.first().click();
      await page.waitForTimeout(600);
      return true;
    };
    for (const [label, link] of [['an /api/... link', '/api/whiteboards'], ['a same-origin link', `${ORIGIN}/api/whiteboards`]]) {
      const el = (linked || []).find((e) => e.link === link);
      const urlBefore = page.url();
      const navsBefore = mainNavs;
      const opens = await page.evaluate(() => window.__dcOpens.length);
      const clicked = el ? await openLink(el) : false;
      ok(`A9 ${label}: the link popup can be clicked`, clicked);
      ok(`A9 ${label}: page location unchanged`, page.url() === urlBefore && mainNavs === navsBefore, `${urlBefore} → ${page.url()}, navs +${mainNavs - navsBefore}`);
      ok(`A9 ${label}: window.open never called`, await page.evaluate(() => window.__dcOpens.length) === opens,
        JSON.stringify(await page.evaluate(() => window.__dcOpens)));
      await page.keyboard.press('Escape');
      await clearSelection();
    }
    await shoot('links');
    const appLink = (linked || []).find((e) => (e.link ?? '').startsWith('dreamcontext://'));
    const urlBeforeApp = page.url();
    const opensBeforeApp = await page.evaluate(() => window.__dcOpens.length);
    const clickedApp = appLink ? await openLink(appLink) : false;
    ok('A9 dreamcontext:// link: the popup can be clicked', clickedApp);
    const onTasks = await until(async () => /Tasks/.test(await page.locator('.sidebar-item--active').innerText().catch(() => '')), 4000);
    ok('A9 a dreamcontext:// link navigates in-app (to the task)', !!onTasks && page.url().startsWith(ORIGIN),
      await page.locator('.sidebar-item--active').innerText().catch(() => ''));
    ok('A9 …without leaving the app or calling window.open',
      await page.evaluate(() => window.__dcOpens.length) === opensBeforeApp && new URL(page.url()).origin === new URL(urlBeforeApp).origin);

    // Back to the board: close the task drawer, then the rail (it opens Control Panel).
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await page.locator('[aria-label="Close"]').count()) await page.locator('[aria-label="Close"]').first().click().catch(() => {});
    await railItem.click();
    await page.locator('.wbs-current').waitFor({ timeout: 10000 });
    await openBoard('Verify board');

    // ── A12: images refused visibly, never on disk ─────────────────────────────────────────
    let p12 = await spot();
    await page.mouse.click(p12.x, p12.y);
    await page.mouse.move(p12.x, p12.y);
    await focusCanvas();
    const pasted = await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return true;
    }, PNG_B64);
    const IMAGE_REFUSAL = /Images are disabled\.?|Images come in a later version/;
    const refusalShown = async () => (IMAGE_REFUSAL.exec(await page.locator('body').innerText().catch(() => '')) ?? [])[0];
    const pasteMsg = await until(refusalShown, 4000);
    ok('A12 a pasted PNG is refused visibly', pasted && !!pasteMsg, String(pasteMsg));
    await shoot('image-paste-refused');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // Close Excalidraw's error dialog: its close button, else a click on its backdrop.
    const closeRefusal = async () => {
      for (const sel of ['.Dialog__close', '.Modal__background']) {
        const l = page.locator(sel);
        // A corner: the backdrop's centre is under the dialog itself.
        if (await l.count()) { await l.first().click({ force: true, position: { x: 8, y: 8 } }).catch(() => {}); return; }
      }
    };
    await closeRefusal();
    await page.waitForTimeout(300);
    const cleared = await until(async () => !(await refusalShown()), 4000);
    ok('A12 fixture: the paste refusal is dismissed before the drop', !!cleared);

    p12 = await spot();
    await page.evaluate(({ b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
      const target = document.elementFromPoint(x, y);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      }
    }, { b64: PNG_B64, x: p12.x, y: p12.y });
    const dropMsg = await until(refusalShown, 4000);
    ok('A12 a dropped PNG is refused visibly', !!dropMsg, String(dropMsg));
    await closeRefusal();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2500);
    s = await scene();
    ok('A12 no image element in the live scene', !(s.elements.some((e) => e.type === 'image')));
    ok('A12 nothing image-typed on disk (tombstones included)', !rawTypesOnDisk(SLUG).includes('image'), rawTypesOnDisk(SLUG).join(','));

    // ── A11: a failing save shows "Not saved", retries, then saves ─────────────────────────
    const puts = [];
    const failPut = (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      puts.push(Date.now());
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'busy', message: 'verify: forced 503' }) });
    };
    await page.route(`**/api/whiteboards/${SLUG}`, failPut);
    const rectsOnDisk = onDisk(SLUG).filter((e) => e.type === 'rectangle').length;
    const p11 = await spot();
    await page.mouse.click(p11.x, p11.y);
    await drawRect(p11.x - 50, p11.y - 30, p11.x + 50, p11.y + 30);
    const notSaved = await until(async () => /Not saved/.test(await page.locator('.wbp-status').innerText().catch(() => '')), 6000);
    ok('A11 a 503 on save shows "Not saved" in the header', !!notSaved, await page.locator('.wbp-status').innerText().catch(() => ''));
    await shoot('not-saved');
    const retried = await until(() => puts.length >= 2, 8000);
    ok('A11 …and the save is retried', !!retried, `${puts.length} PUTs`);
    ok('A11 …while nothing reached disk', onDisk(SLUG).filter((e) => e.type === 'rectangle').length === rectsOnDisk);
    await page.unroute(`**/api/whiteboards/${SLUG}`, failPut);
    const recovered = await until(() => onDisk(SLUG).filter((e) => e.type === 'rectangle').length === rectsOnDisk + 1, 20000, 300);
    ok('A11 once unblocked, the retry saves the edit to disk', !!recovered);
    const savedAgain = await until(async () => /^Saved$/.test((await page.locator('.wbp-status').innerText().catch(() => '')).trim()), 5000);
    ok('A11 …and the header returns to "Saved"', !!savedAgain, await page.locator('.wbp-status').innerText().catch(() => ''));

    // ── A8: the HTML sandbox (its own board, so the chord probe has a clean count) ─────────
    dc(['whiteboard', 'create', 'Sandbox']);
    const SB = 'sandbox';
    const okHtml = '<div class="dc-card"><p id="ran">HTML-NOT-RUN</p></div><script>document.getElementById("ran").textContent = "HTML-SCRIPT-RAN";</script>';
    const navHtml = '<p>NAV-BLOCK</p><script>setTimeout(function () { location.href = "about:blank"; }, 400);</script>';
    const chordHtml = [
      '<p>CHORD-BLOCK</p><script>',
      'function send(key, code, meta) {',
      '  var c = { type: "keydown", key: key, code: code, metaKey: meta, ctrlKey: meta, shiftKey: false, altKey: false };',
      '  parent.postMessage({ __dreamHtmlChord: c }, "*");',
      '  c = Object.assign({}, c, { type: "keyup" });',
      '  parent.postMessage({ __dreamHtmlChord: c }, "*");',
      '}',
      'var n = 0; var t = setInterval(function () {',
      '  send("a", "KeyA", true); send("Backspace", "Backspace", false); send("Delete", "Delete", false);',
      '  parent.postMessage({ __dreamHtmlPress: "down" }, "*"); parent.postMessage({ __dreamHtmlPress: "up" }, "*");',
      '  if (++n > 8) clearInterval(t);',
      '}, 400);',
      '</script>',
    ].join('\n');
    // HTML blocks are L (376x376) by default: one pitch-aligned slot each, no overlap.
    dc(['whiteboard', 'add', SB, 'html', '--title', 'Runs', '--text', okHtml, '--at', '0,0']);
    dc(['whiteboard', 'add', SB, 'html', '--title', 'Navigates', '--text', navHtml, '--at', '392,0']);
    dc(['whiteboard', 'add', SB, 'note', '--title', 'Bystander', '--text', 'Must survive the chord block.', '--at', '0,392']);
    const sbLiveBefore = show(SB).elements.length;
    await openBoard('Sandbox');
    // Count the chord messages the host window actually receives, so "nothing changed" can
    // never pass merely because the block never posted.
    await page.evaluate(() => {
      window.__dcChords = 0;
      window.addEventListener('message', (e) => { if (e.data && e.data.__dreamHtmlChord) window.__dcChords += 1; });
    });
    // Added only once the board is open, so its whole message burst lands on a live host.
    dc(['whiteboard', 'add', SB, 'html', '--title', 'Chords', '--text', chordHtml, '--at', '392,392']);
    const withChord = sbLiveBefore + 1;
    await until(async () => (await page.locator('iframe.wb-html-frame').count()) >= 2, 5000);
    const frameAttrs = await page.locator('iframe.wb-html-frame').evaluateAll((fs) => fs.map((f) => ({
      title: f.getAttribute('title'), sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'),
      hasAllow: f.hasAttribute('allow'), srcdoc: f.getAttribute('srcdoc') ?? '',
    })));
    const runs = frameAttrs.find((f) => f.title === 'Runs');
    ok('A8 the HTML block renders in an iframe', !!runs, JSON.stringify(frameAttrs.map((f) => f.title)));
    if (runs) {
      ok('A8 its sandbox is exactly "allow-scripts"', runs.sandbox === 'allow-scripts', runs.sandbox);
      ok('A8 its allow attribute is SANDBOX_ALLOW', runs.hasAllow && runs.allow === SANDBOX_ALLOW, JSON.stringify(runs.allow));
      ok('A8 its srcdoc carries no REACH_BRIDGE (no chord / press forwarder)',
        !/__dreamHtmlChord|__dreamHtmlPress/.test(runs.srcdoc) && /__dreamHtmlHeight/.test(runs.srcdoc));
      ok('A8 its srcdoc carries the sandbox CSP', /Content-Security-Policy/i.test(runs.srcdoc));
    }
    const scriptRan = await until(async () => {
      for (const f of page.frames()) {
        const t = await f.evaluate(() => document.body?.textContent ?? '').catch(() => '');
        if (t.includes('HTML-SCRIPT-RAN')) return true;
      }
      return false;
    }, 5000);
    ok('A8 the block\'s own script runs inside the sandbox', !!scriptRan);
    const torn = await until(async () => {
      const w = page.locator('.wb-widget[data-widget-kind="html"]', { hasText: 'Navigates' });
      return /This block tried to open a web page/.test(await w.textContent().catch(() => '')) && (await w.locator('iframe').count()) === 0;
    }, 6000);
    ok('A8 a block that sets location.href is torn down ("This block tried to open a web page")', !!torn);
    const chordShown = await until(async () => (await page.locator('.wb-widget[data-widget-kind="html"]', { hasText: 'Chords' }).count()) > 0, 5000);
    ok('A8 fixture: the chord block reached the open board', !!chordShown);
    // Give the canvas focus, as a user working on the board would have it, then let the burst run.
    const pf = await spot({ w: 40, h: 40 });
    if (pf) await page.mouse.click(pf.x, pf.y);
    await focusCanvas();
    await page.waitForTimeout(6000);
    s = await scene();
    const chordsSeen = await page.evaluate(() => window.__dcChords);
    ok('A8 fixture: the host received the block\'s chord messages', chordsSeen >= 6, String(chordsSeen));
    ok('A8 chord messages from a block leave the live scene unchanged', live(s).length === withChord, `${live(s).length} vs ${withChord}`);
    ok('A8 …and the element count on disk unchanged', show(SB).elements.length === withChord, `${show(SB).elements.length} vs ${withChord}`);
    await shoot('sandbox');
    // The probe can see a deletion: the REAL chord, struck on the host, does delete.
    if (pf) await page.mouse.click(pf.x, pf.y);
    await focusCanvas();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    const realDelete = await until(() => show(SB).elements.length < withChord, 6000);
    ok('A8 control: a real ⌘A+Backspace on the host DOES empty the board (the probe can see it)', !!realDelete,
      `${show(SB).elements.length} live on disk`);

    // ── A11: a corrupt board is read-only and byte-unchanged ───────────────────────────────
    dc(['whiteboard', 'create', 'Broken']);
    const BROKEN = boardPath('broken');
    const broken = readFileSync(BROKEN, 'utf-8').replace(/```json[\s\S]*?```/, '```json\n{ "type": "excalidraw", "elements": [ { "id": "x", \n```');
    writeFileSync(BROKEN, broken, 'utf-8');
    const brokenHash = sha(BROKEN);
    const getBroken = await fetch(`${ORIGIN}/api/whiteboards/broken`);
    ok('A11 GET on a corrupt board is 422', getBroken.status === 422, String(getBroken.status));
    await openBoard('Broken');
    const card = page.locator('.wbp-card-state');
    const cardText = await card.innerText().catch(() => '');
    ok('A11 a corrupt board shows the read-only error card', /cannot be read/i.test(cardText), cardText);
    ok('A11 …naming the file', cardText.includes('_dream_context/whiteboards/broken/broken.excalidraw.md'), cardText);
    ok('A11 …with no canvas mounted', await page.locator('.wbp-canvas').count() === 0);
    ok('A11 …and the switcher still there to leave it', await page.locator('.wbs-current').count() === 1);
    await shoot('corrupt');
    const cliOnBroken = dcTry(['whiteboard', 'add', 'broken', 'note', '--text', 'overwrite?']);
    ok('A11 the CLI refuses to write a corrupt board (non-zero exit)', cliOnBroken.code !== 0, cliOnBroken.out);
    const putBroken = await page.evaluate(async () => {
      const r = await fetch('/api/whiteboards/broken', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ elements: [] }),
      });
      return r.status;
    });
    ok('A11 a PUT to a corrupt board is refused', putBroken >= 400, String(putBroken));
    await page.waitForTimeout(2500);
    ok('A11 the corrupt file is byte-unchanged', sha(BROKEN) === brokenHash);

    // ── A16: the board switcher ────────────────────────────────────────────────────────────
    dc(['whiteboard', 'create', 'Scratch board']);
    await waitRow('Scratch board');
    const rowNames = async () => (await panel.locator('.wbs-row-name').allInnerTexts()).map((t) => t.trim());
    const allRows = await rowNames();
    ok('A16 the board name opens "All boards" listing every board',
      allRows.length === 5 && ['Control Panel', 'Verify board', 'Sandbox', 'broken', 'Scratch board']
        .every((n) => allRows.some((r) => r.toLowerCase().startsWith(n.toLowerCase()))),
      JSON.stringify(allRows));
    const cpRow = panel.locator('.wbs-row', { hasText: 'Control Panel' });
    ok('A16 the default board wears a Default badge', /Default/.test(await cpRow.locator('.wbs-badge').innerText().catch(() => '')));
    ok('A16 …and has no delete control', await cpRow.locator('.wbs-row-delete').count() === 0);
    ok('A16 other boards do have one', await panel.locator('.wbs-row', { hasText: 'Verify board' }).locator('.wbs-row-delete').count() === 1);
    ok('A16 a corrupt board\'s row says "Cannot be read"', /Cannot be read/.test(await panel.locator('.wbs-row', { hasText: /broken/i }).innerText().catch(() => '')));
    ok('A16 rows show an element count', /\d+ elements?/.test(await panel.locator('.wbs-row', { hasText: 'Verify board' }).innerText().catch(() => '')),
      await panel.locator('.wbs-row', { hasText: 'Verify board' }).innerText().catch(() => ''));
    await page.locator('.wbs-search-input').fill('sand');
    await page.waitForTimeout(200);
    ok('A16 search filters the list', JSON.stringify(await rowNames()) === '["Sandbox"]', JSON.stringify(await rowNames()));
    await page.locator('.wbs-search-input').fill('');
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    ok('A16 Esc closes the popover', await panel.count() === 0);

    // "+" names a new board: Günlük, name kept verbatim, slug gunluk.
    await page.locator('.wbs-icon-btn').click();
    await page.locator('.wbs-create-input').fill('Günlük');
    await page.waitForTimeout(150);
    await shoot('switcher-new');
    await page.locator('.wbs-create-input').press('Enter');
    const onGunluk = await until(async () => (await currentName()) === 'Günlük' && (await scene())?.width > 0, 15000);
    ok('A16 "+" creates "Günlük" and opens it', !!onGunluk, await currentName());
    ok('A16 …as slug gunluk on disk', existsSync(boardPath('gunluk')), boardDirs().join(','));
    ok('A16 …with the name kept verbatim', (await listBoards()).find((b) => b.slug === 'gunluk')?.name === 'Günlük',
      JSON.stringify((await listBoards()).find((b) => b.slug === 'gunluk')));
    // An edit made just before switching away is not dropped.
    await page.waitForTimeout(500);
    s = await scene();
    const g0 = { x: s.offsetLeft + s.width / 2, y: s.offsetTop + s.height / 2 };
    await page.mouse.click(g0.x, g0.y);
    await drawRect(g0.x - 80, g0.y - 50, g0.x + 80, g0.y + 50);
    ok('A16 fixture: the Günlük rectangle is in the live scene before the switch',
      live(await scene()).filter((e) => e.type === 'rectangle').length === 1, JSON.stringify(live(await scene()).map((e) => e.type)));
    const unsavedAtSwitch = onDisk('gunluk').filter((e) => e.type === 'rectangle').length === 0;
    const gunlukPuts = [];
    const onGunlukPut = (req) => {
      if (req.method() === 'PUT' && /\/api\/whiteboards\/gunluk$/.test(new URL(req.url()).pathname)) {
        gunlukPuts.push((JSON.parse(req.postData() || '{}').elements ?? []).map((e) => e.type).join(','));
      }
    };
    page.on('request', onGunlukPut);
    await openBoard('Control Panel');
    ok('A16 switching lands on Control Panel', await currentName() === 'Control Panel', await currentName());
    const kept = await until(() => onDisk('gunluk').filter((e) => e.type === 'rectangle').length === 1, 6000);
    console.log(`info: A16 the Günlük rectangle was ${unsavedAtSwitch ? 'UNSAVED' : 'already saved'} when the switch began`);
    page.off('request', onGunlukPut);
    ok('A16 the edit made on Günlük just before switching is on disk', !!kept,
      `disk ${JSON.stringify(onDisk('gunluk').map((e) => e.type))}; PUTs to gunluk during the switch: ${JSON.stringify(gunlukPuts)}`);
    // Delete another board through the inline confirm.
    await openSwitcher();
    const scratchRow = panel.locator('.wbs-row', { hasText: 'Scratch board' });
    await scratchRow.hover();
    await scratchRow.locator('.wbs-row-delete').click();
    const confirmRow = panel.locator('.wbs-row--confirm');
    ok('A16 delete asks inline first', await confirmRow.count() === 1 && existsSync(boardPath('scratch-board')));
    await confirmRow.locator('.wbs-btn--danger').click();
    const gone = await until(async () => !existsSync(join(BOARDS, 'scratch-board'))
      && !(await rowNames()).includes('Scratch board'), 6000);
    ok('A16 confirming removes the board (list and disk)', !!gone, `${JSON.stringify(await rowNames())} dirs=${boardDirs().join(',')}`);
    ok('A16 …and the open board stays open', await currentName() === 'Control Panel');
    // Arrows + Enter pick a board.
    await page.locator('.wbs-search-input').fill('verif');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    const byKeys = await until(async () => (await currentName()) === 'Verify board' && (await scene())?.width > 0, 10000);
    ok('A16 search + Enter opens the highlighted board', !!byKeys, await currentName());

    // ── A17: CLI sizes; an S insight is a number, L+ a chart ───────────────────────────────
    dc(['whiteboard', 'create', 'Sizes']);
    const sizeIds = {};
    for (const [size, x] of [['s', 0], ['m', 196], ['l', 588], ['xl', 980]]) {
      const r = dcTry(['whiteboard', 'add', 'sizes', 'insight', '--ref', INSIGHT.slug, '--size', size, '--at', `${x},0`, '--json']);
      ok(`A17 \`whiteboard add sizes insight --size ${size}\` succeeds`, r.code === 0, r.out);
      try { sizeIds[size] = JSON.parse(r.out).id; } catch { sizeIds[size] = /"id":\s*"([^"]+)"/.exec(r.out)?.[1]; }
    }
    const sizesDisk = onDisk('sizes');
    for (const size of ['s', 'm', 'l', 'xl']) {
      const d = sizesDisk.find((e) => e.id === sizeIds[size]);
      ok(`A17 …${size} is ${SIZES[size].join('x')} on disk`, !!d && d.bbox.w === SIZES[size][0] && d.bbox.h === SIZES[size][1] && d.size === size,
        JSON.stringify(d && { bbox: d.bbox, size: d.size }));
    }
    // Read before the dashboard ever opens this board: the stroke is the CLI's own, not a client repair.
    const cliStrokes = rawWidgets('sizes').map((e) => e.strokeColor);
    ok('A18 CLI-added widgets are written with a transparent stroke', cliStrokes.length === 4 && cliStrokes.every((c) => c === 'transparent'), JSON.stringify(cliStrokes));
    // A board the agent just made is in All boards when the user opens it a second later.
    await page.waitForTimeout(1000);
    await openSwitcher();
    const freshRow = await until(async () => (await panel.locator('.wbs-row-open', { hasText: 'Sizes' }).count()) > 0, 3000);
    ok('A16 a board the CLI created a second ago is listed when All boards opens', !!freshRow, JSON.stringify(await rowNames()));
    await page.keyboard.press('Escape');
    await openBoard('Sizes');
    const ins = (size) => page.locator(`.wb-widget[data-widget-kind="insight"][data-widget-size="${size}"]`);
    await until(async () => /4,?210/.test(await ins('s').textContent().catch(() => '')), 8000);
    await page.waitForTimeout(1200);
    s = await scene();
    const xlEl = live(s).find((e) => e.id === sizeIds.xl);
    ok('A17 `add … --size xl` renders XL (768x376 in the live scene, data-widget-size=xl)',
      !!xlEl && xlEl.width === 768 && xlEl.height === 376 && await ins('xl').count() === 1,
      JSON.stringify(xlEl && [xlEl.width, xlEl.height]));
    const sText = await ins('s').textContent().catch(() => '');
    ok('A17 an S insight shows the number', /4,?210/.test(sText), sText.slice(0, 80));
    ok('A17 …and no chart', await ins('s').locator('.wb-widget-body svg, .wb-widget-body canvas').count() === 0);
    ok('A17 an L insight shows a chart', await ins('l').locator('.wb-widget-body svg, .wb-widget-body canvas').count() > 0);
    ok('A17 an XL insight shows a chart', await ins('xl').locator('.wb-widget-body svg, .wb-widget-body canvas').count() > 0);
    // A19: L and XL draw exactly ONE chart (no sparkline beside it), spanning the card body.
    const chartSpan = (size) => ins(size).locator('.wb-widget-body').evaluate((body) => {
      const svgs = [...body.querySelectorAll('svg, canvas')];
      const cs = getComputedStyle(body);
      const b = body.getBoundingClientRect();
      // Rendered content width: the bounding rect carries the board's zoom, so scale the padding with it.
      const k = body.clientWidth ? b.width / body.clientWidth : 1;
      const content = b.width - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) * k;
      const w = svgs[0] ? svgs[0].getBoundingClientRect().width : 0;
      return { count: svgs.length, ratio: content > 0 ? w / content : 0 };
    }).catch((e) => ({ count: -1, ratio: 0, err: String(e) }));
    for (const size of ['l', 'xl']) {
      const span = await chartSpan(size);
      ok(`A19 an ${size.toUpperCase()} insight draws exactly one chart`, span.count === 1, JSON.stringify(span));
      ok(`A19 …and it spans ≥90% of the card body's width`, span.ratio >= 0.9, JSON.stringify(span));
    }
    const lText = await ins('l').textContent().catch(() => '');
    ok('A19 an L insight keeps the headline number and its change', /4,?210/.test(lText) && /305/.test(lText), lText.slice(0, 80));
    await parkPointer();
    await shoot('sizes');

    // ── The owner's Control Panel: a filled board, every kind, S/M/L/XL ────────────────────
    const htmlBlock = [
      '<div class="dc-card" style="padding:16px">',
      '<h3 style="margin:0 0 8px">Release 0.9 readiness</h3>',
      '<table style="width:100%;border-collapse:collapse;font-size:13px">',
      '<tr><td>Docs</td><td style="text-align:right">Done</td></tr>',
      '<tr><td>Widget sizes</td><td style="text-align:right">Done</td></tr>',
      '<tr><td>Board switcher</td><td style="text-align:right">In review</td></tr>',
      '<tr><td>Owner demo</td><td style="text-align:right">Friday</td></tr>',
      '</table></div>',
    ].join('');
    const cp = (args) => dcTry(['whiteboard', 'add', 'control-panel', ...args]);
    const seeded = [
      cp(['insight', '--ref', INSIGHT.slug, '--size', 'xl', '--at', '0,0']),
      cp(['todo', '--title', 'This week', '--size', 'l', '--at', '784,0',
        '--item', 'Ship the Control Panel', '--item', 'Review widget sizes with design', '--item', 'Record the owner demo',
        '--item', 'Write the release notes', '--item', 'Plan the Phase 2 assistant']),
      cp(['knowledge', '--ref', KNOWLEDGE.name, '--size', 's', '--at', '0,392']),
      cp(['task', '--ref', TASK_SLUG, '--size', 's', '--at', '196,392']),
      cp(['html', '--title', 'Readiness', '--text', htmlBlock, '--size', 'l', '--at', '392,392']),
      cp(['web', '--url', 'https://example.com/roadmap', '--title', 'Public roadmap', '--size', 'l', '--at', '784,392']),
      cp(['note', '--title', 'Standup', '--text', '## Standup notes\n\n- Sizes landed, S to XL\n- Switcher replaces the list page\n- Next: the board assistant', '--size', 'm', '--at', '0,588']),
    ];
    ok('fixture: the Control Panel is seeded through the CLI', seeded.every((r) => r.code === 0), seeded.filter((r) => r.code !== 0).map((r) => r.out).join(' | '));
    await openBoard('Control Panel');
    await until(async () => (await page.locator('.wb-widget').count()) >= 7, 8000);
    await page.waitForTimeout(2500);
    await parkPointer();
    await shoot('control-panel');
    // A19: the knowledge card shows the file's title, not its slug.
    const kText = await page.locator('.wb-widget[data-widget-kind="knowledge"]').first().textContent().catch(() => '');
    ok('A19 the knowledge widget shows the knowledge title, not the slug', kText.includes(KNOWLEDGE.title) && !kText.includes(KNOWLEDGE.name), kText.slice(0, 80));
    // A19: the HTML block's content sits on the card; no second bordered frame inside it.
    const cpHtml = page.locator('.wb-widget[data-widget-kind="html"]', { hasText: 'Readiness' }).first();
    const hostFrames = await cpHtml.locator('.wb-widget-body').evaluate((body) => [body, ...body.querySelectorAll('*')]
      .filter((el) => el !== body)
      .map((el) => getComputedStyle(el))
      .filter((cs) => ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none'))
      .length).catch(() => -1);
    const innerFrame = await cpHtml.locator('iframe.wb-html-frame').contentFrame().locator('body > *').first()
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { border: cs.borderTopWidth, style: cs.borderTopStyle, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor };
      }).catch((e) => ({ err: String(e) }));
    ok('A19 the HTML widget body has no inner bordered frame',
      hostFrames === 0 && !innerFrame.err && (parseFloat(innerFrame.border) === 0 || innerFrame.style === 'none')
        && /rgba\(0, 0, 0, 0\)|transparent/.test(innerFrame.bg),
      JSON.stringify({ hostFrames, innerFrame }));
    // The size picker on a filled board, at the zoom the owner works at.
    s = await scene();
    const cpNote = live(s).find((e) => e.kind === 'note');
    if (cpNote) {
      const p = toClient(s, cpNote.x + 24, cpNote.y + 20);
      await page.mouse.click(p.x, p.y);
      await page.locator('.wb-size-picker').waitFor({ timeout: 3000 }).catch(() => {});
      await parkPointer();
      ok('A17 the size picker shows on a Control Panel widget', await page.locator('.wb-size-picker').isVisible().catch(() => false));
      await shoot('widget-selected');
      await clearSelection();
    }
    await openSwitcher();
    await page.waitForTimeout(300);
    await shoot('switcher-open');
    await page.keyboard.press('Escape');

    ok('A4 the page calls /api/whiteboards (no doubled /api/api prefix)', doublePrefixHits.length === 0,
      `${doublePrefixHits.length} requests, e.g. ${[...new Set(doublePrefixHits)].slice(0, 4).join(', ')}`);
    ok('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } catch (e) {
    // A thrown step is a failure of its own; the checks collected so far still print.
    ok('the run completed without a thrown step', false, String(e?.message ?? e).split('\n')[0]);
    await page?.screenshot({ path: join(SHOTS, 'thrown.png') }).catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }

  console.log(results.join('\n'));
  console.log(`shots: ${SHOTS}`);
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(fails.length ? `${fails.length} FAILED` : `all ${results.length} green`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });
