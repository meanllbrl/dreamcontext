#!/usr/bin/env node
/**
 * Chat READING RHYTHM end-to-end verification.
 *
 *   npm run build && npm run verify:chat-prose
 *
 * Owner report 08-02: "satır araları hafif artabilir mi, okuması güç oluyor" — a long answer
 * (a review report: headings, paragraphs, a numbered findings list dense with inline code)
 * packs into a wall. Two separate causes, both invisible in the CSS until something MEASURES
 * the painted line boxes:
 *
 *   1. the transcript's prose leading was 1.6 — fine for a UI label, tight for a body column
 *      at this measure
 *   2. `MarkdownPreview.css` pins `li` to the body-sm leading (1.43) with a selector that
 *      outranks the chat's own block, so the LIST — the shape most long answers take — was
 *      the tightest text on screen, tighter than the paragraphs around it
 *
 * WHAT IT DRIVES — the real dashboard server, the real `/ws/agent-chat` route, the real React
 * surface in Chromium. Every number is the distance between real painted line boxes
 * (`Range.getClientRects()` walks the line boxes of a wrapped paragraph), never computed from
 * the stylesheet by hand — the 08-01 density pass had a rule that measured 35px while its CSS
 * said 26px, and only a runtime measurement caught it.
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is replaced, for this run only, by a scripted
 * stand-in in an isolated fake HOME (same substitution as chat-toolrows.mjs / chat-steer.mjs).
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST: every check prints ✓/✗ with evidence and the run
 * continues. Exit 0 iff all checks pass.
 *
 * Set VERIFY_SHOTS=<dir> to also write the pictures a person can just look at.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-chat-prose');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const ANSWER_FILE = join(SCRATCH, 'answer.md');

// The answer is shaped like the one in the owner's screenshot: a verdict, then a numbered
// findings list whose items run several lines each and are peppered with inline code. The
// paragraphs and the list have to be measured SEPARATELY — that is where the two leadings
// diverged, and a shorter sample would have wrapped to one line and measured nothing.
const ANSWER = `## Verdict

==!FAIL== — the language lock still contradicts itself.

The fix landed in the prose section but was left untouched in both kernels, which still label
"hello/hi/hey/ok/yes/punctuation-only" as ambiguous and lock to English, directly contradicting
the rule twenty-five lines above it, and never mentioning the configured widget language
fallback at all. This is untested. Separately, the new ladder has a real dead end for a
first-ever language-neutral message that silently drops behavior the old text covered.

## Findings

### Critical

1. \`src/engine/prompts/conversational.kernel.txt:237-242\` — the cognitive-process language
   lock still contains the pre-fix rule, contradicting the new ladder in the same file. The
   section the model is told to apply before anything else still reads: if the message is
   ambiguous, lock to English. This was not touched by the diff, even though the prose section
   twenty-five lines above it now explicitly says the opposite: ==do not classify a message as
   ambiguous because it is short, and decide from the visitor's own words alone== — a stroke
   long enough that it has to wrap, which is the case a filled box gets wrong.
2. \`src/engine/prompts/product.kernel.txt:274-279\` — the same block, the same contradiction,
   and the same silence about the configured widget language. A concrete failing input: the
   widget language is Turkish, the channel is web, and the visitor's first-ever message is
   punctuation-only. The new ladder should resolve to the configured widget language; the
   block below unconditionally directs the model to English instead.

The wiring itself is ==+logically sound== but has zero test coverage, so nothing above would
have been caught by the suite as it stands today.
`;

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
/** Scripted stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-prose.mjs. */
const { readFileSync } = require('node:fs');
const ANSWER = readFileSync(${JSON.stringify(ANSWER_FILE)}, 'utf-8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inbox = [];
let busy = false;

async function runTurn() {
  busy = true;
  out({ type: 'system', subtype: 'init', session_id: 'verify-session', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: ['compact'] });
  await sleep(200);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] } });
  await sleep(200);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-session' });
  busy = false;
  pump();
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request' && o.request && o.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) { inbox.push(text); pump(); }
  }
});

let pumping = false;
async function pump() {
  if (pumping || busy) return;
  const next = inbox.shift();
  if (next === undefined) return;
  pumping = true;
  try { await runTurn(next); } finally { pumping = false; }
}
process.stdin.on('end', () => process.exit(0));
`;

// ─── setup (mirrors scripts/verify/chat-toolrows.mjs) ─────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', '.secrets.json'),
    '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
  writeFileSync(ANSWER_FILE, ANSWER);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });

  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── the measurement ──────────────────────────────────────────────────────────────────
//
// Runs IN the page. A wrapped block paints one line box per visual line; a Range over the
// block's text yields one client rect per line box, so `top[n+1] - top[n]` is the pitch a
// reader's eye actually travels — the number the owner is complaining about. Rects are
// grouped by rounded `top` because inline children (a code chip, a bold run) each contribute
// their own rect on the same line.
// The element scanned is the LONGEST match, not the first: the first `p` in a review report is
// the one-word verdict, and a block that never wrapped has no second line box to measure from.
const MEASURE = `(sel) => {
  const of = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Map();
    for (const r of range.getClientRects()) {
      if (r.height <= 0 || r.width <= 0) continue;
      const key = Math.round(r.top);
      const prev = tops.get(key);
      if (!prev || r.height > prev) tops.set(key, r.height);
    }
    const lines = [...tops.keys()].sort((a, b) => a - b);
    if (lines.length < 2) return { lines: lines.length, pitch: null };
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);
    gaps.sort((a, b) => a - b);
    return { lines: lines.length, pitch: gaps[Math.floor(gaps.length / 2)] };
  };
  const all = [...document.querySelectorAll(sel)].map(of);
  if (!all.length) return null;
  return all.sort((a, b) => b.lines - a.lines)[0];
}`;

async function runTheme(chromium, base, theme, report) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));

  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(120); }
    return false;
  };
  const ok = (label, cond, detail) => report.check(theme, label, cond, detail);
  const measure = (sel) => page.evaluate(`(${MEASURE})(${JSON.stringify(sel)})`);

  console.log(`\n═══ ${theme} ═══`);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  ok('a chat session opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20000));
  await page.waitForTimeout(800);

  // A multi-line message of the user's OWN — their words are prose too, and read at the same
  // rhythm as the answer or the transcript has two competing ones.
  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill(
    'Review the language-lock change across both kernels and tell me whether the cognitive-process '
    + 'block still contradicts the ladder above it, because the widget-language fallback looks unhandled.',
  );
  await page.keyboard.press('Enter');

  ok('the answer arrives and renders as markdown',
    await until(async () => (await vis('.chat-msg-assistant-body .markdown-body').count()) > 0, 30000));
  await until(async () => (await vis('.chat-cmp-stop').count()) === 0, 30000);
  await page.waitForTimeout(600);

  // ── the numbers ───────────────────────────────────────────────────────────────────
  console.log('── reading rhythm, measured off painted line boxes');
  const para = await measure('.chat-msg-assistant-body .markdown-body p');
  const item = await measure('.chat-msg-assistant-body .markdown-body li');
  const bubble = await measure('.chat-msg-user-bubble');

  ok('the sample really wrapped — a one-line block measures nothing',
    (para?.lines ?? 0) >= 3 && (item?.lines ?? 0) >= 3 && (bubble?.lines ?? 0) >= 2,
    JSON.stringify({ para, item, bubble }));

  // 15px × 1.75 = 26.25 → 26 after rounding. The old 1.6 painted 24.
  ok('a paragraph reads at ≥26px per line — the transcript\'s own leading, not a UI label\'s',
    (para?.pitch ?? 0) >= 26, `paragraph pitch=${para?.pitch}px`);
  ok('a LIST reads at the same pitch as the paragraphs around it — no tight island where the '
    + 'findings are (MarkdownPreview pins li to 1.43 and out-specifies the chat block)',
    para?.pitch != null && item?.pitch != null && Math.abs(item.pitch - para.pitch) <= 1,
    `paragraph=${para?.pitch}px vs list item=${item?.pitch}px`);
  ok('the user\'s own multi-line message reads at that same pitch',
    bubble?.pitch != null && para?.pitch != null && Math.abs(bubble.pitch - para.pitch) <= 1,
    `bubble=${bubble?.pitch}px vs paragraph=${para?.pitch}px`);

  // A block boundary has to out-read a line boundary, or the paragraphs melt into one slab —
  // raising the leading without raising the block gap would have made that WORSE.
  const blockGap = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('.chat-msg-assistant-body .markdown-body > p')];
    if (ps.length < 2) return null;
    return Math.round(ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom);
  });
  ok('two paragraphs sit ≥14px apart, so a block boundary still out-reads a line boundary',
    (blockGap ?? 0) >= 14, `block gap=${blockGap}px, line pitch=${para?.pitch}px`);

  const itemGap = await page.evaluate(() => {
    const lis = [...document.querySelectorAll('.chat-msg-assistant-body .markdown-body li')];
    if (lis.length < 2) return null;
    return Math.round(lis[1].getBoundingClientRect().top - lis[0].getBoundingClientRect().bottom);
  });
  ok('and two findings sit ≥6px apart — a multi-line item needs more than the 4px a one-liner does',
    (itemGap ?? 0) >= 6, `item gap=${itemGap}px`);

  // ── the highlighter ───────────────────────────────────────────────────────────────
  console.log('── highlighter: ==phrase== paints a marker stroke');
  const marks = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.chat-msg-assistant-body .markdown-body mark')];
    return els.map((el) => {
      const cs = getComputedStyle(el);
      const parentColor = getComputedStyle(el.parentElement ?? el).color;
      return {
        text: (el.textContent ?? '').slice(0, 40),
        pen: el.className || 'default',
        // The resolved ink, so two pens can be compared as PAINT rather than as class names.
        ink: cs.getPropertyValue('--mark-ink').trim(),
        hasInk: cs.backgroundImage !== 'none',
        // The UA stylesheet repaints <mark> black-on-yellow. Inheriting instead is what keeps
        // a highlighted phrase readable when the page is dark — and readable is the point.
        keepsTextColor: cs.color === parentColor,
        // One rect per painted stroke: a wrapped highlight must be TWO pen strokes, not one
        // box stretched around the line break.
        strokes: el.getClientRects().length,
        clone: cs.boxDecorationBreak === 'clone' || cs.webkitBoxDecorationBreak === 'clone',
      };
    });
  });
  ok('the ==phrase== syntax rendered as real <mark> elements in the transcript',
    marks.length >= 2, JSON.stringify(marks));
  ok('every stroke actually paints ink, and none of them repaints the TEXT',
    marks.length > 0 && marks.every((m) => m.hasInk && m.keepsTextColor), JSON.stringify(marks));
  ok('a highlight long enough to wrap paints one stroke PER LINE (box-decoration-break: clone)',
    marks.some((m) => m.strokes >= 2) && marks.every((m) => m.clone),
    JSON.stringify(marks.map((m) => ({ strokes: m.strokes, clone: m.clone }))));

  // The pens: `==!FAIL==` must not merely be classed red, it must PAINT red — and the marker
  // characters themselves must be gone from what the reader sees.
  const pens = Object.fromEntries(marks.map((m) => [m.pen, m.ink]));
  ok('the red pen (==!phrase==) and the green pen (==+phrase==) both reached the transcript',
    'mark-alarm' in pens && 'mark-good' in pens, JSON.stringify(pens));
  ok('…and the three pens paint three DIFFERENT inks, not one class name apart',
    new Set(Object.values(pens)).size === Object.keys(pens).length, JSON.stringify(pens));
  ok('the pen character is consumed, never shown — the reader sees "FAIL", not "!FAIL"',
    marks.every((m) => !/^[!+]/.test(m.text)), JSON.stringify(marks.map((m) => m.text)));

  // Clean numbers are necessary, not sufficient — this is the artifact a person looks at.
  const shot = process.env.VERIFY_SHOTS;
  if (shot) {
    await vis('.chat-msg-assistant-body').first().screenshot({ path: `${shot}/prose-${theme}.png` });
    await vis('.chat-scroll-inner').first().screenshot({ path: `${shot}/transcript-${theme}.png` });
  }
  report.note(`  · ${theme}: paragraph ${para?.pitch}px · list ${item?.pitch}px · bubble ${bubble?.pitch}px `
    + `· block gap ${blockGap}px · item gap ${itemGap}px`);

  await browser.close();
}

// ─── run ──────────────────────────────────────────────────────────────────────────────

const report = {
  pass: 0,
  fails: [],
  notes: [],
  check(theme, label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(`[${theme}] ${label}`); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
try {
  const { chromium } = await import('@playwright/test');
  console.log('· setting up scratch vault + scripted claude…');
  setupScratch();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  for (const theme of (process.env.VERIFY_THEMES || 'light,dark').split(',')) {
    rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
    await runTheme(chromium, `http://127.0.0.1:${port}`, theme, report);
  }
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}

console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
