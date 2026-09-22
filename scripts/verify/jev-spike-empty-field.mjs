#!/usr/bin/env node
/**
 * SPIKE 2 — Jev reads the REAL task board and reports which tasks have an empty
 * "Incremental Revenue Açıklama" custom field. Read-only against a real vault.
 *
 *   npm run build && node scripts/verify/jev-spike-empty-field.mjs [--vault h-f_dreamcontext] [--ui 60] [--all]
 *
 * TWO TIERS, SAME QUESTION.
 *   UI tier   — Playwright opens each task's detail panel in the real dashboard, hands the
 *               panel's aria snapshot + text to Jev, asks "is the field empty?". This is the
 *               shape a validator would use: judge what the USER SEES. `--ui N` caps how many
 *               tasks go through the browser (default 60, balanced empty/filled); `--all` does
 *               every task.
 *   API tier  — every task's custom_fields from /api/tasks, batched 40 per Jev call, so the
 *               "all tasks" answer arrives in a handful of ~1s calls. Also asks WHICH revenue
 *               category the filled ones open with — a semantic read code cannot do.
 *
 * GROUND TRUTH is the frontmatter on disk (gray-matter), computed here before anything runs.
 * Every Jev verdict is scored against it; precision/recall are printed, not asserted away.
 *
 * KEY: `~/.dreamcontext/voice.json` → `openRouterKey`, read into memory, never printed.
 * MUTATION: none. Opening a detail panel does not PATCH; nothing is typed into a field.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import matter from 'gray-matter';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VAULT = arg('--vault', 'h-f_dreamcontext');
const UI_CAP = argv.includes('--all') ? Infinity : Number(arg('--ui', '60'));
const FIELD_KEY = 'incremental_revenue_ac_klama';
const FIELD_LABEL = 'Incremental Revenue Açıklama';
const SHOTS = join(REPO, 'tmp', 'verify-jev-empty-field');

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';
const PASS_AT = 0.85, FAIL_AT = 0.15;

// ─── Key ─────────────────────────────────────────────────────────────────────
function loadKey() {
  try { const k = JSON.parse(readFileSync(join(homedir(), '.dreamcontext', 'voice.json'), 'utf-8')).openRouterKey; return typeof k === 'string' && k.length > 10 ? k : null; }
  catch { return null; }
}

// ─── Jev ─────────────────────────────────────────────────────────────────────
const noul = (instructions) => ({ type: 'noul', instructions });
const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
let spent = 0, calls = 0, msTotal = 0;
async function jev(key, state, questions) {
  const t0 = Date.now();
  const res = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state, questions }) });
  const ms = Date.now() - t0; msTotal += ms; calls++;
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json(); spent += body.usage?.cost ?? 0;
  return { answers: body.answers, ms, usage: body.usage };
}
const band = (p) => (p >= PASS_AT ? 'yes' : p <= FAIL_AT ? 'no' : 'inconclusive');

// ─── Vault + ground truth ────────────────────────────────────────────────────
function vaultPath(name) {
  const r = spawnSync('dreamcontext', ['vaults', 'list'], { encoding: 'utf-8' });
  const line = r.stdout.split('\n').find((l) => l.trim().startsWith(name + ' '));
  if (!line) throw new Error(`vault "${name}" not registered`);
  return line.trim().slice(name.length).trim();
}
function groundTruth(root) {
  const dir = join(root, '_dream_context', 'state');
  const out = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const d = matter(readFileSync(join(dir, f), 'utf-8')).data;
    const v = d.custom_fields?.[FIELD_KEY];
    out.set(f.replace(/\.md$/, ''), { name: d.name ?? f, status: d.status ?? '?', empty: v == null || String(v).trim() === '', value: v == null ? '' : String(v) });
  }
  return out;
}

// ─── Server ──────────────────────────────────────────────────────────────────
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port, cwd) {
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 250)); }
  srv.kill(); throw new Error('server did not come up');
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
function score(rows) {
  let tp = 0, fp = 0, fn = 0, tn = 0, inc = 0;
  for (const r of rows) {
    if (r.got === 'inconclusive') { inc++; continue; }
    const said = r.got === 'yes';
    if (said && r.truth) tp++; else if (said && !r.truth) fp++; else if (!said && r.truth) fn++; else tn++;
  }
  return { tp, fp, fn, tn, inc, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn) };
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ─── UI tier ─────────────────────────────────────────────────────────────────
async function uiTier(base, key, truth, slugs) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'dark' });
  await page.goto(`${base}/?vault=${encodeURIComponent(VAULT)}&page=tasks`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 6; i += 1) { await page.waitForTimeout(500); if (await page.locator('.announcements-modal-scrim').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); } }
  const search = page.getByPlaceholder('Search tasks…');
  await search.waitFor({ timeout: 15_000 });
  // The board opens on the user's last saved view (e.g. "Current Sprint"); the ask is ALL tasks.
  const allTab = page.getByText('All Tasks', { exact: true }).first();
  await allTab.click({ timeout: 5000 });
  await page.waitForTimeout(400);
  console.log(`  view: ${(await page.locator('.bd-card').count())} cards visible after switching to All Tasks`);

  // The detail panel is an overlay that swallows clicks; it closes from its own button, not Escape.
  const closePanel = async () => {
    for (let i = 0; i < 4 && (await page.locator('.detail-overlay').count()); i += 1) {
      await page.locator('.detail-overlay button.modal-close').first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  };
  const rows = []; let unopened = 0, shot = 0;
  for (const slug of slugs) {
    const t = truth.get(slug);
    await search.fill(''); await search.fill(t.name.slice(0, 60)); await page.waitForTimeout(350);
    await closePanel();
    const card = page.locator('.bd-card').first();
    if (!(await card.count())) { unopened++; rows.push({ slug, truth: t.empty, got: 'unopened', p: NaN }); continue; }
    await card.click();
    const panel = page.locator('.detail-overlay');
    try { await panel.waitFor({ timeout: 5000 }); } catch { unopened++; rows.push({ slug, truth: t.empty, got: 'unopened', p: NaN }); continue; }
    await page.waitForTimeout(250);
    const aria = await panel.ariaSnapshot();
    const text = await panel.innerText();
    if (shot < 2) { await page.screenshot({ path: join(SHOTS, `panel-${shot++}.png`) }); }
    const { answers, ms } = await jev(key, { screen: 'Task detail panel', task_name: t.name, accessibility_tree: aria.slice(0, 20_000), visible_text: text.slice(0, 8_000) }, {
      field_empty: noul(`In the Custom Fields section, is the "${FIELD_LABEL}" field EMPTY (no value entered)?`),
      panel_is_task: noul(`Is this the detail panel for the task named "${t.name}"?`),
    });
    const p = answers.field_empty.noul;
    rows.push({ slug, truth: t.empty, got: band(p), p, right: answers.panel_is_task.noul, ms });
    const ok = band(p) === (t.empty ? 'yes' : 'no');
    console.log(`  ${ok ? '✓' : '✗'} ${t.status.padEnd(11)} empty=${String(t.empty).padEnd(5)} jev=${p.toFixed(2)} ${ms}ms  ${t.name.slice(0, 70)}`);
    await closePanel();
  }
  await browser.close();
  return { rows, unopened };
}

// ─── API tier ────────────────────────────────────────────────────────────────
async function apiTier(base, key, truth) {
  const res = await fetch(`${base}/api/tasks?vault=${encodeURIComponent(VAULT)}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body.tasks ?? body.items ?? []);
  const withField = list.filter((t) => truth.has(t.slug));
  console.log(`  /api/tasks → ${list.length} tasks (${withField.length} matched to disk)`);
  const hasCf = withField.some((t) => t.custom_fields);
  const items = withField.map((t) => ({ slug: t.slug, name: t.name ?? t.title, status: t.status, [FIELD_LABEL]: hasCf ? (t.custom_fields?.[FIELD_KEY] ?? '') : truth.get(t.slug).value }));
  if (!hasCf) console.log('  (list API carries no custom_fields — state built from disk frontmatter instead)');

  const rows = []; const cats = {};
  const BATCH = 40;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const state = { field: FIELD_LABEL, tasks: Object.fromEntries(chunk.map((t, j) => [`t${j}`, { name: t.name, status: t.status, [FIELD_LABEL]: t[FIELD_LABEL] }])) };
    const questions = {};
    chunk.forEach((_, j) => {
      questions[`e${j}`] = noul(`Is tasks.t${j}["${FIELD_LABEL}"] empty (blank, missing, or whitespace only)?`);
      questions[`c${j}`] = choice(`Which revenue category does tasks.t${j}["${FIELD_LABEL}"] open with or clearly express?`, {
        direct_revenue: 'Direct Revenue — directly raises sales, acceptance or recovery.',
        long_term_leverage: 'Long Term Leverage — future capacity or infrastructure (hiring, systems, roadmap).',
        productivity: 'Productivity — team efficiency (onboarding, self-learning, faster process).',
        other: 'Some other category or an explanation that names none of the above.',
        empty: 'The field is empty.',
      });
    });
    const { answers, ms } = await jev(key, state, questions);
    chunk.forEach((t, j) => {
      const p = answers[`e${j}`].noul; const c = answers[`c${j}`];
      rows.push({ slug: t.slug, truth: truth.get(t.slug).empty, got: band(p), p, cat: c.choice, conf: c.confidence });
      if (!truth.get(t.slug).empty) cats[c.choice] = (cats[c.choice] ?? 0) + 1;
    });
    console.log(`  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(items.length / BATCH)}: ${chunk.length} tasks, ${chunk.length * 2} questions, ${ms} ms`);
  }
  return { rows, cats };
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const key = loadKey();
  if (!key) { console.log('unobtainable: no openRouterKey in ~/.dreamcontext/voice.json'); process.exit(2); }
  if (!existsSync(join(REPO, 'dist', 'index.js'))) { console.log('dist/index.js missing — npm run build'); process.exit(2); }
  mkdirSync(SHOTS, { recursive: true });

  const root = vaultPath(VAULT);
  const truth = groundTruth(root);
  const empties = [...truth.entries()].filter(([, v]) => v.empty);
  console.log(`\nGROUND TRUTH (disk): ${truth.size} tasks, ${empties.length} with "${FIELD_LABEL}" empty`);
  const byStatus = {}; for (const [, v] of empties) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  console.log(`  empty by status: ${JSON.stringify(byStatus)}`);

  const port = await freePort();
  const srv = await startServer(port, root);
  const base = `http://127.0.0.1:${port}`;
  try {
    console.log(`\n§A  API TIER — all ${truth.size} tasks through Jev, batched`);
    const api = argv.includes('--skip-api') ? { rows: [], cats: {} } : await apiTier(base, key, truth);
    const sA = score(api.rows);
    console.log(`  empty-detection: precision ${pct(sA.precision)} · recall ${pct(sA.recall)} · fp ${sA.fp} · fn ${sA.fn} · inconclusive ${sA.inc}`);
    console.log(`  category read on filled tasks: ${JSON.stringify(api.cats)}`);
    const missed = api.rows.filter((r) => r.truth && r.got !== 'yes').slice(0, 5);
    if (missed.length) console.log(`  missed empties (first 5): ${missed.map((m) => `${m.slug}@${m.p.toFixed(2)}`).join(', ')}`);
    const wrong = api.rows.filter((r) => !r.truth && r.got === 'yes').slice(0, 5);
    if (wrong.length) console.log(`  false empties (first 5): ${wrong.map((m) => `${m.slug}@${m.p.toFixed(2)}`).join(', ')}`);

    // Balanced UI sample: half known-empty, half known-filled, capped.
    const filled = [...truth.entries()].filter(([, v]) => !v.empty);
    const half = Math.ceil(Math.min(UI_CAP, truth.size) / 2);
    const pick = (arr, n) => arr.slice(0, n).map(([slug]) => slug);
    const slugs = UI_CAP === Infinity ? [...truth.keys()] : [...pick(empties, half), ...pick(filled, half)];
    console.log(`\n§B  UI TIER — ${slugs.length} detail panels opened in the real dashboard, Jev reads each`);
    const ui = await uiTier(base, key, truth, slugs);
    const sB = score(ui.rows.filter((r) => r.got !== 'unopened'));
    console.log(`  empty-detection: precision ${pct(sB.precision)} · recall ${pct(sB.recall)} · fp ${sB.fp} · fn ${sB.fn} · inconclusive ${sB.inc} · unopened ${ui.unopened}`);
    const jevEmpties = api.rows.filter((r) => r.got === 'yes').map((r) => r.slug);
    console.log(`\nJEV'S ANSWER (API tier): ${jevEmpties.length} tasks have "${FIELD_LABEL}" empty · truth ${empties.length}`);
  } finally { srv.kill(); }
  console.log(`\nJev: ${calls} calls · ${msTotal} ms total · $${spent.toFixed(5)} · screenshots ${SHOTS}`);
})().catch((e) => { console.error(e); process.exit(1); });
