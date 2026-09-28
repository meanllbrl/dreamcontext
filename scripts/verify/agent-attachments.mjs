#!/usr/bin/env node
/**
 * verify:agent-attachments — an agent that MAKES things can hand them over in its thread.
 *
 * The owner's criterion (2026-09-24): an agent that drew a diagram, produced a PDF and
 * rendered a clip can push all of it to its thread, and every piece works — the board
 * draws, the picture shows, the clip plays, the PDF opens full window.
 *
 * Driven against the REAL server, the REAL runner and a real Chromium. The run is started
 * the way the owner starts one — an @mention through `/api/automations/threads/say` — on a
 * server launched with a FINDER-SHAPED PATH (`/usr/bin:/bin`). That is the environment
 * the desktop app hands its server, and it is where the first real ask failed: the agent
 * ran `dreamcontext automations post`, got "command not found", and the thread stayed
 * empty. The stand-in agent below calls `dreamcontext` BY NAME, so a green run here is
 * proof that `cliAwarePath` put the CLI on the run's PATH, not that a test harness did.
 *
 * The fixtures are REAL files made at seed time: a board from the excalidraw pack's own
 * builder, a PDF from `cupsfilter`, a clip and a picture from `ffmpeg`. Synthetic content
 * (a fictional funnel), per `synthetic-fixtures-for-published-artifacts`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, rect, scratchDir, setTheme, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const BOARD_BUILDER = join(REPO, 'skill-packs', 'excalidraw', 'scripts', 'build_excalidraw.js');

const SCRATCH = scratchDir('dc-ui-agent-attachments');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const OUT_DIR = join(CONTEXT_ROOT, 'automations', 'output', 'maker');
const SHOTS = shotsDir(REPO, 'agent-attachments');

/** What a Finder-launched app gives its children. The whole point of this script. */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ASK = 'make me the signup pack: a diagram, the report as a PDF, a short walkthrough clip';
const POST = 'Here is the signup pack: the funnel diagram, the chart, a 3s walkthrough and the full report.';
/** The SCHEDULED post with four visuals (A4) and the one with a clip, a recording and a long
 *  PDF name (A2, A9, A11). Posted by real scheduled runs through `automations post`. */
const PACK_POST = 'Weekly visuals: the funnel, the chart, the landscape walkthrough and the portrait reel.';
const DOCS_POST = 'The voice note and the long-form report for the pricing review.';
/** 86 characters, the length the audit measured losing its distinguishing end. */
const LONG_PDF = 'quarterly_signup_funnel_analysis_for_the_pricing_rollback_review_final_draft_v3_2026.pdf';

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function cli(args) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function must(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`${what} failed (${cmd}): ${r.stderr || r.stdout}`);
  return r;
}

/**
 * The stand-in `claude`. It calls `dreamcontext` BY NAME — resolved through the PATH the
 * runner gave it — and records the outcome in its own document, so a failure shows up in
 * the thread exactly the way the real one did.
 */
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const slug = process.env.DREAMCONTEXT_AUTOMATION_SLUG || '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const dir = 'automations/output/maker/';
const plan = slug === 'pack'
  ? [${JSON.stringify(PACK_POST)}, ['funnel.excalidraw.md', 'chart.png', 'walkthrough.mp4', 'portrait.mp4']]
  : slug === 'docs'
    ? [${JSON.stringify(DOCS_POST)}, ['note.m4a', ${JSON.stringify(LONG_PDF)}, 'logo.svg']]
    : [${JSON.stringify(POST)}, ['funnel.excalidraw.md', 'chart.png', 'walkthrough.mp4', 'report.pdf']];
const r = spawnSync('dreamcontext', ['automations', 'post', slug, plan[0],
  ...plan[1].flatMap((f) => ['--file', dir + f])], { encoding: 'utf-8' });
const posted = r.status === 0 ? 'posted' : 'POST FAILED: ' + (r.error ? r.error.message : (r.stderr || r.stdout));
out({ session_id: 'standin-' + slug, is_error: false,
  result: 'Signups fell 12% after the pricing change; the trial step is the drop.\\n\\n## Funnel\\n\\n'
    + '| Step | Users |\\n|---|---|\\n| Landing | 4,820 |\\n| Trial | 3,326 |\\n| Paid | 612 |\\n\\n'
    + '## Recommendation\\n\\nRevert the pricing page for one week and re-measure.\\n\\n<!-- ' + posted + ' -->\\n',
  total_cost_usd: 0.12, num_turns: 3, duration_ms: 21000, permission_denials: [] });
`;

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'state'), { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  cli(['vaults', 'add', 'proj', PROJ]);

  // ── the four real files ──
  const spec = join(SCRATCH, 'funnel.spec.json');
  writeFileSync(spec, JSON.stringify({
    out: join(OUT_DIR, 'funnel.excalidraw.md'),
    background: '#ffffff',
    elements: [
      { type: 'text', x: 0, y: -60, text: 'Weekly signups: where the drop happens', fontSize: 26, color: '#1e1e1e' },
      { type: 'rectangle', x: 0, y: 0, width: 200, height: 100, strokeColor: '#1971c2', backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2, roundness: true },
      { type: 'text', x: 30, y: 36, text: 'Landing\n4,820', fontSize: 20, color: '#1e1e1e' },
      { type: 'arrow', x: 210, y: 50, points: [[0, 0], [110, 0]], strokeColor: '#1e1e1e', strokeWidth: 2 },
      { type: 'rectangle', x: 330, y: 0, width: 200, height: 100, strokeColor: '#f08c00', backgroundColor: '#ffec99', fillStyle: 'solid', strokeWidth: 2, roundness: true },
      { type: 'text', x: 360, y: 36, text: 'Trial step\n-31%', fontSize: 20, color: '#1e1e1e' },
      { type: 'arrow', x: 540, y: 50, points: [[0, 0], [110, 0]], strokeColor: '#1e1e1e', strokeWidth: 2 },
      { type: 'rectangle', x: 660, y: 0, width: 200, height: 100, strokeColor: '#2f9e44', backgroundColor: '#b2f2bb', fillStyle: 'solid', strokeWidth: 2, roundness: true },
      { type: 'text', x: 690, y: 36, text: 'Paid\n612', fontSize: 20, color: '#1e1e1e' },
    ],
  }));
  must(process.execPath, [BOARD_BUILDER, spec], 'board builder');
  const txt = join(SCRATCH, 'report.txt');
  writeFileSync(txt, 'Weekly signups report\n\nSignups fell 12% after the pricing change.\nThe trial step is where they drop: -31%.\n');
  // Binary on stdout, so read as a Buffer (no `encoding`) to keep the bytes intact.
  const pdf = spawnSync('cupsfilter', [txt]);
  if (pdf.status !== 0) throw new Error('cupsfilter failed');
  writeFileSync(join(OUT_DIR, 'report.pdf'), pdf.stdout);
  must('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=24',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT_DIR, 'walkthrough.mp4')], 'ffmpeg clip');
  must('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=800x450',
    '-frames:v', '1', join(OUT_DIR, 'chart.png')], 'ffmpeg picture');

  // A portrait reel (A2), a 3s recording (A9) and a PDF whose 86-char name ends in what tells
  // it apart (A11).
  must('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=360x640:rate=24',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT_DIR, 'portrait.mp4')], 'ffmpeg portrait clip');
  must('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:a', 'aac', join(OUT_DIR, 'note.m4a')], 'ffmpeg recording');
  writeFileSync(join(OUT_DIR, LONG_PDF), readFileSync(join(OUT_DIR, 'report.pdf')));
  // Round 2 (R2-3): an SVG an agent posted, carrying a script that must never run.
  writeFileSync(join(OUT_DIR, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80">'
    + '<rect width="160" height="80" fill="#6647f0"/><script>window.parent.__svgRan = 1; window.__svgRan = 1;</script></svg>');

  cli(['automations', 'create', 'maker', '--title', 'Report maker', '--mode', 'call']);
  cli(['automations', 'approve', 'maker', '--yes']);
  cli(['automations', 'create', 'pack', '--title', 'Pack builder', '--days', 'daily', '--at', '07:00']);
  cli(['automations', 'approve', 'pack', '--yes']);
  cli(['automations', 'create', 'docs', '--title', 'Docs clerk', '--days', 'daily', '--at', '08:00']);
  cli(['automations', 'approve', 'docs', '--yes']);
}

/** A SCHEDULED run, for real, through the CLI runner — Finder PATH plus the stand-in. */
function runAgent(slug) {
  const r = spawnSync(process.execPath, [DIST_INDEX, 'automations', 'run', slug, '--force'], {
    cwd: PROJ, env: { ...process.env, HOME, PATH: [join(HOME, '.local', 'bin'), FINDER_PATH, dirname(process.execPath)].join(':') }, encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`run ${slug} failed: ${r.stderr || r.stdout}`);
}

/** `desktop: false` is the server a browser tab on another machine talks to (A10). */
async function startServer(port, { desktop = true } = {}) {
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH: FINDER_PATH, DREAMCONTEXT_DESKTOP: desktop ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

function threadEntries(slug) {
  const dir = join(CONTEXT_ROOT, 'automations', 'threads', slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const raw = readFileSync(join(dir, f), 'utf-8');
    return [...raw.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function main() {
  if (!existsSync(DIST_INDEX)) throw new Error('dist/index.js missing — run `npm run build` first');
  seed();
  runAgent('pack');
  runAgent('docs');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    // The desktop BRANCH (a board draws rather than degrading) is decided client-side.
    await ctx.addInitScript(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await page.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();

    // ── 1: the ask, from a Finder-shaped environment ──
    console.log('\n═══ 1. An ask started from the app can post ═══');
    const said = await page.evaluate(async (text) => {
      const r = await fetch('/api/automations/threads/say?vault=proj', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Dreamcontext-Vault': 'proj' },
        body: JSON.stringify({ slug: 'maker', text }),
      });
      return { status: r.status, body: await r.text() };
    }, ASK);
    check('the channel accepts the ask', said.status === 200 || said.status === 202, JSON.stringify(said));
    const posted = await until(() => threadEntries('maker').some((e) => e.kind === 'agent'), 30000);
    const post = threadEntries('maker').find((e) => e.kind === 'agent');
    check('the run POSTED — `dreamcontext` resolved on a Finder PATH', posted,
      readdirSync(OUT_DIR).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(OUT_DIR, f), 'utf-8').match(/<!-- (.*) -->/)?.[1]).join(' | '));
    check('…carrying all four files', post?.files?.length === 4, JSON.stringify(post?.files));

    // ── 2: the ask row ──
    console.log('\n═══ 2. The ask, in the channel ═══');
    const you = page.locator('.agent-msg--you').first();
    check('your message is the row', await until(async () => (await you.count()) > 0, 20000));
    check('…its preview carries the answer\'s opening',
      await until(async () => (await you.locator('.agent-reply-preview-text').innerText()).includes('signup pack'), 20000));
    const files = await you.locator('.agent-reply-preview-files').innerText().catch(() => '');
    check('…and names what came back, by kind', ['funnel', 'chart.png', 'walkthrough.mp4', 'report.pdf'].every((n) => files.includes(n)), files);
    await page.screenshot({ path: join(SHOTS, '1-ask-row.png') });

    // ── 3: the thread draws every file as what it is ──
    console.log('\n═══ 3. The thread ═══');
    await you.locator('.agent-thread-bar').click();
    const panel = page.locator('.agent-thread');
    check('the thread opens', await until(async () => (await panel.count()) === 1, 8000));
    const postRow = panel.locator('.agent-thread-post--agent:not(.agent-thread-answer)').first();
    check('the post is there', await until(async () => (await postRow.count()) === 1, 10000));

    const board = postRow.locator('.chat-board');
    check('the BOARD is a live canvas, not "couldn\'t be read"',
      await until(async () => (await board.count()) === 1
        && (await board.locator('.chat-board-note').count()) === 0
        && (await board.locator('canvas, svg').count()) > 0, 20000),
      await board.innerText().catch(() => '(none)'));

    const img = postRow.locator('.agent-msg-img img');
    check('the PICTURE loads', await until(async () => img.evaluate((el) => el.complete && el.naturalWidth === 800), 10000));

    const video = postRow.locator('.agent-msg-video video');
    const vid = await until(async () => video.evaluate((el) => el.readyState >= 1 && Math.round(el.duration) === 3), 15000);
    check('the CLIP loads with its real duration (range-streamed from the vault)', vid,
      JSON.stringify(await video.evaluate((el) => ({ rs: el.readyState, d: el.duration, err: el.error?.code })).catch(() => null)));

    const pdfCard = postRow.locator('.agent-msg-file--pdf');
    check('the PDF is a card that says what it is', (await pdfCard.innerText()).includes('report.pdf') && (await pdfCard.innerText()).includes('PDF'));

    const answer = panel.locator('.agent-thread-answer .chat-msg-assistant-body');
    check('the run\'s whole document follows, in the chat\'s answer card',
      await until(async () => (await answer.locator('table').count()) === 1, 10000));
    await page.waitForTimeout(800);
    await panel.screenshot({ path: join(SHOTS, '2-thread.png') });
    await video.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await panel.screenshot({ path: join(SHOTS, '2b-thread-media.png') });
    await answer.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await panel.screenshot({ path: join(SHOTS, '2c-thread-answer.png') });
    await page.screenshot({ path: join(SHOTS, '3-page.png') });

    // ── 4: each opens in the viewer the chat uses for it ──
    console.log('\n═══ 4. Opening ═══');
    await pdfCard.click();
    check('the PDF opens full window', await until(async () => (await page.locator('.pdf-viewer').count()) === 1, 8000));
    const pdfHead = await page.evaluate(async () => {
      const r = await fetch('/api/graph/content?vault=proj&raw=1&path=' + encodeURIComponent('automations/output/maker/report.pdf'), { headers: { Range: 'bytes=0-3', 'X-Dreamcontext-Vault': 'proj' } });
      return { status: r.status, type: r.headers.get('content-type'), head: await r.text() };
    });
    check('…from the vault route, typed and range-served', pdfHead.status === 206 && pdfHead.type === 'application/pdf' && pdfHead.head === '%PDF', JSON.stringify(pdfHead));
    await page.screenshot({ path: join(SHOTS, '4-pdf.png') });
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.pdf-viewer').count()) === 0, 4000);

    await postRow.locator('.agent-msg-img').click();
    check('the picture opens in the lightbox', await until(async () => (await page.locator('.image-viewer').count()) === 1, 8000));
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.image-viewer').count()) === 0, 4000);

    await board.locator('.chat-board-open').first().click();
    const full = page.locator('.fullscreen-overlay');
    check('the board opens fullscreen and draws there',
      await until(async () => (await full.count()) === 1 && (await full.locator('canvas, svg').count()) > 0, 15000));
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOTS, '5-board-full.png') });

    // ══ THE AUDIT PASS (goal-skill v2) ══════════════════════════════════════════════
    // Every check below MEASURES what Chromium painted. Labels carry the audit finding and
    // what the pre-fix build measured; `[guard]` checks hold on both builds.
    const openAgents = async (p) => {
      await p.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2000);
      for (let i = 0; i < 4; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(150); }
      await p.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
      await until(async () => (await p.locator('.agent-msg').count()) >= 3, 20000);
    };
    const row = (p, title) => p.locator('article.agent-msg', { has: p.locator('.agent-msg-name', { hasText: title }) }).first();

    console.log('\n═══ 5. The board, the clip, the widths (desktop, 1500) ═══');
    await page.keyboard.press('Escape');
    await until(async () => (await full.count()) === 0, 4000);
    await board.scrollIntoViewIfNeeded();
    const canvasBox = await rect(board.locator('.chat-board-canvas'));
    const previewBox = await rect(board.locator('.excalidraw-preview'));
    const drawn = await board.locator('canvas').first().evaluate((el) => el.getBoundingClientRect().height).catch(() => null);
    check('[A1] the board preview is exactly its box, and the canvas does not overflow it (was 418 in 340)',
      Math.abs(previewBox.height - canvasBox.height) <= 1 && drawn !== null && drawn <= canvasBox.height + 1,
      `box=${canvasBox.height} preview=${previewBox.height} canvas=${drawn}`);
    const inner = await board.locator('.excalidraw-preview').evaluate((el) => getComputedStyle(el).borderTopWidth);
    check('[A15] no second border inside the board card (was 1px)', inner === '0px', `border-top-width=${inner}`);
    const fullOpen = await rect(board.locator('.chat-board-open').first());
    check('[A13] "Full screen" is a 24px target (was 17px tall)', fullOpen.height >= 24, `h=${fullOpen.height}`);
    const clipOpen = await rect(postRow.locator('.agent-msg-video .agent-msg-media-open').first());
    check('[A13] the clip\'s Open is at least 24x24 (was 42x18)', clipOpen.width >= 24 && clipOpen.height >= 24,
      `${Math.round(clipOpen.width)}x${Math.round(clipOpen.height)}`);
    const widths = async () => ({
      board: (await rect(postRow.locator('.agent-msg-board').first())).width,
      image: (await rect(postRow.locator('.agent-msg-img').first())).width,
      clip: (await rect(postRow.locator('.agent-msg-video').first())).width,
    });
    // Measured in a WIDE column: at the default 560px panel every visual simply fills the
    // column, so a post's widths only disagree once there is room. 900px is a width the
    // thread panel's resize handle reaches; the style is set inline on both builds alike.
    const panelStyle = await panel.evaluate((el) => el.getAttribute('style') || '');
    await panel.evaluate((el) => { el.style.width = '900px'; el.style.maxWidth = 'none'; });
    await page.waitForTimeout(500);
    const wWide = await widths();
    check('[A14] board, picture and clip in one post share one width (was board 100% / picture 520 / clip 560)',
      Math.max(wWide.board, wWide.image, wWide.clip) - Math.min(wWide.board, wWide.image, wWide.clip) <= 2, JSON.stringify(wWide));
    await panel.evaluate((el, s) => el.setAttribute('style', s), panelStyle);
    await page.waitForTimeout(300);

    console.log('\n═══ 6. The ask preview names what came back (1100, thread open) ═══');
    await page.setViewportSize({ width: 1100, height: 950 });
    await page.waitForTimeout(600);
    const filesLine = you.locator('.agent-reply-preview-files');
    const summary = (await filesLine.evaluate((el) => el.textContent)).replace(/\s+/g, ' ').trim();
    check('[A5] the files line reads "▦ funnel · ▣ chart.png · ▶ walkthrough.mp4 · ◧ report.pdf" (was raw names, 3 spaces)',
      summary === '▦ funnel · ▣ chart.png · ▶ walkthrough.mp4 · ◧ report.pdf', `"${summary}"`);
    const fit = await filesLine.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    check('[F8] with the thread open at 1100 the files line is not clipped (was 808 in 730)', fit.sw <= fit.cw + 1, JSON.stringify(fit));
    const titles = await filesLine.evaluate((el) => [...el.querySelectorAll('[title]')].map((n) => n.getAttribute('title')));
    check('[F8] …and every file carries its full name as a tooltip (was none)',
      ['funnel.excalidraw.md', 'chart.png', 'walkthrough.mp4', 'report.pdf'].every((n) => titles.some((tt) => (tt ?? '').endsWith(n))),
      JSON.stringify(titles));
    check('[A17] the board is named by its board name, never ".excalidraw.md" (was the raw filename)',
      !summary.includes('.excalidraw.md'), `"${summary}"`);
    await page.setViewportSize({ width: 1500, height: 1000 });

    console.log('\n═══ 7. A scheduled post with four visuals ═══');
    await openAgents(page);
    const pack = row(page, 'Pack builder');
    const visualsIn = (loc) => loc.locator('.agent-msg-files').first().evaluate((el) =>
      [...el.children].filter((c) => c.matches('.agent-msg-board, .agent-msg-img, .agent-msg-video')).length);
    for (const [w, h] of [[1500, 1000], [1100, 950]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(800);
      const n = await visualsIn(pack);
      const tall = (await rect(pack)).height;
      const folded = await pack.locator('.agent-msg-file--folded').count();
      check(`[A4] at ${w}, the feed row shows ONE visual in full and folds the rest (was 4 stacked, 1248px)`,
        n === 1 && folded === 3 && tall <= 700, `visuals=${n} folded=${folded} height=${Math.round(tall)}`);
    }
    await page.screenshot({ path: join(SHOTS, '6-pack-feed.png') });
    await page.setViewportSize({ width: 1500, height: 1000 });
    await pack.locator('.agent-thread-bar').click();
    const packRoot = page.locator('.agent-thread');
    await until(async () => (await packRoot.count()) === 1, 8000);
    check('[guard] the thread shows every visual of the post', await until(async () =>
      (await packRoot.locator('.agent-msg-board, .agent-msg-img, .agent-msg-video').count()) >= 4, 10000),
      `visuals=${await packRoot.locator('.agent-msg-board, .agent-msg-img, .agent-msg-video').count()}`);
    const portrait = packRoot.locator('.agent-msg-video video[src*="portrait"]').first();
    await until(async () => portrait.evaluate((el) => el.readyState >= 1), 15000);
    await portrait.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const pr = await portrait.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, vw: el.videoWidth, vh: el.videoHeight };
    });
    const boxRatio = pr.w / pr.h;
    const clipRatio = pr.vw / pr.vh;
    check('[A2] the portrait reel plays in a portrait box, no black slabs (was 486x360 for 360x640)',
      pr.vh > 0 && Math.abs(boxRatio - clipRatio) / clipRatio <= 0.02, JSON.stringify(pr));
    await page.screenshot({ path: join(SHOTS, '7-pack-thread.png') });
    await page.keyboard.press('Escape');

    console.log('\n═══ 8. A recording and a long document name ═══');
    const docsRow = row(page, 'Docs clerk');
    const audio = docsRow.locator('.agent-msg-file--audio').first();
    const glyph = await audio.locator('.agent-msg-file-type').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check('[A9] the recording\'s glyph is legible, at least 16px (was 10px)', glyph >= 16, `font-size=${glyph}`);
    const audioOpen = audio.locator('.agent-msg-media-open');
    const hasOpen = (await audioOpen.count()) > 0;
    if (hasOpen) await audioOpen.first().click();
    check('[A9] the recording card has Open, and it opens the file (absent pre-fix: the missing button is the bug)',
      hasOpen && await until(async () => (await page.locator('.chat-slideover-panel').count()) > 0, 8000));
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.chat-slideover-panel').count()) === 0, 4000);
    const longCard = docsRow.locator('.agent-msg-file--pdf').first();
    const nameFit = await longCard.locator('.agent-msg-file-name').evaluate((el) => ({ text: el.innerText, sw: el.scrollWidth, cw: el.clientWidth }));
    check('[A11] the 86-character name keeps its distinguishing end, unclipped (was 625px of text in 270)',
      nameFit.text.trim().endsWith(LONG_PDF.slice(-12)) && nameFit.sw <= nameFit.cw + 1, JSON.stringify(nameFit));
    const notes = await docsRow.locator('.agent-msg-file--pdf .agent-msg-file-note').count();
    check('[A12] a PDF card carries no filler note (was "PDF document")', notes === 0, `notes=${notes}`);
    await page.screenshot({ path: join(SHOTS, '8-docs.png') });

    // R2-3 (owner decision 3a): on desktop an .svg opens in the Lightbox as an <img>, where its
    // script can never run. Pre-fix it opened the SlideOver as source text, because the desktop
    // route refused to serve an SVG as an image even with raw=1.
    console.log('\n═══ 8b. An .svg opens as a picture on desktop ═══');
    const svgCard = docsRow.locator('.agent-msg-file', { hasText: 'logo.svg' }).first();
    const svgCardFound = await until(async () => (await svgCard.count()) > 0, 10000);
    let svgOpen = { opened: 'nothing', width: 0, ran: false };
    if (svgCardFound) {
      await svgCard.click();
      await until(async () => (await page.locator('.image-viewer, .chat-slideover-panel').count()) > 0, 8000);
      await until(async () => page.evaluate(() => (document.querySelector('.image-viewer img')?.naturalWidth ?? 0) > 0), 6000);
      svgOpen = await page.evaluate(() => ({
        opened: document.querySelector('.image-viewer') ? 'lightbox' : document.querySelector('.chat-slideover-panel') ? 'slideover' : 'nothing',
        width: document.querySelector('.image-viewer img')?.naturalWidth ?? 0,
        ran: window.__svgRan === 1,
      }));
      await page.screenshot({ path: join(SHOTS, '8b-svg-lightbox.png') });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    check('[R2-3] on desktop the posted .svg opens in the Lightbox and the picture loads (was the SlideOver source view)',
      svgOpen.opened === 'lightbox' && svgOpen.width > 0, JSON.stringify(svgOpen));
    check('[guard] the SVG\'s own script never runs', svgOpen.ran !== true, JSON.stringify(svgOpen));
    // AD-7: the same URL fetched directly carries the sandbox CSP, so even a navigation to it
    // is inert. Pre-fix the route answered the JSON text preview.
    const rawSvg = await fetch(`${base}/api/agent/file?vault=proj&raw=1&path=${encodeURIComponent('_dream_context/automations/output/maker/logo.svg')}`);
    const svgHead = { status: rawSvg.status, type: rawSvg.headers.get('content-type'), csp: rawSvg.headers.get('content-security-policy'), nosniff: rawSvg.headers.get('x-content-type-options') };
    await rawSvg.arrayBuffer().catch(() => null);
    check('[R2-3/AD-7] GET /api/agent/file?raw=1 serves the .svg as image/svg+xml under a sandbox CSP with nosniff (was application/json)',
      svgHead.status === 200 && (svgHead.type ?? '').startsWith('image/svg+xml') && /sandbox/.test(svgHead.csp ?? '')
        && /default-src 'none'/.test(svgHead.csp ?? '') && svgHead.nosniff === 'nosniff', JSON.stringify(svgHead));
    const vaultSvg = await fetch(`${base}/api/graph/content?vault=proj&raw=1&path=${encodeURIComponent('automations/output/maker/logo.svg')}`,
      { headers: { 'X-Dreamcontext-Vault': 'proj' } });
    const vaultType = vaultSvg.headers.get('content-type');
    await vaultSvg.arrayBuffer().catch(() => null);
    check('[guard] the vault route still never serves an .svg as an image', !(vaultType ?? '').startsWith('image/svg'), `type=${vaultType}`);

    console.log('\n═══ 9. A clip reserves its box before it loads ═══');
    const cls = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await cls.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await cls.route(/walkthrough\.mp4/, async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
    const cp = await cls.newPage();
    await openAgents(cp);
    await cp.locator('.agent-msg--you').first().locator('.agent-thread-bar').click();
    const fig = cp.locator('.agent-thread .agent-msg-video').first();
    await until(async () => (await fig.count()) > 0, 10000);
    const h0 = (await rect(fig)).height;
    await until(async () => fig.locator('video').evaluate((el) => el.readyState >= 1), 20000);
    await cp.waitForTimeout(300);
    const h1 = (await rect(fig)).height;
    check('[A3] a 16:9 clip keeps its height when its metadata lands (was 182 -> 392)', Math.abs(h1 - h0) <= 2, `before=${h0} after=${h1}`);
    await cls.close();

    console.log('\n═══ 10. Dark theme ═══');
    const dark = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await dark.addInitScript(() => { Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); });
    await setTheme(dark, 'dark');
    const dp = await dark.newPage();
    await openAgents(dp);
    const scheme = await dp.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    const audioScheme = await row(dp, 'Docs clerk').locator('audio').first().evaluate((el) => getComputedStyle(el).colorScheme);
    check('[A8] dark theme renders native controls dark: color-scheme is dark on the page and the audio (was normal)',
      scheme === 'dark' && audioScheme === 'dark', `html=${scheme} audio=${audioScheme}`);
    const darkBoard = row(dp, 'Pack builder').locator('.excalidraw-preview').first();
    await until(async () => (await darkBoard.count()) > 0, 15000);
    check('[guard] the board follows the app theme in dark (A16 was a harness artifact)',
      (await darkBoard.getAttribute('data-theme')) === 'dark', `data-theme=${await darkBoard.getAttribute('data-theme')}`);
    await dp.screenshot({ path: join(SHOTS, '10-dark.png') });

    // The full-window PDF viewer under `color-scheme: dark` (K's tokens change). What is
    // measured is the viewer's OWN chrome: its shell, head and stage, the scheme the frame
    // inherits, and whether anything outside the document paints a white slab. The rendered
    // PDF page itself is the owner's in-app check: headless Chromium has no PDF plugin, so
    // the document area here is the frame (or the viewer's fallback), never a painted page.
    const measurePdf = (p) => p.locator('.pdf-viewer').evaluate((viewer) => {
      const parse = (s) => (s.match(/-?[\d.]+/g) || []).map(Number);
      const lum = (s) => {
        const [r, g, b, a = 1] = parse(s);
        if (a === 0) return null;
        const c = [r, g, b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
        return Math.round((0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) * 1000) / 1000;
      };
      const vr = viewer.getBoundingClientRect();
      const area = vr.width * vr.height;
      const frame = viewer.querySelector('.pdf-viewer-frame');
      const stage = viewer.querySelector('.pdf-viewer-stage');
      const slabs = [...viewer.querySelectorAll('*')]
        .filter((el) => !el.closest('.pdf-viewer-frame'))
        .map((el) => ({ el, l: lum(getComputedStyle(el).backgroundColor), r: el.getBoundingClientRect() }))
        .filter((x) => x.l !== null && x.l > 0.9 && (x.r.width * x.r.height) > area / 2)
        .map((x) => `${x.el.className} ${Math.round(x.r.width)}x${Math.round(x.r.height)} L=${x.l}`);
      return {
        shellBg: lum(getComputedStyle(viewer).backgroundColor),
        nameInk: lum(getComputedStyle(viewer.querySelector('.pdf-viewer-name') || viewer).color),
        stageBg: stage ? lum(getComputedStyle(stage).backgroundColor) : null,
        frameScheme: frame ? getComputedStyle(frame).colorScheme : null,
        stageScheme: stage ? getComputedStyle(stage).colorScheme : null,
        hasFrame: !!frame,
        slabs,
      };
    });
    const openPdf = async (p) => {
      await row(p, 'Docs clerk').locator('.agent-msg-file--pdf').first().click();
      await p.locator('.pdf-viewer').waitFor({ timeout: 8000 });
      await p.waitForTimeout(1200);
    };
    await openPdf(dp);
    const pdfDark = await measurePdf(dp);
    console.log(`  · pdf viewer, dark: ${JSON.stringify(pdfDark)}`);
    await dp.screenshot({ path: join(SHOTS, '10b-pdf-dark.png') });
    check('[guard] dark: the PDF viewer\'s shell and stage are dark surfaces with light ink (K color-scheme)',
      pdfDark.shellBg !== null && pdfDark.shellBg < 0.2 && pdfDark.stageBg !== null && pdfDark.stageBg < 0.2 && pdfDark.nameInk > 0.5,
      JSON.stringify(pdfDark));
    check('[K color-scheme] dark: the document frame inherits color-scheme dark, so Chromium keeps it transparent (was normal)',
      (pdfDark.hasFrame ? pdfDark.frameScheme : pdfDark.stageScheme) === 'dark', JSON.stringify(pdfDark));
    check('[guard] dark: nothing outside the document paints a white slab over half the viewer (K color-scheme)',
      pdfDark.slabs.length === 0, pdfDark.slabs.join(' | '));
    await dp.keyboard.press('Escape');
    await dark.close();

    const lightCtx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await setTheme(lightCtx, 'light');
    const lp = await lightCtx.newPage();
    await openAgents(lp);
    await openPdf(lp);
    const pdfLight = await measurePdf(lp);
    console.log(`  · pdf viewer, light: ${JSON.stringify(pdfLight)}`);
    check('[guard] light: the PDF viewer keeps its light shell with dark ink',
      pdfLight.shellBg !== null && pdfLight.shellBg > 0.8 && pdfLight.nameInk < 0.2, JSON.stringify(pdfLight));
    await lightCtx.close();

    console.log('\n═══ 11. One capability decides the board (browser tabs) ═══');
    const tab = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const tp = await tab.newPage();
    await openAgents(tp);
    const tabBoard = row(tp, 'Pack builder');
    check('[A10] a browser tab served by a DESKTOP server draws the board (absent pre-fix: it showed a card saying boards open in the desktop app)',
      await until(async () => (await tabBoard.locator('.chat-board canvas').count()) > 0, 15000),
      `boards=${await tabBoard.locator('.chat-board').count()} cards=${await tabBoard.locator('.agent-msg-file--board').count()}`);
    await tab.close();

    const port2 = await freePort();
    const srv2 = await startServer(port2, { desktop: false });
    try {
      const off = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      const op = await off.newPage();
      await op.goto(`http://127.0.0.1:${port2}/?vault=proj`, { waitUntil: 'domcontentloaded' });
      await op.waitForTimeout(2000);
      for (let i = 0; i < 4; i++) { await op.keyboard.press('Escape'); await op.waitForTimeout(150); }
      await op.locator('.sidebar-item', { hasText: 'Agentic Automations' }).first().click();
      const offCard = row(op, 'Pack builder').locator('.agent-msg-file--board').first();
      await until(async () => (await offCard.count()) > 0, 15000);
      const tag = await offCard.evaluate((el) => el.tagName).catch(() => '(none)');
      await offCard.click().catch(() => {});
      await op.waitForTimeout(1200);
      const overlays = await op.locator('.fullscreen-overlay, .chat-slideover-panel').count();
      check('[A10] off a desktop server the board is a card you cannot click into a dead canvas (was a <button> that opened fullscreen)',
        tag !== 'BUTTON' && overlays === 0, `tag=${tag} overlays=${overlays}`);
      const offName = (await offCard.locator('.agent-msg-file-name').innerText().catch(() => '')).trim();
      check('[A17] …and it is named by its board name (was "funnel.excalidraw.md")', offName === 'funnel', `name="${offName}"`);
      await op.screenshot({ path: join(SHOTS, '11-browser-off-desktop.png') });
      // R2-3: off a desktop server the .svg stays a card and never opens as a picture.
      const offSvg = row(op, 'Docs clerk').locator('.agent-msg-file', { hasText: 'logo.svg' }).first();
      if (await offSvg.count()) { await offSvg.click().catch(() => {}); await op.waitForTimeout(1200); }
      const offViewer = await op.locator('.image-viewer').count();
      check('[guard] off a desktop server the .svg is a card and never opens as a picture', (await offSvg.count()) > 0 && offViewer === 0,
        `card=${await offSvg.count()} viewer=${offViewer}`);
      await off.close();
    } finally {
      srv2.kill();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
  console.log(`  screenshots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
