#!/usr/bin/env node
/**
 * assert — a scripted route, judged in plain language.
 *
 *   node .claude/skills/jev-verify/scripts/assert.mjs --spec checks.json [--out tmp/jev-assert]
 *        [--device desktop|iphone] [--headed] [--no-redact] [--max-spend 0.25]
 *
 * The spec drives Playwright deterministically (navigation and measurement are CODE) and at every
 * `expect` checkpoint hands the page's aria snapshot + visible text to Jev in ONE batched call:
 * each criterion becomes a Noul, each `reject` a Noul that must come back low. The verdict per
 * criterion is a band, not a boolean: pass ≥ 0.85, fail ≤ 0.15, anything between is INCONCLUSIVE
 * and reported as such — a human decides, the script never rounds it up.
 *
 * SPEC (strict: unknown keys and unknown step kinds fail the run — a skipped assertion that
 * reports PASS is the one outcome this pack exists to prevent)
 * {
 *   "url": "http://localhost:5173/?page=settings",   // http(s) only; every goto must share its origin
 *   "device": "desktop",                              // optional; iphone | android | ipad | <Playwright device>
 *   "settle": 400,                                    // optional ms after each action (default 400)
 *   "steps": [
 *     { "goto": "http://localhost:5173/?page=tasks" },
 *     { "dismiss": ".modal-scrim", "timeout": 3000 },         // watch for a late modal; Escape whenever it shows
 *     { "click": "role=button[name='Recall']" },              // any Playwright selector string
 *     { "fill": { "selector": "input[type=email]", "value": "m@m.com" } },   // value may be "env:VAR_NAME"
 *     { "select": { "selector": "select#plan", "value": "pro" } },
 *     { "press": "Escape" },
 *     { "wait": 500 },
 *     { "waitFor": "[role=radiogroup]" },                     // a selector to appear
 *     { "click": "label:has-text('Hybrid')", "waitForResponse": { "url": "/api/sleep", "method": "PATCH" } },
 *                                                          // arm the response listener on the SAME step as the click
 *     { "expect": ["Hybrid recall mode is the selected option"],
 *       "reject": ["An error message is shown"],              // optional decoys, must be NO
 *       "scope": "main", "label": "Settings › Recall after click" }
 *   ]
 * }
 *
 * Write criteria in the words the SCREEN uses. "Embedding card visible" scored 0.28 on a screen
 * that said "Downloading model… 0%"; "a model download is shown in progress" scored 0.99.
 *
 * WHAT LEAVES THE MACHINE: the criteria you wrote plus url, title, aria snapshot and visible text
 * of the scope, PII-masked by default (--no-redact to send literal values). Screenshots never do.
 *
 * OUTPUT  <out>/report.json, <out>/report.md, <out>/NN-<label>.png per checkpoint (dir is 0700 + self-gitignored).
 * EXIT    0 all pass · 1 any fail (or route broke) · 3 inconclusive only · 2 unobtainable (no key / no browser).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveKey, createJev, noul, band, OBSERVATION_RULE, UNOBTAINABLE_HINT, DEFAULT_MAX_SPEND_USD } from './lib/jev.mjs';
import { loadPlaywright, contextOptions } from './lib/playwright.mjs';
import { pageState } from './lib/page.mjs';
import { parseArgs, MARK, foldExit, exitWord, writeReports, dieUnobtainable, say, ensureOutDir, setPiiRedaction, isBrowserMissing, assertKeyNotOnArgv, registerSecret } from './lib/report.mjs';

const args = parseArgs(process.argv.slice(2));
if (typeof args.spec !== 'string' || (args.out !== undefined && typeof args.out !== 'string')) { say('usage: assert.mjs --spec <file.json> [--out dir] [--device desktop|iphone] [--headed] [--no-redact] [--max-spend usd]'); process.exit(2); }

// ─── Spec grammar (allow-listed) ─────────────────────────────────────────────
const STEP_KINDS = new Set(['goto', 'dismiss', 'click', 'fill', 'select', 'press', 'wait', 'waitFor', 'waitForResponse', 'expect', 'reject', 'scope', 'label', 'timeout']);
const TOP_KEYS = new Set(['url', 'device', 'settle', 'steps', 'name']);
const SENSITIVE_FILL = /password|cc-|card|cvc|cvv/i;

function specError(msg) { say(`✗ spec error: ${msg}`); process.exit(1); }
function checkUrl(u, origin) {
  let parsed;
  try { parsed = new URL(u); } catch { specError(`"${u}" is not a URL`); }
  if (!/^https?:$/.test(parsed.protocol)) specError(`"${u}" — only http(s) URLs may be visited`);
  if (origin && parsed.origin !== origin) specError(`"${u}" leaves the spec's origin ${origin}`);
  return parsed;
}
function validate(spec) {
  for (const k of Object.keys(spec)) if (!TOP_KEYS.has(k)) specError(`unknown top-level key "${k}"`);
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) specError('"steps" must be a non-empty array');
  // The origin is pinned to the FIRST navigation — spec.url, else the first goto — and every later
  // goto must match it. Without this, a spec that omits `url` could carry the project's cookies
  // and env-filled credentials to any origin and ship that page to OpenRouter.
  let origin = spec.url ? checkUrl(spec.url).origin : null;
  spec.steps.forEach((step, i) => {
    const keys = Object.keys(step);
    for (const k of keys) if (!STEP_KINDS.has(k)) specError(`step ${i}: unknown key "${k}"`);
    // `waitForResponse` may ride on the same step as the action that triggers it — the listener
    // must be armed BEFORE the click, or the response wins the race and the wait times out.
    const actions = keys.filter((k) => !['scope', 'label', 'timeout', 'reject'].includes(k) && !(k === 'waitForResponse' && keys.some((o) => ['click', 'fill', 'select', 'press', 'goto'].includes(o))));
    if (actions.length !== 1 && !(actions.length === 0 && step.reject)) specError(`step ${i}: exactly one action per step (got ${actions.join(', ') || 'none'})`);
    if (step.goto) origin = checkUrl(step.goto, origin).origin;
    if (step.fill) {
      if (typeof step.fill.selector !== 'string' || step.fill.value === undefined) specError(`step ${i}: fill needs {selector, value}`);
      if (SENSITIVE_FILL.test(step.fill.selector) && !/^env:[A-Z_][A-Z0-9_]*$/.test(String(step.fill.value))) specError(`step ${i}: a password/card field may only be filled from an env reference ("env:VAR")`);
    }
    if (step.waitForResponse && typeof step.waitForResponse.url !== 'string') specError(`step ${i}: waitForResponse needs {url, method?}`);
    for (const k of ['expect', 'reject']) {
      if (k in step && (!Array.isArray(step[k]) || step[k].length === 0 || step[k].some((c) => typeof c !== 'string' || !c.trim()))) specError(`step ${i}: ${k} must be a non-empty array of sentences`);
    }
  });
}
const isEnvRef = (v) => /^env:[A-Z_][A-Z0-9_]*$/.test(String(v));
function fillValue(v) {
  const m = /^env:([A-Z_][A-Z0-9_]*)$/.exec(String(v));
  if (!m) return String(v);
  const val = process.env[m[1]];
  if (!val) specError(`env reference ${m[1]} is not set`);
  registerSecret(val); // an env-filled value is a secret: masked in state, reports and traces
  return val;
}

const spec = JSON.parse(readFileSync(resolve(args.spec), 'utf-8'));
validate(spec);
const OUT = ensureOutDir(resolve(args.out ?? join('tmp', 'jev-assert')));
const SETTLE = Number(spec.settle ?? 400);
const DEVICE = args.device ?? spec.device ?? 'desktop';
setPiiRedaction(args.redact !== false);

const { key, refused } = resolveKey();
assertKeyNotOnArgv(key);
if (!key) dieUnobtainable(refused ?? UNOBTAINABLE_HINT);
let pw;
try { pw = await loadPlaywright(); } catch (e) { dieUnobtainable(e.message); }
const jev = createJev({ key, maxSpend: Number(args['max-spend'] ?? DEFAULT_MAX_SPEND_USD) });

let browser;
try { browser = await pw.chromium.launch({ headless: !args.headed }); }
catch (e) { if (isBrowserMissing(e)) dieUnobtainable('Chromium is not installed — run: npx playwright install chromium'); throw e; }
const ctx = await browser.newContext(contextOptions(pw.devices, DEVICE));
const page = await ctx.newPage();

const results = [];
const checkpoints = [];
let shot = 0;
let truncationWarned = 0;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'checkpoint';

function armResponse(step) {
  if (!step.waitForResponse) return null;
  const { url, method } = step.waitForResponse;
  return page.waitForResponse((r) => r.url().includes(url) && (!method || r.request().method() === method), { timeout: step.timeout ?? 15_000 });
}

async function runStep(step, i) {
  const timeout = step.timeout ?? 10_000;
  const hasAction = ['click', 'fill', 'select', 'press', 'goto'].some((k) => k in step);
  const armed = hasAction ? armResponse(step) : null;   // listener up BEFORE the action
  if (step.goto) { await page.goto(step.goto, { waitUntil: 'domcontentloaded' }); if (armed) await armed; return; }
  if (step.click) { await page.locator(step.click).first().click({ timeout }); if (armed) await armed; return; }
  if (step.fill) {
    const l = page.locator(step.fill.selector).first();
    // Trust the live element, not the selector's wording: a password/card/OTP field takes only env: values.
    const [type, ac] = await Promise.all([l.getAttribute('type'), l.getAttribute('autocomplete')]);
    const sensitive = type === 'password' || /current-password|new-password|one-time-code|^cc-/i.test(ac ?? '');
    if (sensitive && !isEnvRef(step.fill.value)) throw new Error(`refused to fill a ${type ?? ac} field with a literal value — use "env:VAR"`);
    await l.click({ timeout }); await l.fill(fillValue(step.fill.value)); if (armed) await armed; return;
  }
  if (step.select) { await page.locator(step.select.selector).first().selectOption(String(step.select.value), { timeout }); if (armed) await armed; return; }
  if (step.press) { await page.keyboard.press(step.press); if (armed) await armed; return; }
  if (step.wait) { await page.waitForTimeout(Number(step.wait)); return; }
  if (step.waitFor) { await page.locator(step.waitFor).first().waitFor({ timeout: step.timeout ?? 15_000 }); return; }
  if (step.waitForResponse) { await armResponse(step); return; }   // standalone: only for responses that have not fired yet
  if (step.dismiss) {
    // A late-opening scrim (a "what's new" modal behind its own fetch) is not there yet when the
    // step runs and swallows the NEXT click. Watch the whole window; Escape whenever it shows.
    const until = Date.now() + (step.timeout ?? 3000);
    while (Date.now() < until) {
      if (await page.locator(step.dismiss).count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
      else await page.waitForTimeout(250);
    }
    return;
  }
  if (step.expect || step.reject) {
    const expects = step.expect ?? [];
    const rejects = step.reject ?? [];
    const label = step.label ?? `checkpoint ${checkpoints.length + 1}`;
    const { observation, truncated } = await pageState(page, { scope: step.scope, label });
    if (truncated.aria || truncated.text) {
      truncationWarned += 1;
      say(`  ⚠ ${label}: page state hit the size cap (${truncated.aria ? 'aria ' : ''}${truncated.text ? 'text' : ''}) — add a "scope" so the judged region is fully in view; verdicts below may be about a page Jev did not fully see.`);
    }
    const questions = {};
    expects.forEach((c, j) => { questions[`e${j}`] = noul(OBSERVATION_RULE + c); });
    rejects.forEach((c, j) => { questions[`r${j}`] = noul(OBSERVATION_RULE + c); });
    shot += 1;
    const file = `${String(shot).padStart(2, '0')}-${slug(label)}.png`;
    await page.screenshot({ path: join(OUT, file) }).catch(() => {});
    const { answers, ms } = await jev.ask({ observation }, questions);
    say(`\n§ ${label}  (${ms} ms, ${expects.length + rejects.length} criteria, state ${JSON.stringify(observation).length} chars)`);
    const rows = [];
    expects.forEach((c, j) => {
      const p = Number(answers[`e${j}`]?.noul ?? NaN);
      const b = Number.isNaN(p) ? 'inconclusive' : band(p);
      const verdict = b === 'yes' ? 'pass' : b === 'no' ? 'fail' : 'inconclusive';
      rows.push({ kind: 'expect', criterion: c, p, band: b, verdict });
      say(`  ${MARK[b]} ${c}  →  p=${p.toFixed(2)} (${verdict})`);
    });
    rejects.forEach((c, j) => {
      const p = Number(answers[`r${j}`]?.noul ?? NaN);
      const b = Number.isNaN(p) ? 'inconclusive' : band(p);
      const verdict = b === 'no' ? 'pass' : b === 'yes' ? 'fail' : 'inconclusive';
      rows.push({ kind: 'reject', criterion: c, p, band: b, verdict });
      say(`  ${MARK[verdict === 'pass' ? 'yes' : verdict === 'fail' ? 'no' : 'inconclusive']} NOT: ${c}  →  p=${p.toFixed(2)} (${verdict})`);
    });
    checkpoints.push({ index: i, label, url: page.url(), screenshot: file, ms, truncated, rows });
    results.push(...rows);
  }
}

let fatal = null;
try {
  if (spec.url) await page.goto(spec.url, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < spec.steps.length; i += 1) {
    const step = spec.steps[i];
    try { await runStep(step, i); }
    catch (e) {
      fatal = { step: i, action: Object.keys(step)[0], error: String(e.message).split('\n')[0].slice(0, 200) };
      say(`\n✗ step ${i} (${fatal.action}) failed: ${fatal.error}`);
      shot += 1;
      await page.screenshot({ path: join(OUT, `${String(shot).padStart(2, '0')}-failed-step-${i}.png`) }).catch(() => {});
      break;
    }
    if (!step.expect && !step.reject && !step.wait) await page.waitForTimeout(SETTLE);
  }
} finally {
  await browser.close();
}

const verdicts = results.map((r) => r.verdict);
if (fatal) verdicts.push('fail');
if (results.length === 0) { say('✗ no criteria were judged — a run with nothing to check cannot pass'); verdicts.push('fail'); }
const code = foldExit(verdicts);
const counts = { pass: verdicts.filter((v) => v === 'pass').length, fail: verdicts.filter((v) => v === 'fail').length, inconclusive: verdicts.filter((v) => v === 'inconclusive').length };

const md = [
  `# jev-verify assert — ${exitWord(code)}`, '',
  `Spec: \`${args.spec}\` · device: ${DEVICE} · ${counts.pass} pass · ${counts.fail} fail · ${counts.inconclusive} inconclusive · ${jev.summary()}${truncationWarned ? ` · ⚠ ${truncationWarned} checkpoint(s) hit the state cap` : ''}`, '',
  ...(fatal ? [`**Route broke at step ${fatal.step} (${fatal.action}):** ${fatal.error}`, ''] : []),
  ...checkpoints.flatMap((cp) => [
    `## ${cp.label}`, '', `\`${cp.url}\` · ${cp.ms} ms`, '', `![${cp.label}](${cp.screenshot})`, '',
    '| | criterion | p | verdict |', '|---|---|---|---|',
    ...cp.rows.map((r) => `| ${r.kind === 'reject' ? 'NOT' : ''} | ${r.criterion} | ${r.p.toFixed(2)} | ${r.verdict} |`), '',
  ]),
].join('\n');

writeReports(OUT, { json: { verdict: exitWord(code), exitCode: code, spec: args.spec, device: DEVICE, counts, fatal, truncationWarned, checkpoints, usage: jev.usage }, md });
say(`\n${exitWord(code)} — ${counts.pass} pass · ${counts.fail} fail · ${counts.inconclusive} inconclusive · ${jev.summary()}\nreport: ${join(OUT, 'report.md')}`);
process.exit(code);
