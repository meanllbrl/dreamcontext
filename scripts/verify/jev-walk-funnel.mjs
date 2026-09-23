#!/usr/bin/env node
/**
 * SPIKE 3 — Jev WALKS a live funnel on its own and screenshots every screen.
 *
 *   node scripts/verify/jev-walk-funnel.mjs [url] [--email m@m.com] [--max 60] [--out tmp/jev-walk]
 *
 * Unlike the first two spikes, navigation here is NOT scripted. Each step is ONE Jev call over the
 * page's text state (visible text + every interactive element, numbered) with three questions:
 *   action — a Choice over the elements plus scroll_down / wait / done
 *   goal   — a Noul: has the funnel reached its end (plan selection / payment / thank-you)?
 *   stuck  — a Noul: is the walk looping without progress?
 * Code owns everything Jev must not: what gets typed (email = the one you pass; other fields get a
 * plausible test value by a Choice on what the field asks for), when to stop (goal ≥ 0.85, stuck
 * ≥ 0.85, step budget, or ANY card-number field on screen — we never pay), and the screenshots.
 *
 * Every NEW screen (URL + text fingerprint changes) is saved as NN.png, and an index.md lists them
 * with the step, the action Jev picked, its probability, and the goal/stuck readings.
 *
 * KEY: ~/.dreamcontext/voice.json → openRouterKey, in memory only.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, devices } from 'playwright';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = argv.find((a) => a.startsWith('http')) ?? 'https://start.trypushme.com/en/8110';
const EMAIL = arg('--email', 'm@m.com');
const MAX_STEPS = Number(arg('--max', '60'));
const OUT = arg('--out', join('tmp', 'jev-walk-' + (URL_.match(/(\d+)\/?$/)?.[1] ?? 'funnel')));
const GOAL = 'Move through this onboarding funnel as a plausible new user until the paywall / plan selection / payment screen is reached. Pick answers a real user would pick, prefer the primary "continue" action, accept cookie banners, and do not go back.';

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';
const MAX_ELEMENTS = 120;

const key = (() => { try { const k = JSON.parse(readFileSync(join(homedir(), '.dreamcontext', 'voice.json'), 'utf-8')).openRouterKey; return typeof k === 'string' && k.length > 10 ? k : null; } catch { return null; } })();
if (!key) { console.log('unobtainable: no openRouterKey in ~/.dreamcontext/voice.json'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

let spent = 0, calls = 0;
async function jev(state, questions) {
  const t0 = Date.now();
  let res, lastErr;
  // A 5xx or 429 from the gateway is transient; retry three times with backoff before giving up.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      res = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state, questions }) });
      if (res.ok) break;
      lastErr = `Jev ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status < 500 && res.status !== 429) throw new Error(lastErr);
    } catch (e) { lastErr = String(e.message); }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res || !res.ok) throw new Error(lastErr ?? 'Jev unreachable');
  const body = await res.json(); spent += body.usage?.cost ?? 0; calls++;
  return { answers: body.answers, ms: Date.now() - t0 };
}
const noul = (instructions) => ({ type: 'noul', instructions });
const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });

/** Number every visible interactive element and tag it with data-jev so a pick is clickable. */
async function extract(page) {
  return page.evaluate((MAX) => {
    const sel = 'a, button, input, select, textarea, [role=button], [role=radio], [role=checkbox], [role=option], [role=link], [role=tab], [role=menuitem], label, [onclick], [tabindex]:not([tabindex="-1"])';
    const seen = new Set(); const out = [];
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
    const txt = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    document.querySelectorAll('[data-jev]').forEach((el) => el.removeAttribute('data-jev'));
    for (const el of document.querySelectorAll(sel)) {
      if (out.length >= MAX) break;
      if (!vis(el)) continue;
      // A label wrapping a control duplicates it; keep the control.
      if (el.tagName === 'LABEL' && el.querySelector('input,select,textarea,button')) continue;
      if (el.closest('[data-jev]')) continue;
      const t = txt(el);
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || (tag === 'input' ? 'text' : undefined);
      const k = `${tag}|${type}|${t}`;
      if (!t && tag !== 'input' && tag !== 'select') continue;
      if (seen.has(k) && tag !== 'input') continue;
      seen.add(k);
      const id = `e${out.length}`;
      el.setAttribute('data-jev', id);
      const r = el.getBoundingClientRect();
      const href = tag === 'a' ? (el.getAttribute('href') || '') : '';
      if (tag === 'a' && (href === '/' || href === location.origin || href === location.origin + '/' || /^\/(en|ar|de|fr|es|it|pt|tr|ru|ja|ko|zh)?\/?$/.test(href))) continue;
      out.push({ id, tag, type, role: el.getAttribute('role') || undefined, text: t, value: (tag === 'input' || tag === 'select' || tag === 'textarea') ? String(el.value ?? '').slice(0, 40) || undefined : undefined, checked: el.checked || el.getAttribute('aria-checked') === 'true' || undefined, disabled: el.disabled || undefined, in_viewport: r.top >= 0 && r.bottom <= innerHeight, y: Math.round(r.top) });
    }
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3500);
    // Only a VISIBLE payment control counts — funnels preload checkout iframes screens early,
    // and a "scratch card" is not a credit card.
    const hasCard = [...document.querySelectorAll('input[autocomplete*="cc-"], input[name*="cardnumber" i], input[placeholder*="card number" i], iframe[src*="stripe" i], iframe[src*="paddle" i], iframe[src*="checkout" i], iframe[title*="card" i]')].some((el) => vis(el));
    return { title: document.title, text, elements: out, hasCard, scrollY: scrollY, scrollMax: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
  }, MAX_ELEMENTS);
}

const fingerprint = (url, text) => createHash('sha1').update(url.split('#')[0] + '|' + text.slice(0, 1500)).digest('hex').slice(0, 10);

const FILL_KINDS = {
  email: 'An email address.', first_name: 'A first name or nickname.', full_name: 'A full name.', age: 'An age in years.',
  height: 'Body height.', weight: 'Body weight (current).', target_weight: 'A goal / target weight.', phone: 'A phone number.',
  password: 'A password.', code: 'A verification / promo code.', other_text: 'Free text of another kind.',
};
const FILL_VALUES = { email: EMAIL, first_name: 'Mehmet', full_name: 'Mehmet Test', age: '31', height: '178', weight: '82', target_weight: '75', phone: '5551234567', password: 'Test1234!', code: '', other_text: 'test' };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const index = []; const history = [];
  let lastFp = '', lastStateFp = '', sameCount = 0, shots = 0, waits = 0, status = 'max_steps';
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const st = await extract(page);
    const url = page.url();
    // Two fingerprints: the SCREEN one (url + text) decides screenshots; the STATE one also
    // folds in input values and checked marks, so a fill or a ticked checkbox counts as progress.
    const fp = fingerprint(url, st.text);
    const stateFp = fingerprint(url, st.text + st.elements.map((e) => `${e.id}=${e.value ?? ''}${e.checked ? '*' : ''}`).join(','));
    const newScreen = fp !== lastFp;
    const progressed = stateFp !== lastStateFp; lastStateFp = stateFp;
    if (newScreen) {
      shots += 1;
      const file = `${String(shots).padStart(2, '0')}.png`;
      await page.screenshot({ path: join(OUT, file), fullPage: false });
      index.push({ n: shots, step, file, url, title: st.title, text: st.text.slice(0, 160) });
    }
    // A deliberate wait on a loading screen is not a failed action; only non-wait no-ops count.
    sameCount = progressed ? 0 : (history.at(-1)?.action === 'wait' ? sameCount : sameCount + 1);
    if (progressed) waits = 0;
    lastFp = fp;

    // Recovery: two no-op steps in a row usually means an overlay is open; close it before asking again.
    if (sameCount >= 2) {
      const closer = page.locator('[role=dialog] [aria-label*="close" i], nav [aria-label*="close" i], [aria-label="Close menu"]').first();
      if (await closer.count()) { await closer.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(500); }
    }
    if (st.hasCard) { status = 'payment_form_reached'; console.log(`\n■ step ${step}: card fields on screen — stopping before any payment input.`); break; }

    const opts = {};
    // A disabled control is not an action; offering it invites a pick that changes nothing.
    // Page chrome (hamburger menu, back arrow, close) is never the way forward in a funnel.
    const CHROME = /^(open )?menu$|^back$|^close( menu)?$|^go back$/i;
    for (const e of st.elements.filter((x) => !x.disabled && !CHROME.test(x.text))) opts[e.id] = `${e.tag}${e.type ? `[${e.type}]` : ''}${e.role ? `(${e.role})` : ''}${e.checked ? ' [checked]' : ''}${e.disabled ? ' [disabled]' : ''}: ${e.text || '(no text)'}`;
    // Next-best fallback: an element whose pick changed nothing is withdrawn for the retry.
    // (slice(-0) would be the WHOLE history — guard the zero case, ids are reused across screens.)
    if (!progressed && sameCount > 0) for (const h of history.slice(-sameCount)) { const id = String(h.action).split(' ')[0]; if (id !== 'wait') delete opts[id]; }
    if (st.scrollY < st.scrollMax) opts.scroll_down = 'Scroll down to reveal more of the page.';
    if (waits < 4) opts.wait = 'Wait — the page is still loading or animating.';
    opts.done = 'The goal is reached; stop here.';

    const state = { goal: GOAL, step, url, title: st.title, visible_text: st.text, interactive_elements: st.elements.map((e) => ({ id: e.id, ...e, id2: undefined })), recent_actions: history.slice(-6), last_action_changed_screen: progressed, note: progressed ? 'Email fields must receive the test address; code types values — you only pick the element.' : 'The last action changed NOTHING on screen. Pick a DIFFERENT element this time — usually an option/answer must be selected before the continue button works.' };
    const { answers, ms } = await jev(state, {
      action: choice('Which ONE element should be acted on next (or scroll/wait/done) to make progress toward the goal?', opts),
      goal: noul('Has the funnel reached its END screen — a plan selection, paywall, checkout or thank-you page?'),
      stuck: noul('Is the walk stuck, repeating the same screen or actions without progress?'),
    });
    const a = answers.action, goal = answers.goal.noul, stuck = answers.stuck.noul;
    const picked = st.elements.find((e) => e.id === a.choice);
    appendFileSync(join(OUT, 'trace.jsonl'), JSON.stringify({ step, url, progressed, sameCount, waits, text: st.text.slice(0, 600), elements: st.elements.map((e) => opts[e.id] ?? `(withheld) ${e.text}`), pick: a.choice, p: a.probabilities[a.choice], goal, stuck }) + '\n');
    console.log(`step ${step.toString().padStart(2)} ${newScreen ? '📸' : '  '} goal=${goal.toFixed(2)} stuck=${stuck.toFixed(2)} ${ms}ms → ${a.choice} (${(a.probabilities[a.choice] ?? 0).toFixed(2)}) ${picked ? opts[picked.id].slice(0, 70) : ''}   ${url.replace(/^https?:\/\//, '').slice(0, 60)}`);
    if (index.at(-1)?.step === step) Object.assign(index.at(-1), { action: opts[a.choice], p: a.probabilities[a.choice], goal, stuck });

    if (goal >= 0.85 || a.choice === 'done') { status = goal >= 0.85 ? 'goal_reached' : 'done'; break; }
    if ((stuck >= 0.85 && sameCount >= 3) || sameCount >= 5) { status = 'stuck'; break; }

    let acted = a.choice;
    try {
      if (a.choice === 'scroll_down') await page.mouse.wheel(0, 600);
      else if (a.choice === 'wait') { waits += 1; await page.waitForTimeout(4000); }
      else if (picked) {
        const loc = page.locator(`[data-jev="${picked.id}"]`).first();
        const isText = picked.tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'range', 'file'].includes(picked.type ?? '') || picked.tag === 'textarea';
        if (picked.tag === 'input' && picked.type === 'range') {
          await loc.focus(); for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
          acted = `${a.choice} slider +5`;
        } else if (isText) {
          let kind = picked.type === 'email' ? 'email' : null;
          if (!kind) {
            const { answers: k } = await jev({ field: picked, page_text: st.text.slice(0, 1200) }, { kind: choice('What does this input field ask for?', FILL_KINDS) });
            kind = k.answers.kind.choice;
          }
          const val = FILL_VALUES[kind] ?? 'test';
          await loc.click({ timeout: 4000 }); await loc.fill(val);
          acted = `${a.choice} fill(${kind}=${kind === 'email' ? EMAIL : val})`;
        } else if (picked.tag === 'select') {
          const n = await loc.locator('option').count();
          await loc.selectOption({ index: Math.min(1, n - 1) });
        } else {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: 4000 }).catch(() => loc.click({ timeout: 4000, force: true }));
        }
      }
    } catch (e) { acted = `${a.choice} FAILED: ${String(e.message).split('\n')[0].slice(0, 80)}`; }
    history.push({ step, action: acted, screen: st.title });
    await page.waitForTimeout(1300);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  }

  // Final screen, in case the loop broke before shooting it.
  const fin = await extract(page); const fp = fingerprint(page.url(), fin.text);
  { shots += 1; const file = `${String(shots).padStart(2, '0')}-end.png`; await page.screenshot({ path: join(OUT, file), fullPage: true }); index.push({ n: shots, step: 'end', file, url: page.url(), title: fin.title, text: fin.text.slice(0, 160), action: `final state (${fp === lastFp ? 'same screen as last step' : 'new screen'})` }); }

  const md = [`# Jev walk — ${URL_}`, '', `Status: **${status}** · ${index.length} screens · ${calls} Jev calls · $${spent.toFixed(4)} · email used: ${EMAIL}`, '', '| # | step | screen | Jev action | p | goal | url |', '|---|---|---|---|---|---|---|',
    ...index.map((s) => `| ${s.n} | ${s.step} | ![${s.n}](${s.file}) | ${s.action ?? ''} | ${s.p?.toFixed(2) ?? ''} | ${s.goal?.toFixed(2) ?? ''} | ${s.url.replace(/^https?:\/\//, '')} |`), '',
    ...index.map((s) => `## ${s.n}. ${s.title || '(untitled)'}\n\n\`${s.url}\`\n\n> ${s.text}\n\n![screen ${s.n}](${s.file})\n`)].join('\n');
  writeFileSync(join(OUT, 'index.md'), md);
  console.log(`\n${status} · ${index.length} screens · ${calls} Jev calls · $${spent.toFixed(4)} · ${OUT}/index.md`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
