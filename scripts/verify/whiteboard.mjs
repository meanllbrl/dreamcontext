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
 *   W    pages read BESIDE the board, run once per theme (light, then dark, set the app's own
 *        way + a reload that starts from an old "#…wbmode=wiki&wbpage=…" link, which lands on
 *        the same board and is cleaned to "#wb=<slug>"; no Wiki-mode pane, wiki menu or
 *        Canvas | Wiki switch exists and the canvas spans the board). ONE click on an inactive
 *        knowledge / .md / PDF / HTML / task card, and a dreamcontext://knowledge|task link,
 *        open the right side panel: its right edge on the board's, < 60% of the board wide, the
 *        board left of it hit-testable (no scrim). It PUSHES the canvas: the canvas ends at the
 *        panel's left edge (±2px), Excalidraw's toolbar, "+ Add" and Library lie wholly left of
 *        it and elementFromPoint at their centres hits them, and a rectangle drawn with the
 *        pointer beside it lands under the pointer; after close the canvas is full width
 *        again. Path, search and hash unchanged; a stroke
 *        held unsaved (PUTs held at the network), the zoom/scroll and the same Excalidraw
 *        instance survive it. The hovered active page card's title keeps ≥ 4.5:1 contrast on
 *        the card. The header is the page's title (no path) and five SVG icon
 *        buttons; Expand spans the board and Collapse restores the width; ⋯ lists Open in
 *        Knowledge / Tasks only for its owner, then Open on computer / Reveal in Finder / Copy
 *        path; Esc closes the menu, then the panel; × closes; focus returns. The page reads as
 *        a page: ≥ 15px, painted lines ≤ 75ch, no frame or card background; a PDF's title is
 *        written once; HTML in an allow-scripts, no-allow-same-origin, CSP default-src 'none'
 *        iframe with its one-line note right under the page (≤ HTML_NOTE_GAP px). The card that
 *        opened the panel stays in view: one straddling the pushed canvas's edge is panned (zoom
 *        unchanged) until its DOM box is inside the canvas, 12–40px from its right edge; one
 *        already in view moves nothing; close restores the exact pre-open scroll and zoom, but
 *        not after the user wheeled the board while reading, nor after they panned or zoomed
 *        while reading A and then opened B (close returns to their board); Expand + Collapse
 *        pan nothing. [[wikilinks]]
 *        navigate in the same panel with
 *        back/forward, an unresolved one says "not found". Wiki cards seeded by `whiteboard add
 *        … wiki` + `nav add --card`: at S and M an inactive list draws whole rows only, no
 *        heading without a row, and "+N more" with the right N; its row opens the panel in one
 *        click; activated, every row is there and the last one, scrolled to with the wheel,
 *        opens the panel in one click. At L and XL the list beside an in-card page reader (one
 *        highlight, own back/forward, wikilinks stay in the card; headings, rows and the
 *        reader title never cut mid-letter and carry their full text in `title`); a second card keeps its own list; in
 *        edit mode Alt+↑/↓, drag and drop (in and across sections), add / rename / delete
 *        (inline confirm) a section, add a page through the picker and remove one — each read
 *        back from customData.dc.sections IN THE BOARD FILE. W-picker: the palette's picker
 *        labels a knowledge page "Knowledge", files MD / PDF / HTML, readable titles over the
 *        path. No console/page errors. Screenshots: tmp/whiteboard-wiki-shots/.
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
const DEFAULT_SIZE = { insight: 'm', knowledge: 's', task: 's', todo: 'm', note: 'm', html: 'l', web: 'l', wiki: 'l' };
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

// The page panel + wiki card fixtures (W): a fictional launch, two knowledge pages linked by a
// [[wikilink]] (plus one that resolves nowhere), and a project .md, PDF and HTML page. The page
// cards live on one board; the wiki cards (the same handbook list at XL, L, M and S, and a
// second card with a list of its own) on another.
const WIKI_BOARD = { slug: 'wiki-board', name: 'Wiki board' };
const WIKI_CARDS = { slug: 'wiki-cards', name: 'Wiki cards' };
const LAUNCH = { name: 'launch-checklist', title: 'Launch checklist' };
const NOTES = { ref: 'docs/release-notes.md', title: 'Release notes' };
const PDF_REF = 'docs/pricing-sheet.pdf';
const HTML_REF = 'docs/status-page.html';
const HB_LIST = [['Getting started', LAUNCH.name], ['Getting started', NOTES.ref], ['Reference', PDF_REF], ['Reference', HTML_REF]];
// A link saved while the retired Canvas | Wiki mode existed: the board plus its mode and page.
const LEGACY_HASH = `#wb=${WIKI_BOARD.slug}&wbmode=wiki&wbpage=${LAUNCH.name}`;
// Long enough to wrap into several lines at any panel width: the text-measure check reads it.
const LONG_PARAGRAPH = 'Before a workspace launch goes out, the team walks the whole path a new customer takes: the sign-up form, '
  + 'the first empty board, the invitation email and the moment a second person joins. Every step that needs a manual nudge '
  + 'is written down here with the person who owns it, so the launch call can go through the list in ten minutes instead of '
  + 'an hour and nobody has to remember what was promised in the last meeting.';
// The palette's page picker (W-picker): one query, "launch", matches a project file of each
// type outside _dream_context AND the knowledge page "launch-checklist".
const PICK_FILES = { MD: 'docs/launch-notes.md', PDF: 'docs/launch-pricing.pdf', HTML: 'docs/launch-status.html' };
const PICK_TITLES = { MD: 'Launch notes', PDF: 'Launch pricing', HTML: 'Launch status' };
// The owner's W screenshots (panel, wiki card), kept in the repo's tmp/ so they outlive the scratch vault.
const WSHOTS = join(REPO, 'tmp', 'whiteboard-wiki-shots');
// The most an HTML page's last painted line may sit above the panel's sandbox note (see W 2).
const HTML_NOTE_GAP = 48;

/** A one-page PDF that says "Pricing sheet", xref offsets computed (a valid file, ~600 bytes). */
function tinyPdf() {
  const text = 'BT /F1 24 Tf 72 720 Td (Pricing sheet) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

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
            kind: e.customData?.dc?.kind ?? null, size: e.customData?.dc?.size ?? null, ref: e.customData?.dc?.ref ?? null,
          })),
        };
      }
      f = f.return;
    }
    return null;
  });
}

/**
 * Tag the live Excalidraw App instance (`token`), or read the tag back (`token` undefined). A
 * remounted canvas is a NEW instance without the tag: this is how "the canvas was not
 * remounted" is told apart from "it remounted and reloaded the same scene".
 */
function canvasTag(page, token) {
  return page.evaluate((t) => {
    const root = document.querySelector('.wbp-canvas .excalidraw');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? root[key] : null; f; f = f.return) {
      const s = f.stateNode;
      if (s && s.scene && s.state && s.state.zoom) {
        if (t !== undefined) s.__dcVerifyTag = t;
        return s.__dcVerifyTag ?? null;
      }
    }
    return null;
  }, token);
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
    // Console errors and page errors raised while the page-popup / wiki checks (W) run.
    const wikiErrors = [];
    let watchWiki = false;
    page.on('console', (m) => { if (watchWiki && m.type() === 'error') wikiErrors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => { if (watchWiki) wikiErrors.push(`pageerror: ${String(e)}`); });
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
    /**
     * The board's ready signal: the editor is past its loading state (no `.wbp-loading`, which
     * also covers the canvas's Suspense fallback) and shows a canvas or its error card. The
     * switcher already renders WHILE a board loads, and the editor swaps that loading bar for
     * the ready one (a remount: the `.wbs` node is replaced), so a popover opened before this
     * is thrown away under the click that follows it. Never touch the switcher before this.
     */
    const boardReady = () => page.evaluate(() => !!document.querySelector('.wbp-editor')
      && !document.querySelector('.wbp-loading')
      && (!!document.querySelector('.wbp-canvas .excalidraw') || !!document.querySelector('.wbp-card-state')));
    const waitBoardReady = (ms = 15000) => until(boardReady, ms);
    const openSwitcher = async () => {
      if (!(await panel.count())) {
        await waitBoardReady();
        await page.locator('.wbs-current').click({ timeout: 5000 });
      }
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
      // A reload lands back on the board in the URL hash (#wb=…, W3): already there is done.
      if (!(await panel.count()) && (await currentName()) === name && (await scene())?.width > 0) {
        await page.waitForTimeout(700);
        return;
      }
      // A row is clicked only in a popover of a READY board (openSwitcher), and a click that
      // still misses (its popover closed under it) reopens the list rather than hanging.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const row = await waitRow(name);
        if (await row.click({ timeout: 5000 }).then(() => true).catch(() => false)) break;
        if ((await currentName()) === name) break;
      }
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
    // Since 6f0ad33d the group reads Chat, Tasks, Automations, then the beta pages, alpha ones last.
    ok('A15 …after Automations (with the alpha pages)', iAuto >= 0 && iCp > iAuto, ws?.items.join(' | '));
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
    if (!(await waitBoardReady())) await railItem.click().catch(() => {});
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
    // The reload restores the board from the URL hash (#wb=verify-board): wait for it to be
    // READY, not merely for its switcher (which shows while it is still loading).
    if (!(await waitBoardReady())) await railItem.click();
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

    // ── A6: a plain click activates; two ticks in a row ───────────────────────────────────
    // Since 127422a6 a click anywhere on an inactive widget activates it AND is handed to the
    // control under the pointer, so the activating click lands on the title (not a control),
    // and the ticks are real pointer clicks at each checkbox, as a user makes them.
    const centreHit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` : '';
    }, tc);
    const titleAt = toClient(s, todoEl.x + 24, todoEl.y + 14);
    await page.mouse.click(titleAt.x, titleAt.y);
    const activated = await until(async () => (await todoWidget.getAttribute('class'))?.includes('is-active'), 3000);
    ok('A6 a plain click makes the widget interactive', !!activated, `centre hit ${centreHit}`);
    await page.mouse.move(tc.x + 2, tc.y + 2);
    ok('A18 an active widget shows no interact hint', await visibleHints() === 0, String(await visibleHints()));
    const boxes = todoWidget.locator('input[type="checkbox"]');
    const tickAt = async (i) => {
      const b = await boxes.nth(i).boundingBox();
      if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      return !!b;
    };
    ok('A6 fixture: both checkboxes start unticked', JSON.stringify(show(SLUG).elements.find((e) => e.id === TODO_ID)?.items?.map((it) => it.done)) === '[false,false]');
    await tickAt(0);
    await page.waitForTimeout(250);
    console.log(`info: A6 the todo's centre is ${centreHit} (what a centre click's forwarded click would land on)`);
    ok('A6 the widget is still active after the first tick', (await todoWidget.getAttribute('class'))?.includes('is-active'));
    await tickAt(1);
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
    // Since 127422a6 a handle-resize is free-form: the box the user dragged to stays (4px step),
    // and dc.size records the nearest preset for content layout.
    const resnapped = await until(() => {
      const d = noteBox();
      return expected && d && Math.abs(d.bbox.w - liveDuring.width) <= 4 && Math.abs(d.bbox.h - liveDuring.height) <= 4
        && d.bbox.w % 4 === 0 && d.bbox.h % 4 === 0 && d.size === expected && d;
    }, 6000);
    ok(`A17 a handle-resize keeps the dragged box (4px step) and records the nearest preset (${expected ?? '?'}) on disk`, !!resnapped,
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
    // Since the page panel (W2, W5): a task link reads the task BESIDE the board instead of leaving it.
    const taskInPopup = await until(async () => (await page.locator('.wb-page-panel').getAttribute('data-page-path').catch(() => null))
      === `_dream_context/state/${TASK_SLUG}.md`, 4000);
    ok('A9 a dreamcontext://task link opens the task in the board\'s side page panel', !!taskInPopup,
      String(await page.locator('.wb-page-panel').getAttribute('data-page-path').catch(() => null)));
    ok('A9 …the page stays the board (rail item active, URL unchanged)',
      /Whiteboard/.test(await page.locator('.sidebar-item--active').innerText().catch(() => '')) && page.url() === urlBeforeApp,
      `${await page.locator('.sidebar-item--active').innerText().catch(() => '')} ${urlBeforeApp} → ${page.url()}`);
    ok('A9 …without leaving the app or calling window.open',
      await page.evaluate(() => window.__dcOpens.length) === opensBeforeApp && new URL(page.url()).origin === new URL(urlBeforeApp).origin);

    // Back to the board: close the panel (and anything else the click opened).
    await page.locator('.wb-page-panel [aria-label="Close"]').click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
    if (!(await page.locator('.wbs-current').count()) || (await currentName()) !== 'Verify board') {
      await railItem.click();
      await page.locator('.wbs-current').waitFor({ timeout: 10000 });
      await openBoard('Verify board');
    }
    await clearSelection();

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

    // ── W: pages read BESIDE the board (right side panel) and the wiki card, in BOTH themes ──
    watchWiki = true;
    // The owner's screenshots: replaced wholesale, so no shot of a retired view outlives it.
    rmSync(WSHOTS, { recursive: true, force: true });
    mkdirSync(WSHOTS, { recursive: true });
    const wshot = (name) => page.screenshot({ path: join(WSHOTS, `${name}.png`) });
    /** One card with a margin of board around it. */
    const cardShot = async (loc, name) => {
      const b = await loc.boundingBox().catch(() => null);
      if (!b) return wshot(name);
      const vp = page.viewportSize();
      const x = Math.max(0, Math.floor(b.x - 24));
      const y = Math.max(0, Math.floor(b.y - 24));
      return page.screenshot({
        path: join(WSHOTS, `${name}.png`),
        clip: { x, y, width: Math.min(vp.width - x, Math.ceil(b.width + 48)), height: Math.min(vp.height - y, Math.ceil(b.height + 48)) },
      });
    };

    mkdirSync(join(PROJ, 'docs'), { recursive: true });
    writeFileSync(join(PROJ, PDF_REF), tinyPdf());
    writeFileSync(join(PROJ, HTML_REF), [
      '<h1>Status page</h1>',
      '<p id="status">STATUS-NOT-RUN</p>',
      '<script>document.getElementById("status").textContent = "STATUS-SCRIPT-RAN";</script>',
    ].join('\n'), 'utf-8');
    writeFileSync(join(PROJ, NOTES.ref), `# ${NOTES.title}\n\nWhat changed between the beta and the launch build.\n\n- Faster board loads\n- Wiki cards\n`, 'utf-8');
    writeFileSync(join(PROJ, PICK_FILES.MD), '# Launch notes\n\nWhat changed in the launch build.\n', 'utf-8');
    writeFileSync(join(PROJ, PICK_FILES.PDF), tinyPdf());
    writeFileSync(join(PROJ, PICK_FILES.HTML), '<h1>Launch status</h1>', 'utf-8');
    dc(['knowledge', 'create', LAUNCH.name, '-d', 'What has to be true before a workspace launch goes out', '-t', 'onboarding',
      '-c', `# ${LAUNCH.title}\n\nRead [[${KNOWLEDGE.name}|the onboarding playbook]] first, then the pricing notes in [[missing-page]].\n\n${LONG_PARAGRAPH}\n\n## Steps\n\n- Freeze the copy\n- Ship`]);

    // The page board: one card per page type, a task card, and two in-app element links.
    dc(['whiteboard', 'create', WIKI_BOARD.name]);
    const W = WIKI_BOARD.slug;
    const wAdds = [
      dcTry(['whiteboard', 'add', W, 'knowledge', '--ref', LAUNCH.name, '--size', 's', '--at', '0,196']),
      dcTry(['whiteboard', 'add', W, 'knowledge', '--ref', NOTES.ref, '--size', 's', '--at', '196,196']),
      dcTry(['whiteboard', 'add', W, 'knowledge', '--ref', PDF_REF, '--size', 's', '--at', '392,196']),
      dcTry(['whiteboard', 'add', W, 'knowledge', '--ref', HTML_REF, '--size', 's', '--at', '588,196']),
      dcTry(['whiteboard', 'add', W, 'task', '--ref', TASK_SLUG, '--size', 's', '--at', '784,196']),
    ];
    const wLinkFile = join(SCRATCH, 'wiki-link.json');
    writeFileSync(wLinkFile, JSON.stringify({ type: 'excalidraw', version: 2, elements: [
      mkRect('wk-task', 0, `dreamcontext://task/${TASK_SLUG}`),
      mkRect('wk-know', 200, `dreamcontext://knowledge/${KNOWLEDGE.name}`),
    ] }));
    wAdds.push(dcTry(['whiteboard', 'draw', W, '--file', wLinkFile, '--at', '0,420', '--tag', 'wiki-link']));
    ok('W fixture: the page board, its page/task cards and two dreamcontext:// links are seeded through the CLI',
      wAdds.every((r) => r.code === 0), wAdds.filter((r) => r.code !== 0).map((r) => r.out).join(' | '));

    // The wiki-card board: the same handbook list in an XL, an L, an M and an S card, and a
    // second wiki card ("Team wiki") with a list of its own — all through the CLI.
    dc(['whiteboard', 'create', WIKI_CARDS.name]);
    const WC = WIKI_CARDS.slug;
    const addWiki = (title, size, at) => {
      const r = dcTry(['whiteboard', 'add', WC, 'wiki', '--title', title, '--size', size, '--at', at, '--json']);
      try { return JSON.parse(r.out).id ?? null; } catch { return null; }
    };
    const HB = {
      xl: addWiki('Handbook XL', 'xl', '0,0'),
      l: addWiki('Handbook L', 'l', '784,0'),
      m: addWiki('Handbook M', 'm', '0,392'),
      s: addWiki('Handbook S', 's', '392,392'),
    };
    const TEAM = addWiki('Team wiki', 'm', '588,392');
    const navAdds = [];
    for (const id of Object.values(HB)) {
      for (const [section, ref] of HB_LIST) navAdds.push(dcTry(['whiteboard', 'nav', 'add', WC, '--card', id ?? '', '--section', section, '--page', ref]));
    }
    navAdds.push(dcTry(['whiteboard', 'nav', 'add', WC, '--card', TEAM ?? '', '--section', 'Team', '--page', KNOWLEDGE.name]));
    ok('W fixture: five wiki cards added by `whiteboard add <slug> wiki --title`, their lists by `whiteboard nav add --card`',
      Object.values(HB).every(Boolean) && !!TEAM && navAdds.every((r) => r.code === 0),
      navAdds.filter((r) => r.code !== 0).map((r) => r.out).join(' | '));
    /** A wiki card's list as the board FILE holds it (customData.dc.sections), read raw. */
    const wikiOnDisk = (id) => {
      const el = rawElements(WC).find((e) => e.id === id && !e.isDeleted);
      return (el?.customData?.dc?.sections ?? []).map((sec) => ({ id: sec.id, title: sec.title, refs: (sec.pages ?? []).map((p) => p.ref) }));
    };
    const listSig = (secs) => JSON.stringify(secs.map((sec) => [sec.title, sec.refs]));
    const HB_INIT = [['Getting started', [LAUNCH.name, NOTES.ref]], ['Reference', [PDF_REF, HTML_REF]]];
    const TEAM_INIT = [['Team', [KNOWLEDGE.name]]];
    ok('W fixture: every handbook card holds the seeded list in the file, the Team card its own',
      Object.values(HB).every((id) => listSig(wikiOnDisk(id)) === JSON.stringify(HB_INIT)) && listSig(wikiOnDisk(TEAM)) === JSON.stringify(TEAM_INIT),
      Object.values(HB).map((id) => listSig(wikiOnDisk(id))).join(' / '));
    const shownWikis = dcTry(['whiteboard', 'show', WC, '--json']);
    ok('W fixture: `whiteboard show --json` reports every wiki card with its list', (() => {
      try { return (JSON.parse(shownWikis.out).wikis ?? []).length === 5; } catch { return false; }
    })(), shownWikis.out.slice(0, 160));

    const KPATH = (slug) => `_dream_context/knowledge/${slug}.md`;
    const TPATH = `_dream_context/state/${TASK_SLUG}.md`;
    const panelEl = page.locator('.wb-page-panel');
    const panelPath = () => panelEl.getAttribute('data-page-path', { timeout: 500 }).catch(() => null);
    const panelWaitPath = (want, ms = 5000) => until(async () => (await panelPath()) === want, ms);
    const panelOpen = async () => (await panelEl.count()) > 0;
    const pageCard = (text, kind = 'knowledge') => page.locator(`.wb-widget[data-widget-kind="${kind}"]`, { hasText: text }).first();
    const hashState = () => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.replace(/^#/, ''))));
    const pathSearch = () => page.evaluate(() => location.pathname + location.search);
    const activeRail = () => page.locator('.sidebar-item--active').innerText().catch(() => '');
    /**
     * The panel's and the canvas's boxes, whether the panel has stopped moving (no running
     * slide-in or width transition: the gate every geometry read waits on), and what a point
     * halfway between the canvas's left edge and the panel's left edge hits.
     */
    const panelGeo = () => page.evaluate(() => {
      const p = document.querySelector('.wb-page-panel');
      const c = document.querySelector('.wbp-canvas');
      const body = document.querySelector('.wbp-body');
      if (!p || !c || !body) return null;
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
      const pb = box(p);
      const cb = box(c);
      const hit = document.elementFromPoint((cb.l + Math.min(pb.l, cb.r)) / 2, cb.t + cb.h / 2);
      return {
        settled: p.getAnimations().every((a) => a.playState !== 'running'),
        p: pb, c: cb, body: box(body),
        leftHit: { inCanvas: !!hit?.closest('.wbp-canvas'), inPanel: !!hit?.closest('.wb-page-panel'), tag: hit?.tagName ?? null, cls: String(hit?.className ?? '').slice(0, 60) },
      };
    });
    /**
     * Excalidraw's own top-bar controls — the tool row, our "+ Add", the Library trigger — each
     * with its box, the canvas's left edge, the panel's left edge (or the canvas's right one
     * when no panel is open), and whether elementFromPoint at its centre hits the control itself.
     */
    const excalidrawControls = () => page.evaluate(() => {
      const canvas = document.querySelector('.wbp-canvas')?.getBoundingClientRect();
      const panel = document.querySelector('.wb-page-panel')?.getBoundingClientRect();
      const one = (sel) => {
        const el = document.querySelector(sel);
        if (!el || !canvas) return null;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width),
          canvasL: Math.round(canvas.left), panelL: Math.round(panel ? panel.left : canvas.right),
          hitsSelf: !!hit && (hit === el || el.contains(hit)),
          hit: hit ? `${hit.tagName}.${String(hit.className?.baseVal ?? hit.className ?? '').slice(0, 50)}` : null,
        };
      };
      return {
        toolbar: one('.wbp-canvas .App-toolbar'),
        '"+ Add"': one('.wbp-canvas .wb-add-btn'),
        Library: one('.wbp-canvas .sidebar-trigger'),
      };
    });
    /**
     * Hover a page card's title (the card's open target) and read the WCAG contrast of the
     * title's computed colour against the card's painted background (every translucent layer up
     * the tree composited; colours resolved through a canvas, so any CSS colour syntax reads).
     */
    const hoverTitleContrast = async (card) => {
      const t = card.locator('.wb-entity--open .wb-entity-title').first();
      const b = await t.boundingBox().catch(() => null);
      if (!b) return null;
      await page.mouse.move(b.x + Math.min(b.width / 2, 40), b.y + b.height / 2);
      // Wait out any colour transition: two equal reads 150ms apart.
      let prev = null;
      for (let i = 0; i < 12; i += 1) {
        const c = await t.evaluate((el) => getComputedStyle(el).color).catch(() => null);
        if (c && c === prev) break;
        prev = c;
        await page.waitForTimeout(150);
      }
      return t.evaluate((el) => {
        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        const rgba = (css) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2], d[3] / 255];
        };
        const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
        const layers = [];
        for (let n = el; n; n = n.parentElement) {
          const c = rgba(getComputedStyle(n).backgroundColor);
          if (c[3] > 0) layers.push(c);
          if (c[3] >= 1) break;
        }
        let bg = [255, 255, 255, 1];
        for (const l of layers.reverse()) bg = over(l, bg);
        const fg = over(rgba(getComputedStyle(el).color), bg);
        const lum = (c) => {
          const [r, g, b2] = c.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
        };
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b2) => b2 - a);
        const open = el.closest('.wb-entity--open');
        return {
          ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
          fg: getComputedStyle(el).color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`,
          hovered: !!open?.matches(':hover'), active: !!el.closest('.wb-widget')?.classList.contains('is-active'),
        };
      }).catch(() => null);
    };
    const panelSettled = (ms = 4000) => until(async () => { const g = await panelGeo(); return g?.settled ? g : null; }, ms);
    const panelHead = () => page.evaluate(() => {
      const h = document.querySelector('.wb-page-panel-head');
      if (!h) return null;
      return {
        title: (h.querySelector('.wb-page-panel-title')?.textContent ?? '').trim(),
        text: h.innerText,
        buttons: [...h.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label'), svg: !!b.querySelector('svg'), text: (b.textContent ?? '').trim() })),
      };
    });
    /** The ⋯ menu's rows (opened here, left open). */
    const openMenu = async () => {
      await page.locator('.wb-page-panel [aria-label="More actions"]').click().catch(() => {});
      await until(async () => (await page.locator('.wb-page-panel-menu [role="menuitem"]').count()) > 0, 3000);
      return page.locator('.wb-page-panel-menu [role="menuitem"]').evaluateAll((els) => els.map((e) => ({ text: (e.textContent ?? '').trim(), svg: !!e.querySelector('svg') })));
    };
    const MENU_OUT = ['Open on computer', 'Reveal in Finder', 'Copy path'];
    /** Close with Esc from focus inside the panel (where the product listens). */
    const escPanel = async () => {
      if (!(await panelOpen())) return true;
      if (await page.locator('.wb-page-panel-menu').count()) await page.keyboard.press('Escape');
      await page.locator('.wb-page-panel-title').click().catch(() => {});
      await page.keyboard.press('Escape');
      return until(async () => !(await panelOpen()), 3000);
    };
    const closePanel = async () => {
      if (!(await panelOpen())) return true;
      await page.locator('.wb-page-panel [aria-label="Close"]').click().catch(() => {});
      return until(async () => !(await panelOpen()), 3000);
    };
    /** One plain click on a card's content, as a user does. Returns how many clicks it took (0 = never opened). */
    const openCard = async (c) => {
      for (let clicks = 1; clicks <= 2; clicks += 1) {
        const box = await c.locator('.wb-entity').first().boundingBox().catch(() => null) ?? await c.boundingBox().catch(() => null);
        if (!box) return 0;
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 30));
        if (await until(panelOpen, 2000)) return clicks;
      }
      return 0;
    };
    /** The header shows the page's title and no file path; every header button is an icon. */
    const checkHeader = async (T, what, wantTitle) => {
      const head = await until(async () => { const h = await panelHead(); return h?.title === wantTitle ? h : null; }, 4000) ?? await panelHead();
      ok(`${T} ${what}: the panel's title is the page's title "${wantTitle}"`, head?.title === wantTitle, JSON.stringify(head?.title));
      ok(`${T} …and the header holds no file path`, !!head && !/_dream_context|\/|\.(md|pdf|html?)\b/i.test(head.text), JSON.stringify(head?.text));
      ok(`${T} …its five buttons (Back, Forward, Expand, More actions, Close) are line icons: an SVG each, no text glyph`,
        !!head && JSON.stringify(head.buttons.map((b) => b.label)) === JSON.stringify(['Back', 'Forward', 'Expand', 'More actions', 'Close'])
          && head.buttons.every((b) => b.svg && b.text === ''),
        JSON.stringify(head?.buttons));
    };
    /** The panel's typography and frame: the reader is a page, not a card. */
    const readerLook = (scope) => page.evaluate((sel) => {
      const host = document.querySelector(sel);
      const root = host?.querySelector('.doc-reader');
      const md = host?.querySelector('.md-preview');
      const p = [...(host?.querySelectorAll('.md-preview p') ?? [])].find((x) => /walks the whole path/.test(x.textContent ?? ''));
      if (!host || !root || !md || !p) return null;
      const border = (el) => { const cs = getComputedStyle(el); return ['Top', 'Right', 'Bottom', 'Left'].reduce((n, s) => n + (cs[`border${s}Style`] === 'none' ? 0 : parseFloat(cs[`border${s}Width`])), 0); };
      return {
        page: root.classList.contains('doc-reader--page'),
        rootBorder: border(root), rootBg: getComputedStyle(root).backgroundColor, hostBg: getComputedStyle(host).backgroundColor,
        mdBorder: border(md), mdBg: getComputedStyle(md).backgroundColor,
        font: parseFloat(getComputedStyle(p).fontSize),
      };
    }, scope);
    const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;
    /** The long paragraph's painted lines (Range rects grouped by line) against 75ch of its font. */
    const measureParagraph = () => page.evaluate(() => {
      const p = [...document.querySelectorAll('.wb-page-panel .md-preview p')].find((x) => /walks the whole path/.test(x.textContent ?? ''));
      if (!p) return null;
      const range = document.createRange();
      range.selectNodeContents(p);
      const lines = new Map();
      for (const r of range.getClientRects()) {
        if (r.width <= 0) continue;
        const k = Math.round(r.top);
        const l = lines.get(k) ?? { l: Infinity, r: -Infinity };
        l.l = Math.min(l.l, r.left);
        l.r = Math.max(l.r, r.right);
        lines.set(k, l);
      }
      const widths = [...lines.values()].map((l) => l.r - l.l);
      const cs = getComputedStyle(p);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ch = ctx.measureText('0').width;
      const max = Math.max(...widths);
      return { lines: widths.length, max: Math.round(max), ch: Math.round(ch * 100) / 100, chars: Math.round(max / ch), panel: Math.round(document.querySelector('.wb-page-panel').getBoundingClientRect().width) };
    });
    /** Whether focus went back where it was when the panel took it (recorded by the focusin
     *  listener installed after each reload). */
    const focusReturned = () => page.evaluate(() => {
      const from = window.__dcPanelFrom;
      return { ok: !!from && from.isConnected && document.activeElement === from, from: from ? `${from.tagName}.${String(from.className).slice(0, 40)}` : null, now: `${document.activeElement?.tagName}.${String(document.activeElement?.className ?? '').slice(0, 40)}` };
    });
    const resetFocusProbe = () => page.evaluate(() => { window.__dcPanelFrom = null; });

    // The wiki cards.
    const wikiCard = (title) => page.locator('.wb-widget[data-widget-kind="wiki"]')
      .filter({ has: page.locator('.wb-widget-title', { hasText: new RegExp(`^${title}$`) }) }).first();
    const rowsOf = (card) => card.locator('.wb-wiki-row-open').evaluateAll((els) => els.map((e) => ({
      ref: e.getAttribute('data-page-ref'),
      title: (e.querySelector('.wb-wiki-row-title')?.textContent ?? '').trim(),
      type: (e.querySelector('.wb-wiki-row-type')?.textContent ?? '').trim(),
    })));
    const sectionTitlesOf = (card) => card.locator('.wb-wiki-section-title').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
    /**
     * Where each row, section heading and "+N more" line of a wiki card's list sits against
     * what the list actually shows: its padding box when it clips (overflow not visible), cut
     * by the card body's and the card's own boxes. Each box is 'inside' (wholly), 'outside'
     * (wholly) or 'partial'. Returns the rows wholly shown (in order), the partial boxes, the
     * headings shown without a row of their section, and the "+N more" line(s).
     */
    const listFit = (card) => card.evaluate((cardEl) => {
      const list = cardEl.querySelector('.wb-wiki-list');
      if (!list) return null;
      const lcs = getComputedStyle(list);
      const lr = list.getBoundingClientRect();
      const boxes = [cardEl.getBoundingClientRect()];
      const bodyEl = cardEl.querySelector('.wb-widget-body');
      if (bodyEl) boxes.push(bodyEl.getBoundingClientRect());
      if (lcs.overflowY !== 'visible') {
        boxes.push({ top: lr.top + parseFloat(lcs.borderTopWidth), bottom: lr.bottom - parseFloat(lcs.borderBottomWidth) });
      }
      const top = Math.max(...boxes.map((b) => b.top));
      const bottom = Math.min(...boxes.map((b) => b.bottom));
      const where = (el) => {
        const r = el.getBoundingClientRect();
        if (r.height <= 0 || getComputedStyle(el).visibility === 'hidden') return 'none';
        if (r.top >= top - 0.5 && r.bottom <= bottom + 0.5) return 'inside';
        if (r.bottom <= top + 0.5 || r.top >= bottom - 0.5) return 'outside';
        return 'partial';
      };
      const sec = (el) => el.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null;
      const rows = [...list.querySelectorAll('.wb-wiki-row')].map((li) => {
        const b = li.querySelector('.wb-wiki-row-open');
        return {
          ref: b?.getAttribute('data-page-ref') ?? null, section: sec(li), where: where(li),
          title: (li.querySelector('.wb-wiki-row-title')?.textContent ?? '').trim(),
          type: (li.querySelector('.wb-wiki-row-type')?.textContent ?? '').trim(),
        };
      });
      const heads = [...list.querySelectorAll('.wb-wiki-section-title')].map((h) => ({ text: (h.textContent ?? '').trim(), section: sec(h), where: where(h) }));
      const more = [...list.querySelectorAll('button.wb-wiki-more')].map((m) => ({ text: (m.textContent ?? '').trim(), where: where(m), inside: where(m) === 'inside' }));
      return {
        box: { top: Math.round(top), bottom: Math.round(bottom) },
        rows,
        shown: rows.filter((r) => r.where === 'inside').map((r) => ({ ref: r.ref, title: r.title, type: r.type })),
        partial: [...rows.map((r) => ({ what: `row ${r.ref}`, where: r.where })), ...heads.map((h) => ({ what: `heading ${h.text}`, where: h.where })),
          ...more.map((m) => ({ what: `more "${m.text}"`, where: m.where }))].filter((x) => x.where === 'partial'),
        loneHeadings: heads.filter((h) => h.where === 'inside' && !rows.some((r) => r.section === h.section && r.where === 'inside')).map((h) => h.text),
        more,
      };
    }).catch(() => null);
    const rowInside = async (card, ref) => (await listFit(card))?.rows.find((r) => r.ref === ref)?.where === 'inside';
    /**
     * Every heading, row title and in-card reader title of a card's list: whether its text
     * overflows its box, whether an ellipsis is then really in effect (text-overflow: ellipsis
     * on a block box that clips one nowrap line — a flex box ignores text-overflow and cuts
     * mid-letter), and the title attribute that carries the full text.
     */
    const listTexts = (card) => card.evaluate((cardEl) => {
      const blockish = (d) => ['block', 'inline-block', 'flow-root', 'list-item'].includes(d);
      const read = (el, kind, titleEl) => {
        const cs = getComputedStyle(el);
        return {
          kind, text: (el.textContent ?? '').trim(), title: titleEl?.getAttribute('title') ?? null,
          overflows: el.scrollWidth > el.clientWidth + 0.5,
          ellipsis: cs.textOverflow === 'ellipsis' && blockish(cs.display) && cs.overflowX !== 'visible' && /nowrap|pre/.test(cs.whiteSpace),
          sw: el.scrollWidth, cw: el.clientWidth, display: cs.display,
        };
      };
      return [
        ...[...cardEl.querySelectorAll('.wb-wiki-section-title')].map((h) => read(h, 'heading', h)),
        ...[...cardEl.querySelectorAll('.wb-wiki-row-title')].map((t) => read(t, 'row', t.closest('.wb-wiki-row-open'))),
        ...[...cardEl.querySelectorAll('.wb-wiki-reader-title')].map((t) => read(t, 'reader', t)),
      ];
    }).catch(() => null);
    const HB_ROWS = [
      { ref: LAUNCH.name, title: LAUNCH.title, type: 'Knowledge' },
      { ref: NOTES.ref, title: NOTES.title, type: 'MD' },
      { ref: PDF_REF, title: 'Pricing sheet', type: 'PDF' },
      { ref: HTML_REF, title: 'Status page', type: 'HTML' },
    ];
    const pathOfRef = (ref) => (ref.includes('/') ? ref : KPATH(ref));
    const readerPath = (card) => card.locator('.wb-wiki-reader').getAttribute('data-page-path', { timeout: 500 }).catch(() => null);
    /** One plain click on a wiki card's page row, as a user does (the card may be inactive). */
    const clickRow = async (card, ref) => {
      const b = await card.locator(`.wb-wiki-row-open[data-page-ref="${ref}"]`).first().boundingBox().catch(() => null);
      if (!b) return false;
      await page.mouse.click(b.x + Math.min(b.width / 2, 60), b.y + b.height / 2);
      return true;
    };
    /** Every wiki card fully on screen, clear of Excalidraw's toolbars. */
    const wikiCardsInView = () => page.evaluate(() => {
      const c = document.querySelector('.wbp-canvas')?.getBoundingClientRect();
      const cards = [...document.querySelectorAll('.wb-widget[data-widget-kind="wiki"]')];
      return !!c && cards.length === 5 && cards.every((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= c.left + 8 && r.right <= c.right - 8 && r.top >= c.top + 70 && r.bottom <= c.bottom - 70;
      });
    });

    await openBoard(WIKI_BOARD.name);
    for (const theme of ['light', 'dark']) {
      const T = `W[${theme}]`;
      // The real theme setting (the app's own storage), applied by a reload. The reload starts
      // from a link saved while Wiki mode still existed: the board plus the retired params.
      await page.evaluate((t) => localStorage.setItem('dreamcontext-theme', t), theme);
      await page.evaluate((h) => history.replaceState(history.state, '', location.pathname + location.search + h), LEGACY_HASH);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissModal();
      let back = await until(async () => (await currentName()) === WIKI_BOARD.name && (await scene())?.width > 0, 15000);
      ok(`${T} a reload with an old "#wb=…&wbmode=wiki&wbpage=…" hash lands on the same board`, !!back, await currentName());
      if (!back) {
        await railItem.click().catch(() => {});
        await openBoard(WIKI_BOARD.name);
        back = (await currentName()) === WIKI_BOARD.name;
      }
      ok(`${T} the app is in the ${theme} theme`, await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === theme);
      const cleaned = await until(async () => JSON.stringify(await hashState()) === JSON.stringify({ wb: W }), 5000);
      ok(`${T} …the retired wbmode / wbpage params are dropped from the hash (only wb=<slug> stays)`, !!cleaned, JSON.stringify(await hashState()));
      const removed = await page.evaluate(() => ({
        pane: document.querySelectorAll('.wbp-wiki-pane').length,
        menu: document.querySelectorAll('.wbw-menu, .wbw-sections, .wbw-tree').length,
        modes: document.querySelectorAll('.wbp-mode, .wbp-modes').length,
        modeText: [...document.querySelectorAll('.wbp-editor button')].filter((b) => /^(Canvas|Wiki)$/.test((b.textContent ?? '').trim())).length,
        panel: document.querySelectorAll('.wb-page-panel').length,
      }));
      ok(`${T} …and ignored: no Wiki-mode pane, no wiki menu, no Canvas | Wiki switch, no panel open`,
        Object.values(removed).every((n) => n === 0), JSON.stringify(removed));
      const widths = await page.evaluate(() => {
        const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { l: b.left, r: b.right } : null; };
        return { canvas: r('.wbp-canvas'), body: r('.wbp-body'), editor: r('.wbp-editor') };
      });
      ok(`${T} the canvas spans the full board width`,
        !!widths.canvas && !!widths.editor && Math.abs(widths.canvas.l - widths.editor.l) <= 1 && Math.abs(widths.canvas.r - widths.editor.r) <= 1,
        JSON.stringify(widths));
      await page.evaluate(() => {
        window.__dcPanelFrom = null;
        document.addEventListener('focusin', (e) => {
          if (e.target instanceof Element && e.target.classList.contains('wb-page-panel') && !window.__dcPanelFrom) {
            window.__dcPanelFrom = e.relatedTarget ?? document.body;
          }
        }, true);
      });
      await until(async () => (await page.locator('.wb-widget').count()) >= 5, 8000);
      await page.waitForTimeout(800);

      // ── 1. a card opens the panel on the board's right; nothing about the board moves ────
      await page.locator('.excalidraw .zoom-out-button').click();
      await page.waitForTimeout(300);
      // Every PUT of this board is HELD until the panel round trip is over, so the stroke
      // below is provably unsaved (not on disk) the whole time.
      let release;
      const gate = new Promise((r) => { release = r; });
      const heldPuts = [];
      const holdPut = async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        heldPuts.push(Date.now());
        await gate;
        return route.continue().catch(() => {});
      };
      await page.route(`**/api/whiteboards/${W}`, holdPut);
      const rectsBefore = live(await scene()).filter((e) => e.type === 'rectangle').map((e) => e.id);
      const rs = await spot({ w: 200, h: 140 });
      await page.mouse.click(rs.x, rs.y);
      await drawRect(rs.x - 50, rs.y - 30, rs.x + 50, rs.y + 30);
      const strokeId = live(await scene()).find((e) => e.type === 'rectangle' && !rectsBefore.includes(e.id))?.id;
      ok(`${T} fixture: a fresh stroke is in the live scene`, !!strokeId);
      await clearSelection();
      const v0 = await scene();
      const view0 = { zoom: v0.zoom, scrollX: v0.scrollX, scrollY: v0.scrollY };
      const tag = `verify-${theme}-${Date.now()}`;
      await canvasTag(page, tag);
      const loc0 = { ps: await pathSearch(), hash: await page.evaluate(() => location.hash), navs: mainNavs };

      await resetFocusProbe();
      const clicks = await openCard(pageCard(LAUNCH.title));
      ok(`${T} ONE plain click on an inactive knowledge card opens the side panel`, clicks === 1, `clicks=${clicks}`);
      ok(`${T} …on that page`, !!(await panelWaitPath(KPATH(LAUNCH.name))), String(await panelPath()));
      // The panel PUSHES the canvas (lead, 2026-10-03): collapsed, the canvas ends where the
      // panel begins, so nothing of the board — Excalidraw's own controls included — is under it.
      const g = await until(async () => {
        const x = await panelSettled();
        return x && Math.abs(x.c.r - x.p.l) <= 2 ? x : null;
      }, 4000) ?? await panelSettled();
      ok(`${T} the panel's right edge is the board's right edge`, !!g && Math.abs(g.p.r - g.body.r) <= 1, JSON.stringify(g && { p: g.p, body: g.body }));
      ok(`${T} the panel PUSHES the canvas: the canvas's right edge is the panel's left edge (±2px)`,
        !!g && Math.abs(g.c.r - g.p.l) <= 2, JSON.stringify(g && { canvasR: g.c.r, panelL: g.p.l }));
      ok(`${T} …it runs the board's full height`, !!g && Math.abs(g.p.t - g.body.t) <= 1 && Math.abs(g.p.b - g.body.b) <= 1, JSON.stringify(g && { p: g.p, body: g.body }));
      ok(`${T} …it is narrower than 60% of the board, so ≥40% of the board stays in view on its left`,
        !!g && g.p.w < 0.6 * g.body.w && g.p.l - g.body.l >= 0.4 * g.body.w, g ? `panel ${Math.round(g.p.w)}px of ${Math.round(g.body.w)}px, left gap ${Math.round(g.p.l - g.body.l)}px` : 'no panel');
      ok(`${T} …and the board left of it is not covered: a point there hits the canvas, not a scrim`,
        !!g && g.leftHit.inCanvas && !g.leftHit.inPanel, JSON.stringify(g?.leftHit));
      // The card just clicked is active; hovered, its title must stay readable (light: it once
      // turned the on-accent white and vanished on the white card).
      const hover = await hoverTitleContrast(pageCard(LAUNCH.title));
      console.log(`info: ${T} the hovered active page card's title: ${hover?.fg} on ${hover?.bg}, ${hover?.ratio}:1`);
      ok(`${T} the hovered active page card's title has ≥ 4.5:1 contrast on the card`,
        !!hover && hover.active && hover.hovered && hover.ratio >= 4.5, JSON.stringify(hover));
      await cardShot(pageCard(LAUNCH.title), `w-page-card-hover-${theme}`);
      const ctl = await excalidrawControls();
      for (const [name, c] of Object.entries(ctl ?? {})) {
        ok(`${T} Excalidraw's ${name} lies entirely left of the panel and inside the canvas`,
          !!c && c.w > 0 && c.l >= c.canvasL - 1 && c.r <= c.panelL + 0.5, JSON.stringify(c));
        ok(`${T} …and nothing covers it (elementFromPoint at its centre hits it)`, !!c?.hitsSelf, JSON.stringify(c?.hit));
      }
      ok(`${T} fixture: the toolbar, "+ Add" and Library were all found`, !!ctl && Object.values(ctl).every(Boolean), JSON.stringify(ctl));
      // Excalidraw re-lays itself into the narrower box: a rectangle drawn with the pointer now
      // lands where the pointer went (scene → client within 3px at both corners).
      await clearSelection();
      const rp = await spot({ w: 180, h: 120 });
      const rectIds = new Set(live(await scene()).map((e) => e.id));
      if (rp) await drawRect(rp.x - 50, rp.y - 30, rp.x + 50, rp.y + 30);
      const sDrawn = await scene();
      const drawn = live(sDrawn).find((e) => e.type === 'rectangle' && !rectIds.has(e.id));
      const corners = drawn && { a: toClient(sDrawn, drawn.x, drawn.y), b: toClient(sDrawn, drawn.x + drawn.width, drawn.y + drawn.height) };
      ok(`${T} a rectangle drawn with the pointer beside the open panel lands where the pointer went`,
        !!rp && !!corners && rp.x + 50 < (g?.p.l ?? 0)
          && Math.abs(corners.a.x - (rp.x - 50)) <= 3 && Math.abs(corners.a.y - (rp.y - 30)) <= 3
          && Math.abs(corners.b.x - (rp.x + 50)) <= 3 && Math.abs(corners.b.y - (rp.y + 30)) <= 3,
        JSON.stringify({ rp, corners, panelL: g?.p.l }));
      ok(`${T} …and drawing on the board left the panel open`, await panelOpen() && (await panelPath()) === KPATH(LAUNCH.name));
      // Drop the new rectangle's selection (and Excalidraw's shape panel with it) before the shots.
      await clearSelection();
      ok(`${T} …and so did a click on empty board beside it`, await panelOpen() && (await panelPath()) === KPATH(LAUNCH.name));
      const h1 = page.locator('.wb-page-panel .md-preview h1').first();
      await h1.waitFor({ timeout: 5000 }).catch(() => {});
      ok(`${T} md renders formatted in the panel (its heading is an <h1>)`, (await h1.innerText().catch(() => '')).trim() === LAUNCH.title,
        await page.locator('.wb-page-panel-body').innerText().catch(() => '').then((t) => t.slice(0, 120)));
      ok(`${T} …and a list renders as a list`, await page.locator('.wb-page-panel .md-preview li', { hasText: 'Freeze the copy' }).count() === 1);
      ok(`${T} the shell page is still the whiteboard`, /Whiteboard/.test(await activeRail()), await activeRail());
      ok(`${T} location path+search unchanged and no navigation`, (await pathSearch()) === loc0.ps && mainNavs === loc0.navs,
        `${loc0.ps} → ${await pathSearch()}, navs +${mainNavs - loc0.navs}`);
      ok(`${T} …and the hash still holds only the board`, (await page.evaluate(() => location.hash)) === loc0.hash,
        `${loc0.hash} → ${await page.evaluate(() => location.hash)}`);
      ok(`${T} the canvas is still mounted beside the panel`, await page.locator('.wbp-canvas .excalidraw').count() === 1);
      ok(`${T} the stroke is unsaved while the panel is open (on disk: no)`, !onDisk(W).some((e) => e.id === strokeId));
      await checkHeader(T, 'a knowledge page', LAUNCH.title);

      // ── 3. the page reads as a page: size, measure, no frame ────────────────────────────
      const look = await until(() => readerLook('.wb-page-panel'), 4000);
      ok(`${T} the panel reads with the page variant of DocumentReader`, !!look?.page, JSON.stringify(look));
      ok(`${T} …body text is at least 15px`, (look?.font ?? 0) >= 15, String(look?.font));
      ok(`${T} …no border and no card background around the text (reader root and .md-preview)`,
        !!look && look.rootBorder === 0 && look.mdBorder === 0 && TRANSPARENT.test(look.mdBg)
          && (TRANSPARENT.test(look.rootBg) || look.rootBg === look.hostBg),
        JSON.stringify(look));
      await wshot(`w-panel-md-${theme}`);

      // Expand spans the board; the measure holds at that width; Collapse restores the side width.
      await page.locator('.wb-page-panel [aria-label="Expand"]').click().catch(() => {});
      const full = await until(async () => {
        const x = await panelGeo();
        return x?.settled && Math.abs(x.p.l - x.body.l) <= 1 && Math.abs(x.p.r - x.body.r) <= 1 ? x : null;
      }, 4000);
      ok(`${T} Expand makes the panel span the full board width`, !!full, JSON.stringify(await panelGeo().then((x) => x && { p: x.p, body: x.body })));
      ok(`${T} …and the button turns into a pressed Collapse`, await page.locator('.wb-page-panel [aria-label="Collapse"][aria-pressed="true"]').count() === 1);
      const m = await measureParagraph();
      ok(`${T} expanded, a long paragraph wraps into a column of at most ~75 characters (painted lines)`,
        !!m && m.lines >= 3 && m.max <= 75 * m.ch, JSON.stringify(m));
      await wshot(`w-panel-md-expanded-${theme}`);
      await page.locator('.wb-page-panel [aria-label="Collapse"]').click().catch(() => {});
      const side = await until(async () => {
        const x = await panelGeo();
        return x?.settled && g && Math.abs(x.p.w - g.p.w) <= 1 && Math.abs(x.p.r - x.body.r) <= 1 ? x : null;
      }, 4000);
      ok(`${T} Collapse brings back the side width`, !!side, `${g?.p.w} vs ${(await panelGeo())?.p.w}`);
      const pushed = await until(async () => { const x = await panelGeo(); return x?.settled && Math.abs(x.c.r - x.p.l) <= 2 ? x : null; }, 4000);
      ok(`${T} …and pushes the canvas again (the canvas's right edge at the panel's left edge)`, !!pushed,
        JSON.stringify(await panelGeo().then((x) => x && { canvasR: x.c.r, panelL: x.p.l })));

      // The ⋯ menu, and Esc: the menu first, then the panel.
      const items = await openMenu();
      ok(`${T} ⋯ on a knowledge page: Open in Knowledge, Open on computer, Reveal in Finder, Copy path`,
        JSON.stringify(items.map((i) => i.text)) === JSON.stringify(['Open in Knowledge', ...MENU_OUT]), JSON.stringify(items));
      ok(`${T} …each row with a line icon`, items.length > 0 && items.every((i) => i.svg));
      await wshot(`w-panel-menu-${theme}`);
      await page.keyboard.press('Escape');
      const menuGone = await until(async () => (await page.locator('.wb-page-panel-menu').count()) === 0, 2000);
      ok(`${T} the first Esc closes the ⋯ menu and leaves the panel open`, !!menuGone && await panelOpen());

      // ── 4. [[wikilinks]], back / forward, "not found" ──────────────────────────────────
      const wl = page.locator(`.wb-page-panel [data-wikilink="${KNOWLEDGE.name}"]`).first();
      ok(`${T} a [[target|label]] wikilink renders as a link with its label`,
        (await wl.innerText().catch(() => '')).includes('the onboarding playbook'), await wl.innerText().catch(() => '(none)'));
      await wl.click().catch(() => {});
      ok(`${T} clicking the wikilink opens its target in the SAME panel`, !!(await panelWaitPath(KPATH(KNOWLEDGE.name))) && (await panelEl.count()) === 1, String(await panelPath()));
      const h1b = page.locator('.wb-page-panel .md-preview h1').first();
      ok(`${T} …showing the target's heading`, !!(await until(async () => (await h1b.innerText().catch(() => '')).trim() === KNOWLEDGE.title, 4000)),
        await h1b.innerText().catch(() => ''));
      ok(`${T} …and the header follows it`, (await panelHead())?.title === KNOWLEDGE.title, (await panelHead())?.title);
      await wshot(`w-panel-wikilink-${theme}`);
      const backBtn = page.locator('.wb-page-panel [aria-label="Back"]');
      const fwdBtn = page.locator('.wb-page-panel [aria-label="Forward"]');
      ok(`${T} Back becomes available`, await backBtn.isEnabled().catch(() => false));
      await backBtn.click().catch(() => {});
      ok(`${T} Back returns to the first page`, !!(await panelWaitPath(KPATH(LAUNCH.name))), String(await panelPath()));
      ok(`${T} …and Forward becomes available`, await fwdBtn.isEnabled().catch(() => false));
      await fwdBtn.click().catch(() => {});
      ok(`${T} Forward goes to the linked page again`, !!(await panelWaitPath(KPATH(KNOWLEDGE.name))), String(await panelPath()));
      await backBtn.click().catch(() => {});
      await panelWaitPath(KPATH(LAUNCH.name));
      await page.locator('.wb-page-panel [data-wikilink="missing-page"]').first().click().catch(() => {});
      const notFound = await until(async () => /not found/i.test(await page.locator('.wb-page-panel .doc-reader-notice').innerText().catch(() => '')), 4000);
      ok(`${T} an unresolved [[missing-page]] says "not found"`, !!notFound,
        await page.locator('.wb-page-panel .doc-reader-notice').innerText().catch(() => '(no notice)'));
      ok(`${T} …and stays on the page it was clicked on`, (await panelPath()) === KPATH(LAUNCH.name), String(await panelPath()));
      ok(`${T} the next Esc closes the panel`, !!(await escPanel()));
      const fr1 = await focusReturned();
      ok(`${T} …and focus goes back where it was before the panel opened`, fr1.ok, JSON.stringify(fr1));

      const v1 = await scene();
      ok(`${T} after closing: zoom and scroll are exactly as before`,
        v1.zoom === view0.zoom && v1.scrollX === view0.scrollX && v1.scrollY === view0.scrollY,
        `${JSON.stringify(view0)} → ${JSON.stringify({ zoom: v1.zoom, scrollX: v1.scrollX, scrollY: v1.scrollY })}`);
      const fullAgain = await page.evaluate(() => {
        const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { l: b.left, r: b.right } : null; };
        return { canvas: r('.wbp-canvas'), body: r('.wbp-body') };
      });
      ok(`${T} …and the canvas is full width again`, !!fullAgain.canvas && !!fullAgain.body
        && Math.abs(fullAgain.canvas.l - fullAgain.body.l) <= 1 && Math.abs(fullAgain.canvas.r - fullAgain.body.r) <= 1, JSON.stringify(fullAgain));
      const exWidth = await until(async () => {
        const s = await scene();
        return fullAgain.canvas && Math.abs(s.width - (fullAgain.canvas.r - fullAgain.canvas.l)) <= 2 ? s : null;
      }, 3000);
      ok(`${T} …with Excalidraw laid out across it again (its own width = the canvas's)`, !!exWidth,
        `${(await scene())?.width} vs ${fullAgain.canvas && fullAgain.canvas.r - fullAgain.canvas.l}`);
      const v1b = exWidth ?? await scene();
      ok(`${T} …and after that re-layout the zoom and scroll are still as before`,
        v1b.zoom === view0.zoom && v1b.scrollX === view0.scrollX && v1b.scrollY === view0.scrollY,
        `${JSON.stringify(view0)} → ${JSON.stringify({ zoom: v1b.zoom, scrollX: v1b.scrollX, scrollY: v1b.scrollY })}`);
      ok(`${T} …the unsaved stroke is still in the live scene`, live(v1).some((e) => e.id === strokeId));
      ok(`${T} …the canvas was not remounted (same Excalidraw instance)`, await canvasTag(page) === tag);
      ok(`${T} …and it was unsaved the whole time (held PUTs: ${heldPuts.length})`, !onDisk(W).some((e) => e.id === strokeId));
      release();
      await page.unroute(`**/api/whiteboards/${W}`, holdPut);
      ok(`${T} once saves are let through, the stroke reaches disk`, !!(await until(() => onDisk(W).some((e) => e.id === strokeId), 10000, 300)));

      // ── 1b. a project .md file ──────────────────────────────────────────────────────────
      await clearSelection();
      await resetFocusProbe();
      ok(`${T} ONE click on the inactive .md file card opens the panel`, (await openCard(pageCard(NOTES.title))) === 1);
      ok(`${T} …on the file`, !!(await panelWaitPath(NOTES.ref)), String(await panelPath()));
      await checkHeader(T, 'a project .md file', NOTES.title);
      ok(`${T} …formatted`, !!(await until(async () => (await page.locator('.wb-page-panel .md-preview h1').first().innerText().catch(() => '')).trim() === NOTES.title, 4000)));
      const notesMenu = await openMenu();
      ok(`${T} ⋯ on a project file: Open on computer, Reveal in Finder, Copy path — no "Open in Knowledge"`,
        JSON.stringify(notesMenu.map((i) => i.text)) === JSON.stringify(MENU_OUT), JSON.stringify(notesMenu));
      await page.keyboard.press('Escape');
      await until(async () => (await page.locator('.wb-page-panel-menu').count()) === 0, 2000);
      ok(`${T} the panel's × closes it`, !!(await closePanel()));
      const fr2 = await focusReturned();
      ok(`${T} …and focus goes back`, fr2.ok, JSON.stringify(fr2));

      // ── 2. PDF and HTML pages ───────────────────────────────────────────────────────────
      await clearSelection();
      ok(`${T} the PDF card's header label says PDF`, (await pageCard('Pricing sheet').locator('.wb-widget-kind').innerText().catch(() => '')).trim() === 'PDF');
      ok(`${T} ONE click on the inactive PDF card opens the panel`, (await openCard(pageCard('Pricing sheet'))) === 1);
      ok(`${T} …on the PDF`, !!(await panelWaitPath(PDF_REF)), String(await panelPath()));
      await checkHeader(T, 'a PDF', 'Pricing sheet');
      const pdfView = page.locator('.wb-page-panel .pdf-viewer--embedded');
      await pdfView.waitFor({ timeout: 5000 }).catch(() => {});
      ok(`${T} the PDF opens in the embedded viewer, inside the panel`, await pdfView.count() === 1);
      const pdfState = await until(async () => {
        if (await pdfView.locator('.pdf-viewer-frame').count()) return 'frame';
        const st = await pdfView.locator('.pdf-viewer-status').first().innerText().catch(() => '');
        return /can.t display/i.test(st) ? 'cannot-display' : (/Couldn/.test(st) ? `error: ${st}` : null);
      }, 6000);
      console.log(`info: ${T} the PDF viewer state is ${pdfState ?? 'still loading'}`);
      ok(`${T} the PDF viewer settles on the document or the "can't display" fallback (no error)`,
        pdfState === 'frame' || pdfState === 'cannot-display', String(pdfState));
      const pdfTitles = await page.evaluate(() => {
        const p = document.querySelector('.wb-page-panel');
        const text = p?.innerText ?? '';
        return {
          title: text.split('Pricing sheet').length - 1,
          path: text.split('docs/pricing-sheet.pdf').length - 1,
          viewerHead: p?.querySelectorAll('.pdf-viewer-head, .pdf-viewer-name, .pdf-viewer-path').length ?? -1,
        };
      });
      ok(`${T} the PDF's title is written once (the panel header; the viewer draws no header of its own)`,
        pdfTitles.title === 1 && pdfTitles.path === 0 && pdfTitles.viewerHead === 0, JSON.stringify(pdfTitles));
      const pdfMenu = await openMenu();
      ok(`${T} ⋯ on the PDF keeps "Open on computer" reachable (and no Open in Knowledge)`,
        JSON.stringify(pdfMenu.map((i) => i.text)) === JSON.stringify(MENU_OUT), JSON.stringify(pdfMenu));
      await page.keyboard.press('Escape');
      await until(async () => (await page.locator('.wb-page-panel-menu').count()) === 0, 2000);
      await wshot(`w-panel-pdf-${theme}`);
      ok(`${T} Esc closes the PDF panel`, !!(await escPanel()));

      await clearSelection();
      ok(`${T} the HTML card's header label says HTML`, (await pageCard('Status page').locator('.wb-widget-kind').innerText().catch(() => '')).trim() === 'HTML');
      ok(`${T} ONE click on the inactive HTML card opens the panel`, (await openCard(pageCard('Status page'))) === 1);
      ok(`${T} …on the HTML page`, !!(await panelWaitPath(HTML_REF)), String(await panelPath()));
      await checkHeader(T, 'an HTML page', 'Status page');
      const hf = page.locator('.wb-page-panel iframe.doc-reader-html-frame');
      await hf.waitFor({ timeout: 5000 }).catch(() => {});
      const sandbox = await hf.getAttribute('sandbox').catch(() => null);
      ok(`${T} the HTML page renders in an iframe whose sandbox has allow-scripts`, /\ballow-scripts\b/.test(sandbox ?? ''), String(sandbox));
      ok(`${T} …and NOT allow-same-origin`, sandbox !== null && !/allow-same-origin/.test(sandbox), String(sandbox));
      const srcdoc = await hf.getAttribute('srcdoc').catch(() => '') ?? '';
      ok(`${T} …with a CSP of default-src 'none' in its srcdoc`, /Content-Security-Policy/i.test(srcdoc) && /default-src\s+'none'/.test(srcdoc));
      const htmlRan = await until(async () => /STATUS-SCRIPT-RAN/.test(await hf.contentFrame().locator('body').innerText().catch(() => '')), 4000);
      ok(`${T} …and the page's own script runs`, !!htmlRan);
      const note = await page.evaluate(() => {
        const n = document.querySelector('.wb-page-panel .doc-reader-html-note');
        if (!n) return null;
        const range = document.createRange();
        range.selectNodeContents(n);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        return { text: (n.textContent ?? '').trim(), lines: tops.size, visible: n.getBoundingClientRect().height > 0 };
      });
      ok(`${T} the external-assets note is visible, on one line`, !!note?.visible && note.lines === 1 && /sandbox/i.test(note.text), JSON.stringify(note));
      // The note sits right under the page: the gap from the page's last painted line (read
      // inside the sandboxed frame, offset by the frame's top) to the note's top is at most
      // HTML_NOTE_GAP. Fixed, it is ~22px: the page's own trailing margins (the <p>'s 1em, the
      // body's 8px) and the note's top margin, nothing else. A frame that keeps its 200px floor
      // under this short page leaves ~105px. 48px is about two lines of body text: room for
      // those margins at a larger font, never room for a hole.
      let lastGap = null;
      const gapAt = await until(async () => {
        const inner = await hf.contentFrame().locator('body').evaluate((body) => {
          const range = document.createRange();
          range.selectNodeContents(body);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
          return rects.length ? Math.max(...rects.map((r) => r.bottom)) : null;
        }).catch(() => null);
        const outer = await page.evaluate(() => {
          const f = document.querySelector('.wb-page-panel iframe.doc-reader-html-frame')?.getBoundingClientRect();
          const n = document.querySelector('.wb-page-panel .doc-reader-html-note')?.getBoundingClientRect();
          return f && n ? { frameTop: f.top, frameH: f.height, noteTop: n.top } : null;
        });
        lastGap = inner !== null && outer ? { gap: Math.round(outer.noteTop - (outer.frameTop + inner)), contentBottom: Math.round(inner), ...outer } : null;
        return lastGap && lastGap.gap >= 0 && lastGap.gap <= HTML_NOTE_GAP ? lastGap : null;
      }, 4000) ?? lastGap;
      console.log(`info: ${T} the HTML page's last line ends ${gapAt?.gap}px above the sandbox note (frame ${Math.round(gapAt?.frameH ?? 0)}px tall)`);
      ok(`${T} …right under the page: ≤ ${HTML_NOTE_GAP}px from its last line to the note`,
        !!gapAt && gapAt.gap >= 0 && gapAt.gap <= HTML_NOTE_GAP, JSON.stringify(gapAt));
      await wshot(`w-panel-html-${theme}`);
      ok(`${T} the panel's × closes it`, !!(await closePanel()));

      // ── 1c. the card that opened the panel stays in view (owner, 2026-10-03) ────────────
      // The push narrows the canvas, so a card near the board's right can end up under the
      // panel's edge. Such a card is panned just far enough to show it whole (zoom untouched);
      // a card already in view moves nothing; closing puts the pre-open pan back unless the user
      // panned while reading; Expand / Collapse pan nothing. `g.p.l` (block 1) is where the
      // pushed canvas ends. Every pan here is a user's wheel over empty canvas.
      const vpOf = (s) => ({ zoom: s?.zoom, scrollX: s?.scrollX, scrollY: s?.scrollY });
      const sameVp = (a, b) => !!a && !!b && a.zoom === b.zoom && a.scrollX === b.scrollX && a.scrollY === b.scrollY;
      const opener = pageCard(NOTES.title);
      const openerFit = async () => {
        const b = await opener.boundingBox().catch(() => null);
        const c = await page.locator('.wbp-canvas').boundingBox().catch(() => null);
        return b && c ? {
          card: { l: Math.round(b.x * 10) / 10, r: Math.round((b.x + b.width) * 10) / 10, t: Math.round(b.y), b: Math.round(b.y + b.height) },
          canvas: { l: Math.round(c.x * 10) / 10, r: Math.round((c.x + c.width) * 10) / 10, t: Math.round(c.y), b: Math.round(c.y + c.height) },
        } : null;
      };
      const wholeIn = (f) => !!f && f.card.l >= f.canvas.l - 1 && f.card.r <= f.canvas.r + 1 && f.card.t >= f.canvas.t - 1 && f.card.b <= f.canvas.b + 1;
      let panned = { x: 0, y: 0 };
      /** The user's wheel over empty canvas, moving the board's content by (dx, dy) screen px. */
      const wheelPan = async (dx, dy) => {
        const s = await scene();
        const p = emptySpot(s, [], { w: 40, h: 40 }) ?? { x: s.offsetLeft + 300, y: s.offsetTop + s.height - 120 };
        const before = vpOf(s);
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel(-dx, -dy);
        panned = { x: panned.x + dx, y: panned.y + dy };
        return until(async () => { const v = vpOf(await scene()); return sameVp(v, before) ? null : v; }, 3000);
      };
      const pushedOpen = () => until(async () => { const x = await panelSettled(); return x && Math.abs(x.c.r - x.p.l) <= 2 ? x : null; }, 4000);
      const edge = g?.p.l ?? 0;

      // (b) a card wholly left of where the pushed canvas will end: opening moves nothing.
      await clearSelection();
      const fb0 = await openerFit();
      if (fb0) await wheelPan(Math.round(edge - 80 - fb0.card.r), 0);
      const fb = await openerFit();
      ok(`${T} fixture: a page card sits wholly left of where the pushed canvas will end`,
        !!fb && !!g && fb.card.l >= fb.canvas.l + 1 && fb.card.r <= edge - 40, JSON.stringify({ fb, edge }));
      const vB = vpOf(await scene());
      ok(`${T} ONE click on that card opens the panel`, (await openCard(opener)) === 1 && !!(await panelWaitPath(NOTES.ref)), String(await panelPath()));
      await pushedOpen();
      await page.waitForTimeout(250);
      const vB1 = vpOf(await scene());
      ok(`${T} a card already in view beside the panel: opening it leaves scrollX / scrollY / zoom exactly as they were`,
        sameVp(vB1, vB), `${JSON.stringify(vB)} → ${JSON.stringify(vB1)}`);
      ok(`${T} …and the card is still wholly in the canvas`, wholeIn(await openerFit()), JSON.stringify(await openerFit()));
      ok(`${T} (b) closed`, !!(await closePanel()));

      // (a) a card straddling where the pushed canvas will end: ONE click, and it is panned whole into view.
      await clearSelection();
      const fa0 = await openerFit();
      if (fa0) await wheelPan(Math.round(edge - (fa0.card.l + fa0.card.r) / 2), 0);
      const fa = await openerFit();
      ok(`${T} fixture: the card straddles where the pushed canvas will end (the panel's edge would cut it)`,
        !!fa && !!g && fa.card.l < edge - 20 && fa.card.r > edge + 20 && fa.card.l >= fa.canvas.l, JSON.stringify({ fa, edge }));
      const vA = vpOf(await scene());
      ok(`${T} ONE click on the straddling card opens the panel`, (await openCard(opener)) === 1 && !!(await panelWaitPath(NOTES.ref)), String(await panelPath()));
      const gA = await pushedOpen();
      const fitA = await until(async () => { const x = await openerFit(); return wholeIn(x) ? x : null; }, 3000) ?? await openerFit();
      ok(`${T} after the push, the card that opened the panel is wholly inside the canvas (DOM box inside the canvas box ±1px)`,
        !!gA && wholeIn(fitA), JSON.stringify({ fitA, panelL: gA?.p.l }));
      const vA1 = vpOf(await scene());
      ok(`${T} …by a pan alone: the zoom is unchanged`, vA1.zoom === vA.zoom && vA1.scrollX !== vA.scrollX, `${JSON.stringify(vA)} → ${JSON.stringify(vA1)}`);
      console.log(`info: ${T} the opener ends ${fitA ? Math.round(fitA.canvas.r - fitA.card.r) : '?'}px left of the pushed canvas's right edge`);
      ok(`${T} …and by the least pan: the card ends a small margin (12–40px) left of the canvas's right edge`,
        !!fitA && fitA.canvas.r - fitA.card.r >= 12 && fitA.canvas.r - fitA.card.r <= 40, JSON.stringify(fitA));
      await wshot(`w-panel-opener-visible-${theme}`);

      // (e) Expand, then Collapse: no pan.
      await page.locator('.wb-page-panel [aria-label="Expand"]').click().catch(() => {});
      const fullE = await until(async () => { const x = await panelGeo(); return x?.settled && Math.abs(x.p.l - x.body.l) <= 1 ? x : null; }, 4000);
      await page.locator('.wb-page-panel [aria-label="Collapse"]').click().catch(() => {});
      const sideE = await pushedOpen();
      await page.waitForTimeout(250);
      const vE = vpOf(await scene());
      ok(`${T} Expand then Collapse pan nothing: scroll and zoom exactly as the open left them`,
        !!fullE && !!sideE && sameVp(vE, vA1), `${JSON.stringify(vA1)} → ${JSON.stringify(vE)}`);

      // (c) close: the pre-open pan comes back exactly.
      ok(`${T} (c) the panel's × closes it`, !!(await closePanel()));
      const vC = vpOf(await scene());
      ok(`${T} closing (the viewport untouched while open) puts scroll and zoom back exactly as before the open`,
        sameVp(vC, vA), `${JSON.stringify(vA)} → ${JSON.stringify(vC)}`);

      // (d) the user pans while the panel is open: closing leaves the viewport where they took it.
      await clearSelection();
      const vD = vpOf(await scene());
      ok(`${T} ONE click opens the straddling card again`, (await openCard(opener)) === 1 && !!(await panelWaitPath(NOTES.ref)));
      await pushedOpen();
      await until(async () => wholeIn(await openerFit()), 3000);
      const vD1 = await wheelPan(0, -60);
      ok(`${T} fixture: the user's wheel pans the board while the panel is open`, !!vD1 && vD1.scrollY !== vD.scrollY, JSON.stringify(vD1));
      ok(`${T} (d) the panel's × closes it`, !!(await closePanel()));
      const vD2 = vpOf(await scene());
      ok(`${T} the user panned while the panel was open: closing leaves the viewport where they took it (no reset to the pre-open pan)`,
        sameVp(vD2, vD1) && !sameVp(vD2, vD), `pre-open ${JSON.stringify(vD)}, user ${JSON.stringify(vD1)}, after close ${JSON.stringify(vD2)}`);
      // (f) the user moves the board while reading A, then opens B from the board, then closes:
      // the close returns to the board the USER left before B, never to the pan from before A
      // (with a zoom, never an old scroll under the new zoom). Once with the wheel, once zooming.
      const openerB = pageCard(LAUNCH.title);
      for (const how of ['pans', 'zooms']) {
        await clearSelection();
        const vPreA = vpOf(await scene());
        ok(`${T} (f, ${how}) ONE click opens card A`, (await openCard(opener)) === 1 && !!(await panelWaitPath(NOTES.ref)));
        await pushedOpen();
        await until(async () => wholeIn(await openerFit()), 3000);
        const vOpen = vpOf(await scene());
        if (how === 'pans') await wheelPan(0, -60);
        else await page.locator('.excalidraw .zoom-in-button').click().catch(() => {});
        const vUser = await until(async () => { const v = vpOf(await scene()); return sameVp(v, vOpen) ? null : v; }, 3000);
        ok(`${T} (f, ${how}) fixture: the user ${how} the board while A is open`, !!vUser && (how === 'pans' || vUser.zoom !== vOpen.zoom), JSON.stringify({ vOpen, vUser }));
        const bBox = await openerB.locator('.wb-entity').first().boundingBox().catch(() => null);
        if (bBox) await page.mouse.click(bBox.x + bBox.width / 2, bBox.y + Math.min(bBox.height / 2, 30));
        ok(`${T} (f, ${how}) one click on card B, beside the open panel, opens B in it`, !!(await panelWaitPath(KPATH(LAUNCH.name))), String(await panelPath()));
        await pushedOpen();
        await page.waitForTimeout(250);
        ok(`${T} (f, ${how}) the panel's × closes it`, !!(await closePanel()));
        const vAfter = vpOf(await scene());
        ok(`${T} the user ${how === 'pans' ? 'panned' : 'zoomed'} while reading A, then opened B: closing returns to the board they left before B, not the pan from before A`,
          sameVp(vAfter, vUser) && !sameVp(vAfter, vPreA), `pre-A ${JSON.stringify(vPreA)}, user ${JSON.stringify(vUser)}, after close ${JSON.stringify(vAfter)}`);
        if (how === 'zooms') {
          await page.locator('.excalidraw .zoom-out-button').click().catch(() => {});
          await page.waitForTimeout(250);
        }
      }

      // The board back where block 1c found it, for the checks after it.
      await wheelPan(-panned.x, -panned.y);
      panned = { x: 0, y: 0 };

      // A task card, a dreamcontext://task link and a dreamcontext://knowledge link: all three
      // read in the panel.
      await clearSelection();
      ok(`${T} ONE click on the inactive task card opens the panel`, (await openCard(pageCard(TASK_NAME, 'task'))) === 1);
      ok(`${T} …on the task's file`, !!(await panelWaitPath(TPATH)), String(await panelPath()));
      await checkHeader(T, 'a task', TASK_NAME);
      const taskMenu = await openMenu();
      ok(`${T} ⋯ on a task: Open in Tasks first, then the three ways out`,
        JSON.stringify(taskMenu.map((i) => i.text)) === JSON.stringify(['Open in Tasks', ...MENU_OUT]), JSON.stringify(taskMenu));
      await page.keyboard.press('Escape');
      ok(`${T} …and the page is still the whiteboard`, /Whiteboard/.test(await activeRail()) && (await pathSearch()) === loc0.ps);
      await escPanel();
      await clearSelection();
      for (const [label, link, want, title] of [
        ['dreamcontext://task', `dreamcontext://task/${TASK_SLUG}`, TPATH, TASK_NAME],
        ['dreamcontext://knowledge', `dreamcontext://knowledge/${KNOWLEDGE.name}`, KPATH(KNOWLEDGE.name), KNOWLEDGE.title],
      ]) {
        const el = live(await scene()).find((e) => e.type === 'rectangle' && e.link === link);
        const linkClicked = el ? await openLink(el) : false;
        ok(`${T} fixture: the ${label} link's hyperlink can be clicked`, linkClicked);
        ok(`${T} a ${label} link opens its page in the side panel`, !!(await panelWaitPath(want)), String(await panelPath()));
        ok(`${T} …titled "${title}"`, !!(await until(async () => (await panelHead())?.title === title, 4000)), (await panelHead())?.title);
        ok(`${T} …without leaving the board`, /Whiteboard/.test(await activeRail()) && (await pathSearch()) === loc0.ps && mainNavs === loc0.navs
          && (await page.evaluate(() => location.hash)) === loc0.hash);
        await escPanel();
        await clearSelection();
      }

      // ── 5. the wiki card: S/M list → panel, L/XL list + in-card reader ──────────────────
      await openBoard(WIKI_CARDS.name);
      await until(async () => (await page.locator('.wb-widget[data-widget-kind="wiki"]').count()) === 5, 8000);
      await page.waitForTimeout(600);
      if (!(await wikiCardsInView())) {
        await focusCanvas();
        await page.keyboard.press('Shift+1');
        await page.waitForTimeout(400);
        for (let i = 0; i < 6 && !(await wikiCardsInView()); i += 1) {
          await page.locator('.excalidraw .zoom-out-button').click();
          await page.waitForTimeout(250);
        }
      }
      ok(`${T} fixture: all five wiki cards are on screen`, !!(await wikiCardsInView()), `zoom ${(await scene())?.zoom}`);

      // The row each size is clicked on: one an inactive card draws in full. An inactive S/M
      // card cannot scroll: it draws only WHOLE rows, never a heading without one of its rows,
      // and says how many rows it left out ("+N more"); activating it shows every row.
      for (const [size, title, ref] of [['s', 'Handbook S', LAUNCH.name], ['m', 'Handbook M', NOTES.ref]]) {
        const card = wikiCard(title);
        const S = size.toUpperCase();
        await clearSelection();
        ok(`${T} the ${S} wiki card is drawn at ${S}`, (await card.getAttribute('data-widget-size').catch(() => null)) === size);
        ok(`${T} …as a list (no in-card reader)`, (await card.locator('.wb-wiki[data-wiki-layout="list"]').count()) === 1
          && (await card.locator('.wb-wiki-reader').count()) === 0);
        const fit = await until(() => listFit(card), 4000);
        ok(`${T} inactive ${S}: no row, heading or "+N more" line is partly visible (each box wholly inside or wholly outside the list's visible box)`,
          !!fit && fit.partial.length === 0, JSON.stringify(fit?.partial ?? fit));
        ok(`${T} …no section heading is shown without one of its rows`, !!fit && fit.loneHeadings.length === 0, JSON.stringify(fit?.loneHeadings));
        const hidden = fit ? HB_ROWS.length - fit.shown.length : -1;
        ok(`${T} …the rows shown are the list's first ${fit?.shown.length}, with readable titles and type labels`,
          !!fit && fit.shown.length > 0 && JSON.stringify(fit.shown) === JSON.stringify(HB_ROWS.slice(0, fit.shown.length)), JSON.stringify(fit?.shown));
        ok(hidden > 0
          ? `${T} …and a "+N more" line, wholly visible, says the ${hidden} hidden row${hidden === 1 ? '' : 's'}`
          : `${T} …and with nothing hidden there is no "+N more" line`,
        !!fit && (hidden > 0
          ? fit.more.length === 1 && fit.more[0].inside && new RegExp(`(^|\\D)${hidden}(\\D|$)`).test(fit.more[0].text) && /more/i.test(fit.more[0].text)
          : fit.more.every((m) => !m.inside)),
        JSON.stringify({ hidden, more: fit?.more }));
        console.log(`info: ${T} the inactive ${S} card draws ${fit?.shown.length} of its ${HB_ROWS.length} page rows, then "${fit?.more[0]?.text ?? ''}"`);
        await cardShot(card, `w-wiki-card-${size}-${theme}`);
        ok(`${T} …the row clicked next is drawn in full`, !!fit?.shown.some((r) => r.ref === ref), JSON.stringify(fit?.shown.map((r) => r.ref)));
        await clickRow(card, ref);
        ok(`${T} ONE click on a page row of the inactive ${S} card opens the side panel on that page`,
          !!(await panelWaitPath(pathOfRef(ref), 3000)), String(await panelPath()));
        ok(`${T} …not inside the card`, (await card.locator('.wb-wiki-reader').count()) === 0);
        if (size === 'm') await wshot(`w-wiki-card-m-panel-${theme}`);
        await escPanel();
        await clearSelection();
        // Active: the clip is lifted, every section and row is there, and the last row is
        // reached by scrolling the list with the wheel; one click on it opens the panel.
        ok(`${T} fixture: the ${S} card is inactive again`, !!(await until(async () => !(await card.evaluate((el) => el.classList.contains('is-active')).catch(() => true)), 3000)));
        const again = await until(async () => { const f = await listFit(card); return f && f.partial.length === 0 && f.shown.length === fit?.shown.length ? f : null; }, 3000);
        ok(`${T} …and draws the same whole rows and "+N more" again`, !!again && JSON.stringify(again.more.map((m) => m.text)) === JSON.stringify(fit?.more.map((m) => m.text)),
          JSON.stringify(again ?? await listFit(card)));
        const head = await card.locator('.wb-widget-head').boundingBox().catch(() => null);
        if (head) await page.mouse.click(head.x + head.width * 0.3, head.y + head.height / 2);
        const activeAll = await until(async () => (await card.evaluate((el) => el.classList.contains('is-active')).catch(() => false))
          && JSON.stringify(await rowsOf(card)) === JSON.stringify(HB_ROWS), 3000);
        ok(`${T} one click on the ${S} card's header activates it and lifts the clip: every page row is there`, !!activeAll, JSON.stringify(await rowsOf(card)));
        ok(`${T} …under every section`, JSON.stringify(await sectionTitlesOf(card)) === JSON.stringify(['Getting started', 'Reference']),
          JSON.stringify(await sectionTitlesOf(card)));
        ok(`${T} …and no "+N more" line is left`, (await card.locator('button.wb-wiki-more').count()) === 0);
        const lastRef = HB_ROWS[HB_ROWS.length - 1].ref;
        const listBox = await card.locator('.wb-wiki-list').boundingBox().catch(() => null);
        if (listBox) {
          await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
          for (let i = 0; i < 6 && !(await rowInside(card, lastRef)); i += 1) {
            await page.mouse.wheel(0, 120);
            await page.waitForTimeout(150);
          }
        }
        const reached = await until(() => rowInside(card, lastRef), 2000);
        ok(`${T} …the last row is reached by scrolling the list with the wheel, and is then wholly visible`, !!reached,
          JSON.stringify(await card.locator('.wb-wiki-list').evaluate((n) => ({ scrollTop: n.scrollTop, scrollH: n.scrollHeight, clientH: n.clientHeight, overflowY: getComputedStyle(n).overflowY })).catch(() => null)));
        await clickRow(card, lastRef);
        ok(`${T} …and ONE click on it opens the side panel on that page`, !!(await panelWaitPath(pathOfRef(lastRef), 3000)), String(await panelPath()));
        await escPanel();
        await clearSelection();
      }
      // Two wiki cards on one board keep separate lists.
      ok(`${T} the second wiki card ("Team wiki") shows its own list, not the handbook's`,
        JSON.stringify(await rowsOf(wikiCard('Team wiki'))) === JSON.stringify([{ ref: KNOWLEDGE.name, title: KNOWLEDGE.title, type: 'Knowledge' }]),
        JSON.stringify(await rowsOf(wikiCard('Team wiki'))));

      for (const [size, title, ref] of [['l', 'Handbook L', NOTES.ref], ['xl', 'Handbook XL', HTML_REF]]) {
        const card = wikiCard(title);
        const S = size.toUpperCase();
        await clearSelection();
        ok(`${T} the ${S} wiki card lays out as list + reader`, (await card.locator('.wb-wiki[data-wiki-layout="split"]').count()) === 1);
        const lr = await page.evaluate((t) => {
          const cardEl = [...document.querySelectorAll('.wb-widget[data-widget-kind="wiki"]')]
            .find((el) => (el.querySelector('.wb-widget-title')?.textContent ?? '').trim() === t);
          const list = cardEl?.querySelector('.wb-wiki-split > .wb-wiki-list')?.getBoundingClientRect();
          const reader = cardEl?.querySelector('.wb-wiki-reader')?.getBoundingClientRect();
          return list && reader ? { listR: Math.round(list.right), readerL: Math.round(reader.left), listW: Math.round(list.width), readerW: Math.round(reader.width) } : null;
        }, title);
        ok(`${T} …the list on the left, the reader on the right`, !!lr && lr.listR <= lr.readerL + 1 && lr.readerW > lr.listW, JSON.stringify(lr));
        ok(`${T} …opening on its first page`, !!(await until(async () => (await readerPath(card)) === KPATH(LAUNCH.name), 4000)), String(await readerPath(card)));
        await clickRow(card, ref);
        ok(`${T} ONE click on a page row of the inactive ${S} card reads it INSIDE the card`,
          !!(await until(async () => (await readerPath(card)) === pathOfRef(ref), 4000)), String(await readerPath(card)));
        const inCard = card.locator('.wb-wiki-reader .doc-reader.doc-reader--page');
        const inCardBox = await inCard.boundingBox().catch(() => null);
        const cardBox = await card.boundingBox().catch(() => null);
        ok(`${T} …with DocumentReader's page variant, drawn inside the card element`, (await inCard.count()) === 1 && !!inCardBox && !!cardBox
          && inCardBox.width > 80 && inCardBox.height > 80 && inCardBox.x >= cardBox.x - 1 && inCardBox.x + inCardBox.width <= cardBox.x + cardBox.width + 1,
          JSON.stringify({ inCardBox, cardBox }));
        ok(`${T} …and the side panel stays closed`, !(await panelOpen()));
        const cur = await card.locator('.wb-wiki-row.is-current .wb-wiki-row-open').evaluateAll((els) => els.map((e) => e.getAttribute('data-page-ref')));
        ok(`${T} …exactly one row is highlighted: the one read`, JSON.stringify(cur) === JSON.stringify([ref]), JSON.stringify(cur));
        const texts = await listTexts(card);
        const counts = texts && ['heading', 'row', 'reader'].map((k) => texts.filter((x) => x.kind === k).length);
        ok(`${T} fixture: the ${S} card's 2 headings, 4 row titles and its reader title are all read`, JSON.stringify(counts) === JSON.stringify([2, 4, 1]), JSON.stringify(counts));
        const cut = (texts ?? []).filter((x) => x.overflows && !x.ellipsis);
        ok(`${T} …no heading, row or reader title is cut mid-letter: any text wider than its box ends in a real ellipsis`,
          !!texts && cut.length === 0, JSON.stringify(cut));
        const untitled = (texts ?? []).filter((x) => x.title !== x.text || !x.text);
        ok(`${T} …and each carries its full text in its title attribute`, !!texts && untitled.length === 0, JSON.stringify(untitled));
        ok(`${T} …the row titles in full are the pages' titles`,
          JSON.stringify((texts ?? []).filter((x) => x.kind === 'row').map((x) => x.title)) === JSON.stringify(HB_ROWS.map((r) => r.title)),
          JSON.stringify((texts ?? []).filter((x) => x.kind === 'row').map((x) => x.title)));
        console.log(`info: ${T} the ${S} card ellipsizes ${(texts ?? []).filter((x) => x.overflows).map((x) => `"${x.text}"`).join(', ') || 'nothing'}`);
        if (ref === HTML_REF) {
          const cardFrame = card.locator('.wb-wiki-reader iframe.doc-reader-html-frame');
          const sb = await cardFrame.getAttribute('sandbox', { timeout: 4000 }).catch(() => null);
          ok(`${T} …the HTML page in the card is in the same strict sandbox`, /\ballow-scripts\b/.test(sb ?? '') && !/allow-same-origin/.test(sb ?? ''), String(sb));
        } else {
          await card.locator('.wb-wiki-reader .md-preview h1').first().waitFor({ timeout: 4000 }).catch(() => {});
          ok(`${T} …formatted`, (await card.locator('.wb-wiki-reader .md-preview h1').first().innerText().catch(() => '')).trim() === NOTES.title);
        }
        await page.waitForTimeout(300);
        await cardShot(card, `w-wiki-card-${size}-${theme}`);
        const cardBack = card.locator('.wb-wiki-reader-head [aria-label="Back"]');
        const cardFwd = card.locator('.wb-wiki-reader-head [aria-label="Forward"]');
        await cardBack.click().catch(() => {});
        ok(`${T} the card's own Back returns to the first page`, !!(await until(async () => (await readerPath(card)) === KPATH(LAUNCH.name), 4000)), String(await readerPath(card)));
        const cur2 = await card.locator('.wb-wiki-row.is-current .wb-wiki-row-open').evaluateAll((els) => els.map((e) => e.getAttribute('data-page-ref')));
        ok(`${T} …and the one highlight follows it`, JSON.stringify(cur2) === JSON.stringify([LAUNCH.name]), JSON.stringify(cur2));
        await cardFwd.click().catch(() => {});
        ok(`${T} the card's Forward goes to the page again`, !!(await until(async () => (await readerPath(card)) === pathOfRef(ref), 4000)), String(await readerPath(card)));
        await cardBack.click().catch(() => {});
        await until(async () => (await readerPath(card)) === KPATH(LAUNCH.name), 4000);
        const look2 = await until(() => page.evaluate((t) => {
          const cardEl = [...document.querySelectorAll('.wb-widget[data-widget-kind="wiki"]')]
            .find((el) => (el.querySelector('.wb-widget-title')?.textContent ?? '').trim() === t);
          const p = [...(cardEl?.querySelectorAll('.wb-wiki-reader .md-preview p') ?? [])].find((x) => /walks the whole path/.test(x.textContent ?? ''));
          const md = cardEl?.querySelector('.wb-wiki-reader .md-preview');
          if (!p || !md) return null;
          const cs = getComputedStyle(md);
          return { font: parseFloat(getComputedStyle(p).fontSize), mdBorder: parseFloat(cs.borderTopWidth) * (cs.borderTopStyle === 'none' ? 0 : 1), mdBg: cs.backgroundColor };
        }, title), 4000);
        ok(`${T} the card reads the same page typography as the panel (≥15px, no frame, no card background)`,
          !!look2 && look2.font >= 15 && look2.mdBorder === 0 && TRANSPARENT.test(look2.mdBg), JSON.stringify(look2));
        await card.locator(`.wb-wiki-reader [data-wikilink="${KNOWLEDGE.name}"]`).first().click().catch(() => {});
        ok(`${T} a wikilink in the card navigates WITHIN the card`, !!(await until(async () => (await readerPath(card)) === KPATH(KNOWLEDGE.name), 4000)), String(await readerPath(card)));
        ok(`${T} …(the side panel stays closed)`, !(await panelOpen()));
        await clearSelection();
      }

      // ── 6. in-card editing, written to the board FILE ────────────────────────────────────
      const L = wikiCard('Handbook L');
      await clearSelection();
      const lHead = await L.locator('.wb-widget-head').boundingBox().catch(() => null);
      if (lHead) await page.mouse.click(lHead.x + lHead.width * 0.3, lHead.y + lHead.height / 2);
      const editBtn = L.locator('.wb-widget-actions .wb-widget-btn', { hasText: /^Edit$/ });
      await editBtn.waitFor({ timeout: 3000 }).catch(() => {});
      await editBtn.click().catch(() => {});
      ok(`${T} one click on the L card's header, then Edit, puts the card in edit mode`,
        !!(await until(async () => (await L.locator('.wb-wiki--editing').count()) === 1, 3000)));
      const fileSig = () => listSig(wikiOnDisk(HB.l));
      const expectFile = async (want, label) => {
        const got = await until(() => fileSig() === JSON.stringify(want), 8000);
        ok(`${T} ${label} — in the board FILE`, !!got, `want ${JSON.stringify(want)}, file ${fileSig()}`);
        return !!got;
      };
      const screenRows = () => L.locator('.wb-wiki-section').evaluateAll((secs) => secs.map((sec) => [
        (sec.querySelector('.wb-wiki-section-name, .wb-wiki-section-title')?.textContent ?? '').trim(),
        [...sec.querySelectorAll('.wb-wiki-row-open')].map((b) => b.getAttribute('data-page-ref')),
      ]));
      const rowBtn = (ref) => L.locator(`.wb-wiki-row-open[data-page-ref="${ref}"]`).first();
      const press = async (ref, key) => { await rowBtn(ref).focus().catch(() => {}); await page.keyboard.press(key); };
      const GS = 'Getting started';
      const REF = 'Reference';
      // Keyboard, within a section.
      await press(LAUNCH.name, 'Alt+ArrowDown');
      await expectFile([[GS, [NOTES.ref, LAUNCH.name]], [REF, [PDF_REF, HTML_REF]]], 'Alt+Down moves a page down its section');
      ok(`${T} …and on screen`, JSON.stringify(await screenRows()) === JSON.stringify([[GS, [NOTES.ref, LAUNCH.name]], [REF, [PDF_REF, HTML_REF]]]), JSON.stringify(await screenRows()));
      await press(LAUNCH.name, 'Alt+ArrowUp');
      await expectFile(HB_INIT, 'Alt+Up moves it back');
      // Keyboard, across a section boundary.
      await press(NOTES.ref, 'Alt+ArrowDown');
      await expectFile([[GS, [LAUNCH.name]], [REF, [NOTES.ref, PDF_REF, HTML_REF]]], 'Alt+Down on a section\'s last page moves it into the next section');
      await press(NOTES.ref, 'Alt+ArrowUp');
      await expectFile(HB_INIT, 'Alt+Up brings it back');
      // Drag and drop, within a section and across sections.
      const rowLi = (ref) => L.locator('.wb-wiki-row', { has: page.locator(`[data-page-ref="${ref}"]`) }).first();
      const dnd = async (fromRef, toRef, half) => {
        const to = rowLi(toRef);
        const box = await to.boundingBox().catch(() => null);
        if (!box) return;
        await rowLi(fromRef).dragTo(to, { targetPosition: { x: 20, y: half === 'top' ? 2 : Math.max(1, box.height - 2) } }).catch(() => {});
      };
      await dnd(HTML_REF, PDF_REF, 'top');
      await expectFile([[GS, [LAUNCH.name, NOTES.ref]], [REF, [HTML_REF, PDF_REF]]], 'drag and drop reorders pages in a section');
      ok(`${T} …and on screen`, JSON.stringify(await screenRows()) === JSON.stringify([[GS, [LAUNCH.name, NOTES.ref]], [REF, [HTML_REF, PDF_REF]]]), JSON.stringify(await screenRows()));
      await dnd(PDF_REF, HTML_REF, 'top');
      await expectFile(HB_INIT, 'drag and drop puts it back');
      await dnd(PDF_REF, NOTES.ref, 'bottom');
      await expectFile([[GS, [LAUNCH.name, NOTES.ref, PDF_REF]], [REF, [HTML_REF]]], 'drag and drop moves a page into another section');
      await dnd(PDF_REF, HTML_REF, 'top');
      await expectFile(HB_INIT, 'drag and drop moves it back');
      // Add a section, rename it, add a page through the picker, remove it, delete the section.
      await L.locator('.wb-wiki-list-foot .wb-widget-btn', { hasText: 'Add section' }).click().catch(() => {});
      const renameField = L.locator('input.wb-wiki-rename');
      await renameField.waitFor({ timeout: 3000 }).catch(() => {});
      await renameField.fill('Drafts').catch(() => {});
      await renameField.press('Enter').catch(() => {});
      await expectFile([...HB_INIT, ['Drafts', []]], 'Add section adds a titled section');
      await L.locator('.wb-wiki-section-name', { hasText: /^Drafts$/ }).click().catch(() => {});
      await renameField.waitFor({ timeout: 3000 }).catch(() => {});
      await renameField.fill('Drafts renamed').catch(() => {});
      await renameField.press('Enter').catch(() => {});
      await expectFile([...HB_INIT, ['Drafts renamed', []]], 'clicking a section\'s title renames it');
      const drafts = L.locator('.wb-wiki-section', { has: page.locator('.wb-wiki-section-name', { hasText: /^Drafts renamed$/ }) }).first();
      await drafts.locator('[aria-label="Add page to this section"]').click().catch(() => {});
      const wikiPicker = L.locator('.wb-wiki-picker');
      await wikiPicker.locator('.wb-picker-search').fill('launch').catch(() => {});
      const pickRow = wikiPicker.locator(`.wb-picker-row[data-page-ref="${PICK_FILES.MD}"]`);
      await pickRow.waitFor({ timeout: 5000 }).catch(() => {});
      await pickRow.click().catch(() => {});
      await expectFile([...HB_INIT, ['Drafts renamed', [PICK_FILES.MD]]], 'the page picker adds a page to the section');
      await page.waitForTimeout(300);
      await cardShot(L, `w-wiki-card-edit-${theme}`);
      await drafts.locator('.wb-wiki-row-remove').first().click().catch(() => {});
      await expectFile([...HB_INIT, ['Drafts renamed', []]], 'a page\'s × removes it from the card');
      await drafts.locator('[aria-label="Delete section"]').click().catch(() => {});
      const confirmBox = L.locator('.wb-wiki-confirm');
      ok(`${T} Delete section asks inline first`, !!(await until(async () => /Delete “Drafts renamed”\?/.test(await confirmBox.innerText().catch(() => '')), 3000)),
        await confirmBox.innerText().catch(() => '(no confirm)'));
      ok(`${T} …and nothing is deleted yet`, fileSig() === JSON.stringify([...HB_INIT, ['Drafts renamed', []]]), fileSig());
      await confirmBox.locator('button', { hasText: /^Delete$/ }).click().catch(() => {});
      await expectFile(HB_INIT, 'confirming deletes the section');
      await L.locator('.wb-widget-actions .wb-widget-btn', { hasText: /^Done$/ }).click().catch(() => {});
      ok(`${T} Done leaves edit mode`, !!(await until(async () => (await L.locator('.wb-wiki--editing').count()) === 0, 3000)));
      ok(`${T} the other wiki cards' lists are untouched in the file`,
        [HB.xl, HB.m, HB.s].every((id) => listSig(wikiOnDisk(id)) === JSON.stringify(HB_INIT)) && listSig(wikiOnDisk(TEAM)) === JSON.stringify(TEAM_INIT),
        [HB.xl, HB.m, HB.s, TEAM].map((id) => listSig(wikiOnDisk(id))).join(' / '));
      const shownL = dcTry(['whiteboard', 'show', WC, '--json']);
      ok(`${T} \`whiteboard show --json\` reports the L card's list as the file holds it`, (() => {
        try {
          const card = (JSON.parse(shownL.out).wikis ?? []).find((c) => c.id === HB.l);
          return listSig((card?.sections ?? []).map((sec) => ({ title: sec.title, refs: sec.pages.map((p) => p.ref) }))) === fileSig();
        } catch { return false; }
      })(), shownL.out.slice(0, 160));
      await clearSelection();
      await openBoard(WIKI_BOARD.name);
    }

    // ── W-picker: the palette's page picker searches knowledge AND project files, shows each
    // row's type and a readable title over its path, and a picked file lands as a page widget
    // whose ref is its path. Once, not per theme: the search and the pick do not depend on the
    // theme (both themes' card labels are checked above).
    await clearSelection();
    const pickAt = await spot(roomFor('knowledge'));
    const embedsBefore = live(await scene()).filter((e) => e.type === 'embeddable').length;
    await page.mouse.click(pickAt.x, pickAt.y, { button: 'right' });
    await page.locator('.wb-palette .wb-palette-item', { hasText: 'Knowledge or file' }).first().click();
    const search = page.locator('.wb-picker-search');
    await search.fill('launch');
    const prow = (ref) => page.locator(`.wb-picker-row[data-page-ref="${ref}"]`);
    const chipOf = (ref) => prow(ref).locator('.wb-picker-type').innerText().catch(() => '');
    const titleOfRow = async (ref) => (await prow(ref).locator('.wb-picker-row-title').innerText().catch(() => '')).replace(await chipOf(ref), '').trim();
    // The ready signal: the rows of THIS query (the list keeps the previous result while the
    // new one loads, so "every expected row is there" alone can still be the unfiltered list).
    const listed = await until(async () => {
      for (const ref of [...Object.values(PICK_FILES), LAUNCH.name]) if (!(await prow(ref).count())) return false;
      const refs = await page.locator('.wb-picker-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-page-ref')));
      return refs.every((r) => /launch/i.test(r));
    }, 8000);
    const rowRefs = await page.locator('.wb-picker-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-page-ref')));
    ok('W-picker the page picker lists project files of every type AND the knowledge page for "launch"', !!listed, JSON.stringify(rowRefs));
    for (const [type, ref] of Object.entries(PICK_FILES)) {
      ok(`W-picker …the project ${type} file ${ref} wears the ${type} chip`, (await chipOf(ref)).trim() === type, `"${await chipOf(ref)}"`);
      ok(`W-picker …a readable title ("${PICK_TITLES[type]}")`, (await titleOfRow(ref)) === PICK_TITLES[type], `"${await titleOfRow(ref)}"`);
      ok('W-picker …and its path underneath', (await prow(ref).locator('.wb-picker-row-meta').innerText().catch(() => '')).trim() === ref);
    }
    ok('W-picker …the knowledge entry wears "Knowledge", titled, with its slug', (await chipOf(LAUNCH.name)).trim() === 'Knowledge'
      && (await titleOfRow(LAUNCH.name)) === LAUNCH.title
      && (await prow(LAUNCH.name).locator('.wb-picker-row-meta').innerText().catch(() => '')).trim() === LAUNCH.name,
      `"${await chipOf(LAUNCH.name)}" "${await titleOfRow(LAUNCH.name)}"`);
    ok('W-picker …and nothing from outside the query', rowRefs.every((r) => /launch/i.test(r)), JSON.stringify(rowRefs));
    await wshot('w-picker');
    await prow(PICK_FILES.PDF).click().catch(() => {});
    const pickedLive = await until(async () => {
      const el = live(await scene()).find((e) => e.type === 'embeddable' && e.kind === 'knowledge' && e.ref === PICK_FILES.PDF);
      return el && live(await scene()).filter((e) => e.type === 'embeddable').length === embedsBefore + 1 && el;
    }, 5000);
    ok('W-picker picking the PDF row adds ONE page widget whose ref is the project path, in the live scene', !!pickedLive,
      JSON.stringify(live(await scene()).filter((e) => e.type === 'embeddable').map((e) => [e.kind, e.ref])));
    const pickedDisk = await until(() => onDisk(W).find((e) => e.kind === 'knowledge' && e.ref === PICK_FILES.PDF), 8000);
    ok('W-picker …and on disk (dc.ref = the project-relative path)', !!pickedDisk,
      JSON.stringify(onDisk(W).filter((e) => e.kind === 'knowledge').map((e) => e.ref)));
    await clearSelection();
    const pickedCard = pageCard(PICK_TITLES.PDF);
    ok('W-picker …and its card\'s header label says PDF', (await pickedCard.locator('.wb-widget-kind').innerText().catch(() => '')).trim() === 'PDF');
    ok('W-picker …and ONE click opens that PDF in the side panel', (await openCard(pickedCard)) === 1 && !!(await panelWaitPath(PICK_FILES.PDF)), String(await panelPath()));
    await escPanel();

    watchWiki = false;
    ok('W no console errors or page errors during the popup / wiki checks', wikiErrors.length === 0, wikiErrors.slice(0, 4).join(' | '));
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'light'));

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
