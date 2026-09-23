#!/usr/bin/env node
/**
 * SPIKE — TypeSafe Jev as a semantic assertion layer over a Playwright-driven dreamcontext.
 *
 *   npm run build && node scripts/verify/jev-spike-recall-settings.mjs
 *
 * THE QUESTION THIS ANSWERS. Can a System One model (Jev, via OpenRouter's decisions API)
 * read the TEXT state Playwright already emits — the aria snapshot and the visible text —
 * and answer plain-language acceptance criteria about the real dashboard, fast and cheaply,
 * without a screenshot and without a frontier LLM reading the page?
 *
 * WHAT IT DRIVES. The real dashboard server on a scratch vault. Settings › Recall. It reads
 * the page BEFORE (default: Haiku), asks Jev, then CLICKS Hybrid, waits for the PATCH to
 * land, re-reads, asks again. Every Jev answer is compared against DOM/API ground truth,
 * so a wrong verdict shows up as a ✗ here, not as a trusted PASS.
 *
 * DECOYS ON PURPOSE. Two questions ask about things NOT on the page. A model that says
 * "yes" to everything would pass the positives and fail these.
 *
 * KEY. `~/.dreamcontext/voice.json` → `openRouterKey` (the J.A.R.V.I.S key). It is read into
 * memory and sent as a bearer header, never printed. No key → exit 2 with `unobtainable`,
 * per the fail-open pattern: a gate that cannot run must say so, not pass.
 *
 * SCRATCH HOME, ALWAYS. Nothing here touches the developer's real vaults or ~/.claude.json.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dc-jev-spike-recall');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-jev-spike');

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';
/** Pass above, fail below, inconclusive between — jev-assert's bands, to be tuned on data. */
const PASS_AT = 0.85;
const FAIL_AT = 0.15;

// ─── Key (in memory only) ────────────────────────────────────────────────────

function loadKey() {
  try {
    const raw = readFileSync(join(homedir(), '.dreamcontext', 'voice.json'), 'utf-8');
    const k = JSON.parse(raw).openRouterKey;
    return typeof k === 'string' && k.length > 10 ? k : null;
  } catch {
    return null;
  }
}

// ─── Jev ─────────────────────────────────────────────────────────────────────

const noul = (instructions) => ({ type: 'noul', instructions });
const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });

let spent = 0;
async function jev(key, state, questions) {
  const t0 = Date.now();
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  spent += body.usage?.cost ?? 0;
  return { answers: body.answers, ms, usage: body.usage };
}

const band = (p) => (p >= PASS_AT ? 'yes' : p <= FAIL_AT ? 'no' : 'inconclusive');

// ─── Page state: what Playwright gives us as TEXT ────────────────────────────

async function pageState(page, label) {
  const aria = await page.locator('main, [role=main], body').first().ariaSnapshot();
  const text = await page.locator('body').innerText();
  return {
    screen: label,
    url: page.url(),
    accessibility_tree: aria.slice(0, 20_000),
    visible_text: text.slice(0, 8_000),
  };
}

// ─── Scaffold ────────────────────────────────────────────────────────────────

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const cli = (args) => {
    const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args],
      { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  };
  cli(['vaults', 'add', 'proj', PROJ]);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n`);
  chmodSync(bin, 0o755);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

// ─── Report ──────────────────────────────────────────────────────────────────

const report = { pass: 0, fail: 0, rows: [] };
function check(label, ok, ev) {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}
/** One Jev verdict against ground truth. `expect` is 'yes' | 'no'. */
function judge(label, p, expect) {
  const got = band(p);
  const ok = got === expect;
  report.rows.push({ label, p: p.toFixed(2), got, expect, ok });
  check(`${label}  →  p=${p.toFixed(2)} (${got}), truth=${expect}`, ok);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function run(base, key) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const truth = async () => (await (await fetch(`${base}/api/sleep?vault=proj`)).json()).recall_mode ?? 'haiku';

  await page.goto(`${base}/?vault=proj&page=settings`, { waitUntil: 'domcontentloaded' });
  // A never-seen vault raises the "What's New" modal, whose scrim swallows every click.
  // It opens late (behind its own fetch), so this retries rather than checking once.
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(500);
    if (await page.locator('.announcements-modal-scrim').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
  }
  await page.getByRole('button', { name: 'Recall' }).click();
  await page.locator('[role=radiogroup][aria-label="Recall"]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, '1-before.png') });

  const QUESTIONS = {
    on_recall: noul('Is the Recall section of Settings the one currently displayed, with its recall-mode options visible?'),
    hybrid_selected: noul('Is the "Hybrid" recall mode the currently SELECTED option?'),
    selected_mode: choice('Which recall mode is currently selected?', {
      haiku: 'The Haiku option is selected.',
      raw: 'The Raw / BM25-only option is selected.',
      hybrid: 'The Hybrid option is selected.',
      off: 'The Off option is selected.',
    }),
    hybrid_experimental: noul('Is the Hybrid option marked as experimental?'),
    embedding_card: noul('Is a model download (with a progress indicator) shown in progress under the Hybrid option?'),
    // decoys — not on this screen
    github_token_field: noul('Is a GitHub token input field visible on this screen?'),
    error_shown: noul('Is an error message currently displayed on this screen?'),
  };

  console.log('\n§1  BEFORE — default mode, Jev reads the page');
  const before = await pageState(page, 'Settings › Recall, before any change');
  const t1 = await truth();
  const r1 = await jev(key, before, QUESTIONS);
  console.log(`      latency ${r1.ms} ms · ${r1.usage.input_tokens} tokens in · $${r1.usage.cost.toFixed(6)}`);
  judge('recall section is shown', r1.answers.on_recall.noul, 'yes');
  judge('hybrid is selected (should NOT be)', r1.answers.hybrid_selected.noul, t1 === 'hybrid' ? 'yes' : 'no');
  check(`selected mode = ${r1.answers.selected_mode.choice} (conf ${r1.answers.selected_mode.confidence.toFixed(2)}), truth=${t1}`,
    r1.answers.selected_mode.choice === t1 && r1.answers.selected_mode.confidence >= PASS_AT);
  judge('hybrid labelled experimental', r1.answers.hybrid_experimental.noul, 'yes');
  judge('model download shown (should NOT be yet)', r1.answers.embedding_card.noul, 'no');
  judge('DECOY: github token field visible', r1.answers.github_token_field.noul, 'no');
  judge('DECOY: an error is shown', r1.answers.error_shown.noul, 'no');

  console.log('\n§2  ACT — click Hybrid, wait for the PATCH to land');
  const patched = page.waitForResponse((r) => r.url().includes('/api/sleep') && r.request().method() === 'PATCH', { timeout: 10_000 });
  await page.locator('label.setting-choice', { hasText: 'Hybrid' }).click();
  const resp = await patched;
  check(`PATCH /api/sleep → ${resp.status()}`, resp.ok());
  await page.waitForTimeout(500);
  const t2 = await truth();
  check(`API ground truth recall_mode = ${t2}`, t2 === 'hybrid');
  await page.screenshot({ path: join(SHOTS, '2-after.png') });

  console.log('\n§3  AFTER — Jev re-reads the page');
  const after = await pageState(page, 'Settings › Recall, after clicking Hybrid');
  const r2 = await jev(key, after, QUESTIONS);
  console.log(`      latency ${r2.ms} ms · ${r2.usage.input_tokens} tokens in · $${r2.usage.cost.toFixed(6)}`);
  judge('recall section is shown', r2.answers.on_recall.noul, 'yes');
  judge('hybrid is selected', r2.answers.hybrid_selected.noul, 'yes');
  check(`selected mode = ${r2.answers.selected_mode.choice} (conf ${r2.answers.selected_mode.confidence.toFixed(2)}), truth=${t2}`,
    r2.answers.selected_mode.choice === t2 && r2.answers.selected_mode.confidence >= PASS_AT);
  judge('model download shown', r2.answers.embedding_card.noul, 'yes');
  judge('DECOY: github token field visible', r2.answers.github_token_field.noul, 'no');
  judge('DECOY: an error is shown', r2.answers.error_shown.noul, 'no');

  console.log('\n§4  PLAIN-LANGUAGE ACCEPTANCE CRITERIA — the shape a task file would carry');
  const criteria = {
    ac1: noul('The user can pick between at least four recall modes.'),
    ac2: noul('Hybrid recall mode is enabled.'),
    ac3: noul('The Hybrid option explains that it falls back to BM25 when the embedding model is unavailable.'),
    ac4: noul('The Hybrid option warns that first use downloads a model of roughly 100 MB.'),
    ac5: noul('Recall is turned off.'),
  };
  const r3 = await jev(key, after, criteria);
  console.log(`      latency ${r3.ms} ms · $${r3.usage.cost.toFixed(6)}`);
  judge('AC1 four or more modes', r3.answers.ac1.noul, 'yes');
  judge('AC2 hybrid enabled', r3.answers.ac2.noul, 'yes');
  judge('AC3 fallback to BM25 explained', r3.answers.ac3.noul, 'yes');
  judge('AC4 ~100 MB download warned', r3.answers.ac4.noul, 'yes');
  judge('AC5 recall is off (should be NO)', r3.answers.ac5.noul, 'no');

  await browser.close();
  return { states: { beforeChars: JSON.stringify(before).length, afterChars: JSON.stringify(after).length } };
}

(async () => {
  const key = loadKey();
  if (!key) {
    console.log('unobtainable: no openRouterKey in ~/.dreamcontext/voice.json — Jev gate cannot run, nothing judged.');
    process.exit(2);
  }
  if (!existsSync(join(REPO, 'dist', 'index.js'))) {
    console.log('dist/index.js missing — run npm run build first.');
    process.exit(2);
  }
  setup();
  const port = await freePort();
  const srv = await startServer(port);
  let extra = {};
  try {
    extra = await run(`http://127.0.0.1:${port}`, key);
  } finally {
    srv.kill();
  }
  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed · Jev spend $${spent.toFixed(5)} · state sizes ${extra.states?.beforeChars ?? '?'} / ${extra.states?.afterChars ?? '?'} chars`);
  console.log(`screenshots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
