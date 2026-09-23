#!/usr/bin/env node
/**
 * walk — Jev drives a flow on its own; every new screen is screenshotted and indexed.
 *
 *   node .claude/skills/jev-verify/scripts/walk.mjs <url> [--goal "…"] [--email test@example.com]
 *        [--fill first_name=Ada --fill age=31] [--max 80] [--device iphone] [--out tmp/jev-walk]
 *        [--max-spend 0.25] [--past-payment] [--no-redact]
 *
 * Each step is ONE Jev call over the page's text state (visible text + every offerable interactive
 * element, numbered) with three questions: which element to act on (a Choice over the elements
 * plus scroll_down / wait / done), whether the goal is reached (Noul), whether the walk is stuck
 * (Noul). CODE owns everything Jev must not: what gets typed, when to stop, what is never offered.
 *
 * NEVER OFFERED, NEVER CLICKED — the guard is on the ACT side, checked twice (when building the
 * option set and again at the click), because a deny-list on observation only delays the stop by
 * one step:
 *   · anything labelled like a purchase (pay / buy / checkout / place order / subscribe / Apple Pay /
 *     Google Pay / PayPal / Klarna / "start my plan" …) — PURCHASE_RE in page.mjs
 *   · disabled controls · page chrome (menu / back / close / home and language links, nav links)
 *   · password, file, tel and one-time-code inputs — never typed into, in any language
 * The walk also STOPS when a payment control becomes visible (card fields, PSP frames, wallet
 * buttons) unless --past-payment, which only lets it keep observing; purchase controls stay unclickable.
 *
 * WHAT GETS TYPED. Jev picks a KIND ("this field asks for an age"); code picks the string from a
 * fixed table (--fill overrides). Page text never becomes typed text. The email you pass is the
 * only identity the walker will ever supply — it appears in report.md and reaches Jev inside the
 * page text (masked unless --no-redact). Use a disposable address and a staging environment.
 *
 * PROGRESS. Two fingerprints: SCREEN (url + text) decides screenshots; STATE also folds in input
 * values and checked marks so a fill or a tick counts as progress. A pick that changed nothing is
 * withdrawn for the retry. Waits are capped per screen and never count as failed actions.
 * Stop: goal ≥ 0.85 · Jev says done · 3 no-op steps with stuck ≥ 0.85 · 5 no-op steps · step
 * budget · spend ceiling · payment control visible · ANY extraction error (fail closed).
 *
 * OUTPUT <out>/NN.png per screen, trace.jsonl per step, index.md, report.json (dir 0700, self-gitignored).
 * EXIT   0 goal / done / payment_reached · 1 stuck / max_steps / error · 2 unobtainable.
 */

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveKey, createJev, noul, choice, OBSERVATION_RULE, UNOBTAINABLE_HINT, DEFAULT_MAX_SPEND_USD, EXIT } from './lib/jev.mjs';
import { loadPlaywright, contextOptions } from './lib/playwright.mjs';
import { extract, screenFingerprint, stateFingerprint, isTypeable, isOfferable, isPurchaseControl, isSensitiveInput } from './lib/page.mjs';
import { parseArgs, dieUnobtainable, say, ensureOutDir, appendTrace, setPiiRedaction, redact, redactPii, sanitizeText, isBrowserMissing, assertKeyNotOnArgv } from './lib/report.mjs';

const args = parseArgs(process.argv.slice(2));
const URL_ = args._.find((a) => /^https?:\/\//.test(a));
if (!URL_) { say('usage: walk.mjs <url> [--goal "…"] [--email …] [--fill k=v]… [--max 80] [--device iphone|desktop] [--out dir] [--max-spend usd] [--past-payment] [--no-redact]'); process.exit(2); }
const GOAL = args.goal ?? 'Move through this flow as a plausible new user until its end screen (a paywall, plan selection, checkout, confirmation or dashboard) is reached. Pick answers a real user would pick, prefer the primary continue action, accept cookie banners, and do not go back.';
const EMAIL = args.email ?? 'test@example.com';
const MAX_STEPS = Number(args.max ?? 80);
const OUT = ensureOutDir(resolve(args.out ?? join('tmp', 'jev-walk-' + (URL_.match(/(\d+)\/?$/)?.[1] ?? 'flow'))));
const DEVICE = args.device ?? 'iphone';
const PAST_PAYMENT = args['past-payment'] === true;
setPiiRedaction(args.redact !== false);

// Jev picks a KIND; code picks the string. No password, no phone, no card — those inputs are
// never typeable (page.mjs); a kind with an empty value is skipped and logged, never guessed.
const FILL_KINDS = {
  email: 'An email address.', first_name: 'A first name or nickname.', full_name: 'A full name.', age: 'An age in years.',
  height: 'Body height.', weight: 'Body weight (current).', target_weight: 'A goal / target weight.',
  code: 'A verification / promo code.', other_text: 'Free text of another kind.',
};
const FILL_VALUES = { email: EMAIL, first_name: 'Ada', full_name: 'Ada Test', age: '31', height: '170', weight: '70', target_weight: '65', code: '', other_text: 'test' };
for (const kv of [].concat(args.fill ?? [])) { const [k, ...v] = String(kv).split('='); if (k in FILL_VALUES) FILL_VALUES[k] = v.join('='); }

const { key, refused } = resolveKey();
assertKeyNotOnArgv(key);
if (!key) dieUnobtainable(refused ?? UNOBTAINABLE_HINT);
let pw;
try { pw = await loadPlaywright(); } catch (e) { dieUnobtainable(e.message); }
const jev = createJev({ key, maxSpend: Number(args['max-spend'] ?? DEFAULT_MAX_SPEND_USD) });

let browser;
try { browser = await pw.chromium.launch(); }
catch (e) { if (isBrowserMissing(e)) dieUnobtainable('Chromium is not installed — run: npx playwright install chromium'); throw e; }
const ctx = await browser.newContext(contextOptions(pw.devices, DEVICE));
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const index = [];
const history = [];
let lastFp = '', lastStateFp = '', sameCount = 0, shots = 0, waits = 0, status = 'max_steps', error = null;

try {
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const st = await extract(page); // throws → fail closed (catch below)
    const url = redactPii(sanitizeText(page.url()));
    const fp = screenFingerprint(url, st.text);
    const sfp = stateFingerprint(url, st.text, st.elements);
    const newScreen = fp !== lastFp;
    const progressed = sfp !== lastStateFp;
    lastStateFp = sfp;
    if (newScreen) {
      shots += 1;
      const file = `${String(shots).padStart(2, '0')}.png`;
      await page.screenshot({ path: join(OUT, file) });
      index.push({ n: shots, step, file, url, title: st.title, text: st.text.slice(0, 160) });
    }
    sameCount = progressed ? 0 : (history.at(-1)?.action === 'wait' ? sameCount : sameCount + 1);
    if (progressed) waits = 0;
    lastFp = fp;

    if (st.hasPayment && !PAST_PAYMENT) { status = 'payment_reached'; say(`\n■ step ${step}: a payment control is visible — stopping before any purchase path.`); break; }

    if (sameCount >= 2) {
      const closer = page.locator('[role=dialog] [aria-label*="close" i], nav [aria-label*="close" i], [aria-label="Close menu"]').first();
      if (await closer.count()) { await closer.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(500); }
    }

    const opts = {};
    const withheld = [];
    for (const e of st.elements) {
      if (!isOfferable(e)) { withheld.push(e.id); continue; }
      opts[e.id] = `${e.tag}${e.type ? `[${e.type}]` : ''}${e.role ? `(${e.role})` : ''}${e.checked ? ' [checked]' : ''}${e.value ? ` [value: ${e.value}]` : ''}: ${e.text || '(no text)'}`;
    }
    // Next-best fallback: withdraw the picks that changed nothing on THIS screen. (slice(-0) is the
    // whole history — guard the zero case; element ids are reused across screens.)
    if (!progressed && sameCount > 0) for (const h of history.slice(-sameCount)) { const id = String(h.action).split(' ')[0]; if (id !== 'wait') delete opts[id]; }
    if (st.scrollY < st.scrollMax) opts.scroll_down = 'Scroll down to reveal more of the page.';
    if (waits < 4) opts.wait = 'Wait — the page is still loading or animating.';
    opts.done = 'The goal is reached; stop here.';

    const state = {
      goal: GOAL,
      step,
      observation: {
        url, title: st.title, visible_text: st.text,
        interactive_elements: st.elements.filter((e) => opts[e.id]).map(({ id, tag, type, role, text, value, checked, in_viewport }) => ({ id, tag, type, role, text, value, checked, in_viewport })),
      },
      recent_actions: history.slice(-6),
      last_action_changed_screen: progressed,
      note: progressed
        ? 'Email fields receive the test address; code types values — you only pick the element.'
        : 'The last action changed NOTHING on screen. Pick a DIFFERENT element — usually an option must be selected before the continue button works.',
    };
    const { answers, ms } = await jev.ask(state, {
      action: choice(OBSERVATION_RULE + 'Which ONE element should be acted on next (or scroll/wait/done) to make progress toward the caller\'s goal?', opts),
      goal: noul(OBSERVATION_RULE + 'Has the flow reached its END screen — a plan selection, paywall, checkout, confirmation or dashboard?'),
      stuck: noul(OBSERVATION_RULE + 'Is the walk stuck, repeating the same screen or actions without progress?'),
    });
    const a = answers.action, goal = Number(answers.goal?.noul ?? 0), stuck = Number(answers.stuck?.noul ?? 0);
    const picked = st.elements.find((e) => e.id === a?.choice);
    const p = Number(a?.probabilities?.[a?.choice] ?? 0);
    say(`step ${String(step).padStart(2)} ${newScreen ? '📸' : '  '} goal=${goal.toFixed(2)} stuck=${stuck.toFixed(2)} ${ms}ms → ${a?.choice} (${p.toFixed(2)}) ${picked ? opts[picked.id]?.slice(0, 70) ?? '' : ''}   ${url.replace(/^https?:\/\//, '').slice(0, 60)}`);
    appendTrace(OUT, { step, url, progressed, sameCount, waits, text: st.text.slice(0, 600), options: opts, withheld, pick: a?.choice, p, goal, stuck });
    if (index.at(-1)?.step === step) Object.assign(index.at(-1), { action: opts[a?.choice], p, goal, stuck });

    if (goal >= 0.85 || a?.choice === 'done') { status = goal >= 0.85 ? 'goal_reached' : 'done'; break; }
    if ((stuck >= 0.85 && sameCount >= 3) || sameCount >= 5) { status = 'stuck'; break; }

    let acted = a?.choice ?? 'none';
    try {
      if (a?.choice === 'scroll_down') await page.mouse.wheel(0, 600);
      else if (a?.choice === 'wait') { waits += 1; await page.waitForTimeout(4000); }
      else if (picked) {
        // Second check at the click site: the option set was mutated between pick and act.
        if (isPurchaseControl(picked) || !isOfferable(picked)) { status = 'purchase_guard'; say(`\n■ step ${step}: refused to click "${picked.text}" — purchase or guarded control.`); break; }
        const loc = page.locator(`[data-jev="${picked.id}"]`).first();
        if (picked.tag === 'input' && picked.type === 'range') {
          await loc.focus(); for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
          acted = `${a.choice} slider +5`;
        } else if (isSensitiveInput(picked)) {
          acted = `${a.choice} skipped (sensitive input: ${picked.type}${picked.autocomplete ? `/${picked.autocomplete}` : ''})`;
        } else if (isTypeable(picked)) {
          let kind = picked.type === 'email' ? 'email' : null;
          if (!kind) {
            const { answers: k } = await jev.ask({ observation: { field: picked, page_text: st.text.slice(0, 1200) } }, { kind: choice(OBSERVATION_RULE + 'What does this input field ask for?', FILL_KINDS) });
            kind = k.kind?.choice ?? 'other_text';
          }
          const val = FILL_VALUES[kind] ?? '';
          if (val === '') acted = `${a.choice} skipped (no value configured for ${kind})`;
          else { await loc.click({ timeout: 4000 }); await loc.fill(val); acted = `${a.choice} fill(${kind})`; }
        } else if (picked.tag === 'select') {
          const n = await loc.locator('option').count();
          await loc.selectOption({ index: Math.min(1, Math.max(0, n - 1)) });
        } else {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: 4000 }).catch(() => loc.click({ timeout: 4000, force: true }));
        }
      }
    } catch (e) { acted = `${a?.choice} FAILED: ${redact(String(e.message).split('\n')[0].slice(0, 80))}`; }
    history.push({ step, action: acted, screen: st.title });
    await page.waitForTimeout(1300);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  }
} catch (e) {
  // Fail CLOSED: an extraction or Jev error stops the walk; it never continues blind.
  status = 'error';
  error = redact(String(e.message).split('\n')[0].slice(0, 200));
  say(`\n■ stopped: ${error}`);
}

try {
  const fin = await extract(page);
  shots += 1;
  const file = `${String(shots).padStart(2, '0')}-end.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: true }).catch(() => {});
  index.push({ n: shots, step: 'end', file, url: redactPii(sanitizeText(page.url())), title: fin.title, text: fin.text.slice(0, 160), action: `final state (${screenFingerprint(page.url(), fin.text) === lastFp ? 'same screen as last step' : 'new screen'})` });
} catch { /* the browser may already be gone */ }
await browser.close();

const md = [
  `# jev-verify walk — ${URL_}`, '',
  `Status: **${status}**${error ? ` (${error})` : ''} · ${index.length} screens · ${jev.summary()} · device ${DEVICE}`, '',
  '| # | step | screen | Jev action | p | goal | url |', '|---|---|---|---|---|---|---|',
  ...index.map((s) => `| ${s.n} | ${s.step} | ![${s.n}](${s.file}) | ${s.action ?? ''} | ${s.p?.toFixed(2) ?? ''} | ${s.goal?.toFixed(2) ?? ''} | ${s.url.replace(/^https?:\/\//, '')} |`), '',
  ...index.map((s) => `## ${s.n}. ${s.title || '(untitled)'}\n\n\`${s.url}\`\n\n> ${s.text}\n\n![screen ${s.n}](${s.file})\n`),
].join('\n');
writeFileSync(join(OUT, 'index.md'), redact(md), { mode: 0o600 });
writeFileSync(join(OUT, 'report.json'), redact(JSON.stringify({ status, error, url: URL_, goal: GOAL, device: DEVICE, screens: index, usage: jev.usage }, null, 2)) + '\n', { mode: 0o600 });
say(`\n${status} · ${index.length} screens · ${jev.summary()}\n${join(OUT, 'index.md')}`);
process.exit(['goal_reached', 'done', 'payment_reached', 'purchase_guard'].includes(status) ? EXIT.PASS : EXIT.FAIL);
