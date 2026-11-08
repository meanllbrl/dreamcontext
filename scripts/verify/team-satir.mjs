#!/usr/bin/env node
/**
 * The drawer's Team rows, owner 2026-11-05 (three faults on the installed 0.41.1):
 *   1 every member with a photo shows its photo (the faces in the Team row too), a global
 *     member's in the Global row, a member with none keeps its figure.
 *   2 a "Super için" member's name is never cut by its mark (a glyph on its face, its tooltip says it):
 *     the owner's "Pacioli" read "P...", at the 200px drawer and wide.
 *   3 opening Team shows no row at work unless the member is: the first 2s after the click are
 *     sampled every frame, and a mark of work on a member that does not work is a FAIL.
 *
 *   npm run build && DC_VERIFY_PHASE=before|after node scripts/verify/team-satir.mjs [outDir]
 *
 * The real dashboard server from dist, scratch HOME, pinned to ANOTHER project than the one in
 * view (the desktop app's server is pinned to wherever it started: a read with no vault named
 * answers for that root, not for the project whose drawer row asks). Six real members made with `dreamcontext agents create`, one of them
 * global, each but one given a photo through POST /api/agents/:slug/photo. Who works for the
 * Super is the summary's `members` (staged, as ekip-satiri.mjs does); everything else is live.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen, PHASE } from './lib/measure.mjs';
import { applyTheme, cleanEnv, freePort, reporter, startServer, until, watchPage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-team-satir-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const OTHER = 'kuzey-atolyesi';
const CLI = join(REPO, 'dist', 'index.js');
const OUT = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'team-satir'));
const env = () => cleanEnv(HOME);
const dc = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(), encoding: 'utf-8' });
const { ok, summary } = reporter();

/** slug, title, photo colour (null = no photo), scope. */
const MEMBERS = [
  ['pacioli', 'Pacioli Finans', '#c2410c', 'project'],
  ['hoca-masasi', 'Hoca masası', '#0f766e', 'project'],
  ['front-desk', 'Front Desk', '#1d4ed8', 'project'],
  ['ozel-hat', 'Özel Hat izleme', '#a21caf', 'project'],
  ['doctor', 'Doctor', null, 'project'],
  // A global agent cannot hold a photo (`updateAgent` refuses: a photo belongs to one project).
  ['social-media', 'Social Media Manager', null, 'global'],
];
const m = (slug, o = {}) => ({ slug, global: false, enabled: true, ownerWorking: 0, asking: false, approval: false, unread: 0, superOnly: false, lastAt: 0, pending: 0, ...o });
/** The summary's members: Performans Pazarlama works for the Super, nobody for the owner. */
const STAGED = [
  m('pacioli', { superOnly: true, lastAt: 9 }), m('hoca-masasi', { lastAt: 8 }), m('front-desk', { lastAt: 7 }),
  m('ozel-hat', { lastAt: 6 }), m('doctor', { enabled: false }), m('social-media', { global: true, lastAt: 5 }),
];

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(PROJ, '_dream_context', 'state'), join(SCRATCH, OTHER, '_dream_context', 'state'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  for (const p of [PROJ, join(SCRATCH, OTHER)]) spawnSync('git', ['-C', p, 'init', '-q'], { encoding: 'utf-8' });
  const steps = [
    ['vaults add', dc(SCRATCH, 'vaults', 'add', VAULT, PROJ)],
    ['vaults add other', dc(SCRATCH, 'vaults', 'add', OTHER, join(SCRATCH, OTHER))],
  ];
  for (const [slug, title, , scope] of MEMBERS) steps.push([`agent ${slug}`, dc(PROJ, 'agents', 'create', slug, '--title', title, '--prompt', `${title} işini yapar.`, '--scope', scope)]);
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

/** A flat-colour PNG made in the page, posted as the member's photo. */
const uploadPhoto = (page, vault, slug, colour) => page.evaluate(async ([v, s, c]) => {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
  const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 26, 12, 0, Math.PI * 2); g.fill(); g.fillRect(14, 44, 36, 20);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const r = await fetch(`/api/agents/${s}/photo`, { method: 'POST', headers: { 'X-Dreamcontext-Vault': v, 'Content-Type': 'image/png' }, body: blob });
  return r.status;
}, [vault, slug, colour]);

const teamRow = (page) => page.locator(`[data-testid="drawer-team-row"][data-vault="${VAULT}"]:visible`).first();
const globalRow = (page) => page.locator('[data-testid="drawer-global-team-row"]:visible').first();

async function load(page, base, { open = false, globalOpen = false } = {}) {
  await page.evaluate(([k, o, g]) => {
    if (o) localStorage.setItem(k, '1'); else localStorage.removeItem(k);
    if (g) localStorage.setItem('dc.drawer.team.global', '1'); else localStorage.removeItem('dc.drawer.team.global');
  }, [`dc.drawer.team.${VAULT}`, open, globalOpen]);
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  const project = page.locator(`[data-drawer-project="${VAULT}"]`).first();
  const toggle = project.locator('[data-testid="drawer-project-row"]').first();
  await until(page, async () => (await toggle.count()) === 1, 20000);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return until(page, async () => (await teamRow(page).count()) === 1, 20000);
}

/** Every visible member row's photo state: does its <img> show a loaded picture? */
const faces = (page, listSel) => page.locator(`${listSel} [data-testid="team-list-member"]`).evaluateAll((rows) => rows.map((r) => {
  const img = r.querySelector('.agent-av img');
  return { slug: r.getAttribute('data-slug'), photo: !!img && img.complete && img.naturalWidth > 0 };
}));

async function shot(page, name) {
  const file = join(OUT, `${PHASE}-${name}.png`);
  const drawer = page.getByTestId('chat-drawer');
  const box = await drawer.boundingBox();
  await page.screenshot({ path: file, ...(box ? { clip: { x: box.x, y: box.y, width: Math.min(box.width + 40, 600), height: Math.min(box.height, 620) } } : {}) });
  return file;
}

async function setDrawerWidth(page, wide) {
  const drawer = page.getByTestId('chat-drawer');
  const handle = page.locator('.ns-dr-handle');
  const hb = await handle.boundingBox();
  const now = Math.round((await drawer.boundingBox())?.width ?? 0);
  const target = wide ? 340 : 200;
  if (!hb || now === target) return now;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + (target - now), hb.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  return Math.round((await drawer.boundingBox())?.width ?? 0);
}

async function run(base) {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(SCRATCH, 'video'), size: { width: 1440, height: 900 } } });
  await markAnnouncementsSeen(context, base);
  const summaryHits = [];
  await context.route('**/api/agent/sessions?summary=1*', async (route) => {
    summaryHits.push({ at: Date.now(), url: route.request().url() });
    const res = await route.fetch();
    let body = {};
    try { body = await res.json(); } catch { /* keep empty */ }
    const vault = new URL(route.request().url()).searchParams.get('vault') ?? route.request().headers()['x-dreamcontext-vault'];
    await route.fulfill({ response: res, json: vault === OTHER ? { ...body, members: [m('social-media', { global: true })] } : { ...body, members: STAGED } });
  });
  const page = await context.newPage();
  const watch = watchPage(page, 'desk');
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  for (const [slug, , colour] of MEMBERS) {
    if (!colour) continue;
    ok(`setup: photo for ${slug}`, (await uploadPhoto(page, VAULT, slug, colour)) === 200);
  }

  console.log('── 1 photos');
  ok('1 the Team row is there', await load(page, base, { open: true, globalOpen: true }));
  const list = '[data-testid="team-list"]:visible';
  await until(page, async () => (await page.locator(`${list} [data-testid="team-list-member"]`).count()) === 5, 10000);
  await page.waitForTimeout(1200);
  const got = await faces(page, list);
  for (const [slug, , colour, scope] of MEMBERS) {
    if (scope === 'global') continue;
    const f = got.find((x) => x.slug === slug);
    ok(colour ? `1 ${slug} shows its photo` : `1 ${slug} (no photo) keeps its figure`, !!f && f.photo === !!colour, JSON.stringify(f));
  }
  const rowFaces = await teamRow(page).locator('.ns-team-face img').evaluateAll((imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length);
  ok('1 the Team row\'s faces are photos', rowFaces === 3, String(rowFaces));
  // A member with no photo wears the figure stamped on it (its picked face), not the bare hash.
  const stamped = await page.evaluate(async (v) => (await (await fetch('/api/agents', { headers: { 'X-Dreamcontext-Vault': v } })).json()).agents.map((x) => ({ slug: x.slug, face: x.face })), VAULT);
  const TONES = ['violet', 'plum', 'indigo', 'sky', 'teal', 'coral', 'amber', 'rose'];
  const doc = stamped.find((x) => x.slug === 'doctor')?.face;
  const drawn = await page.locator(`${list} [data-slug="doctor"] .agent-figure`).evaluate((el) => ({ shape: Number(el.getAttribute('data-shape')), tone: el.getAttribute('data-tone') })).catch(() => null);
  ok('1 Doctor (no photo) wears its stamped figure', !!doc && !!drawn && drawn.shape === doc.shape && drawn.tone === TONES[doc.color], JSON.stringify({ doc, drawn }));
  const gl = '[data-testid="global-team-list"]:visible';
  ok('1 the Global row is there', await until(page, async () => (await page.locator(`${gl} [data-testid="team-list-member"]`).count()) === 1, 10000));
  const gf = await faces(page, gl);
  ok('1 the global member (no photo possible) keeps its figure', gf[0]?.photo === false && (await page.locator(`${gl} .agent-av--figure`).count()) === 1, JSON.stringify(gf));

  console.log('── 2 the "Super için" mark');
  for (const theme of ['dark', 'light']) {
    await applyTheme(page, theme);
    for (const wide of [false, true]) {
      const w = await setDrawerWidth(page, wide);
      await page.waitForTimeout(500);
      const name = page.locator(`${list} [data-slug="pacioli"] .ns-team-mname`);
      // The painted text against its box (Range rects, not scrollWidth: that read "not cut" on a
      // name the screenshot showed with an ellipsis).
      const cut = await name.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.5; }).catch(() => true);
      ok(`2 ${theme} ${w}px: "Pacioli Finans" is not cut`, !cut);
      const mark = page.locator(`${list} [data-slug="pacioli"] [data-testid="team-mark-super"]`);
      const mw = Math.round((await mark.boundingBox().catch(() => null))?.width ?? 999);
      ok(`2 ${theme} ${w}px: the mark is there, small, and on the face (not in the name's row)`, (await mark.count()) === 1 && mw <= 12
        && await mark.evaluate((el) => !!el.closest('.ns-team-mface')), `${mw}px`);
      await shot(page, `${wide ? 'genis' : 'dar'}-${theme}`);
    }
  }
  await setDrawerWidth(page, false);
  await applyTheme(page, 'dark');
  const mark = page.locator(`${list} [data-slug="pacioli"] [data-testid="team-mark-super"]`);
  const label = (await mark.getAttribute('aria-label').catch(() => null)) ?? (await mark.getAttribute('title').catch(() => null)) ?? (await mark.innerText().catch(() => ''));
  ok('2 the mark still names "For Super"', /For Super/.test(label ?? ''), String(label));

  console.log('── 3 opening Team');
  ok('3 folded first', await load(page, base, { open: false, globalOpen: false }));
  await page.waitForTimeout(3000);
  const before = summaryHits.length;
  // Sample every frame for 2s from the click: which rows show a mark of work, a spinner or a pending face.
  await page.evaluate(() => {
    window.__samples = [];
    const t0 = performance.now();
    const tick = () => {
      const rows = [...document.querySelectorAll('[data-testid="team-list"] [data-testid="team-list-member"]')];
      window.__samples.push({
        t: Math.round(performance.now() - t0),
        rows: rows.length,
        working: rows.filter((r) => r.querySelector('[data-testid="team-mark-working"], .project-chip-bubbles, [class*="spin"], [class*="pulse"]')).map((r) => r.getAttribute('data-slug')),
        busy: rows.filter((r) => r.querySelector('[aria-busy="true"], [data-loading="true"]')).length,
        pendingImg: rows.filter((r) => { const i = r.querySelector('.agent-av img'); return !!i && !(i.complete && i.naturalWidth > 0); }).length,
      });
      if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await teamRow(page).click();
  const frames = [];
  for (let i = 0; i < 8; i++) { frames.push(await shot(page, `acilis-kare-${i}`)); await page.waitForTimeout(60); }
  await page.waitForTimeout(2200);
  const samples = await page.evaluate(() => window.__samples);
  const flashed = samples.filter((s) => s.working.length > 0 || s.busy > 0);
  ok('3 no member shows work on opening (none works)', flashed.length === 0, JSON.stringify(flashed.slice(0, 5)));
  const pend = samples.filter((s) => s.pendingImg > 0);
  console.log(`  · frames ${samples.length}, frames with a still-loading photo: ${pend.length} (first ${pend[0]?.t ?? '-'}ms, last ${pend.at(-1)?.t ?? '-'}ms)`);
  ok('3 opening sends no new summary read', summaryHits.length - before <= 1, `${summaryHits.length - before} reads`);
  writeFileSync(join(OUT, `${PHASE}-acilis-ornekler.json`), JSON.stringify(samples, null, 1));

  ok('no console error', watch.errors.length === 0, watch.errors.join('\n'));
  ok('no failed request', watch.failed.length === 0, watch.failed.slice(0, 8).join('\n'));
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) { const p = await video.path(); spawnSync('cp', [p, join(OUT, `${PHASE}-acilis.webm`)]); }
}

setup();
const port = await freePort();
let srv;
try {
  srv = await startServer({ cli: CLI, cwd: join(SCRATCH, OTHER), home: HOME, port, logFile: join(SCRATCH, 'server.log'), extraEnv: { DREAMCONTEXT_DESKTOP: '1' } });
  await run(`http://127.0.0.1:${port}`);
} catch (err) {
  ok('the run finished', false, err?.stack ?? String(err));
} finally {
  srv?.kill();
}
console.log(`\nshots: ${OUT}\n${summary()}`);
process.exitCode = /0 failed/.test(summary()) ? 0 : 1;
